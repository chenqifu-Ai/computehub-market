/**
 * relay.js — OpenAI 兼容中继核心
 *
 * 职责：
 *   1. 鉴权（sk- 令牌 → 用户/令牌校验：状态/过期/额度/模型白名单/IP）
 *   2. 渠道选择（优先级 → 权重 → 失败重试）
 *   3. 模型映射（对外名 → 上游真实名）
 *   4. 转发（支持流式 SSE 与非流式）
 *   5. 计费 + 日志
 */
'use strict';

const crypto = require('node:crypto');
const ratelimit = require('./ratelimit');
const health = require('./health');

let CTX = null; // { db, store, billing, QUOTA_PER_USD, clientIp, json }

function status() {
  if (!CTX) return { ready: false };
  const chs = CTX.store.listChannelsRaw(CTX.db);
  return {
    ready: true,
    site: CTX.store.getSetting(CTX.db, 'site_name'),
    channels: chs.length,
    active: chs.filter(c => c.status === 1).length,
    healthy: chs.filter(c => c.status === 1 && health.available(c.id)).length,
    models: CTX.store.publicModelCatalog(CTX.db).count,
    health: health.snapshot(),
    ratelimit: ratelimit.stats(),
  };
}

/** 让 status 在首次 /v1 请求前也能用（由 server 启动时注入） */
function init(ctx) { CTX = ctx; }

// ---------- 鉴权 ----------
function authToken(ctx, req) {
  const h = req.headers['authorization'] || '';
  let raw = null;
  if (h.startsWith('Bearer ')) raw = h.slice(7).trim();
  else if (req.headers['x-api-key']) raw = String(req.headers['x-api-key']).trim();
  if (!raw) return { err: '缺少 API Key（Authorization: Bearer sk-xxx）', code: 401 };
  const plain = raw.replace(/^sk-/, '');
  const t = ctx.store.getTokenByPlain(ctx.db, plain);
  if (!t) return { err: 'Invalid token', code: 401 };
  if (t.status !== 1) return { err: '令牌已禁用', code: 403 };
  if (t.expired_time > 0 && t.expired_time < Date.now()) return { err: '令牌已过期', code: 401 };

  const user = ctx.store.getUserById(ctx.db, t.user_id);
  if (!user || user.status !== 1) return { err: '用户不存在或已禁用', code: 403 };

  // IP 白名单
  if (t.allow_ips) {
    const ip = ctx.clientIp(req);
    const allow = t.allow_ips.split(',').map(s => s.trim()).filter(Boolean);
    if (allow.length && !allow.includes(ip)) return { err: `IP 不在白名单: ${ip}`, code: 403 };
  }
  // 令牌额度
  if (!t.unlimited_quota && t.remain_quota <= 0) return { err: '令牌额度已用尽', code: 402 };
  // 用户余额
  if (user.quota <= 0) return { err: '账户余额不足，请充值', code: 402 };

  // 限流（按令牌；管理员豁免）
  if (user.role < 100) {
    const limit = ctx.store.getSetting(ctx.db, 'rate_limit_per_min');
    const rl = ratelimit.check('t' + t.id, limit);
    if (!rl.ok) {
      return { err: `请求过于频繁（限 ${rl.limit}/分钟，请 ${rl.retryAfter}s 后重试）`, code: 429, retryAfter: rl.retryAfter };
    }
  }

  return { token: t, user };
}

function modelAllowed(token, model) {
  if (!token.model_limits) return true;
  const allow = token.model_limits.split(',').map(s => s.trim()).filter(Boolean);
  return allow.includes(model);
}

// ---------- 渠道选择 ----------
function rankChannels(ctx, model) {
  const list = ctx.store.channelsForModel(ctx.db, model);
  if (!list.length) return [];
  // 按 priority 降序，同优先级按权重随机（加权轮询的简化版）
  const groups = {};
  for (const c of list) {
    const p = c.priority || 0;
    (groups[p] = groups[p] || []).push(c);
  }
  const prios = Object.keys(groups).map(Number).sort((a, b) => b - a);
  const out = [];
  for (const p of prios) {
    const g = groups[p].slice();
    // 组内加权洗牌
    for (let i = g.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [g[i], g[j]] = [g[j], g[i]];
    }
    out.push(...g);
  }
  return out;
}

