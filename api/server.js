#!/usr/bin/env node
/**
 * 算力商城 · AI 模型聚合网关 (ComputeHub API Gateway)
 * New-API 式中转站：多用户 / 令牌 / 渠道池 / 模型路由 / 计费 / 控制台
 *
 * 零 npm 依赖 —— 纯 Node.js 内置模块（http / sqlite / crypto / fetch）
 * 启动: node server.js   (端口 PORT 环境变量，默认 58880)
 */
'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const store = require('./lib/store');
const relay = require('./lib/relay');
const billing = require('./lib/billing');
const health = require('./lib/health');

// ============ 配置 ============
const PORT = parseInt(process.env.PORT || '58880', 10);
const HOST = process.env.HOST || '0.0.0.0';
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'api.db');
const PUBLIC_DIR = path.join(__dirname, 'public');
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
// 1 美元基准 quota（New-API 惯例 500000 = $1）
const QUOTA_PER_USD = 500000;

// ============ 数据库 ============
const db = store.open(DB_PATH);
store.migrate(db);
store.seedChannels(db, path.join(__dirname, 'channels.json'));
console.log(`[db] 数据库就绪: ${DB_PATH}`);
health.startProber({ db, store });

// ============ HTTP 工具 ============
function json(res, code, obj, extraHeaders) {
  const body = JSON.stringify(obj);
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
  };
  // extraHeaders 可以是对象，也可以是数字（秒级 Retry-After）
  if (typeof extraHeaders === 'number') headers['Retry-After'] = String(Math.max(1, extraHeaders));
  else Object.assign(headers, extraHeaders || {});
  res.writeHead(code, headers);
  res.end(body);
}
function readBody(req, limit = 20 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let n = 0;
    req.on('data', c => {
      n += c.length;
      if (n > limit) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
async function readJson(req) {
  const b = await readBody(req);
  try { return JSON.parse(b.toString('utf8') || '{}'); } catch { return null; }
}
function clientIp(req) {
  const xf = req.headers['x-forwarded-for'];
  if (xf) return String(xf).split(',')[0].trim();
  return (req.socket.remoteAddress || '').replace('::ffff:', '');
}

// ============ 会话 / 鉴权 ============
function tokenFromReq(req) {
  const h = req.headers['authorization'] || '';
  if (h.startsWith('Bearer ')) return h.slice(7).trim();
  const u = new URL(req.url, 'http://x');
  return u.searchParams.get('token');
}
function requireUser(req, res) {
  const t = tokenFromReq(req);
  const s = store.getSession(db, t);
  if (!s) { json(res, 401, { success: false, message: '未登录或会话已过期' }); return null; }
  return store.getUserById(db, s.user_id);
}

// ============ 路由 ============
const server = http.createServer(async (req, res) => {
  let pathname, query;
  try {
    const u = new URL(req.url, 'http://x');
    pathname = decodeURIComponent(u.pathname);
    query = u.searchParams;
  } catch { return json(res, 400, { success: false, message: 'Bad URL' }); }

  try {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type,Authorization,New-Api-User',
      });
      return res.end();
    }

    // ---------- OpenAI 兼容中继（核心） ----------
    if (pathname.startsWith('/v1/')) {
      return await relay.handle(relayCtx(), req, res, pathname, query);
    }

    // ---------- 用户认证 ----------
    if (pathname === '/api/user/register' && req.method === 'POST') return await handleRegister(req, res);
    if (pathname === '/api/user/login' && req.method === 'POST') return await handleLogin(req, res);
    if (pathname === '/api/user/logout') return handleLogout(req, res);
    if (pathname === '/api/user/self') {
      const u = requireUser(req, res); if (!u) return;
      return json(res, 200, { success: true, data: store.publicUser(db, u) });
    }
    if (pathname === '/api/user/update' && req.method === 'POST') {
      const u = requireUser(req, res); if (!u) return;
      return await handleUserUpdate(req, res, u);
    }
    if (pathname === '/api/user/dashboard') {
      const u = requireUser(req, res); if (!u) return;
      return json(res, 200, { success: true, data: store.userDashboard(db, u) });
    }

    // ---------- 兑换 / 签到 / 邀请 ----------
    if (pathname === '/api/user/topup' && req.method === 'POST') {
      const u = requireUser(req, res); if (!u) return;
      const b = await readJson(req) || {};
      const code = String(b.code || '').trim();
      if (!code) return json(res, 400, { success: false, message: '请输入兑换码' });
      const r = store.redeemCode(db, u, code);
      if (!r.ok) return json(res, 400, { success: false, message: r.message });
      console.log(`[topup] ${u.username} 兑换 ${r.quota} quota`);
      return json(res, 200, { success: true, message: '兑换成功', data: store.publicUser(db, r.user) });
    }
    if (pathname === '/api/user/checkin') {
      const u = requireUser(req, res); if (!u) return;
      if (req.method === 'GET') return json(res, 200, { success: true, data: store.checkinStatus(db, u) });
      const quota = parseInt(store.getSetting(db, 'checkin_quota') || '0', 10);
      const r = store.doCheckin(db, u, quota);
      if (!r.ok) return json(res, 400, { success: false, message: r.message });
      return json(res, 200, { success: true, message: `签到成功，获得 ${quota} quota`, data: store.publicUser(db, r.user) });
    }
    if (pathname === '/api/user/invite') {
      const u = requireUser(req, res); if (!u) return;
      return json(res, 200, {
        success: true,
        data: {
          aff_code: u.aff_code,
          stats: store.inviteStats(db, u),
          invitees: store.listInvitees(db, u),
          reward_rate: parseFloat(store.getSetting(db, 'invite_reward_rate') || '0'),
          site_name: store.getSetting(db, 'site_name'),
        },
      });
    }

    // ---------- 令牌 ----------
    if (pathname === '/api/token/' || pathname === '/api/token') {
      const u = requireUser(req, res); if (!u) return;
      if (req.method === 'GET') return json(res, 200, { success: true, data: store.listTokens(db, u.id) });
      if (req.method === 'POST') return await handleTokenCreate(req, res, u);
    }
    if (pathname === '/api/token/update' && req.method === 'POST') {
      const u = requireUser(req, res); if (!u) return;
      return await handleTokenUpdate(req, res, u);
    }
    if (pathname === '/api/token/delete' && req.method === 'POST') {
      const u = requireUser(req, res); if (!u) return;
      return await handleTokenDelete(req, res, u);
    }
    if (pathname === '/api/token/key' && req.method === 'GET') {
      const u = requireUser(req, res); if (!u) return;
      const id = parseInt(query.get('id') || '0', 10);
      return handleTokenReveal(res, u, id);
    }

    // ---------- 日志 / 统计 ----------
    if (pathname === '/api/log/self') {
      const u = requireUser(req, res); if (!u) return;
      const p = parseInt(query.get('p') || '1', 10), size = Math.min(parseInt(query.get('size') || '20', 10), 200);
      return json(res, 200, { success: true, data: store.listLogs(db, { userId: u.id, p, size }) });
    }
    if (pathname === '/api/log/model') {
      const u = requireUser(req, res); if (!u) return;
      return json(res, 200, { success: true, data: store.logStatsByModel(db, u.id) });
    }
    // 导出使用日志（xlsx 双 sheet：明细 + 按模型汇总）
    if (pathname === '/api/log/export') {
      const u = requireUser(req, res); if (!u) return;
      const all = query.get('all') === '1' && store.isAdmin(u);
      const userId = all ? null : u.id;
      const days = Math.min(parseInt(query.get('days') || '0', 10), 3650);
      const since = days > 0 ? Date.now() - days * 86400000 : 0;
      return exportUsageXlsx(res, { userId, since, all });
    }

    // ---------- 模型 / 渠道（对外目录：不含密钥） ----------
    if (pathname === '/api/models') {
      return json(res, 200, { success: true, data: store.publicModelCatalog(db) });
    }
    if (pathname === '/api/pricing') {
      return json(res, 200, { success: true, data: store.pricingCatalog(db) });
    }
    if (pathname === '/api/channel/' || pathname === '/api/channel') {
      const u = requireUser(req, res); if (!u) return;
      if (!store.isAdmin(u)) return json(res, 403, { success: false, message: '需要管理员权限' });
      if (req.method === 'GET') {
        const list = store.listChannelsRaw(db).map(c => ({
          ...c,
          api_key: store.maskKey(c.api_key),
          models: c.models || '',
          health: health.snapshot()[c.id] || null,
        }));
        return json(res, 200, { success: true, data: list });
      }
      if (req.method === 'POST') {
        const b = await readJson(req) || {};
        return json(res, 200, { success: true, data: store.addChannel(db, b) });
      }
    }
    if (pathname === '/api/channel/update' && req.method === 'POST') {
      const u = requireUser(req, res); if (!u) return;
      if (!store.isAdmin(u)) return json(res, 403, { success: false, message: '需要管理员权限' });
      const b = await readJson(req) || {};
      const c = store.updateChannel(db, parseInt(b.id || 0, 10), b);
      return json(res, 200, { success: true, data: c });
    }
    if (pathname === '/api/channel/delete' && req.method === 'POST') {
      const u = requireUser(req, res); if (!u) return;
      if (!store.isAdmin(u)) return json(res, 403, { success: false, message: '需要管理员权限' });
      const b = await readJson(req) || {};
      store.deleteChannel(db, parseInt(b.id || 0, 10));
      return json(res, 200, { success: true, message: '已删除' });
    }
    if (pathname === '/api/channel/test' && req.method === 'POST') {
      const u = requireUser(req, res); if (!u) return;
      if (!store.isAdmin(u)) return json(res, 403, { success: false, message: '需要管理员权限' });
      const b = await readJson(req) || {};
      const c = store.getChannel(db, parseInt(b.id || 0, 10));
      if (!c) return json(res, 404, { success: false, message: '渠道不存在' });
      const r = await health.probeChannel(c);
      store.touchChannel(db, c.id);
      return json(res, 200, { success: r.ok, data: r, message: r.ok ? `✅ ${r.models} 个模型 / ${r.latency}ms` : '❌ ' + r.error });
    }
    if (pathname === '/api/channel/models' && req.method === 'POST') {
      const u = requireUser(req, res); if (!u) return;
      const b = await readJson(req);
      if (!b || !b.base_url) return json(res, 400, { success: false, message: '缺少 base_url' });
      return await handleChannelModels(res, b);
    }

    // ---------- 管理：用户 / 兑换码 / 设置 ----------
    if (pathname === '/api/admin/user/list') {
      const u = requireUser(req, res); if (!u) return;
      if (!store.isAdmin(u)) return json(res, 403, { success: false, message: '需要管理员权限' });
      return json(res, 200, { success: true, data: store.listUsers(db) });
    }
    if (pathname === '/api/admin/user/update' && req.method === 'POST') {
      const u = requireUser(req, res); if (!u) return;
      if (!store.isAdmin(u)) return json(res, 403, { success: false, message: '需要管理员权限' });
      const b = await readJson(req) || {};
      const r = store.adminUpdateUser(db, parseInt(b.id || 0, 10), b);
      return json(res, 200, { success: true, data: r });
    }
    if (pathname === '/api/admin/redemption/') {
      const u = requireUser(req, res); if (!u) return;
      if (!store.isAdmin(u)) return json(res, 403, { success: false, message: '需要管理员权限' });
      if (req.method === 'GET') {
        const p = parseInt(query.get('p') || '1', 10), size = Math.min(parseInt(query.get('size') || '50', 10), 200);
        return json(res, 200, { success: true, data: store.listRedemptions(db, { p, size }) });
      }
      if (req.method === 'POST') {
        const b = await readJson(req) || {};
        const created = await store.createRedemptions(db, {
          count: Math.min(parseInt(b.count || 1, 10), 500),
          quota: parseInt(b.quota || 0, 10),
          name: String(b.name || ''),
          createdBy: u.id,
        });
        console.log(`[admin] ${u.username} 生成 ${created.length} 个兑换码`);
        return json(res, 200, { success: true, data: { count: created.length, codes: created } });
      }
    }
    if (pathname === '/api/admin/redemption/update' && req.method === 'POST') {
      const u = requireUser(req, res); if (!u) return;
      if (!store.isAdmin(u)) return json(res, 403, { success: false, message: '需要管理员权限' });
      const b = await readJson(req) || {};
      store.setRedemptionStatus(db, parseInt(b.id || 0, 10), b.status);
      return json(res, 200, { success: true, message: '已更新' });
    }
    if (pathname === '/api/admin/redemption/delete' && req.method === 'POST') {
      const u = requireUser(req, res); if (!u) return;
      if (!store.isAdmin(u)) return json(res, 403, { success: false, message: '需要管理员权限' });
      const b = await readJson(req) || {};
      store.deleteRedemption(db, parseInt(b.id || 0, 10));
      return json(res, 200, { success: true, message: '已删除' });
    }
    if (pathname === '/api/settings') {
      if (req.method === 'GET') {
        const s = { ...store.getSettings(db) };
        return json(res, 200, { success: true, data: s });
      }
      const u = requireUser(req, res); if (!u) return;
      if (!store.isAdmin(u)) return json(res, 403, { success: false, message: '需要管理员权限' });
      const b = await readJson(req) || {};
      return json(res, 200, { success: true, data: store.setSettings(db, b) });
    }
    if (pathname === '/api/admin/stats') {
      const u = requireUser(req, res); if (!u) return;
      if (!store.isAdmin(u)) return json(res, 403, { success: false, message: '需要管理员权限' });
      return json(res, 200, { success: true, data: { ...store.systemStats(db), health: health.snapshot(), site: store.getSettings(db) } });
    }

    if (pathname === '/api/admin/user/list') {
      const u = requireUser(req, res); if (!u) return;
      if (!store.isAdmin(u)) return json(res, 403, { success: false, message: '需要管理员权限' });
      return json(res, 200, { success: true, data: store.listUsers(db) });
    }
    if (pathname === '/api/admin/user/update' && req.method === 'POST') {
      const u = requireUser(req, res); if (!u) return;
      if (!store.isAdmin(u)) return json(res, 403, { success: false, message: '需要管理员权限' });
      const b = await readJson(req) || {};
      const r = store.adminUpdateUser(db, parseInt(b.id || 0, 10), b);
      return json(res, 200, { success: true, data: r });
    }
    if (pathname === '/api/admin/stats') {
      const u = requireUser(req, res); if (!u) return;
      if (!store.isAdmin(u)) return json(res, 403, { success: false, message: '需要管理员权限' });
      return json(res, 200, { success: true, data: store.systemStats(db) });
    }

    if (pathname === '/api/health') return json(res, 200, { success: true, ts: Date.now(), site: store.getSetting(db, 'site_name') });
    if (pathname === '/api/status') return json(res, 200, { success: true, data: relay.status() });

    // ---------- 静态 ----------
    return serveStatic(req, res, pathname);
  } catch (e) {
    console.error('[error]', e);
    if (!res.headersSent) return json(res, 500, { success: false, message: '服务器内部错误: ' + e.message });
  }
});

