#!/usr/bin/env node
/**
 * 算力商城 (Compute Market) 后端服务
 * 零 npm 依赖：纯 Node.js 内置模块（http / sqlite / crypto）
 *
 * 功能：用户注册、登录、会话管理 + 静态文件服务
 * 启动：node server.js   （端口 PORT 环境变量，默认 5800）
 */
'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

// ============ 配置 ============
const PORT = parseInt(process.env.PORT || '5800', 10);
const HOST = process.env.HOST || '127.0.0.1';
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'market.db');
// ComputeHub Gateway 上游：算力节点 / 下单 / 订单查询都从这里取
const UPSTREAM = process.env.UPSTREAM || 'http://127.0.0.1:8282';

// 与 ComputeHub src/kernel/task_econ.go 完全一致的计价系数（本地报价，不依赖上游）
const TOKEN_COEFF = { CPU: 1.0, GPU: 10.0, LLM: 0.02, IO: 0.1 };
const CONFIDENCE = 0.6;
const PRICING = {
  unit: '1 token = 1 核 CPU × 1 分钟',
  coeff: TOKEN_COEFF,
  note: 'GPU 任务按 卡数×时长×10 计；LLM 按输入 token 量；IO 按数据量+时长',
};

function normalizeCommandType(ct) {
  switch (String(ct || '').toLowerCase().trim()) {
    case 'gpu': return 'gpu';
    case 'llm': case 'infer': case 'inference': return 'llm';
    case 'io': case 'data': case 'transfer': return 'io';
    case 'cpu': return 'cpu';
    default: return 'cpu';
  }
}

function inferCommandTypeFromText(cmd) {
  const c = String(cmd || '').toLowerCase();
  const has = arr => arr.some(k => c.includes(k));
  if (has(['nvidia', 'cuda', 'gpu', 'llava', 'ollama', 'stable-diffusion', 'whisper', 'yolo', 'comfyui'])) return 'gpu';
  if (has(['llm', 'gpt', 'chat', 'claude', 'deepseek', 'infer', 'token', 'glm', 'qwen'])) return 'llm';
  if (has(['cp ', 'rsync', 'scp', 'wget', 'curl', 'download', 'upload', 'mv ', 'tar '])) return 'io';
  return 'cpu';
}

// 复刻 kernel.EstimateTokens：区间 min/mid/max + 置信度
function estimateTokens(ct, r) {
  const cores = Math.max(1, Number(r.cpu_cores) || 0);
  const dur = Number(r.est_duration) > 0 ? Number(r.est_duration) : 60;
  const dataMB = Number(r.data_mb) || 0;
  const gpuCount = Number(r.gpu && r.gpu.count) || 0;
  let mid;
  switch (ct) {
    case 'gpu': {
      let cardMin = (dur / 60.0) * TOKEN_COEFF.GPU;
      if (gpuCount > 0) cardMin *= gpuCount; else cardMin = 1;
      mid = cardMin + cores * dur / 60.0 * TOKEN_COEFF.CPU;
      break;
    }
    case 'llm': {
      const kIn = (dataMB * 2500) / 1000.0;
      mid = kIn * TOKEN_COEFF.LLM * dur / 60.0;
      break;
    }
    case 'io':
      mid = (dataMB / 100.0) * TOKEN_COEFF.IO + (dur / 60.0) * TOKEN_COEFF.CPU;
      break;
    default:
      mid = cores * dur / 60.0 * TOKEN_COEFF.CPU;
  }
  if (mid < 1) mid = 1;
  return { min: mid * 0.7, mid, max: mid * 1.8, confidence: CONFIDENCE, basis: 'v1-estimator' };
}
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 会话 7 天
const PUBLIC_DIR = path.join(__dirname, 'public');

// ============ 数据库初始化 ============
const db = new DatabaseSync(DB_PATH);
db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    pass_hash TEXT NOT NULL,
    salt TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    username TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(username);
