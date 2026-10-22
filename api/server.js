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
const zlib = require('node:zlib');
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
// 导出任务表（内存，重启即清空；文件保留在 logs/exports/）
const _exportJobs = new Map();
// 【2026-10-22】导出文件保存 24h 供断点续传（Range/If-Range），到期连文件带 job 记录一起清
const EXPORT_FILE_TTL_MS = 24 * 3600 * 1000;
setInterval(() => {
  const now = Date.now();
  for (const [k, j] of _exportJobs) {
    if (j.expireAt && now > j.expireAt) {
      if (j.file) { fs.unlink(j.file, () => {}); }
      _exportJobs.delete(k);
    }
  }
  // 【2026-10-22】migrate 落盘包同步清理（用 mtime 判 24h）
  try {
    const migDir = path.join(__dirname, 'logs', 'migrate');
    if (fs.existsSync(migDir)) for (const f of fs.readdirSync(migDir)) {
      const fp = path.join(migDir, f);
      if (now - fs.statSync(fp).mtimeMs > EXPORT_FILE_TTL_MS) fs.unlink(fp, () => {});
    }
  } catch {}
}, 10 * 60 * 1000).unref();
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
  // 【诊断 2026-10-21】事件循环延迟采样（setInterval 偏差法，正确）+ 周期性快照
  // 原理：setInterval(100ms) 每 100ms 触发一次，若事件循环被阻塞 N ms，
  // 实际间隔 = 100 + N，偏差 = 实际间隔 - 100 就是卡顿时长。
  if (!global.__elDiag) {
    global.__elDiag = { maxLag: 0, maxLagAt: 0, activeReqs: 0, sampleCount: 0, lastSample: Date.now(), lagHistory: [], _lastTick: Date.now() };
    const TICK = 100;
    const tick = () => {
      const d = global.__elDiag;
      const now = Date.now();
      const lagMs = Math.max(0, now - d._lastTick - TICK); // 实际间隔 - 期望间隔 = 卡顿
      d._lastTick = now;
      d.sampleCount++;
      if (lagMs > 20) { // 只记录 >20ms 的卡顿（过滤正常抖动）
        d.lagHistory.push({ t: new Date().toISOString().slice(11, 19), lag: Math.round(lagMs) });
        if (d.lagHistory.length > 200) d.lagHistory.shift();
        if (lagMs > d.maxLag) { d.maxLag = lagMs; d.maxLagAt = new Date().toISOString(); }
      }
      d.lastSample = now;
      if (lagMs > 3000) console.error(`[diag] ⚠️ 事件循环卡顿 ${Math.round(lagMs)}ms @ ${new Date().toISOString().slice(11,19)}`);
    };
    const _iv = setInterval(tick, TICK);
    _iv.unref?.();
    // 每 60s 输出快照到日志（含最近 lag 趋势 + 内存 + 活跃请求 + 导出job）
    setInterval(() => {
      const d = global.__elDiag;
      const recent = d.lagHistory.slice(-6).map(x => `${x.t}:${x.lag}`).join(' ');
      const jobs = [..._exportJobs.entries()].filter(([, j]) => j.status === 'running').length;
      const rss = Math.round(process.memoryUsage().rss / 1048576);
      console.log(`[diag] snapshot lag_max=${Math.round(d.maxLag)}ms active=${d.activeReqs} mem=${rss}MB running_jobs=${jobs} recent=[${recent}]`);
    }, 60000).unref();
    server.on('request', () => { global.__elDiag.activeReqs++; });
    server.on('request', (req, res) => {
      const done = () => { if (global.__elDiag) global.__elDiag.activeReqs = Math.max(0, global.__elDiag.activeReqs - 1); };
      res.on('finish', done);
      res.on('close', done);
    });
  }
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

    // ---------- 诊断端点（无需登录） ----------
    if (pathname === '/api/diag' && req.method === 'GET') {
      const d = global.__elDiag || {};
      return json(res, 200, {
        uptime_sec: Math.round(process.uptime()),
        event_loop_max_lag_ms: Math.round(d.maxLag || 0),
        event_loop_max_lag_at: d.maxLagAt || null,
        event_loop_samples: d.sampleCount || 0,
        active_requests: d.activeReqs || 0,
        export_jobs: [..._exportJobs.entries()].map(([k, j]) => ({ job: k, status: j.status, progress: j.progress || null })),
        lag_history: (d.lagHistory || []).slice(-30),
        memory_mb: Math.round(process.memoryUsage().rss / 1048576),
        time: new Date().toISOString(),
      });
    }

    // ---------- OpenAI 兼容中继（核心） ----------
    if (pathname.startsWith('/v1/')) {
      return await relay.handle(relayCtx(), req, res, pathname, query);
    }

    // ---------- 用户认证 ----------
    if (pathname === '/api/user/register' && req.method === 'POST') return await handleRegister(req, res);
    if (pathname === '/api/user/login' && req.method === 'POST') return await handleLogin(req, res);
    if (pathname === '/api/user/logout') return handleLogout(req, res);
    // 身份切换（左下角）：免密切到下级/自己；切到上级需上级密码；admin 可切任何人
    if (pathname === '/api/user/impersonate' && req.method === 'POST') {
      const u = requireUser(req, res); if (!u) return;
      const b = await readJson(req) || {};
      const targetRaw = String(b.target || 'me');
      const sess = store.getSession(db, tokenFromReq(req));
      const originId = sess && sess.origin_id ? sess.origin_id : u.id;  // 原始登录身份
      const origin = store.getUserById(db, originId) || u;

      if (targetRaw === 'me') {
        const t = store.createSession(db, origin.id, SESSION_TTL_MS, { origin_id: origin.id, switch_depth: 0 });
        return json(res, 200, { success: true, message: '已返回本人', data: { token: t, user: store.publicUser(db, origin) } });
      }
      const tid = parseInt(targetRaw, 10);
      if (!tid) return json(res, 400, { success: false, message: '无效的目标用户' });
      const target = store.getUserById(db, tid);
      if (!target) return json(res, 404, { success: false, message: '目标用户不存在' });
      if (target.status !== 1) return json(res, 403, { success: false, message: '目标账号已禁用' });

      // 权限判定（基于原始登录身份 origin，而非当前已切换身份，避免套娃）
      const down = store.listDownline(db, origin.id, { maxDepth: 20 }).map(d => d.id);
      const up = store.getUpline(db, origin.id, 3).map(d => d.id);
      const isAdminUser = store.isAdmin(origin);
      let allowed = false, needPw = false;
      if (isAdminUser) allowed = true;                    // 管理员免密切换任何人
      else if (tid === origin.id) allowed = true;          // 自己
      else if (down.includes(tid)) allowed = true;         // 下级（含 L1/L2/L3）免密
      else if (up.includes(tid)) { allowed = true; needPw = true; }  // 上级需密码

      if (!allowed) return json(res, 403, { success: false, message: '只能切换到自己的下级或上级' });

      if (needPw) {
        const pw = String(b.password || '');
        if (!pw || !(await store.verifyPassword(pw, target.salt, target.pass_hash)))
          return json(res, 401, { success: false, message: '切换到上级需要该上级的密码' });
      }
      const t = store.createSession(db, target.id, SESSION_TTL_MS, { origin_id: origin.id, switch_depth: (sess && sess.switch_depth || 0) + 1 });
      console.log(`[impersonate] ${origin.username} -> ${target.username}${needPw ? ' (需密码)' : ''}`);
      return json(res, 200, { success: true, message: '', data: { token: t, user: store.publicUser(db, target) } });
    }

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
      store.addLedger(db, {
        user_id: u.id, delta: r.quota, kind: 'redeem',
        detail: `兑换码充值 +$${(r.quota / 500000).toFixed(4)}`,
        op_user_id: u.id, op_username: u.username, op_role: '用户', ip: clientIp(req),
        request_id: 'redeem:' + code + '-' + Date.now(), remark: code,
      });
      console.log(`[topup] ${u.username} 兑换 ${r.quota} quota`);
      return json(res, 200, { success: true, message: '兑换成功', data: store.publicUser(db, r.user) });
    }
    if (pathname === '/api/user/checkin') {
      const u = requireUser(req, res); if (!u) return;
      if (req.method === 'GET') return json(res, 200, { success: true, data: store.checkinStatus(db, u) });
      const quota = parseInt(store.getSetting(db, 'checkin_quota') || '0', 10);
      const r = store.doCheckin(db, u, quota);
      if (!r.ok) return json(res, 400, { success: false, message: r.message });
      store.addLedger(db, {
        user_id: u.id, delta: quota, kind: 'checkin',
        detail: `每日签到 +$${(quota / 500000).toFixed(4)}`,
        op_user_id: u.id, op_username: u.username, op_role: '用户', ip: clientIp(req),
        request_id: 'checkin:' + u.id + '-' + Date.now(),
      });
      return json(res, 200, { success: true, message: `签到成功，获得 ${quota} quota`, data: store.publicUser(db, r.user) });
    }
    // 可切换身份列表：自己 + 下级(免密) + 上级(需密)
    if (pathname === '/api/user/switchable' && req.method === 'GET') {
      const u = requireUser(req, res); if (!u) return;
      const sess = store.getSession(db, tokenFromReq(req));
      const originId = sess && sess.origin_id ? sess.origin_id : u.id;
      const origin = store.getUserById(db, originId) || u;
      const down = store.listDownline(db, origin.id, { maxDepth: 5 }).map(d => ({ id: d.id, username: d.username, depth: d.depth, agent_level: d.agent_level, agent_name: d.agent_name }));
      const up = store.getUpline(db, origin.id, 3).map((p, i) => ({ id: p.id, username: p.username, depth: -(i + 1), agent_level: p.agent_level, agent_name: p.agent_name }));
      const isAdminUser = store.isAdmin(origin);
      // 管理员：列出平台全部用户（除自己），可直达任意人
      let all = [];
      if (isAdminUser) {
        all = db.prepare('SELECT id,username,display_name,agent_level,agent_name,role,status FROM users WHERE id != ? ORDER BY id').all(origin.id)
          .map(x => ({ id: x.id, username: x.username, agent_level: x.agent_level, agent_name: x.agent_name, role: x.role, status: x.status }));
      }
      return json(res, 200, {
        success: true,
        data: {
          current: { id: u.id, username: u.username },
          origin: { id: origin.id, username: origin.username },
          is_admin: isAdminUser,
          downline: down,
          upline: up,
          all,
        },
      });
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
          reward_l2: parseFloat(store.getSetting(db, 'agent_reward_l2') || '0'),
          reward_l3: parseFloat(store.getSetting(db, 'agent_reward_l3') || '0'),
          team: store.teamStats(db, u.id),
          upline: store.getUpline(db, u.id, 3).map(p => ({ id: p.id, username: p.username, agent_level: p.agent_level })),
          site_name: store.getSetting(db, 'site_name'),
        },
      });
    }

    // ---------- 多层级代理 ----------
    // 我的团队（含整棵下级树 + 各级统计）
    if (pathname === '/api/agent/team') {
      const u = requireUser(req, res); if (!u) return;
      return json(res, 200, {
        success: true,
        data: {
          me: { id: u.id, username: u.username, agent_level: u.agent_level, agent_name: u.agent_name, quota: u.quota, used_quota: u.used_quota, request_count: u.request_count, status: u.status },
          stats: store.teamStats(db, u.id),
          downline: store.listDownline(db, u.id, { maxDepth: 5 }),
          subtree: store.subtreeOf(db, u.id, 5),   // 以我为首的嵌套树
          upline: store.getUpline(db, u.id, 3).map(p => ({ id: p.id, username: p.username, agent_level: p.agent_level, agent_name: p.agent_name })),
        },
      });
    }
    // 管理员：全平台代理树 / 设置某用户上级与等级
    if (pathname === '/api/admin/agent/tree' && req.method === 'GET') {
      const u = requireUser(req, res); if (!u) return;
      if (!store.isAdmin(u)) return json(res, 403, { success: false, message: '需要管理员权限' });
      // 根节点 = 无上级的用户
      const roots = db.prepare('SELECT id,username,agent_level,agent_name,quota,used_quota,status,role,remark,inviter_id FROM users WHERE inviter_id=0 ORDER BY id').all();
      const build = (n) => {
        const kids = db.prepare('SELECT id,username,agent_level,agent_name,quota,used_quota,status,role,remark,inviter_id FROM users WHERE inviter_id=? ORDER BY id').all(n.id);
        return { ...n, children: kids.map(build) };
      };
      return json(res, 200, { success: true, data: roots.map(build) });
    }
    if (pathname === '/api/admin/agent/set' && req.method === 'POST') {
      const u = requireUser(req, res); if (!u) return;
      if (!store.isAdmin(u)) return json(res, 403, { success: false, message: '需要管理员权限' });
      const b = await readJson(req) || {};
      const uid = parseInt(b.user_id || 0, 10);
      if (!uid) return json(res, 400, { success: false, message: '缺少 user_id' });
      const before = store.getUserById(db, uid);
      if (!before) return json(res, 404, { success: false, message: '用户不存在' });
      if (b.inviter_id !== undefined) {
        const r = store.setInviterSafe(db, uid, parseInt(b.inviter_id || 0, 10));
        if (!r.ok) return json(res, 400, { success: false, message: r.message });
      }
      if (b.agent_level !== undefined || b.agent_name !== undefined || b.agent_channel_id !== undefined) {
        store.setAgentInfo(db, uid, { agent_level: b.agent_level, agent_name: b.agent_name, agent_channel_id: b.agent_channel_id });
      }
      const after = store.getUserById(db, uid);
      // 审计
      if (before.inviter_id !== after.inviter_id || before.agent_level !== after.agent_level || before.agent_name !== after.agent_name || (before.agent_channel_id || 0) !== (after.agent_channel_id || 0)) {
        const oi = before.inviter_id ? store.getUserById(db, before.inviter_id) : null;
        const ni = after.inviter_id ? store.getUserById(db, after.inviter_id) : null;
        store.addAgentAudit(db, {
          target_user_id: uid, target_name: after.username,
          old_inviter_id: before.inviter_id, old_inviter: oi ? oi.username : '平台直营',
          new_inviter_id: after.inviter_id, new_inviter: ni ? ni.username : '平台直营',
          action: 'admin-set', level_before: before.agent_level, level_after: after.agent_level, agent_name: after.agent_name,
          op_user_id: u.id, op_username: u.username, op_role: '管理员', ip: clientIp(req),
        });
      }
      console.log(`[agent] ${u.username} 设置 uid=${uid} inviter=${b.inviter_id ?? '-'} level=${b.agent_level ?? '-'} channel=${b.agent_channel_id ?? '-'}`);
      return json(res, 200, { success: true, data: store.publicUser(db, after) });
    }

    // 代理自助：改自己「下1级用户」的归属（admin 可改任何人）
    // POST /api/agent/reassign { user_id, inviter_id }
    if (pathname === '/api/agent/reassign' && req.method === 'POST') {
      const u = requireUser(req, res); if (!u) return;
      const b = await readJson(req) || {};
      const uid = parseInt(b.user_id || 0, 10);
      const newInviter = parseInt(b.inviter_id || 0, 10);
      if (!uid) return json(res, 400, { success: false, message: '缺少 user_id' });
      const target = store.getUserById(db, uid);
      if (!target) return json(res, 404, { success: false, message: '用户不存在' });
      const isAdminUser = store.isAdmin(u);
      // 非管理员：只能动「自己的直属下级」（target.inviter_id === 自己）
      if (!isAdminUser && target.inviter_id !== u.id) {
        return json(res, 403, { success: false, message: '只能调整自己的直属下级' });
      }
      // 非管理员：新上级必须是自己或自己的下级（不能把下1级挂到自己上面/体系外）
      if (!isAdminUser) {
        const ownDown = store.listDownline(db, u.id, { maxDepth: 20 }).map(d => d.id);
        if (newInviter !== u.id && !ownDown.includes(newInviter)) {
          return json(res, 403, { success: false, message: '只能在自己团队内部调整（可挂到自己或自己的下级）' });
        }
      }
      const r = store.setInviterSafe(db, uid, newInviter);
      if (!r.ok) return json(res, 400, { success: false, message: r.message });
      const oi = target.inviter_id ? store.getUserById(db, target.inviter_id) : null;
      const ni = newInviter ? store.getUserById(db, newInviter) : null;
      store.addAgentAudit(db, {
        target_user_id: uid, target_name: target.username,
        old_inviter_id: target.inviter_id, old_inviter: oi ? oi.username : '平台直营',
        new_inviter_id: newInviter, new_inviter: ni ? ni.username : '平台直营',
        action: 'agent-reassign', level_before: target.agent_level, level_after: target.agent_level, agent_name: target.agent_name,
        op_user_id: u.id, op_username: u.username, op_role: store.isAdmin(u) ? '管理员' : '代理', ip: clientIp(req),
      });
      console.log(`[agent] ${u.username} 调整 uid=${uid} 归属 -> inviter=${newInviter}`);
      return json(res, 200, { success: true, data: store.publicUser(db, store.getUserById(db, uid)) });
    }

    // 代理结算：导出每个代理的团队结算（自身 + 全下级消费 + 返佣）
    // GET /api/admin/agent/settle  (管理员)
    if (pathname === '/api/admin/agent/settle' && req.method === 'GET') {
      const u = requireUser(req, res); if (!u) return;
      if (!store.isAdmin(u)) return json(res, 403, { success: false, message: '需要管理员权限' });
      const days = Math.min(parseInt(query.get('days') || '0', 10), 3650);
      const since = parseInt(query.get('from') || '0', 10) || (days > 0 ? Date.now() - days * 86400000 : 0);
      const until = parseInt(query.get('until') || '0', 10) || 0;
      return exportAgentSettleXlsx(res, { since, until });
    }

    // 归属变更审计日志
    // GET /api/agent/audit?user=<id>&limit=N  （管理员看全部；普通用户看自己相关）
    if (pathname === '/api/agent/audit' && req.method === 'GET') {
      const u = requireUser(req, res); if (!u) return;
      const limit = Math.min(parseInt(query.get('limit') || '200', 10), 500);
      if (store.isAdmin(u)) {
        const target = parseInt(query.get('user') || '0', 10);
        return json(res, 200, { success: true, data: store.listAgentAudit(db, { targetUserId: target, limit }) });
      }
      // 普通用户：只看自己（作为被调整对象）的记录
      return json(res, 200, { success: true, data: store.listAgentAudit(db, { targetUserId: u.id, limit }) });
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
    // 按月导出: /api/log/export?user=all&since=2026-09&until=2026-10  （管理员，until 为开区间下月首日）
    if (pathname === '/api/log/export') {
      const u = requireUser(req, res); if (!u) return;
      const isAdmin = store.isAdmin(u);
      const all = query.get('all') === '1' && isAdmin;
      let userId = all ? null : u.id;
      // 管理员 ?user=<id|name> 指定用户导出
      const userArg = query.get('user');
      if (isAdmin && userArg && userArg !== 'all' && userArg !== 'me') {
        const t = store.getUserByName(db, userArg) || (parseInt(userArg, 10) > 0 ? store.getUserById(db, parseInt(userArg, 10)) : null);
        if (!t) return json(res, 404, { success: false, message: '用户不存在: ' + userArg });
        userId = t.id;
      }
      // 时间窗: 优先 from/until（毫秒时间戳，与 /api/settle/export 统一），
      // 再退 since（YYYY-MM-DD / YYYY-MM），最后 days，都没有=全量。
      // 【2026-10-21】旧版只认 since，前端/其它调用方传 from（毫秒）直接被忽略 → 永远导全量。
      let since = 0, until = 0;
      const parseDay = (s) => {
        const m = String(s).match(/^(\d{4})-(\d{2})(?:-(\d{2}))?/);
        if (!m) return NaN;
        return Date.UTC(+m[1], +m[2] - 1, m[3] ? +m[3] : 1);
      };
      // 同一个参数名兼容两种写法：纯数字 = 毫秒时间戳；含 '-' = YYYY-MM-DD / YYYY-MM
      const asMs = (v) => {
        if (v == null || v === '') return null;
        const str = String(v).trim();
        if (/^\d{10,}$/.test(str)) return parseInt(str, 10);   // 毫秒
        if (str.includes('-')) {                               // 日期
          const d = parseDay(str);
          return isNaN(d) ? NaN : d;
        }
        return null;
      };
      const fromV = asMs(query.get('from')), sinceV = asMs(query.get('since'));
      const untilV = asMs(query.get('until'));
      if (fromV != null || sinceV != null || untilV != null) {
        const bad = [fromV, sinceV, untilV].some(v => v != null && Number.isNaN(v));
        if (bad) return json(res, 400, { success: false, message: 'from/since/until 格式错误，支持毫秒时间戳或 YYYY-MM-DD / YYYY-MM' });
        since = fromV != null ? fromV : (sinceV != null ? sinceV : 0);
        until = untilV != null ? untilV : 0;
        // 日期形式的 until 是「当天 0 点」，需要 -1ms 变闭区间；毫秒形式由调用方自己给准确值
        if (until && String(query.get('until')).includes('-')) until = until - 1;
      } else {
        const days = Math.min(parseInt(query.get('days') || '0', 10), 3650);
        if (days > 0) since = Date.now() - days * 86400000;
      }
      const limit = Math.min(parseInt(query.get('limit') || '0', 10) || 500000, 2000000); // 明细行数硬上限，防全站冻结/OOM
      return exportUsageXlsx(res, { userId, since, until, all, admin: isAdmin, limit });
    }
    // 导出任务状态/下载（异步导出模式）
    if (pathname === '/api/log/export/job') {
      const u = requireUser(req, res); if (!u) return;
      const j = _exportJobs.get(query.get('job') || '');
      if (!j) return json(res, 404, { success: false, message: '任务不存在或已过期' });
      // 【2026-10-21】meta=1 只查状态不下载。前端轮询必须用这个，否则 done 时接口返回二进制，
      // 前端 sr.json() 解析失败 → 一直卡在「正在生成… 已用 Ns」永不结束。
      if (query.get('meta') === '1') {
        return json(res, 200, {
          success: true, status: j.status, started: j.started,
          progress: j.progress || null, fname: j.fname || '',
          size: j.size || 0, error: j.error || null,
        });
      }
      // 【2026-10-21】补 progress：前端据此画进度条，之前漏传导致界面永远停在“提交中 0s”
      if (j.status === 'running') return json(res, 200, { success: true, status: 'running', started: j.started, progress: j.progress || null, fname: j.fname || '' });
      if (j.status === 'error') return json(res, 200, { success: true, status: 'error', error: j.error });
      // done → 下载文件
      // 【修复 2026-10-21】文件名含中文直接塞 header 会抛 ERR_INVALID_CHAR（下载 500），
      // 必须用 RFC 5987 的 filename*=UTF-8'' 形式 + ASCII 降级名。
      const asciiName = String(j.fname || 'export.xlsx').replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
      const disposition = `attachment; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(String(j.fname || 'export.xlsx'))}`;
      // 【2026-10-22】断点续传：支持 Range 请求（Accept-Ranges: bytes）。
      // 浏览器/中断恢复可以请求 Range: bytes=N- 从断点继续，不必重新生成。
      // 文件保留策略升级：从「下载完 1h 后删」改为「生成后 24h 内可断点续传，最后下载完 1h 后删」。
      const rangeHdr = req.headers['range'];
      if (rangeHdr) {
        const m = String(rangeHdr).match(/^bytes=(\d+)-(\d*)$/);
        if (m) {
          const start = parseInt(m[1], 10);
          const end = m[2] ? Math.min(parseInt(m[2], 10), j.size - 1) : j.size - 1;
          if (start >= j.size || start > end) {
            // 超范围：告知完整大小
            res.writeHead(416, { 'Content-Range': `bytes */${j.size}`, 'Cache-Control': 'no-store' });
            return res.end();
          }
          res.writeHead(206, {
            'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            'Content-Disposition': disposition,
            'Content-Range': `bytes ${start}-${end}/${j.size}`,
            'Content-Length': end - start + 1,
            'Accept-Ranges': 'bytes',
            'Cache-Control': 'no-store',
          });
          console.log(`[export] 续传 job=${query.get('job')} bytes=${start}-${end}/${j.size}`);
          const st2 = fs.createReadStream(j.file, { start, end });
          st2.on('error', (e) => { try { res.destroy(); } catch {} });
          st2.pipe(res);
          res.on('close', () => { setTimeout(() => { fs.unlink(j.file, () => {}); }, 3600000); });
          return;
        }
      }
      res.writeHead(200, {
        'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': disposition,
        'Content-Length': j.size,
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'no-store',
      });
      const st = fs.createReadStream(j.file);
      st.on('error', (e) => { if (!res.headersSent) json(res, 500, { success: false, message: e.message }); else res.destroy(); });
      st.pipe(res);
      res.on('close', () => { // 下载完成/中断后延迟清理文件（文件保留 24h 供续传）
        setTimeout(() => { fs.unlink(j.file, () => {}); }, 3600000);
      });
      return;
    }
    if (pathname === '/api/log/export/jobs') {
      const u = requireUser(req, res); if (!u) return;
      const list = [];
      for (const [k, j] of _exportJobs) list.push({ job: k, ...j, size: j.file ? (j.size || 0) : 0 });
      list.sort((a, b) => b.started - a.started);
      return json(res, 200, { success: true, data: list.slice(0, 20) });
    }

    // 结算清单导出（xlsx，管理员：全部或指定用户；普通用户：自己）
    // GET /api/settle/export?user=all|<id>|me  [&days=N]
    if (pathname === '/api/settle/export') {
      const u = requireUser(req, res); if (!u) return;
      const isAdminUser = store.isAdmin(u);
      let target = String(query.get('user') || (isAdminUser ? 'all' : 'me'));
      if (!isAdminUser) target = 'me';               // 非管理员只能导自己
      if (target === 'me') target = String(u.id);
      if (target !== 'all') {
        const uid = parseInt(target, 10);
        if (!uid) return json(res, 400, { success: false, message: '参数 user 需为 all / me / 用户ID' });
        if (uid !== u.id && !isAdminUser) return json(res, 403, { success: false, message: '无权导出其他用户' });
        target = String(uid);
      }
      const days = Math.min(parseInt(query.get('days') || '0', 10), 3650);
      const since = days > 0 ? Date.now() - days * 86400000 : 0;
      const fromQ = parseInt(query.get('from') || '0', 10);
      const untilQ = parseInt(query.get('until') || '0', 10);
      const range = {
        since: fromQ || since,
        until: untilQ || 0,
      };
      // 明细上限: 防超大用户 OOM(>50万行自动截断, 汇总表不受影响)
      const limit = Math.min(parseInt(query.get('limit') || '0', 10) || 500000, 2000000);
      return exportSettleXlsx(res, { target, since: range.since, until: range.until, limit });
    }

    // ---------- 模型 / 渠道（对外目录：不含密钥） ----------
    if (pathname === '/api/models') {
      return json(res, 200, { success: true, data: store.publicModelCatalog(db) });
    }
    if (pathname === '/api/pricing') {
      // 模型目录：渠道聚合出的在售模型 + billing 真实价（未定价的标 priced=false，走 default）
      const list = store.pricingCatalog(db).map(x => {
        const p = billing.priceOf(x.model);
        return { ...x, input: p.input, output: p.output, cached: p.cached, peak: p.peak,
                 peak_now: billing.peakMultiplier(x.model), priced: billing.isPriced(x.model) };
      });
      // 未定价告警：在售但走 default 的模型（静默亏损风险）
      const unpriced = list.filter(x => !x.priced).map(x => x.model);
      return json(res, 200, { success: true, data: list, default: billing.DEFAULT,
        alert: { unpriced_count: unpriced.length, unpriced, default: billing.DEFAULT } });
    }
    // 改价（仅管理员）：{model, input, output, cached?, peak?} → 落盘 pricing.json + 热重载
    if (pathname === '/api/pricing/update' && req.method === 'POST') {
      const u = requireUser(req, res); if (!u) return;
      if (!store.isAdmin(u)) return json(res, 403, { success: false, message: '需要管理员权限' });
      const b = await readJson(req) || {};
      const r = billing.setPrice(b.model, b.input, b.output, b.cached, b.peak);
      if (!r.ok) return json(res, 400, { success: false, message: r.error });
      const pk = r.peak ? `（高峰 ${r.peak.windows.map(w => w.join('-')).join('/')} ×${r.peak.multiplier}）` : '';
      return json(res, 200, { success: true, data: r, message: `已定价 ${r.model}: 输入 $${r.input} / 补全 $${r.output} / 缓存 $${r.cached}${pk} 每 M tokens` });
    }
    // 删除定价（仅管理员）：回落 default 价
    if (pathname === '/api/pricing/delete' && req.method === 'POST') {
      const u = requireUser(req, res); if (!u) return;
      if (!store.isAdmin(u)) return json(res, 403, { success: false, message: '需要管理员权限' });
      const b = await readJson(req) || {};
      const r = billing.deletePrice(b.model);
      if (!r.ok) return json(res, 400, { success: false, message: r.error });
      return json(res, 200, { success: true, message: `已删除 ${r.model} 的定价，回落默认价` });
    }
    // 全量价格表（仅管理员）：含未上架但有定价的模型
    if (pathname === '/api/pricing/all') {
      const u = requireUser(req, res); if (!u) return;
      if (!store.isAdmin(u)) return json(res, 403, { success: false, message: '需要管理员权限' });
      return json(res, 200, { success: true, data: billing.allPrices(), default: billing.DEFAULT });
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
    // 探测上游模型：
    //   {base_url, api_key}  → 纯探测，不落库（新建/编辑弹窗里回填用）
    //   {id, persist?}       → 用渠道已存 key 探测，并把结果覆盖写入该渠道 models
    if (pathname === '/api/channel/models' && req.method === 'POST') {
      const u = requireUser(req, res); if (!u) return;
      const b = await readJson(req) || {};
      if (b.id) {
        if (!store.isAdmin(u)) return json(res, 403, { success: false, message: '需要管理员权限' });
        const c = store.getChannel(db, parseInt(b.id, 10));
        if (!c) return json(res, 404, { success: false, message: '渠道不存在' });
        const r = await probeUpstreamModels(c.base_url, c.api_key);
        if (!r.ok) return json(res, 502, { success: false, message: '探测失败: ' + r.error });
        if (b.persist !== false) {
          const ms = [...new Set(r.models.map(x => String(x).trim()).filter(Boolean))].sort();
          store.updateChannel(db, c.id, { models: ms });
          store.touchChannel(db, c.id);
          r.models = ms; r.count = ms.length;
        }
        return json(res, 200, { success: true, data: r, message: `已同步 ${r.count} 个模型` });
      }
      if (!b.base_url) return json(res, 400, { success: false, message: '缺少 base_url' });
      return await handleChannelModels(res, b);
    }

    // ---------- 管理：用户 / 兑换码 / 设置 ----------
    // 代理给下级划转额度（从自己余额）：POST /api/agent/transfer {user_id, amount}
    if (pathname === '/api/agent/transfer' && req.method === 'POST') {
      const u = requireUser(req, res); if (!u) return;
      const b = await readJson(req) || {};
      const tid = parseInt(b.user_id || 0, 10);
      const amount = parseInt(b.amount || 0, 10);   // quota 单位
      if (!tid) return json(res, 400, { success: false, message: '缺少 user_id' });
      if (amount <= 0) return json(res, 400, { success: false, message: '划转额度必须大于 0' });
      const target = store.getUserById(db, tid);
      if (!target) return json(res, 404, { success: false, message: '目标用户不存在' });
      // 非管理员：只能给自己的下级划转
      const isAdminUser = store.isAdmin(u);
      if (!isAdminUser) {
        const down = store.listDownline(db, u.id, { maxDepth: 20 }).map(d => d.id);
        if (!down.includes(tid)) return json(res, 403, { success: false, message: '只能给自己的下级划转额度' });
      }
      const r = store.transferQuota(db, u.id, tid, amount);
      if (!r.ok) return json(res, 400, { success: false, message: r.message });
      // 双边流水留痕
      const rid = 'transfer:' + u.id + '-' + Date.now();
      store.addLedger(db, {
        user_id: u.id, delta: -amount, kind: 'transfer_out',
        detail: `划转给 ${target.username} -$${(amount / 500000).toFixed(4)}`,
        ref_user_id: tid, ref_username: target.username,
        op_user_id: u.id, op_username: u.username, op_role: isAdminUser ? '管理员' : '代理', ip: clientIp(req), request_id: rid,
      });
      store.addLedger(db, {
        user_id: tid, delta: amount, kind: 'transfer_in',
        detail: `来自 ${u.username} 划转 +$${(amount / 500000).toFixed(4)}`,
        ref_user_id: u.id, ref_username: u.username,
        op_user_id: u.id, op_username: u.username, op_role: isAdminUser ? '管理员' : '代理', ip: clientIp(req), request_id: rid,
      });
      // 记流水（充值类型）
      store.insertLog(db, {
        user_id: tid, username: target.username, token_id: 0, token_name: '代理划转',
        model_name: '', channel_id: 0, channel_name: '', quota: amount,
        status: 'success', log_type: 'recharge', source: 'agent-transfer',
        request_id: rid,
      });
      // 审计
      store.addAgentAudit(db, {
        target_user_id: tid, target_name: target.username,
        old_inviter_id: target.inviter_id, old_inviter: '—',
        new_inviter_id: target.inviter_id, new_inviter: '—',
        action: 'transfer', agent_name: '$' + (amount / 500000).toFixed(4),
        op_user_id: u.id, op_username: u.username, op_role: isAdminUser ? '管理员' : '代理', ip: clientIp(req),
      });
      console.log(`[agent] ${u.username} 给 ${target.username} 划转 quota=${amount}`);
      return json(res, 200, { success: true, message: `已给 ${target.username} 划转 $${(amount / 500000).toFixed(4)}`, data: { from: store.publicUser(db, r.from), to: store.publicUser(db, r.to) } });
    }

    // 钱包流水（资金账单）：GET /api/ledger?user=<id>&kind=&limit=N
    // 管理员看全部/可筛用户；普通用户只能看自己
    if (pathname === '/api/ledger' && req.method === 'GET') {
      const u = requireUser(req, res); if (!u) return;
      const limit = Math.min(parseInt(query.get('limit') || '200', 10), 1000);
      const kind = String(query.get('kind') || '');
      const days = parseInt(query.get('days') || '0', 10);
      const since = days > 0 ? Date.now() - days * 86400000 : 0;
      if (store.isAdmin(u)) {
        const target = parseInt(query.get('user') || '0', 10);
        return json(res, 200, { success: true, data: store.listLedger(db, { userId: target, kind, limit, since }) });
      }
      return json(res, 200, { success: true, data: store.listLedger(db, { userId: u.id, kind, limit, since }) });
    }

    // 批量建用户（管理员）POST /api/admin/user/bulk
    if (pathname === '/api/admin/user/bulk' && req.method === 'POST') {
      const u = requireUser(req, res); if (!u) return;
      if (!store.isAdmin(u)) return json(res, 403, { success: false, message: '需要管理员权限' });
      const b = await readJson(req) || {};
      const created = await store.bulkCreateUsers(db, {
        prefix: b.prefix || 'user', count: b.count || 1,
        password: b.password || '123456', quota: b.quota || 0,
        startIndex: b.startIndex, digits: b.digits || 4,
        inviter_id: b.inviter_id || 0, agent_name: b.agent_name || '',
      });
      console.log(`[admin] ${u.username} 批量建 ${created.length} 个用户 (前缀 ${b.prefix || 'user'}${b.inviter_id ? ', 挂到代理 ' + b.inviter_id : ''})`);
      return json(res, 200, { success: true, message: `已创建 ${created.length} 个用户`, data: created });
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
    // 【2026-10-21】/api/admin/stats 已合并到下方主实现（含 ops 运营面板），此处删除重复路由


    if (pathname === '/api/admin/user/list') {
      const u = requireUser(req, res); if (!u) return;
      if (!store.isAdmin(u)) return json(res, 403, { success: false, message: '需要管理员权限' });
      return json(res, 200, { success: true, data: store.listUsers(db) });
    }
    if (pathname === '/api/admin/user/update' && req.method === 'POST') {
      const u = requireUser(req, res); if (!u) return;
      if (!store.isAdmin(u)) return json(res, 403, { success: false, message: '需要管理员权限' });
      const b = await readJson(req) || {};
      const uid = parseInt(b.id || 0, 10);
      const before = store.getUserById(db, uid);
      if (!before) return json(res, 404, { success: false, message: '用户不存在' });
      const r = store.adminUpdateUser(db, uid, b);
      const after = store.getUserById(db, uid);
      if (after.quota !== before.quota) {
        const delta = after.quota - before.quota;
        store.addLedger(db, {
          user_id: uid, delta, kind: delta >= 0 ? 'recharge' : 'adjust',
          detail: delta >= 0 ? ('管理员充值 +$' + (delta / 500000).toFixed(4)) : ('管理员扣减 $' + (delta / 500000).toFixed(4)),
          op_user_id: u.id, op_username: u.username, op_role: '管理员', ip: clientIp(req),
          request_id: 'admin-user-update:' + uid + '-' + Date.now(),
        });
      }
      if (before.role !== after.role || before.status !== after.status) {
        store.addAgentAudit(db, {
          target_user_id: uid, target_name: after.username,
          old_inviter_id: before.inviter_id, old_inviter: '—', new_inviter_id: after.inviter_id, new_inviter: '—',
          action: 'admin-account', level_before: before.agent_level, level_after: after.agent_level,
          agent_name: `role ${before.role}->${after.role}, status ${before.status}->${after.status}`,
          op_user_id: u.id, op_username: u.username, op_role: '管理员', ip: clientIp(req),
        });
      }
      console.log(`[admin] ${u.username} 更新用户 ${uid}${after.quota !== before.quota ? ' quota ' + before.quota + '->' + after.quota : ''}`);
      return json(res, 200, { success: true, data: r });
    }
    // 【2026-10-21】删除用户（管理员）：二次确认 + 事务级联 + 审计快照
    if (pathname === '/api/admin/user/delete' && req.method === 'POST') {
      const u = requireUser(req, res); if (!u) return;
      if (!store.isAdmin(u)) return json(res, 403, { success: false, message: '需要管理员权限' });
      const b = await readJson(req) || {};
      const uid = parseInt(b.id || 0, 10);
      const target = store.getUserById(db, uid);
      if (!target) return json(res, 404, { success: false, message: '用户不存在' });
      if (target.id === u.id) return json(res, 400, { success: false, message: '不能删除自己的账号' });
      if (target.role >= 100) return json(res, 400, { success: false, message: '管理员账号不允许删除（可先降级再删）' });
      if (String(b.confirm || '').trim() !== target.username) {
        return json(res, 400, { success: false, message: '二次确认失败：confirm 必须等于用户名「' + target.username + '」' });
      }
      const r = store.deleteUser(db, target, { opUser: u, ip: clientIp(req) });
      if (!r.ok) return json(res, 500, { success: false, message: r.message });
      console.log('[admin] ' + u.username + ' 删除用户 ' + uid + ' (' + target.username + ')');
      return json(res, 200, { success: true, message: r.message, data: r.detail });
    }
    // 【2026-10-21】帐号数据迁移：一键导出单个帐号全部数据（JSONL，含 tokens 明文 key / 全量日志 / 资金流水 / 签到 / 审计）
    // GET /api/admin/user/export?id=<uid>&log_limit=<可选上限>
    // 【2026-10-22 v2】落地盘 + 断点续传：先落盘 24h 内可 Range 续传，大帐号中断不再从头重来。
    // 首次请求：后台生成落盘 → 前端流式读；再次请求带 resume=1&offset=<bytes>：直接从文件续传。
    if (pathname === '/api/admin/user/export' && req.method === 'GET') {
      const u = requireUser(req, res); if (!u) return;
      if (!store.isAdmin(u)) return json(res, 403, { success: false, message: '需要管理员权限' });
      const uid = parseInt(query.get('id') || '0', 10);
      const target = uid ? store.getUserById(db, uid) : null;
      if (!target) return json(res, 404, { success: false, message: '用户不存在' });
      const logLimit = Math.min(parseInt(query.get('log_limit') || '0', 10) || 0, 2000000);

      const migDir = path.join(__dirname, 'logs', 'migrate');
      fs.mkdirSync(migDir, { recursive: true });
      // 稳定文件名（不含时间戳）：同一帐号重复导出覆盖旧包，续传按 offset 定位
      const migFile = path.join(migDir, `account-migration-${target.id}.jsonl`);
      const fname = `帐号迁移_${target.username}_${target.id}_${new Date().toISOString().slice(0, 10)}.jsonl`;
      const disposition = `attachment; filename="account-migration-${target.id}.jsonl"; filename*=UTF-8''${encodeURIComponent(fname)}`;

      // ---- 续传分支：文件已存在 → 直接从 offset 发（不重新生成）----
      // 【2026-10-22】probe=1 只探测是否有现成包（不触发重新生成）：有包 hasFile:true，无包 noFile:true
      if (query.get('probe') === '1') {
        if (fs.existsSync(migFile)) return json(res, 200, { success: true, hasFile: true, size: fs.statSync(migFile).size });
        return json(res, 200, { success: true, noFile: true });
      }
      const resumeOffset = parseInt(query.get('resume') === '1' ? (query.get('offset') || '0') : '-1', 10);
      if (resumeOffset >= 0 && fs.existsSync(migFile)) {
        const size = fs.statSync(migFile).size;
        const start = Math.min(Math.max(resumeOffset, 0), size);
        if (start >= size) {
          // 已经全部收过：返回空 200（前端直接落盘）
          res.writeHead(200, {
            'Content-Type': 'application/x-ndjson; charset=utf-8',
            'Content-Disposition': disposition,
            'Content-Length': 0, 'X-Migrate-Total': String(size),
            'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*',
          });
          return res.end();
        }
        console.log(`[migrate] 续传帐号 ${target.username}(#${target.id}) bytes=${start}-${size}`);
        const mTime = fs.statSync(migFile).mtime.toUTCString();
        res.writeHead(206, {
          'Content-Type': 'application/x-ndjson; charset=utf-8',
          'Content-Disposition': disposition,
          'Content-Range': `bytes ${start}-${size - 1}/${size}`,
          'Content-Length': size - start,
          'Accept-Ranges': 'bytes', 'X-Migrate-Total': String(size),
          'ETag': `"m-${target.id}-${size}"`,
          'Last-Modified': mTime,
          'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*',
        });
        const st = fs.createReadStream(migFile, { start });
        st.on('error', () => { try { res.destroy(); } catch {} });
        st.pipe(res);
        res.on('close', () => { /* 断开不删文件，24h GC 统一清 */ });
        return;
      }

      // ---- 首次请求：落盘生成（复用现有流式生成器）----
      const t0 = Date.now();
      const finalize = (cb) => {
        let out = fs.createWriteStream(migFile);
        let n = 0;
        (async () => {
          try {
            for await (const line of store.exportUserBundleStream(db, target.id, { logLimit, operator: u })) {
              out.write(line + '\n'); n++;
              if (n % 100000 === 0) await new Promise(r => setImmediate(r)); // 让出事件循环
            }
            await new Promise(r => out.end(r));
            const cnt = store.countLogs(db, target.id);
            console.log(`[migrate] ${u.username} 导出帐号 ${target.username}(#${target.id}) ${n} 行 / logs=${cnt} / ${Date.now() - t0}ms`);
            cb(n);
          } catch (e) {
            console.error('[migrate] 导出失败:', e.message);
            try { out.end(); } catch {}
            cb(null, e);
          }
        })();
      };

      // wait=1&nostream=1：只生成落盘，返回 JSON {ok:true,size}（配合前端把下载交给浏览器原生下载器）
      if (query.get('wait') === '1' && query.get('nostream') === '1') {
        if (!fs.existsSync(migFile)) {
          await new Promise((resolve) => finalize(() => resolve()));
        }
        const size = fs.statSync(migFile).size;
        return json(res, 200, { success: true, ok: true, size });
      }
      // 支持两种模式：wait=1（等生成完再发，配合前端直接流式下载）；默认（立即以流式发送边生成边发，兼容旧前端）
      if (query.get('wait') === '1') {
        // 【2026-10-22 铁律】文件已存在 → 无论哪个模式都不重新生成，直接发文件（防旧前端反复覆盖落盘包）
        if (fs.existsSync(migFile)) {
          const size = fs.statSync(migFile).size;
          res.writeHead(200, {
            'Content-Type': 'application/x-ndjson; charset=utf-8',
            'Content-Disposition': disposition,
            'Content-Length': size, 'Accept-Ranges': 'bytes', 'X-Migrate-Total': String(size),
            'ETag': `"m-${target.id}-${size}"`, 'Last-Modified': fs.statSync(migFile).mtime.toUTCString(),
            'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*',
          });
          const st = fs.createReadStream(migFile);
          st.on('error', () => { try { res.destroy(); } catch {} });
          st.pipe(res);
          res.on('close', () => {});
          return;
        }
        // 文件不存在才生成
        finalize(() => {
          const size = fs.statSync(migFile).size;
          res.writeHead(200, {
            'Content-Type': 'application/x-ndjson; charset=utf-8',
            'Content-Disposition': disposition,
            'Content-Length': size, 'Accept-Ranges': 'bytes', 'X-Migrate-Total': String(size),
            'ETag': `"m-${target.id}-${size}"`, 'Last-Modified': fs.statSync(migFile).mtime.toUTCString(),
            'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*',
          });
          const st = fs.createReadStream(migFile);
          st.on('error', () => { try { res.destroy(); } catch {} });
          st.pipe(res);
          res.on('close', () => {});
        });
        return;
      }
      // 兼容旧前端：边生成边发（原逻辑），同时落盘
      // 【2026-10-22】文件已存在 → 短路直发文件，不重新生成（防旧前端每次点击覆盖已落盘包）
      if (fs.existsSync(migFile)) {
        const size = fs.statSync(migFile).size;
        res.writeHead(200, {
          'Content-Type': 'application/x-ndjson; charset=utf-8',
          'Content-Disposition': disposition,
          'Content-Length': size, 'Accept-Ranges': 'bytes', 'X-Migrate-Total': String(size),
          'ETag': `"m-${target.id}-${size}"`, 'Last-Modified': fs.statSync(migFile).mtime.toUTCString(),
          'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*',
        });
        const st = fs.createReadStream(migFile);
        st.on('error', () => { try { res.destroy(); } catch {} });
        st.pipe(res);
        res.on('close', () => {});
        return;
      }
      res.writeHead(200, {
        'Content-Type': 'application/x-ndjson; charset=utf-8',
        'Content-Disposition': disposition,
        'X-Migrate-Job': 'streaming', 'Cache-Control': 'no-store',
        'Access-Control-Allow-Origin': '*',
      });
      res.write('');
      finalize(() => {
        try { res.end(); } catch {}
      });
      return;
    }
    // 【2026-10-22】迁移包 gzip 版：/api/admin/user/export-gz?id=N&token=***
    // 直发 logs/migrate/account-migration-N.jsonl.gz；无 .gz 现场从 .jsonl 压（gzip -k 同步）。配合浏览器原生下载器。
    if (pathname === '/api/admin/user/export-gz' && req.method === 'GET') {
      const u = requireUser(req, res); if (!u) return;
      if (!store.isAdmin(u)) return json(res, 403, { success: false, message: '需要管理员权限' });
      const uid = parseInt(query.get('id') || '0', 10);
      const target = uid ? store.getUserById(db, uid) : null;
      if (!target) return json(res, 404, { success: false, message: '用户不存在' });
      const migDir = path.join(__dirname, 'logs', 'migrate');
      fs.mkdirSync(migDir, { recursive: true });
      const raw = path.join(migDir, `account-migration-${target.id}.jsonl`);
      const gz = path.join(migDir, `account-migration-${target.id}.jsonl.gz`);
      // 有 .jsonl 无 .gz → 同步压（大文件 ~30s，node zlib 流式）
      if (!fs.existsSync(gz) && fs.existsSync(raw)) {
        await new Promise((resolve) => {
          const zin = fs.createReadStream(raw);
          const zout = zlib.createGzip({ level: 6 });
          const fout = fs.createWriteStream(gz);
          zin.pipe(zout).pipe(fout);
          fout.on('finish', resolve);
          fout.on('error', resolve);
          zin.on('error', resolve);
        });
      }
      if (!fs.existsSync(gz)) return json(res, 404, { success: false, message: '包不存在（先点一次迁移导出生成）' });
      const size = fs.statSync(gz).size;
      const gfname = `帐号迁移_${target.username}_${target.id}.jsonl.gz`;
      const gdisposition = `attachment; filename="account-migration-${target.id}.jsonl.gz"; filename*=UTF-8''${encodeURIComponent(gfname)}`;
      // Range 续传
      const rangeHdr = req.headers['range'];
      if (rangeHdr) {
        const m = String(rangeHdr).match(/^bytes=(\d+)-(\d*)$/);
        if (m) {
          const start = parseInt(m[1], 10);
          const end = m[2] ? Math.min(parseInt(m[2], 10), size - 1) : size - 1;
          if (start >= size || start > end) {
            res.writeHead(416, { 'Content-Range': `bytes */${size}`, 'Cache-Control': 'no-store' });
            return res.end();
          }
          res.writeHead(206, {
            'Content-Type': 'application/gzip',
            'Content-Disposition': gdisposition,
            'Content-Range': `bytes ${start}-${end}/${size}`,
            'Content-Length': end - start + 1,
            'Accept-Ranges': 'bytes',
            'ETag': `"gz-${target.id}-${size}"`, 'Last-Modified': fs.statSync(gz).mtime.toUTCString(),
            'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*',
          });
          const st = fs.createReadStream(gz, { start, end });
          st.on('error', () => { try { res.destroy(); } catch {} });
          st.pipe(res);
          return;
        }
      }
      console.log(`[migrate] ${u.username} 下载 gz 包 ${target.username}(#${target.id}) ${size}b`);
      res.writeHead(200, {
        'Content-Type': 'application/gzip',
        'Content-Disposition': gdisposition,
        'Content-Length': size,
        'Accept-Ranges': 'bytes',
        'ETag': `"gz-${target.id}-${size}"`, 'Last-Modified': fs.statSync(gz).mtime.toUTCString(),
        'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*',
      });
      const st = fs.createReadStream(gz);
      st.on('error', () => { try { res.destroy(); } catch {} });
      st.pipe(res);
      return;
    }

    // 【2026-10-21】帐号数据迁移：导入导出包
    // POST /api/admin/user/import  body: JSONL 文本（application/json 包一层 {"data": "..."} 或原始文本）
    //   ?mode=new（默认，新建用户，重名自动 _2/_3）| merge&target_id=<uid>（合并到已有帐号）
    // 密码：body.user.password 有值用之，否则随机生成并返回给管理员一次性展示。
    if (pathname === '/api/admin/user/import' && req.method === 'POST') {
      const u = requireUser(req, res); if (!u) return;
      if (!store.isAdmin(u)) return json(res, 403, { success: false, message: '需要管理员权限' });
      const buf = await readBody(req, 512 * 1024 * 1024);   // 导入包上限 512MB
      let text = buf.toString('utf8');
      // 兼容两种投递：纯 JSONL 文本，或 JSON 包装 {data: "..."} / {username,password} 附加字段
      let extra = {};
      const trimmed = text.trim();
      if (trimmed.startsWith('{') && !trimmed.startsWith('{"type"')) {
        try {
          const wrapped = JSON.parse(trimmed);
          if (typeof wrapped === 'object' && wrapped !== null && (typeof wrapped.data === 'string' || wrapped.data instanceof Array)) {
            text = Array.isArray(wrapped.data) ? wrapped.data.join('\n') : wrapped.data;
            extra = wrapped;
          }
        } catch { /* 不是 JSON 包装 → 当纯 JSONL 处理 */ }
      }
      const mode = query.get('mode') === 'merge' ? 'merge' : 'new';
      const targetId = mode === 'merge' ? parseInt(query.get('target_id') || '0', 10) : 0;
      if (mode === 'merge' && !targetId) return json(res, 400, { success: false, message: 'merge 模式需要 target_id' });
      // 允许在导入时覆盖密码/用户名（新建模式下）
      if (extra && extra.password) {
        try {
          const lines = text.split('\n');
          for (let i = 0; i < lines.length; i++) {
            const o = JSON.parse(lines[i]);
            if (o && o.type === 'header') { o.user.password = String(extra.password); lines[i] = JSON.stringify(o); break; }
          }
          text = lines.join('\n');
        } catch { /* 忽略：密码注入失败不影响导入 */ }
      }
      const t0 = Date.now();
      const r = await store.importUserBundle(db, text, { mode, targetUserId: targetId, opUser: u });
      if (!r.ok) return json(res, 400, { success: false, message: r.message });
      console.log(`[migrate] ${u.username} ${mode === 'merge' ? '合并导入到 #' + targetId + ' ' + r.new_username : '导入新帐号 ' + r.new_username}(#${r.new_user_id}) tokens=${r.imported.tokens} logs=${r.imported.logs} ledger=${r.imported.ledger} ${Date.now() - t0}ms`);
      return json(res, 200, {
        success: true,
        message: mode === 'merge'
          ? `已合并到 ${r.new_username}(#${r.new_user_id})：+${r.imported.tokens} 令牌 / +${r.imported.logs} 日志 / +${r.imported.ledger} 流水`
          : `已导入为新帐号 ${r.new_username}(#${r.new_user_id})：${r.imported.tokens} 令牌 / ${r.imported.logs} 日志 / ${r.imported.ledger} 流水`,
        data: { user: store.publicUser(db, r.user), imported: r.imported, new_user_id: r.new_user_id, new_username: r.new_username, new_password: r.new_password },
      });
    }
    if (pathname === '/api/admin/stats') {
      const u = requireUser(req, res); if (!u) return;
      if (!store.isAdmin(u)) return json(res, 403, { success: false, message: '需要管理员权限' });
      // 【2026-10-21】运营面板增强：今日请求/错误/消费/Top错误模型/渠道余额快照
      let ops = null;
      try {
        const dayStart = new Date(new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai' }).slice(0, 10) + 'T00:00:00+08:00').getTime();
        const one = (r) => r || { c: 0, q: 0 };
        const tot = one(db.prepare("SELECT COUNT(*) c, COALESCE(SUM(quota),0) q FROM logs WHERE created_at>=? AND log_type='consume' AND request_id NOT LIKE 'invite:%'").get(dayStart));
        const err = one(db.prepare("SELECT COUNT(*) c, 0 q FROM logs WHERE created_at>=? AND status!='success'").get(dayStart));
        const users = one(db.prepare("SELECT COUNT(DISTINCT user_id) c, 0 q FROM logs WHERE created_at>=? AND log_type='consume' AND username NOT LIKE 'agent-reward%'").get(dayStart));
        const topErr = db.prepare("SELECT model_name, COUNT(*) c, SUBSTR(COALESCE(group_concat(DISTINCT substr(error,1,80)),''),1,180) sample FROM logs WHERE created_at>=? AND status!='success' GROUP BY model_name ORDER BY c DESC LIMIT 3").all(dayStart);
        const byHour = db.prepare("SELECT (created_at/3600000+8)*3600000%86400000/1000 h, COUNT(*) c, SUM(CASE WHEN status!='success' THEN 1 ELSE 0 END) e FROM logs WHERE created_at>=? AND log_type='consume' GROUP BY 1 ORDER BY 1").all(dayStart);
        // 渠道上游余额（尽力而为：NewAPI 式 /dashboard/billing/subscription，失败静默）
        const chs = store.listChannelsRaw(db).filter(c => c.status === 1);
        const upstream = [];
        for (const ch of chs.slice(0, 8)) {
          if (!ch.api_key || !/^https?:/i.test(ch.base_url)) continue;
          let bal = null;
          try {
            const ctl = new AbortController();
            const tid = setTimeout(() => ctl.abort(), 4000);
            const r2 = await fetch(ch.base_url.replace(/\/+$/, '') + '/dashboard/billing/subscription', { headers: { Authorization: 'Bearer ' + ch.api_key }, signal: ctl.signal });
            clearTimeout(tid);
            if (r2.ok) {
              const j = await r2.json().catch(() => null);
              const limit = Number(j && (j.hard_limit_usd ?? j.system_hard_limit_usd));
              if (Number.isFinite(limit)) {
                let used = null;
                try {
                  const ctl2 = new AbortController();
                  const tid2 = setTimeout(() => ctl2.abort(), 4000);
                  const r3 = await fetch(ch.base_url.replace(/\/+$/, '') + '/dashboard/billing/usage', { headers: { Authorization: 'Bearer ' + ch.api_key }, signal: ctl2.signal });
                  clearTimeout(tid2);
                  if (r3.ok) { const j3 = await r3.json().catch(() => null); const tu = Number(j3 && j3.total_usage); if (Number.isFinite(tu)) used = tu / 100; }
                } catch {}
                if (used == null) {
                  const chRow = db.prepare('SELECT balance FROM channels WHERE id=?').get(ch.id);
                  bal = { limit, used: chRow && chRow.balance ? chRow.balance : null };
                } else bal = { limit, used };
              }
            }
          } catch {}
          upstream.push({ id: ch.id, name: ch.name, balance: bal });
        }
        ops = {
          today: { requests: tot.c, errors: err.c, usd: tot.q / 500000, active_users: users.c },
          error_rate: tot.c ? +(err.c / tot.c * 100).toFixed(2) : 0,
          top_errors: topErr, by_hour: byHour,
          upstream_balance: upstream,
        };
      } catch (e) { console.error('[admin/stats/ops]', e.message); }
      return json(res, 200, { success: true, data: { ...store.systemStats(db), health: health.snapshot(), site: store.getSettings(db) }, ops });
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

  // 改用户名（不能重名）
  if (b.username !== undefined && String(b.username).trim() !== '') {
    const newU = String(b.username).trim();
    if (newU !== u.username) {
      const r = store.setUsername(db, u.id, newU);
      if (!r.ok) return json(res, 400, { success: false, message: r.message });
      changed.push('用户名');
    }
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

/**
 * 通用导出派发器（2026-10-21 重构）
 * 旧版在**主进程**做 DB 流式读 + 汇总 SQL + 喂 worker，95.9 万行时主线程连续阻塞 55~62s，
 * 期间 /api/* 全部无响应（前端一直转圈 = "又卡住了"）。
 * 现在整条链路（只读 DB 连接 + 汇总 SQL + 多线程 xlsx 拼装 + 落盘）都在子进程里跑，
 * 主进程只登记任务 + 透传进度 → 事件循环零阻塞，导出再大也不影响别人。
 *
 *   mode=settle-single / usage  →  lib/export-multi.js（4 线程并行，96 万行 ~27s）
 *   mode=settle-all             →  lib/export-worker.js（汇总为主，单进程足够）
 */
function spawnExportJob(res, { mode, cfg, fname, message }) {
  const { spawn } = require('node:child_process');
  const jobKey = crypto.randomBytes(8).toString('hex');
  const outDir = path.join(__dirname, 'logs', 'exports');
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, jobKey + '.xlsx');
  _exportJobs.set(jobKey, { status: 'running', started: Date.now(), fname, progress: null });
  const t0 = Date.now();

  const script = (mode === 'settle-all') ? 'export-worker.js' : 'export-multi.js';
  const wp = path.join(__dirname, 'lib', script);
  const child = spawn(process.execPath, ['--no-warnings', wp, outFile, mode], { stdio: ['pipe', 'pipe', 'pipe'] });
  let outBuf = '';
  let errBuf = '';
  let bytes = 0;

  child.stdout.on('data', (d) => {
    outBuf += d.toString('utf8');
    let i;
    while ((i = outBuf.indexOf('\n')) >= 0) {
      const line = outBuf.slice(0, i); outBuf = outBuf.slice(i + 1);
      if (!line.trim()) continue;
      let m; try { m = JSON.parse(line); } catch { continue; }
      if (m.t === 'progress') { const j = _exportJobs.get(jobKey); if (j) j.progress = { rows: m.rows || 0, chunks: m.chunks || 0, sent: m.sent || 0 }; }
      else if (m.t === 'done') { bytes = m.bytes || 0; }
      else if (m.t === 'error') { const j = _exportJobs.get(jobKey); if (j) j.error = String(m.message || '').split('\n')[0]; }
    }
  });
  child.stderr.on('data', (d) => { errBuf += d.toString('utf8'); if (errBuf.length > 4000) errBuf = errBuf.slice(-4000); });
  child.on('error', (e) => {
    console.error('[export] spawn 失败:', e.message);
    _exportJobs.set(jobKey, { status: 'error', error: e.message, fname, started: t0 });
  });
  child.on('close', (code) => {
    const j = _exportJobs.get(jobKey) || { fname, started: t0 };
    if (j.status === 'error') return;
    if (code !== 0 || !fs.existsSync(outFile)) {
      const msg = (j.error || errBuf.trim().split('\n').pop() || ('worker exit ' + code));
      console.error('[export] ' + mode + ' 失败 job=' + jobKey + ': ' + msg);
      _exportJobs.set(jobKey, { status: 'error', error: msg, fname, started: t0 });
      return;
    }
    const size = fs.statSync(outFile).size;
    _exportJobs.set(jobKey, { status: 'done', file: outFile, fname, size: bytes || size, started: t0, finished: Date.now(), expireAt: Date.now() + EXPORT_FILE_TTL_MS });
    console.log('[export] ' + mode + ' 完成 job=' + jobKey + ': ' + (size / 1024 / 1024 | 0) + 'MB / ' + (Date.now() - t0) + 'ms');
    try {
      const files = fs.readdirSync(outDir).filter(f => f.endsWith('.xlsx'))
        .map(f => ({ f, m: fs.statSync(path.join(outDir, f)).mtimeMs })).sort((a, b) => b.m - a.m);
      for (const old of files.slice(10)) fs.unlink(path.join(outDir, old.f), () => {});
    } catch {}
  });

  child.stdin.end(JSON.stringify(cfg));
  return json(res, 202, { success: true, async: true, job: jobKey, message });
}

/** 使用日志导出（xlsx：明细分片 + 按模型汇总） */
function exportUsageXlsx(res, { userId, since, until = 0, all, admin = false, limit = 500000 }) {
  const d = new Date();
  const stamp = `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}-${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}`;
  return spawnExportJob(res, {
    mode: 'usage',
    cfg: { dbPath: DB_PATH, userId: userId || null, since: since || 0, until: until || 0, limit, all: !!all, quotaPerUsd: QUOTA_PER_USD },
    fname: `${all ? 'all' : 'usage'}-logs-${stamp}.xlsx`,
    message: '导出任务已启动，稍后可在下载中心获取',
  });
}

function asyncXlsxJob(res, { build, fname, logPrefix }) {
  const jobKey = crypto.randomBytes(8).toString('hex');
  const outDir = path.join(__dirname, 'logs', 'exports');
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, jobKey + '.xlsx');
  _exportJobs.set(jobKey, { status: 'running', started: Date.now() });
  setImmediate(() => {
    try {
      const buf = build(); // 同步生成（重活，但此时导出 job 互斥概率低；settle 本身也秒级）
      fs.writeFileSync(outFile, buf);
      _exportJobs.set(jobKey, { status: 'done', file: outFile, fname, size: buf.length, started: _exportJobs.get(jobKey).started, finished: Date.now(), expireAt: Date.now() + EXPORT_FILE_TTL_MS });
      console.log(`${logPrefix} 完成: ${buf.length / 1024 / 1024 | 0}MB → ${outFile}`);
    } catch (e) {
      console.error(`${logPrefix} 失败:`, e.message);
      _exportJobs.set(jobKey, { status: 'error', error: e.message });
    }
  });
  return json(res, 202, { success: true, async: true, job: jobKey, message: '生成任务已启动' });
}

/** 结算清单导出：target = 'all' 或 用户ID 字符串 */
/**
 * 结算清单导出（xlsx）
 *   target = 'all' → settle-all（总表 + 每用户 sheet）
 *   target = 用户ID → settle-single（概要 + 按模型/按渠道/返佣 + 明细分片）
 * 全部在子进程执行，主进程零阻塞。
 */
function exportSettleXlsx(res, { target, since, until = 0, limit = 500000 }) {
  const d = new Date();
  const stamp = `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}-${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}`;

  // 范围描述（写进提示语，避免"以为导了今天其实导了全量"这种误判）
  const rangeDesc = (since && until) ? `${fmtTs(since)} ~ ${fmtTs(until)}`
    : since ? `${fmtTs(since)} 起`
    : until ? `截止 ${fmtTs(until)}`
    : '全部历史';

  if (target !== 'all') {
    const u = store.getUserById(db, parseInt(target, 10));
    if (!u) return json(res, 404, { success: false, message: '用户不存在' });
    return spawnExportJob(res, {
      mode: 'settle-single',
      cfg: { dbPath: DB_PATH, userId: u.id, since: since || 0, until: until || 0, limit: limit || 500000, quotaPerUsd: QUOTA_PER_USD },
      fname: `结算清单_${u.username}_${u.id}_${stamp}.xlsx`,
      message: `结算清单生成中（范围：${rangeDesc}）`,
    });
  }

  const users = store.listUsers(db);
  return spawnExportJob(res, {
    mode: 'settle-all',
    cfg: { dbPath: DB_PATH, since: since || 0, until: until || 0, perUserLimit: 10000, quotaPerUsd: QUOTA_PER_USD },
    fname: `结算清单_全部用户_${stamp}.xlsx`,
    message: `全部用户结算生成中（${users.length} 个用户，范围：${rangeDesc}）`,
  });
}

function _settleStamp() { const d = new Date(); return `${d.getFullYear()}${pad2(d.getMonth()+1)}${pad2(d.getDate())}-${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}`; }

/** 代理结算导出：每个代理一行（团队人数/团队消费/各级返佣）+ 每代理一个明细 sheet */
function exportAgentSettleXlsx(res, { since = 0, until = 0 } = {}) {
  const xlsx = require('./lib/xlsx');
  const usdS = q => '$' + ((q || 0) / QUOTA_PER_USD).toFixed(6);
  const rngFor = (ids) => {
    const ph = ids.map(() => '?').join(',');
    const cond = [`user_id IN (${ph})`, "request_id NOT LIKE 'invite:%'"], v = [...ids];
    if (since) { cond.push('created_at>=?'); v.push(since); }
    if (until) { cond.push('created_at<=?'); v.push(until); }
    return { where: cond.join(' AND '), v };
  };
  const agents = db.prepare('SELECT * FROM users WHERE agent_level > 0 ORDER BY agent_level, id').all();

  const head = ['用户ID','用户名','代理名','等级','直属下级','团队总人数','团队消费(USD)','自身消费(USD)','一级返佣(USD)','二级返佣(USD)','三级返佣(USD)','返佣合计(USD)','当前余额(USD)'];
  const master = [head];
  let GT={users:0,consume:0,r1:0,r2:0,r3:0};

  const detailSheets = [];
  for (const a of agents) {
    const ts = store.teamStats(db, a.id);
    // 团队消费 = 自身 + 全下级消费
    const teamIds = [a.id, ...store.listDownline(db, a.id, { maxDepth: 5 }).map(d => d.id)];
    let teamConsume = 0;
    for (const id of teamIds) {
      const r = rngFor([id]);
      teamConsume += db.prepare(`SELECT COALESCE(SUM(quota),0) q FROM logs WHERE ${r.where}`).get(...r.v).q;
    }
    const ro = rngFor([a.id]);
    const own = db.prepare(`SELECT COALESCE(SUM(quota),0) q FROM logs WHERE ${ro.where}`).get(...ro.v).q;
    master.push([
      String(a.id), a.username, a.agent_name || '', 'L' + a.agent_level,
      ts.direct, ts.total, usdS(teamConsume), usdS(own),
      usdS(ts.reward_l1), usdS(ts.reward_l2), usdS(ts.reward_l3), usdS(ts.reward_total), usdS(a.quota),
    ]);
    GT.users += ts.total; GT.consume += teamConsume; GT.r1 += ts.reward_l1; GT.r2 += ts.reward_l2; GT.r3 += ts.reward_l3;

    // 该代理的明细 sheet（自身 + 下级消费明细）
    const rows = [['代理:' + a.username + ' (L' + a.agent_level + ' ' + (a.agent_name || '') + ')',''],
      ['团队人数', String(ts.total)], ['团队消费(USD)', usdS(teamConsume)],
      ['返佣 L1/L2/L3', usdS(ts.reward_l1) + ' / ' + usdS(ts.reward_l2) + ' / ' + usdS(ts.reward_l3)],
      ['',''], ['时间','成员','模型','渠道','输入token','输出token','总token','消费(USD)','状态']];
    const rr = rngFor(teamIds);
    const logs = db.prepare(`SELECT l.*, u.username AS uname FROM logs l JOIN users u ON u.id=l.user_id
      WHERE l.user_id IN (${teamIds.map(() => '?').join(',')}) AND l.request_id NOT LIKE 'invite:%'
      ${since ? 'AND l.created_at>=?' : ''} ${until ? 'AND l.created_at<=?' : ''}
      ORDER BY l.created_at DESC LIMIT 5000`).all(...teamIds, ...(since ? [since] : []), ...(until ? [until] : []));
    for (const l of logs) rows.push([
      fmtTs(l.created_at), l.uname, l.model_name || '-', l.channel_name || '-',
      l.prompt_tokens, l.completion_tokens, l.total_tokens, usdS(l.quota),
      l.status === 'success' ? '成功' : '失败',
    ]);
    let nm = a.username.replace(/[\\\/\?\*\[\]:]/g, '_').slice(0, 26);
    detailSheets.push({ name: nm, rows, colWidths: [19,16,22,22,11,11,11,13,7], freezeHeader: true });
  }
  master.push(['合计','','','', '', GT.users, usdS(GT.consume), '', usdS(GT.r1), usdS(GT.r2), usdS(GT.r3), usdS(GT.r1 + GT.r2 + GT.r3), '']);

  // sheet 名去重
  const used = new Set(['代理结算总表']);
  for (const s of detailSheets) {
    let b = s.name, i = 2;
    while (used.has(s.name)) s.name = b + '_' + (i++);
    used.add(s.name);
  }
  const sheets = [{ name: '代理结算总表', rows: master, colWidths: [8,16,14,6,9,10,14,14,14,14,14,14,14], freezeHeader: true }, ...detailSheets.slice(0, 30)];
  return asyncXlsxJob(res, { build: () => xlsx.build(sheets), fname: `代理结算清单_${_settleStamp()}.xlsx`, logPrefix: `[settle] agents=${agents.length}` });
}

function sendXlsx(res, buf, fname, logMsg) {
  res.writeHead(200, {
    'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'Content-Disposition': `attachment; filename="${encodeURIComponent(fname)}"; filename*=UTF-8''${encodeURIComponent(fname)}`,
    'Content-Length': buf.length,
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(buf);
  console.log(logMsg);
}

/**
 * 流式发送 xlsx：先写响应头（让前端 fetch 立刻拿到响应、显示进度），
 * 再用 setImmediate 让出事件循环后同步 build + 发送。
 * 用于单用户结算等中小数据量导出——比 asyncXlsxJob 简单，前端体验一致。
 */
function sendXlsxStream(res, buildFn, fname, logMsg) {
  res.writeHead(200, {
    'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'Content-Disposition': `attachment; filename="${encodeURIComponent(fname)}"; filename*=UTF-8''${encodeURIComponent(fname)}`,
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
  });
  res.write(''); // 立即 flush 响应头，前端 fetch 可开始读 body 显示进度
  setImmediate(() => {
    try {
      const t0 = Date.now();
      const buf = buildFn();
      res.end(buf);
      console.log(logMsg + (logMsg ? ' ' : '') + `(${buf.length / 1024 | 0}KB / ${Date.now() - t0}ms)`);
    } catch (e) {
      // 头已发无法改状态码，只能断连
      console.error('[xlsx-stream] 生成失败:', e.message);
      try { res.destroy(); } catch {}
    }
  });
}

// 探测上游 /models，返回 { ok, models, count, error }
async function probeUpstreamModels(baseUrl, apiKey) {
  const base = String(baseUrl || '').replace(/\/+$/, '');
  const key = String(apiKey || '');
  const url = base + '/models';
  try {
    const r = await fetch(url, {
      headers: key ? { Authorization: 'Bearer ' + key } : {},
      signal: AbortSignal.timeout(20000),
    });
    if (!r.ok) return { ok: false, error: `HTTP ${r.status}`, models: [], count: 0 };
    const j = await r.json();
    const ids = (j.data || j.models || []).map(m => m.id || m.name).filter(Boolean);
    return { ok: true, models: ids, count: ids.length };
  } catch (e) {
    return { ok: false, error: e.message, models: [], count: 0 };
  }
}
async function handleChannelModels(res, b) {
  const r = await probeUpstreamModels(b.base_url, b.api_key);
  if (!r.ok) return json(res, 502, { success: false, message: '探测失败: ' + r.error });
  return json(res, 200, { success: true, data: { count: r.count, models: r.models } });
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
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
      // 【2026-10-22】静态资源加 no-cache：改版后浏览器必须拉最新 app.js，否则续传逻辑不生效
      'Cache-Control': 'no-cache, must-revalidate',
      'Etag': `"${Math.floor(buf.length / 100)}-${Math.floor(fs.statSync(filePath).mtimeMs / 1000)}"`,
    });
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