// relay 需要的上下文（避免循环依赖）
function relayCtx() {
  return { db, store, billing, QUOTA_PER_USD, clientIp, json };
}
relay.init(relayCtx());   // 启动即注入，使 /api/status 在首次 /v1 请求前就可用

// ============ Handlers ============
async function handleRegister(req, res) {
  const b = await readJson(req);
  if (!b) return json(res, 400, { success: false, message: 'JSON 格式错误' });
  const username = String(b.username || '').trim();
  const password = String(b.password || '');
  if (!/^[a-zA-Z0-9_\u4e00-\u9fa5]{2,32}$/.test(username))
    return json(res, 400, { success: false, message: '用户名需 2-32 位（中文/字母/数字/下划线）' });
  if (password.length < 6) return json(res, 400, { success: false, message: '密码至少 6 位' });
  if (store.getUserByName(db, username)) return json(res, 409, { success: false, message: '用户名已存在' });

  // 首个注册用户自动成为管理员
  const isFirst = db.prepare('SELECT COUNT(*) c FROM users').get().c === 0;
  const signupQuota = parseInt(store.getSetting(db, 'signup_quota') || '0', 10);
  const u = await store.createUser(db, username, password, {
    quota: isFirst ? 5 * QUOTA_PER_USD : signupQuota,
    role: isFirst ? 100 : 1,
  });

  // 邀请绑定（通过邀请码）
  const aff = String(b.aff_code || b.inviter || '').trim();
  if (aff && !isFirst) {
    const inviter = store.userByAff(db, aff);
    if (inviter && inviter.id !== u.id) store.setInviter(db, u.id, inviter.id);
  }

  console.log(`[auth] 注册: ${username}${isFirst ? ' (管理员)' : ''}${aff ? ' 邀请码=' + aff : ''}`);
  return json(res, 200, { success: true, message: '注册成功', data: store.publicUser(db, store.getUserById(db, u.id)) });
}