function pickChannel(ctx, model) {
  const ranked = rankChannels(ctx, model);
  return ranked.length ? ranked[0] : null;
}

function mapModel(channel, model) {
  try {
    const m = channel.model_mapping ? JSON.parse(channel.model_mapping) : {};
    if (m[model]) return m[model];
  } catch {}
  return model;
}

// ---------- 主入口 ----------
async function handle(ctx, req, res, pathname, query) {
  CTX = ctx;
  const { store, billing } = ctx;

  // GET /v1/models —— 需要鉴权，返回令牌可见模型
  if (pathname === '/v1/models' && req.method === 'GET') {
    const a = authToken(ctx, req);
    if (a.err) return ctx.json(res, a.code, { error: { message: a.err, type: 'invalid_request_error' } });
    const cat = store.publicModelCatalog(ctx.db);
    let models = cat.models;
    if (a.token.model_limits) {
      const allow = a.token.model_limits.split(',').map(s => s.trim());
      models = models.filter(m => allow.includes(m));
    }
    return ctx.json(res, 200, {
      object: 'list',
      data: models.map(m => ({ id: m, object: 'model', created: 1626777600, owned_by: 'computehub' })),
    });
  }

  // 仅支持 POST 的推理端点
  const isChat = pathname === '/v1/chat/completions';
  const isCompl = pathname === '/v1/completions';
  const isEmbed = pathname === '/v1/embeddings';
  const isAudio = pathname.startsWith('/v1/audio/');
  if (!isChat && !isCompl && !isEmbed && !isAudio) {
    return ctx.json(res, 404, { error: { message: `未知端点 ${pathname}`, type: 'invalid_request_error' } });
  }
  if (req.method !== 'POST') {
    return ctx.json(res, 405, { error: { message: '仅支持 POST', type: 'invalid_request_error' } });
  }

  // 读 body
  const raw = await readRaw(req);
  let body;
  try { body = JSON.parse(raw.toString('utf8') || '{}'); }
  catch { return ctx.json(res, 400, { error: { message: '请求体不是合法 JSON', type: 'invalid_request_error' } }); }

  const model = String(body.model || '');
  if (!model) return ctx.json(res, 400, { error: { message: '缺少 model 参数', type: 'invalid_request_error' } });

  // 鉴权
  const a = authToken(ctx, req);
  if (a.err) return ctx.json(res, a.code, { error: { message: a.err, type: 'invalid_request_error' } }, a.retryAfter);

  // 模型白名单
  if (!modelAllowed(a.token, model)) {
    return ctx.json(res, 403, { error: { message: `令牌无权访问模型 ${model}`, type: 'invalid_request_error' } });
  }

  const started = Date.now();
  const requestId = 'ch-' + crypto.randomBytes(12).toString('hex');
  const isStream = !!body.stream && (isChat || isCompl);

  const ip = ctx.clientIp(req);
  const logBase = {
    user_id: a.user.id, username: a.user.username,
    token_id: a.token.id, token_name: a.token.name,
    model_name: model,
    is_stream: isStream, ip, request_id: requestId,
  };

  // 渠道路由：按优先级依次尝试，失败自动换下一个（故障转移 + 熔断跳过）
  const ranked = rankChannels(ctx, model).filter(c => health.available(c.id));
  if (!ranked.length) {
    return ctx.json(res, 503, { error: { message: `没有可用渠道支持模型 ${model}（可能全部熔断）`, type: 'api_error' } });
  }

  let lastErr = null;
  for (let i = 0; i < ranked.length; i++) {
    const ch = ranked[i];
    const upstreamModel = mapModel(ch, model);
    const upstreamUrl = ch.base_url.replace(/\/+$/, '') + pathname.replace('/v1', '');
    const outBody = { ...body, model: upstreamModel };
    const logCtx = { ...logBase, channel_id: ch.id, channel_name: ch.name, retry: i };
    const chT0 = Date.now();

    try {
      const up = await fetch(upstreamUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(ch.api_key ? { Authorization: 'Bearer ' + ch.api_key } : {}),
          'Accept': isStream ? 'text/event-stream' : 'application/json',
        },
        body: JSON.stringify(outBody),
        signal: AbortSignal.timeout(parseInt(process.env.UPSTREAM_TIMEOUT_MS || '300000', 10)),
      });

      if (!up.ok) {
        const txt = await up.text().catch(() => '');
        lastErr = `上游 ${ch.name} 返回 ${up.status}: ${txt.slice(0, 200)}`;
        health.onFailure(ch.id, lastErr);
        ctx.store.insertLog(ctx.db, { ...logCtx, use_time: (Date.now() - started) / 1000, status: 'error', error: lastErr });
        console.warn(`[relay] 渠道失败，尝试下一个: ${lastErr}`);
        continue;   // 故障转移
      }

      health.onSuccess(ch.id, Date.now() - chT0);
      if (isStream) return await relayStream({ ctx, up, res, body, logCtx, model, started });
      return await relayOnce({ ctx, up, res, body, logCtx, model, started });
    } catch (e) {
      lastErr = `上游 ${ch.name} 请求失败: ${e.message}`;
      health.onFailure(ch.id, lastErr);
      ctx.store.insertLog(ctx.db, { ...logCtx, use_time: (Date.now() - started) / 1000, status: 'error', error: lastErr });
      console.warn(`[relay] ${lastErr}`);
      continue;
    }
  }

  if (!res.headersSent) {
    return ctx.json(res, 502, { error: { message: '所有渠道均不可用: ' + lastErr, type: 'upstream_error' } });
  }
  try { res.end(); } catch {}
}