`);
console.log(`[db] 数据库就绪: ${DB_PATH}`);

// ============ 密码哈希 (scrypt + 随机盐) ============
function hashPassword(password, salt) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, 64, { N: 16384, r: 8, p: 1 }, (err, key) => {
      if (err) reject(err);
      else resolve(key.toString('hex'));
    });
  });
}
function verifyPassword(password, salt, expectedHash) {
  return hashPassword(password, salt).then(h =>
    crypto.timingSafeEqual(Buffer.from(h, 'hex'), Buffer.from(expectedHash, 'hex'))
  ).catch(() => false);
}

// ============ 会话 token ============
function createToken() {
  return crypto.randomBytes(32).toString('hex');
}
function insertSession(token, username) {
  db.prepare('INSERT INTO sessions (token, username, created_at, expires_at) VALUES (?,?,?,?)')
    .run(token, username, Date.now(), Date.now() + SESSION_TTL_MS);
}
function getValidSession(token) {
  if (!token) return null;
  const row = db.prepare('SELECT * FROM sessions WHERE token = ?').get(token);
  if (!row) return null;
  if (row.expires_at < Date.now()) {
    db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
    return null;
  }
  return row;
}

// ============ HTTP 工具 ============
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', c => { data += c; if (data.length > 1e6) { reject(new Error('body too large')); req.destroy(); } });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}
function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(body);
}
function tokenFromReq(req) {
  // 优先 Authorization: Bearer，其次 ?token=
  const h = req.headers['authorization'] || '';
  if (h.startsWith('Bearer ')) return h.slice(7).trim();
  return (req.url || '').includes('token=')
    ? new URLSearchParams((req.url.split('?')[1] || '')).get('token')
    : null;
}

// ============ ComputeHub 反向代理 ============
// 前端只跟本服务同源通信，/api/v1/* 全部转发给 ComputeHub Gateway，
// 避免浏览器直连 8282 的跨域 + 硬编码端口问题。
function proxyToUpstream(req, res, pathname) {
  let target;
  try { target = new URL(UPSTREAM); } catch { return json(res, 500, { ok: false, error: 'UPSTREAM 配置无效' }); }
  const opts = {
    hostname: target.hostname,
    port: target.port || 80,
    path: pathname + (req.url.includes('?') ? '?' + req.url.split('?').slice(1).join('?') : ''),
    method: req.method,
    headers: { ...req.headers, host: target.host },
    timeout: 60000,
  };
  const preq = http.request(opts, pres => {
    res.writeHead(pres.statusCode, {
      'Content-Type': pres.headers['content-type'] || 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'Access-Control-Allow-Origin': '*',
    });
    pres.pipe(res);
  });
  preq.on('timeout', () => { preq.destroy(new Error('上游超时')); });
  preq.on('error', e => {
    if (!res.headersSent) json(res, 502, { ok: false, error: 'ComputeHub 上游不可达: ' + e.message, upstream: UPSTREAM });
  });
  req.pipe(preq);
}

// ============ 本地报价 ============
// POST /api/v1/tasks/estimate — 不依赖上游，直接算（与 kernel 同公式）
async function handleEstimate(req, res) {
  if (req.method !== 'POST') return json(res, 405, { ok: false, error: '仅支持 POST' });
  let body;
  try { body = JSON.parse((await readBody(req)) || '{}'); }
  catch { return json(res, 400, { ok: false, error: 'JSON 格式错误' }); }

  const res_ = body.resources || {};
  let ct = body.command_type || '';
  if (!ct && body.command) ct = inferCommandTypeFromText(body.command);
  if (!ct) ct = 'cpu';
  ct = normalizeCommandType(ct);
  if (!(Number(res_.cpu_cores) > 0)) res_.cpu_cores = 1;
  if (!(Number(res_.est_duration) > 0)) res_.est_duration = 60;

  const est = estimateTokens(ct, res_);
  return json(res, 200, {
    id: '', success: true,
    data: { command_type: ct, resources: res_, estimate: est, pricing: PRICING },
  });
}

// ============ 静态文件 ============
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};
function serveStatic(req, res, pathname) {
  let rel = pathname === '/' ? '/index.html' : pathname;
  const filePath = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403); res.end('Forbidden'); return;
  }
  fs.readFile(filePath, (err, buf) => {
    if (err) {
      // SPA fallback
      if (!path.extname(filePath)) {
        fs.readFile(path.join(PUBLIC_DIR, 'index.html'), (e2, b2) => {
          if (e2) { res.writeHead(404); res.end('Not Found'); }
          else { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(b2); }
        });
      } else { res.writeHead(404); res.end('Not Found'); }
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream' });
    res.end(buf);
  });
}

// ============ API Handlers ============
async function handleRegister(req, res) {
  if (req.method !== 'POST') return json(res, 405, { ok: false, error: '仅支持 POST' });
  let body;
  try { body = JSON.parse(await readBody(req) || '{}'); } catch { return json(res, 400, { ok: false, error: 'JSON 格式错误' }); }
  const username = (body.username || '').trim();
  const password = body.password || '';

  if (!/^[a-zA-Z0-9_\u4e00-\u9fa5]{2,32}$/.test(username))
    return json(res, 400, { ok: false, error: '用户名需 2-32 位（中文/字母/数字/下划线）' });
  if (password.length < 6)
    return json(res, 400, { ok: false, error: '密码至少 6 位' });

  const exists = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
  if (exists) return json(res, 409, { ok: false, error: '用户名已存在' });

  const salt = crypto.randomBytes(16).toString('hex');
  const passHash = await hashPassword(password, salt);
  db.prepare('INSERT INTO users (username, pass_hash, salt, created_at) VALUES (?,?,?,?)')
    .run(username, passHash, salt, Date.now());

  console.log(`[auth] 新用户注册: ${username}`);
  return json(res, 201, { ok: true, username });
}

async function handleLogin(req, res) {
  if (req.method !== 'POST') return json(res, 405, { ok: false, error: '仅支持 POST' });
  let body;
  try { body = JSON.parse(await readBody(req) || '{}'); } catch { return json(res, 400, { ok: false, error: 'JSON 格式错误' }); }
  const username = (body.username || '').trim();
  const password = body.password || '';
  if (!username || !password) return json(res, 400, { ok: false, error: '请输入用户名和密码' });

  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (!user) return json(res, 401, { ok: false, error: '用户名或密码错误' });

  const ok = await verifyPassword(password, user.salt, user.pass_hash);
  if (!ok) return json(res, 401, { ok: false, error: '用户名或密码错误' });

  const token = createToken();
  insertSession(token, username);
  console.log(`[auth] 登录成功: ${username}`);
  return json(res, 200, { ok: true, token, username });
}

function handleMe(req, res) {
  const token = tokenFromReq(req);
  const session = getValidSession(token);
  if (!session) return json(res, 401, { ok: false, error: '未登录或会话已过期' });
  return json(res, 200, { ok: true, username: session.username });
}

function handleLogout(req, res) {
  if (req.method !== 'POST') return json(res, 405, { ok: false, error: '仅支持 POST' });
  const token = tokenFromReq(req);
  if (token) db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
  return json(res, 200, { ok: true });
}

// ============ 路由 ============
const server = http.createServer(async (req, res) => {
  const pathname = decodeURIComponent(new URL(req.url, 'http://x').pathname);

  try {
    // CORS 预检
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type,Authorization',
      });
      return res.end();
    }

    if (pathname === '/api/register') return await handleRegister(req, res);
    if (pathname === '/api/login') return await handleLogin(req, res);
    if (pathname === '/api/me') return handleMe(req, res);
    if (pathname === '/api/logout') return handleLogout(req, res);
    if (pathname === '/api/health') return json(res, 200, { ok: true, ts: Date.now() });
    if (pathname === '/api/config') return json(res, 200, { ok: true, upstream: UPSTREAM, port: PORT });

    // 报价走本地（生产 gateway 尚未编译 market handler）
    if (pathname === '/api/v1/tasks/estimate') return await handleEstimate(req, res);

    // 其余 ComputeHub API 反代（节点/下单/订单）
    if (pathname.startsWith('/api/v1/')) return proxyToUpstream(req, res, pathname);

    // 其余走静态文件
    return serveStatic(req, res, pathname);
  } catch (e) {
    console.error('[error]', e);
    return json(res, 500, { ok: false, error: '服务器内部错误: ' + e.message });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`\n⚡ 算力商城 (Compute Market) 已启动`);
  console.log(`   本地访问: http://${HOST}:${PORT}`);
  console.log(`   数据库:   ${DB_PATH}`);
  console.log(`   上游网关: ${UPSTREAM}`);
  console.log(`\n`);
});

process.on('SIGINT', () => { db.close(); process.exit(0); });
process.on('SIGTERM', () => { db.close(); process.exit(0); });
