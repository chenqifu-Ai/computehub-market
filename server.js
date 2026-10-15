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
  console.log(`\n`);
});

process.on('SIGINT', () => { db.close(); process.exit(0); });
process.on('SIGTERM', () => { db.close(); process.exit(0); });