async function handleLogin(req, res) {
  const b = await readJson(req);
  if (!b) return json(res, 400, { success: false, message: 'JSON 格式错误' });
  const username = String(b.username || '').trim();
  const password = String(b.password || '');
  const u = store.getUserByName(db, username);
  if (!u) return json(res, 401, { success: false, message: '用户名或密码错误' });
  if (!(await store.verifyPassword(password, u.salt, u.pass_hash)))
    return json(res, 401, { success: false, message: '用户名或密码错误' });
  if (u.status !== 1) return json(res, 403, { success: false, message: '账号已被禁用' });

  const sess = store.createSession(db, u.id, SESSION_TTL_MS);
  store.touchLogin(db, u.id, clientIp(req));
  console.log(`[auth] 登录: ${username}`);
  return json(res, 200, {
    success: true, message: '',
    data: { ...store.publicUser(db, u), token: sess },
  });
}

function handleLogout(req, res) {
  const t = tokenFromReq(req);
  if (t) store.deleteSession(db, t);
  return json(res, 200, { success: true, message: '' });
}

async function handleUserUpdate(req, res, u) {
  const b = await readJson(req) || {};
  let changed = [];

  // 改密码：必须验证旧密码
  if (b.password !== undefined && String(b.password) !== '') {
    const np = String(b.password);
    if (np.length < 6) return json(res, 400, { success: false, message: '新密码至少 6 位' });
    const oldpw = String(b.old_password || '');
    if (!oldpw) return json(res, 400, { success: false, message: '请输入当前密码' });
    if (!(await store.verifyPassword(oldpw, u.salt, u.pass_hash)))
      return json(res, 403, { success: false, message: '当前密码不正确' });
    await store.setPassword(db, u.id, np);
    changed.push('密码');
  }

  // 改昵称
  if (b.display_name !== undefined) {
    const dn = String(b.display_name).trim().slice(0, 32);
    if (!dn) return json(res, 400, { success: false, message: '昵称不能为空' });
    store.setDisplayName(db, u.id, dn);
    changed.push('昵称');
  }

  if (!changed.length) return json(res, 400, { success: false, message: '没有要修改的内容' });
  console.log(`[user] ${u.username} 修改了 ${changed.join('、')}`);
  return json(res, 200, { success: true, message: '已更新 ' + changed.join('、'), data: store.publicUser(db, store.getUserById(db, u.id)) });
}