// ---------- 非流式 ----------
async function relayOnce({ ctx, up, res, body, logCtx, model, started }) {
  const text = await up.text();
  let obj = null;
  try { obj = JSON.parse(text); } catch {}

  const usage = ctx.billing.parseUsage(obj);
  let prompt = usage?.prompt, completion = usage?.completion, cached = usage?.cached || 0;
  if (prompt == null) {
    prompt = ctx.billing.estimateTokens(JSON.stringify(body.messages || body.prompt || ''));
    completion = obj ? ctx.billing.estimateTokens(extractContent(obj)) : 0;
    cached = 0;
  }
  const quota = ctx.billing.computeQuota(model, prompt, completion || 0, cached);
  settle(ctx, { logCtx, model, prompt, completion: completion || 0, cached, quota, started, stream: false });

  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*', 'X-Request-Id': logCtx.request_id });
  return res.end(text);
}

function extractContent(obj) {
  try {
    const c = obj.choices?.[0];
    if (!c) return '';
    return (c.message?.content || c.text || '') + (c.message?.reasoning_content || '');
  } catch { return ''; }
}

// ---------- 流式 ----------
async function relayStream({ ctx, up, res, body, logCtx, model, started }) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
    'Access-Control-Allow-Origin': '*',
    'X-Request-Id': logCtx.request_id,
  });

  const reader = up.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let prompt = null, completion = null, cached = 0;
  let contentChars = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(value);
      // 解析 SSE 以统计 usage / 内容
      buf += dec.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const line of lines) {
        const s = line.trim();
        if (!s.startsWith('data:')) continue;
        const payload = s.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;
        try {
          const j = JSON.parse(payload);
          if (j.usage) {
            const u = ctx.billing.parseUsage({ usage: j.usage });
            if (u) { prompt = u.prompt; completion = u.completion; cached = u.cached || 0; }
          }
          const d = j.choices?.[0]?.delta;
          if (d?.content) contentChars += d.content;
          if (d?.reasoning_content) contentChars += d.reasoning_content;
        } catch {}
      }
    }
  } catch (e) {
    // 客户端断开或上游中断
    if (!res.writableEnded) { try { res.write(`data: {"error":{"message":"stream aborted: ${e.message}"}}\n\n`); } catch {} }
  } finally {
    try { res.end(); } catch {}
  }

  if (prompt == null) {
    prompt = ctx.billing.estimateTokens(JSON.stringify(body.messages || body.prompt || ''));
    completion = ctx.billing.estimateTokens(contentChars);
    cached = 0;
  }
  const quota = ctx.billing.computeQuota(model, prompt, completion || 0, cached);
  settle(ctx, { logCtx, model, prompt, completion: completion || 0, cached, quota, started, stream: true });
}

