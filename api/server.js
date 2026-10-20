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
// 导出任务表（内存，重启即清空；文件保留在 logs/exports/）
const _exportJobs = new Map();
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
      // 时间窗: 优先 since/until（支持 YYYY-MM-DD 或 YYYY-MM），否则 days，都没有=全量
      let since = 0, until = 0;
      const sStr = query.get('since'), uStr = query.get('until');
      const parseDay = (s) => {
        const m = String(s).match(/^(\d{4})-(\d{2})(?:-(\d{2}))?/);
        if (!m) return NaN;
        return Date.UTC(+m[1], +m[2] - 1, m[3] ? +m[3] : 1);
      };
      if (sStr || uStr) {
        const s = sStr ? parseDay(sStr) : 0, e2 = uStr ? parseDay(uStr) : 0;
        if (isNaN(s) || isNaN(e2) || (s && e2 && s > e2)) return json(res, 400, { success: false, message: 'since/until 格式错误，支持 YYYY-MM-DD 或 YYYY-MM' });
        since = s || 0;
        until = e2 ? e2 - 1 : 0; // store 用 created_at<=until，转成闭区间
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
      if (j.status === 'running') return json(res, 200, { success: true, status: 'running', started: j.started });
      if (j.status === 'error') return json(res, 200, { success: true, status: 'error', error: j.error });
      // done → 下载文件
      res.writeHead(200, {
        'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': `attachment; filename="${j.fname}"`,
        'Content-Length': j.size,
        'Cache-Control': 'no-store',
      });
      const st = fs.createReadStream(j.file);
      st.on('error', (e) => { if (!res.headersSent) json(res, 500, { success: false, message: e.message }); else res.destroy(); });
      st.pipe(res);
      res.on('close', () => { // 下载完成/中断后延迟清理文件（任务记录保留 24h）
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

function exportUsageXlsx(res, { userId, since, until = 0, all, admin = false, limit = 500000 }) {
  // 【死锁修复 2026-10-21 最终版】导出是重操作（全站 95 万行要 100s+），
  // 主线程同步执行会阻塞所有其他请求（relay/登录/页面全卡）。
  // 改为：响应立即 202 返回 + 后台异步入盘，下载链接见 /api/log/export/job。
  // 前端下载按钮改为轮询任务状态。
  const jobKey = crypto.randomBytes(8).toString('hex');
  const outFile = path.join(__dirname, 'logs', 'exports', jobKey + '.xlsx');
  fs.mkdirSync(path.join(__dirname, 'logs', 'exports'), { recursive: true });
  _exportJobs.set(jobKey, { status: 'running', user: 'admin', started: Date.now() });
  // 后台异步执行，不阻塞事件循环
  setImmediate(async () => {
    try {
      const xlsx = require('./lib/xlsx');
      const t0 = Date.now();
      const summary = store.exportSummary(db, { userId, since, until });
      const sum = [
        ['用户', '用户ID', '令牌名称', '令牌ID', '模型', '请求次数', '输入token数', '输出token数', '总token数', '消费金额'],
      ];
      let tReq = 0, tIn = 0, tOut = 0, tTok = 0, tQ = 0;
      for (const s of summary) {
        sum.push([s.username, String(s.user_id), s.token_name || '-', String(s.token_id || ''), s.model_name, s.req_count, s.prompt_tokens, s.completion_tokens, s.total_tokens, fmtYuan(s.quota)]);
        tReq += s.req_count; tIn += s.prompt_tokens; tOut += s.completion_tokens; tTok += s.total_tokens; tQ += s.quota;
      }
      sum.push(['合计', '', '', '', '', tReq, tIn, tOut, tTok, fmtYuan(tQ)]);
      const header = ['时间', '类型', '用户', '用户ID', '令牌名称', '模型', '输入token数', '缓存读token数', '未命中token数', '命中率', '输出token数', '花费金额', '用时(秒)', '流式'];
      // 【流式管道修复 2026-10-21 2】旧版把 50 万行×14列 全量预读到 rowsPre 数组驻留 1.8GB，
      // GC 风暴 + worker stdin 背压链断裂 → 导出永远完不成、其它接口变慢。
      // 改为：先起 worker，DB 边读边按 5000 行/批写 stdin；写前等 drain，内存恒定 ~2MB。
      const d = new Date();
      const stamp = `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}-${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}`;
      const fname = `${all ? 'all' : 'usage'}-logs-${stamp}.xlsx`;
      const { spawn } = require('node:child_process');
      const wp = path.join(__dirname, 'lib', 'xlsx-worker.js');
      const child = spawn(process.execPath, [wp, outFile], { stdio: ['pipe', 'pipe', 'inherit'] });
      let wBuf = '';
      child.stdout.on('data', (d) => {
        wBuf += d.toString('utf8');
        let i;
        while ((i = wBuf.indexOf('\n')) >= 0) {
          const line = wBuf.slice(0, i); wBuf = wBuf.slice(i + 1);
          if (!line.trim()) continue;
          let m; try { m = JSON.parse(line); } catch { continue; }
          if (m.t === 'progress') { const j = _exportJobs.get(jobKey); if (j) j.progress = m; }
          if (m.t === 'error') { wErr = m.message; }
        }
      });
      let wErr = null;
      const wDone = new Promise((resolve) => {
        child.on('close', (code) => { if (code !== 0 && !wErr) wErr = 'worker exit ' + code; resolve(); });
      });
      child.stdin.write(JSON.stringify({ t: 'init', header, chunkSize: 50000, prefix: all ? '全部明细' : '使用日志', summarySheets: [{ name: '按模型汇总', rows: sum, colWidths: [14, 9, 16, 9, 24, 10, 13, 13, 13, 13], freezeHeader: true }] }) + '\n');
      // DB 边读边喂 worker（背压安全）
      const tRead = Date.now();
      let n = 0;
      const FLUSH = 5000;
      let buf = [];
      const it = store.exportLogsIter(db, { userId, since, until, limit, wide: admin });
      for (let l = it.next(); !l.done; l = it.next()) {
        if (wErr) break;
        n++;
        const row = l.value;
        const ca = row.cached_tokens || 0;
        buf.push([fmtTs(row.created_at), typeLabel(row), row.username, String(row.user_id), row.token_name || '', row.model_name || '', row.prompt_tokens, ca, Math.max(0, (row.prompt_tokens || 0) - ca), row.prompt_tokens ? Math.round(ca / row.prompt_tokens * 100) + '%' : '', row.completion_tokens, fmtYuan(row.quota), Math.round(row.use_time || 0), row.is_stream ? '是' : '否']);
        if (buf.length >= FLUSH) {
          const ok = child.stdin.write(JSON.stringify({ t: 'rows', rows: buf }) + '\n');
          buf = [];
          if (!ok) await new Promise(r => child.stdin.once('drain', r)); // 背压：worker 没消化完就等
        }
      }
      if (buf.length) {
        const ok = child.stdin.write(JSON.stringify({ t: 'rows', rows: buf }) + '\n');
        if (!ok) await new Promise(r => child.stdin.once('drain', r));
      }
      console.log(`[export] job=${jobKey} 流式读取 ${n} 行 / ${Date.now() - tRead}ms（内存恒定，无预读驻留）`);
      child.stdin.end(JSON.stringify({ t: 'end' }) + '\n');
      await wDone;
      if (wErr) throw new Error(wErr);
      _exportJobs.set(jobKey, { status: 'done', file: outFile, fname, size: fs.statSync(outFile).size, started: _exportJobs.get(jobKey)?.started || t0, finished: Date.now() });
      console.log(`[export] job=${jobKey} 完成: ${fs.statSync(outFile).size / 1024 / 1024 | 0}MB / ${n} 行 / ${Date.now() - t0}s → ${outFile}`);
      // 清理旧任务（保留最近 10 个文件）
      try {
        const files = fs.readdirSync(path.dirname(outFile)).filter(f => f.endsWith('.xlsx')).map(f => ({ f, m: fs.statSync(path.join(path.dirname(outFile), f)).mtimeMs })).sort((a, b) => b.m - a.m);
        for (const old of files.slice(10)) fs.unlink(path.join(path.dirname(outFile), old.f), () => {});
      } catch {}
    } catch (e) {
      console.error(`[export] job=${jobKey} 失败:`, e.message);
      _exportJobs.set(jobKey, { status: 'error', error: e.message });
    }
    // 任务记录保留 24h 供下载（文件单独按 mtime 清理）
    setTimeout(() => { const j = _exportJobs.get(jobKey); if (j && j.status !== 'done') _exportJobs.delete(jobKey); }, 86400000);
  });
  // 立即返回 202 + 任务 key，前端轮询
  return json(res, 202, { success: true, async: true, job: jobKey, message: '导出任务已启动，稍后可在下载中心获取' });
}

/** 异步文件生成：后台把 Buffer 写入 logs/exports/ 并登记任务，立即 202 返回；前端轮询 /api/log/export/job 下载 */
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
      _exportJobs.set(jobKey, { status: 'done', file: outFile, fname, size: buf.length, started: _exportJobs.get(jobKey).started, finished: Date.now() });
      console.log(`${logPrefix} 完成: ${buf.length / 1024 / 1024 | 0}MB → ${outFile}`);
    } catch (e) {
      console.error(`${logPrefix} 失败:`, e.message);
      _exportJobs.set(jobKey, { status: 'error', error: e.message });
    }
  });
  return json(res, 202, { success: true, async: true, job: jobKey, message: '生成任务已启动' });
}