async function handleTokenCreate(req, res, u) {
  const b = await readJson(req) || {};
  const t = store.createToken(db, u.id, {
    name: String(b.name || 'default').slice(0, 32),
    unlimited: b.unlimited_quota !== false,
    quota: parseInt(b.remain_quota || b.quota || 0, 10),
    modelLimits: String(b.model_limits || ''),
    allowIps: String(b.allow_ips || ''),
    expiredTime: parseInt(b.expired_time || -1, 10),
  });
  console.log(`[token] 新建: ${u.username} / ${t.name}`);
  return json(res, 200, { success: true, message: '', data: t });
}

async function handleTokenUpdate(req, res, u) {
  const b = await readJson(req) || {};
  const id = parseInt(b.id || 0, 10);
  const t = store.getToken(db, id);
  if (!t || t.user_id !== u.id) return json(res, 404, { success: false, message: '令牌不存在' });
  store.updateToken(db, id, b);
  return json(res, 200, { success: true, message: '已更新' });
}

async function handleTokenDelete(req, res, u) {
  const b = await readJson(req) || {};
  const id = parseInt(b.id || 0, 10);
  const t = store.getToken(db, id);
  if (!t || t.user_id !== u.id) return json(res, 404, { success: false, message: '令牌不存在' });
  store.deleteToken(db, id);
  return json(res, 200, { success: true, message: '已删除' });
}