// ---------- 结算 ----------
function settle(ctx, { logCtx, model, prompt, completion, cached = 0, quota, started, stream }) {
  const useSec = (Date.now() - started) / 1000;
  try {
    ctx.store.insertLog(ctx.db, {
      ...logCtx, prompt_tokens: prompt, completion_tokens: completion, cached_tokens: cached || 0,
      total_tokens: prompt + completion, quota, use_time: useSec, status: 'success',
    });
    ctx.store.addUserUsage(ctx.db, logCtx.user_id, quota, 1);
    ctx.store.addTokenUsage(ctx.db, logCtx.token_id, quota);
    ctx.store.touchToken(ctx.db, logCtx.token_id);
    ctx.store.addChannelUsage(ctx.db, logCtx.channel_id, quota);

    // 消费扣费留痕
    if (quota > 0 && ctx.store.addLedger) {
      ctx.store.addLedger(ctx.db, {
        user_id: logCtx.user_id, delta: -quota, kind: 'consume',
        detail: `调用 ${model} -$${(quota / 500000).toFixed(6)}`,
        ref_user_id: 0, ref_username: logCtx.channel_name || '',
        op_user_id: logCtx.user_id, op_username: logCtx.username, op_role: '用户',
        ip: logCtx.ip || '', request_id: logCtx.request_id,
      });
    }

    // 多层级返佣：下线消费，沿上级链逐级分成（第1代/第2代/第3代）
    try {
      const rate1 = parseFloat(ctx.store.getSetting(ctx.db, 'invite_reward_rate') || '0');
      const rate2 = parseFloat(ctx.store.getSetting(ctx.db, 'agent_reward_l2') || '0');
      const rate3 = parseFloat(ctx.store.getSetting(ctx.db, 'agent_reward_l3') || '0');
      const rates = [rate1, rate2, rate3];
      if (quota > 0 && (rate1 > 0 || rate2 > 0 || rate3 > 0)) {
        const chain = ctx.store.getUpline(ctx.db, logCtx.user_id, 3);   // [L1, L2, L3]
        for (let i = 0; i < chain.length; i++) {
          const rate = rates[i] || 0;
          if (rate <= 0) continue;
          const reward = Math.floor(quota * rate);
          if (reward <= 0) continue;
          const parent = chain[i];
          ctx.store.addAgentReward(ctx.db, parent.id, i + 1, reward);
          if (ctx.store.addLedger) {
            ctx.store.addLedger(ctx.db, {
              user_id: parent.id, delta: reward, kind: 'reward',
              detail: `下级 ${logCtx.username} 消费返佣 L${i + 1} +$${(reward / 500000).toFixed(6)}`,
              ref_user_id: logCtx.user_id, ref_username: logCtx.username,
              op_user_id: 0, op_username: 'system', op_role: '系统', request_id: 'invite:' + logCtx.request_id,
            });
          }
          ctx.store.insertLog(ctx.db, {
            user_id: parent.id, username: 'agent-reward-L' + (i + 1), token_id: 0, token_name: '返佣L' + (i + 1),
            model_name: model, channel_id: 0, channel_name: '', quota: -reward,
            status: 'success', request_id: 'invite:' + logCtx.request_id,
          });
        }
      }
    } catch (e) { console.error('[settle/agent-reward]', e.message); }

    console.log(`[relay] ${logCtx.username} ${model} ch=${logCtx.channel_name} p=${prompt} cached=${cached || 0} c=${completion} quota=${quota} ${useSec.toFixed(1)}s${stream ? ' stream' : ''}`);
  } catch (e) { console.error('[settle]', e.message); }
}

function readRaw(req, limit = 32 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = []; let n = 0;
    req.on('data', c => { n += c.length; if (n > limit) { reject(new Error('body too large')); req.destroy(); return; } chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

module.exports = { handle, status, init };