/** 结算清单导出：target = 'all' 或 用户ID 字符串 */
function exportSettleXlsx(res, { target, since, until = 0, limit = 500000 }) {
  const xlsx = require('./lib/xlsx');
  const TYPE = { consume: '消费', recharge: '充值', reward: '返利', system: '系统', admin: '管理' };
  const usdS = q => '$' + ((q || 0) / QUOTA_PER_USD).toFixed(6);
  // 范围条件（供 agg / 汇总用）
  const rng = (uid) => {
    const cond = ['user_id=?'], v = [uid];
    if (since) { cond.push('created_at>=?'); v.push(since); }
    if (until) { cond.push('created_at<=?'); v.push(until); }
    return { where: cond.join(' AND '), v };
  };
  const aggSql = (uid) => {
    const { where, v } = rng(uid);
    return { sql: `SELECT COUNT(*) c,
      SUM(CASE WHEN status='success' THEN 1 ELSE 0 END) ok,
      SUM(CASE WHEN status!='success' THEN 1 ELSE 0 END) err,
      COALESCE(SUM(prompt_tokens),0) tin, COALESCE(SUM(completion_tokens),0) tout,
      COALESCE(SUM(total_tokens),0) tok, COALESCE(SUM(quota),0) q
    FROM logs WHERE ${where}`, v };
  };
  const aggOf = (uid) => { const a = aggSql(uid); return db.prepare(a.sql).get(...a.v); };
  const rcOf = (uid) => {
    const { where, v } = rng(uid);
    return db.prepare(`SELECT COALESCE(SUM(quota),0) q FROM logs WHERE ${where} AND log_type='recharge'`).get(...v).q;
  };

  const users = target === 'all'
    ? store.listUsers(db)
    : [store.getUserById(db, parseInt(target, 10))].filter(Boolean);
  if (!users.length) return json(res, 404, { success: false, message: '用户不存在' });

  // 汇总总表
  const master = [['用户ID','用户名','角色','状态','账期起','账期止','请求次数','成功','失败','输入token','输出token','总token','累计消费(USD)','累计充值(USD)','当前余额(USD)']];
  let G={c:0,ok:0,err:0,tin:0,tout:0,tok:0,q:0,rc:0};

  for (const u of users) {
    const logs = store.exportLogs(db, { userId: u.id, since, until, limit: target === 'all' ? 20000 : limit });
    const agg = aggOf(u.id);
    const rc = rcOf(u.id);
    const first = logs.length ? logs[logs.length-1].created_at : u.created_at;  // exportLogs 为 DESC
    const last  = logs.length ? logs[0].created_at : u.created_at;
    G.c+=agg.c; G.ok+=agg.ok||0; G.err+=agg.err||0; G.tin+=agg.tin; G.tout+=agg.tout; G.tok+=agg.tok; G.q+=agg.q; G.rc+=rc;
    master.push([
      String(u.id), u.username, u.role>=100?'管理员':'用户', u.status===1?'启用':'禁用',
      fmtTs(first), fmtTs(last), agg.c, agg.ok||0, agg.err||0,
      agg.tin, agg.tout, agg.tok, usdS(agg.q), usdS(rc), usdS(u.quota),
    ]);
  }
  master.push(['合计','','','','','',G.c,G.ok,G.err,G.tin,G.tout,G.tok,usdS(G.q),usdS(G.rc),'']);

  // 每人一份结算 sheet 的拼接方式：指定用户→多 sheet；全部→总表 + 每人一个 sheet（上限保护）
  const d = new Date();
  const stamp = `${d.getFullYear()}${pad2(d.getMonth()+1)}${pad2(d.getDate())}-${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}`;

  if (target !== 'all') {
    const u = users[0];
    // 单用户：流式分页迭代 + 行数上限（防 .all() 百万行炸内存冻结全站）
    const cap = Math.min(Math.max(limit || 500000, 1), 2000000);
    const logs = [];
    for (const l of store.exportLogsIter(db, { userId: u.id, since, until, limit: cap, wide: true })) logs.push(l);
    const agg = aggOf(u.id);
    const rc = rcOf(u.id);
    const first = logs.length ? logs[logs.length-1].created_at : u.created_at;  // exportLogs 为 DESC
    const last  = logs.length ? logs[0].created_at : u.created_at;

    const info = [
      ['结算清单',''], ['用户名', u.username], ['用户ID', String(u.id)],
      ['角色', u.role>=100?'管理员':'用户'], ['状态', u.status===1?'启用':'禁用'],
      ['注册时间', fmtTs(u.created_at)],
      ['账期', logs.length ? `${fmtTs(first)} ~ ${fmtTs(last)}` : '(无调用记录)'],
      ['',''], ['结算项目','金额(USD)'],
      ['累计充值', usdS(rc)], ['累计消费', usdS(agg.q)], ['当前余额', usdS(u.quota)],
      ['',''], ['调用统计',''],
      ['请求总数', String(agg.c)], ['成功', String(agg.ok||0)], ['失败', String(agg.err||0)],
      ['输入token', String(agg.tin)], ['输出token', String(agg.tout)], ['总token', String(agg.tok)],
      ['明细行数', logs.length < agg.c ? `前 ${logs.length} 条(共 ${agg.c} 条, 已截断)` : String(logs.length)],
      ['导出时间', fmtTs(Date.now())],
    ];
    const detail = [['时间','类型','模型','渠道','令牌','输入token','输出token','总token','消费(USD)','耗时(秒)','流式','状态','错误','来源IP']];
    for (const l of logs) detail.push([
      fmtTs(l.created_at), TYPE[l.log_type]||l.log_type||'消费', l.model_name||'-', l.channel_name||'-', l.token_name||'-',
      l.prompt_tokens, l.completion_tokens, l.total_tokens, usdS(l.quota),
      Math.round(l.use_time||0), l.is_stream?'是':'否', l.status==='success'?'成功':'失败',
      (l.error||'').slice(0,80), l.ip||'',
    ]);
    const r1 = rng(u.id);
    const byModel = db.prepare(`SELECT model_name, COUNT(*) c, COALESCE(SUM(prompt_tokens),0) tin,
       COALESCE(SUM(completion_tokens),0) tout, COALESCE(SUM(total_tokens),0) tok, COALESCE(SUM(quota),0) q
       FROM logs WHERE ${r1.where} GROUP BY model_name ORDER BY q DESC`).all(...r1.v);
    const mSheet = [['模型','请求次数','输入token','输出token','总token','消费(USD)']];
    let mR=0,mI=0,mO=0,mT=0,mQ=0;
    for (const r of byModel) { mSheet.push([r.model_name,r.c,r.tin,r.tout,r.tok,usdS(r.q)]); mR+=r.c;mI+=r.tin;mO+=r.tout;mT+=r.tok;mQ+=r.q; }
    mSheet.push(['合计',mR,mI,mO,mT,usdS(mQ)]);
    const byCh = db.prepare(`SELECT channel_name, COUNT(*) c, COALESCE(SUM(total_tokens),0) tok, COALESCE(SUM(quota),0) q
       FROM logs WHERE ${r1.where} GROUP BY channel_name ORDER BY q DESC`).all(...r1.v);
    const cSheet = [['渠道','请求次数','总token','消费(USD)']];
    let cR=0,cT=0,cQ=0;
    for (const r of byCh) { cSheet.push([r.channel_name||'-',r.c,r.tok,usdS(r.q)]); cR+=r.c;cT+=r.tok;cQ+=r.q; }
    cSheet.push(['合计',cR,cT,usdS(cQ)]);

    // 返佣汇总(该用户作为邀请人获得的各级返佣, 来自 invite: 行)
    const rwRows = db.prepare(`SELECT CASE WHEN username='agent-reward-L1' THEN 'L1'
       WHEN username='agent-reward-L2' THEN 'L2' ELSE 'L3' END lv, COUNT(*) c, COALESCE(SUM(quota),0) q
       FROM logs WHERE user_id=? AND log_type='consume' AND username LIKE 'agent-reward-L%' GROUP BY lv`).all(u.id);
    const rwSheet = [['返佣层级','笔数','返佣(USD)']];
    let rwQ = 0;
    for (const r of rwRows) { rwSheet.push([r.lv, r.c, usdS(r.q)]); rwQ += r.q; }
    rwSheet.push(['合计', rwRows.reduce((a, r) => a + r.c, 0), usdS(rwQ)]);
    const rwUsers = db.prepare(`SELECT u.id, u.username, COALESCE(SUM(r.quota),0) q
       FROM logs c
       JOIN logs r ON r.request_id = 'invite:' || c.request_id
       JOIN users u ON u.id = r.user_id
       WHERE c.user_id=? AND c.log_type='consume' AND c.username=? AND c.request_id NOT LIKE 'invite:%'
         AND r.log_type='consume' AND r.username LIKE 'agent-reward-L%'
       GROUP BY u.id ORDER BY q`).all(u.id, u.username);
    const rwSheet2 = [['返佣获得用户','ID','返佣(USD)']];
    for (const r of rwUsers) rwSheet2.push([r.username, String(r.id), usdS(r.q)]);
    const fname = `结算清单_${u.username}_${u.id}_${stamp}.xlsx`;
    // 流式发送：先写响应头（前端立即显示进度），再 setImmediate 后同步 build+发送
    return sendXlsxStream(res, () => xlsx.build([
      { name: '结算概要', rows: info, colWidths: [16, 44] },
      { name: '调用明细', rows: detail, colWidths: [19,8,22,24,14,11,11,11,13,8,6,7,40,16], freezeHeader: true },
      { name: '按模型汇总', rows: mSheet, colWidths: [24,10,13,13,13,14], freezeHeader: true },
      { name: '按渠道汇总', rows: cSheet, colWidths: [26,10,13,14], freezeHeader: true },
      { name: '返佣汇总', rows: rwSheet.concat([['',''],['按用户',''], ...rwSheet2]), colWidths: [20,10,14], freezeHeader: true },
    ]), fname, `[settle] uid=${u.id} ${logs.length} 条`);
  }

  // 全部用户：总表 + 每个用户一个明细 sheet（sheet 名去重/截断，上限 40 用户）
  const sheets = [{ name: '全部用户结算', rows: master, colWidths: [8,16,8,6,19,19,9,7,7,12,12,12,15,15,15], freezeHeader: true }];
  const used = new Set(['全部用户结算']);
  for (const u of users.slice(0, 40)) {
    const logs = store.exportLogs(db, { userId: u.id, since, until });
    if (!logs.length) continue;
    let nm = u.username.replace(/[\\\/\?\*\[\]:]/g, '_').slice(0, 26);
    let base = nm, i = 2;
    while (used.has(nm)) nm = base + '_' + (i++);
    used.add(nm);
    const agg = aggOf(u.id);
    const rows = [['结算:' + u.username + ' (ID ' + u.id + ')',''],
      ['累计消费(USD)', usdS(agg.q)], ['总token', String(agg.tok)], ['请求数', String(agg.c)],
      ['',''], ['时间','模型','渠道','输入token','输出token','总token','消费(USD)','状态']];
    for (const l of logs) rows.push([
      fmtTs(l.created_at), l.model_name||'-', l.channel_name||'-',
      l.prompt_tokens, l.completion_tokens, l.total_tokens, usdS(l.quota),
      l.status==='success'?'成功':'失败',
    ]);
    sheets.push({ name: nm, rows, colWidths: [19,24,24,11,11,11,13,7], freezeHeader: true });
  }
  const fname = `结算清单_全部用户_${stamp}.xlsx`;
  return asyncXlsxJob(res, { build: () => xlsx.build(sheets), fname, logPrefix: `[settle] ALL ${users.length} 用户` });
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