function handleTokenReveal(res, u, id) {
  const t = store.getToken(db, id);
  if (!t || t.user_id !== u.id) return json(res, 404, { success: false, message: '令牌不存在' });
  return json(res, 200, { success: true, data: { id, key: 'sk-' + t.key_plain } });
}

// 探测上游渠道可用模型
// ============ 使用日志 Excel 导出（仿 SLCH usage-logs xlsx）============
function pad2(n) { return String(n).padStart(2, '0'); }
function fmtTs(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} `
    + `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}
function fmtYuan(quota) { return '¥' + (quota / QUOTA_PER_USD).toFixed(6); }
const TYPE_LABEL = { consume: '消费', recharge: '充值', reward: '返利', system: '系统', admin: '管理' };
function typeLabel(l) {
  if (l.log_type && TYPE_LABEL[l.log_type]) return TYPE_LABEL[l.log_type];
  return l.quota < 0 ? '返利' : '消费';
}

function exportUsageXlsx(res, { userId, since, all }) {
  const xlsx = require('./lib/xlsx');
  const rows = store.exportLogs(db, { userId, since });
  const summary = store.exportSummary(db, { userId, since });

  const detail = [
    ['时间', '类型', '用户', '用户ID', '令牌名称', '模型', '输入token数', '输出token数', '花费金额', '用时(秒)', '流式'],
  ];
  for (const l of rows) {
    detail.push([
      fmtTs(l.created_at),
      typeLabel(l),
      l.username,
      String(l.user_id),
      l.token_name || '',
      l.model_name || '',
      l.prompt_tokens, l.completion_tokens,
      fmtYuan(l.quota),
      Math.round(l.use_time || 0),
      l.is_stream ? '是' : '否',
    ]);
  }

  const sum = [
    ['用户', '用户ID', '令牌名称', '令牌ID', '模型', '请求次数', '输入token数', '输出token数', '总token数', '消费金额'],
  ];
  let tReq = 0, tIn = 0, tOut = 0, tTok = 0, tQ = 0;
  for (const s of summary) {
    sum.push([
      s.username, String(s.user_id), s.token_name || '-', String(s.token_id || ''),
      s.model_name, s.req_count, s.prompt_tokens, s.completion_tokens,
      s.total_tokens, fmtYuan(s.quota),
    ]);
    tReq += s.req_count; tIn += s.prompt_tokens; tOut += s.completion_tokens; tTok += s.total_tokens; tQ += s.quota;
  }
  sum.push(['合计', '', '', '', '', tReq, tIn, tOut, tTok, fmtYuan(tQ)]);

  const sheet1Name = all ? '全部明细' : '使用日志';
  const buf = xlsx.build([
    { name: sheet1Name, rows: detail, colWidths: [20, 8, 14, 9, 16, 24, 13, 13, 13, 10, 8], freezeHeader: true },
    { name: '按模型汇总', rows: sum, colWidths: [14, 9, 16, 9, 24, 10, 13, 13, 13, 13], freezeHeader: true },
  ]);

  const d = new Date();
  const stamp = `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}-${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}`;
  const fname = `${all ? 'all' : 'usage'}-logs-${stamp}.xlsx`;
  res.writeHead(200, {
    'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'Content-Disposition': `attachment; filename="${fname}"`,
    'Content-Length': buf.length,
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(buf);
  console.log(`[export] ${all ? 'ALL' : 'uid'} xlsx: ${rows.length} 条明细 / ${summary.length} 行汇总`);
}

async function handleChannelModels(res, b) {
  const base = String(b.base_url).replace(/\/+$/, '');
  const key = String(b.api_key || '');
  const url = base + '/models';
  try {
    const r = await fetch(url, {
      headers: key ? { Authorization: 'Bearer ' + key } : {},
      signal: AbortSignal.timeout(20000),
    });
    const j = await r.json();
    const ids = (j.data || j.models || []).map(m => m.id || m.name).filter(Boolean);
    return json(res, 200, { success: true, data: { count: ids.length, models: ids } });
  } catch (e) {
    return json(res, 502, { success: false, message: '探测失败: ' + e.message });
  }
}

// ============ 静态文件 ============
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
};
function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? '/index.html' : pathname;
  const filePath = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!filePath.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end('Forbidden'); }
  fs.readFile(filePath, (err, buf) => {
    if (err) {
      if (!path.extname(filePath)) {
        return fs.readFile(path.join(PUBLIC_DIR, 'index.html'), (e2, b2) => {
          if (e2) { res.writeHead(404); res.end('Not Found'); }
          else { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(b2); }
        });
      }
      res.writeHead(404); return res.end('Not Found');
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream' });
    res.end(buf);
  });
}

server.listen(PORT, HOST, () => {
  console.log(`\n⚡ 算力商城 · AI 模型聚合网关 已启动`);
  console.log(`   本机:   http://${HOST === '0.0.0.0' ? '127.0.0.1' : HOST}:${PORT}`);
  console.log(`   控制台: http://${HOST === '0.0.0.0' ? '127.0.0.1' : HOST}:${PORT}/`);
  console.log(`   API:    http://${HOST === '0.0.0.0' ? '127.0.0.1' : HOST}:${PORT}/v1`);
  console.log(`   数据库: ${DB_PATH}\n`);
});

process.on('SIGINT', () => { db.close(); process.exit(0); });
process.on('SIGTERM', () => { db.close(); process.exit(0); });

module.exports = { server, db };
