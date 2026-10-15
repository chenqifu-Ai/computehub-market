/**
 * store.js — 数据库层（SQLite，schema + 用户/令牌/渠道/日志 CRUD）
 * 零依赖：node:sqlite + node:crypto
 */
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

// ---------- 打开 / 迁移 ----------
function open(dbPath) {
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  return db;
}

function migrate(db) {
  db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    username      TEXT UNIQUE NOT NULL,
    display_name  TEXT NOT NULL DEFAULT '',
    pass_hash     TEXT NOT NULL,
    salt          TEXT NOT NULL,
    quota         INTEGER NOT NULL DEFAULT 0,     -- 剩余额度 (500000 = $1)
    used_quota    INTEGER NOT NULL DEFAULT 0,     -- 已用额度
    request_count INTEGER NOT NULL DEFAULT 0,
    group_name    TEXT NOT NULL DEFAULT 'default',
    role          INTEGER NOT NULL DEFAULT 1,     -- 1=user 100=admin
    status        INTEGER NOT NULL DEFAULT 1,     -- 1 启用 / 2 禁用
    aff_code      TEXT NOT NULL DEFAULT '',
    remark        TEXT NOT NULL DEFAULT '',
    last_login_ip TEXT NOT NULL DEFAULT '',
    created_at    INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token      TEXT PRIMARY KEY,
    user_id    INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

  CREATE TABLE IF NOT EXISTS tokens (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id         INTEGER NOT NULL,
    name            TEXT NOT NULL DEFAULT 'default',
    key_plain       TEXT NOT NULL,               -- sk- 后面的明文（用于展示/复制）
    key_hash        TEXT UNIQUE NOT NULL,        -- sha256(key)  用于快速查
    status          INTEGER NOT NULL DEFAULT 1,  -- 1 启用 / 2 禁用
    remain_quota    INTEGER NOT NULL DEFAULT 0,
    unlimited_quota INTEGER NOT NULL DEFAULT 1,  -- 1 无限 / 0 限额
    used_quota      INTEGER NOT NULL DEFAULT 0,
    model_limits    TEXT NOT NULL DEFAULT '',     -- 逗号分隔，空=不限
    allow_ips       TEXT NOT NULL DEFAULT '',
    expired_time    INTEGER NOT NULL DEFAULT -1,  -- -1 永不过期
    created_time    INTEGER NOT NULL,
    accessed_time   INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_tokens_user ON tokens(user_id);

  CREATE TABLE IF NOT EXISTS channels (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    name          TEXT NOT NULL,
    type          INTEGER NOT NULL DEFAULT 1,     -- 1=OpenAI兼容
    base_url      TEXT NOT NULL,
    api_key       TEXT NOT NULL DEFAULT '',
    models        TEXT NOT NULL DEFAULT '',       -- 逗号分隔（上游真实模型名）
    model_mapping TEXT NOT NULL DEFAULT '',       -- JSON: {"对外名":"上游名"}
    weight        INTEGER NOT NULL DEFAULT 1,     -- 负载权重
    priority      INTEGER NOT NULL DEFAULT 0,     -- 越大越优先
    status        INTEGER NOT NULL DEFAULT 1,
    used_quota    INTEGER NOT NULL DEFAULT 0,
    balance       REAL NOT NULL DEFAULT 0,
    tested_at     INTEGER NOT NULL DEFAULT 0,
    created_at    INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS logs (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id           INTEGER NOT NULL,
    username          TEXT NOT NULL DEFAULT '',
    token_id          INTEGER NOT NULL DEFAULT 0,
    token_name        TEXT NOT NULL DEFAULT '',
    model_name        TEXT NOT NULL DEFAULT '',
    channel_id        INTEGER NOT NULL DEFAULT 0,
    channel_name      TEXT NOT NULL DEFAULT '',
    prompt_tokens     INTEGER NOT NULL DEFAULT 0,
    completion_tokens INTEGER NOT NULL DEFAULT 0,
    total_tokens      INTEGER NOT NULL DEFAULT 0,
    quota             INTEGER NOT NULL DEFAULT 0,
    use_time          REAL NOT NULL DEFAULT 0,
    is_stream         INTEGER NOT NULL DEFAULT 0,
    ip                TEXT NOT NULL DEFAULT '',
    request_id        TEXT NOT NULL DEFAULT '',
    status            TEXT NOT NULL DEFAULT 'success',
    error             TEXT NOT NULL DEFAULT '',
    created_at        INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_logs_user ON logs(user_id, created_at DESC);
  `);
}

// ---------- 密码 ----------
function hashPassword(password, salt) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, 64, { N: 16384, r: 8, p: 1 }, (e, k) =>
      e ? reject(e) : resolve(k.toString('hex')));
  });
}
async function verifyPassword(password, salt, expected) {
  try {
    const h = await hashPassword(password, salt);
    const a = Buffer.from(h, 'hex'), b = Buffer.from(expected, 'hex');
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch { return false; }
}

// ---------- 用户 ----------
function getUserByName(db, username) {
  return db.prepare('SELECT * FROM users WHERE username = ?').get(username) || null;
}
function getUserById(db, id) {
  return db.prepare('SELECT * FROM users WHERE id = ?').get(id) || null;
}
function isAdmin(u) { return !!u && u.role >= 100; }

async function createUser(db, username, password, opts = {}) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = await hashPassword(password, salt);
  const aff = crypto.randomBytes(4).toString('hex').slice(0, 6);
  const info = db.prepare(`
    INSERT INTO users (username, display_name, pass_hash, salt, quota, group_name, role, aff_code, created_at)
    VALUES (?,?,?,?,?,?,?,?,?)
  `).run(
    username, opts.display_name || username, hash, salt,
    parseInt(opts.quota || 0, 10),
    opts.group_name || 'default',
    parseInt(opts.role || 1, 10),
    aff, Date.now(),
  );
  return getUserById(db, Number(info.lastInsertRowid));
}
function publicUser(db, u) {
  return {
    id: u.id,
    username: u.username,
    display_name: u.display_name,
    quota: u.quota,
    used_quota: u.used_quota,
    request_count: u.request_count,
    group: u.group_name,
    role: u.role,
    status: u.status,
    aff_code: u.aff_code,
    remark: u.remark,
    created_at: u.created_at,
  };
}
async function setPasswordReal(db, id, plain) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = await hashPassword(plain, salt);
  db.prepare('UPDATE users SET pass_hash=?, salt=? WHERE id=?').run(hash, salt, id);
}
function setDisplayName(db, id, name) {
  db.prepare('UPDATE users SET display_name=? WHERE id=?').run(name, id);
}
function touchLogin(db, id, ip) {
  db.prepare('UPDATE users SET last_login_ip=? WHERE id=?').run(ip || '', id);
}
function addUserUsage(db, id, quota, tokens = 1) {
  db.prepare('UPDATE users SET used_quota = used_quota + ?, quota = MAX(0, quota - ?), request_count = request_count + ? WHERE id = ?')
    .run(quota, quota, tokens, id);
}
function addUserQuota(db, id, amount) {
  db.prepare('UPDATE users SET quota = quota + ? WHERE id = ?').run(amount, id);
  return getUserById(db, id);
}
function userDashboard(db, u) {
  const row = db.prepare(`
    SELECT COUNT(*) AS reqs,
           COALESCE(SUM(quota),0) AS quota,
           COALESCE(SUM(total_tokens),0) AS tokens
    FROM logs WHERE user_id = ?
  `).get(u.id);
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const t = db.prepare(`
    SELECT COUNT(*) AS reqs, COALESCE(SUM(quota),0) AS quota, COALESCE(SUM(total_tokens),0) AS tokens
    FROM logs WHERE user_id = ? AND created_at >= ?
  `).get(u.id, today.getTime());
  return {
    quota: u.quota, used_quota: u.used_quota, request_count: u.request_count,
    total: { requests: row.reqs, quota: row.quota, tokens: row.tokens },
    today: { requests: t.reqs, quota: t.quota, tokens: t.tokens },
  };
}

// ---------- 会话 ----------
function createSession(db, userId, ttlMs) {
  const t = crypto.randomBytes(32).toString('hex');
  db.prepare('INSERT INTO sessions (token,user_id,created_at,expires_at) VALUES (?,?,?,?)')
    .run(t, userId, Date.now(), Date.now() + ttlMs);
  return t;
}
function getSession(db, token) {
  if (!token) return null;
  const r = db.prepare('SELECT * FROM sessions WHERE token = ?').get(token);
  if (!r) return null;
  if (r.expires_at < Date.now()) { db.prepare('DELETE FROM sessions WHERE token=?').run(token); return null; }
  return r;
}
function deleteSession(db, token) { db.prepare('DELETE FROM sessions WHERE token=?').run(token); }

// ---------- 令牌 ----------
function newTokenKey() {
  // 48 字符随机，sk- 前缀在展示时加
  return crypto.randomBytes(24).toString('base64url').slice(0, 48);
}
function hashKey(plain) { return crypto.createHash('sha256').update(plain).digest('hex'); }

function createToken(db, userId, opts = {}) {
  const plain = newTokenKey();
  const info = db.prepare(`
    INSERT INTO tokens (user_id,name,key_plain,key_hash,status,remain_quota,unlimited_quota,model_limits,allow_ips,expired_time,created_time)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    userId, opts.name || 'default', plain, hashKey(plain), 1,
    parseInt(opts.quota || 0, 10), opts.unlimited === false ? 0 : 1,
    opts.modelLimits || '', opts.allowIps || '',
    parseInt(opts.expiredTime ?? -1, 10), Date.now(),
  );
  return getToken(db, Number(info.lastInsertRowid));
}
function getToken(db, id) { return db.prepare('SELECT * FROM tokens WHERE id=?').get(id) || null; }
function getTokenByPlain(db, plain) {
  return db.prepare('SELECT * FROM tokens WHERE key_hash=?').get(hashKey(plain)) || null;
}
function listTokens(db, userId) {
  const rows = db.prepare('SELECT * FROM tokens WHERE user_id=? ORDER BY id DESC').all(userId);
  return { items: rows.map(maskToken), total: rows.length };
}
function maskToken(t) {
  const p = t.key_plain || '';
  return {
    id: t.id, name: t.name, status: t.status,
    remain_quota: t.remain_quota, unlimited_quota: t.unlimited_quota, used_quota: t.used_quota,
    model_limits: t.model_limits, model_limits_enabled: !!t.model_limits,
    allow_ips: t.allow_ips,
    key: p.slice(0, 4) + '**********' + p.slice(-4),
    created_time: t.created_time, accessed_time: t.accessed_time, expired_time: t.expired_time,
    group: 'default',
  };
}
function updateToken(db, id, b) {
  const f = [];
  const v = [];
  const set = (col, val) => { f.push(col + '=?'); v.push(val); };
  if (b.name !== undefined) set('name', String(b.name).slice(0, 32));
  if (b.status !== undefined) set('status', parseInt(b.status, 10));
  if (b.remain_quota !== undefined) set('remain_quota', parseInt(b.remain_quota, 10));
  if (b.unlimited_quota !== undefined) set('unlimited_quota', b.unlimited_quota ? 1 : 0);
  if (b.model_limits !== undefined) set('model_limits', String(b.model_limits));
  if (b.allow_ips !== undefined) set('allow_ips', String(b.allow_ips));
  if (f.length) { v.push(id); db.prepare(`UPDATE tokens SET ${f.join(',')} WHERE id=?`).run(...v); }
}
function deleteToken(db, id) { db.prepare('DELETE FROM tokens WHERE id=?').run(id); }
function touchToken(db, id) { db.prepare('UPDATE tokens SET accessed_time=? WHERE id=?').run(Date.now(), id); }
function addTokenUsage(db, id, quota) {
  db.prepare('UPDATE tokens SET used_quota = used_quota + ?, remain_quota = CASE WHEN unlimited_quota=1 THEN remain_quota ELSE MAX(0, remain_quota - ?) END WHERE id=?')
    .run(quota, quota, id);
}

// ---------- 渠道 ----------
function seedChannels(db, jsonPath) {
  const n = db.prepare('SELECT COUNT(*) c FROM channels').get().c;
  if (n > 0) return;
  let cfgs = [];
  try { cfgs = JSON.parse(fs.readFileSync(jsonPath, 'utf8')); } catch { return; }
  const stmt = db.prepare(`
    INSERT INTO channels (name,type,base_url,api_key,models,model_mapping,weight,priority,status,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)
  `);
  for (const c of cfgs) {
    stmt.run(c.name, c.type || 1, c.base_url, c.api_key || '',
      Array.isArray(c.models) ? c.models.join(',') : (c.models || ''),
      c.model_mapping ? JSON.stringify(c.model_mapping) : '',
      c.weight || 1, c.priority || 0, c.status === 0 ? 0 : 1, Date.now());
  }
  console.log(`[db] 已导入 ${cfgs.length} 个上游渠道`);
}
function listChannels(db, withKey = true) {
  const rows = db.prepare('SELECT * FROM channels ORDER BY priority DESC, id ASC').all();
  return rows.map(c => withKey ? c : { ...c, api_key: c.api_key ? c.api_key.slice(0, 6) + '…' + c.api_key.slice(-4) : '' });
}
function listChannelsRaw(db) { return db.prepare('SELECT * FROM channels ORDER BY priority DESC, id ASC').all(); }
function getChannel(db, id) { return db.prepare('SELECT * FROM channels WHERE id=?').get(id) || null; }
function addChannelUsage(db, id, quota) {
  db.prepare('UPDATE channels SET used_quota = used_quota + ? WHERE id=?').run(quota, id);
}

// 找出能服务某模型的渠道（按优先级/权重）
function channelsForModel(db, model) {
  const all = listChannelsRaw(db).filter(c => c.status === 1);
  const hit = [];
  for (const c of all) {
    let list = [];
    try { list = c.models ? c.models.split(',').map(s => s.trim()).filter(Boolean) : []; } catch {}
    let map = {};
    try { map = c.model_mapping ? JSON.parse(c.model_mapping) : {}; } catch {}
    const names = new Set([...list, ...Object.keys(map)]);
    if (names.size === 0 || names.has(model)) hit.push(c);
  }
  return hit;
}

// 对外模型目录（聚合所有渠道的模型名）
function publicModelCatalog(db) {
  const all = listChannelsRaw(db).filter(c => c.status === 1);
  const set = new Set();
  for (const c of all) {
    (c.models || '').split(',').map(s => s.trim()).filter(Boolean).forEach(m => set.add(m));
    try { Object.keys(c.model_mapping ? JSON.parse(c.model_mapping) : {}).forEach(m => set.add(m)); } catch {}
  }
  const models = [...set].sort();
  return { models, count: models.length, groups: ['default'], object: 'list' };
}

function pricingCatalog(db) {
  const all = listChannelsRaw(db).filter(c => c.status === 1);
  const map = {};
  for (const c of all) {
    (c.models || '').split(',').map(s => s.trim()).filter(Boolean).forEach(m => {
      map[m] = map[m] || { model: m, channels: 0 };
      map[m].channels++;
    });
  }
  return Object.values(map).sort((a, b) => a.model.localeCompare(b.model));
}

// ---------- 日志 ----------
function insertLog(db, l) {
  db.prepare(`
    INSERT INTO logs (user_id,username,token_id,token_name,model_name,channel_id,channel_name,
      prompt_tokens,completion_tokens,total_tokens,quota,use_time,is_stream,ip,request_id,status,error,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    l.user_id, l.username || '', l.token_id || 0, l.token_name || '', l.model_name || '',
    l.channel_id || 0, l.channel_name || '', l.prompt_tokens || 0, l.completion_tokens || 0,
    l.total_tokens || 0, l.quota || 0, l.use_time || 0, l.is_stream ? 1 : 0,
    l.ip || '', l.request_id || '', l.status || 'success', l.error || '', Date.now(),
  );
}
function listLogs(db, { userId, p = 1, size = 20 }) {
  const off = (p - 1) * size;
  const total = db.prepare('SELECT COUNT(*) c FROM logs WHERE user_id=?').get(userId).c;
  const items = db.prepare('SELECT * FROM logs WHERE user_id=? ORDER BY id DESC LIMIT ? OFFSET ?').all(userId, size, off);
  return { items, total, page: p, page_size: size };
}
function logStatsByModel(db, userId) {
  return db.prepare(`
    SELECT model_name, COUNT(*) AS count, SUM(prompt_tokens) AS prompt_tokens,
           SUM(completion_tokens) AS completion_tokens, SUM(quota) AS quota,
           AVG(use_time) AS avg_time
    FROM logs WHERE user_id=? GROUP BY model_name ORDER BY count DESC
  `).all(userId);
}

// ---------- 管理 ----------
function listUsers(db) {
  return db.prepare('SELECT * FROM users ORDER BY id ASC').all().map(publicUser);
}
function adminUpdateUser(db, id, b) {
  const f = [], v = [];
  const set = (c, val) => { f.push(c + '=?'); v.push(val); };
  if (b.quota !== undefined) set('quota', parseInt(b.quota, 10));
  if (b.add_quota !== undefined) { v.push(id); db.prepare('UPDATE users SET quota = MAX(0, quota + ?) WHERE id=?').run(parseInt(b.add_quota, 10)); }
  if (b.status !== undefined) set('status', parseInt(b.status, 10));
  if (b.role !== undefined) set('role', parseInt(b.role, 10));
  if (b.group_name !== undefined) set('group_name', String(b.group_name));
  if (b.remark !== undefined) set('remark', String(b.remark));
  if (f.length) { v.push(id); db.prepare(`UPDATE users SET ${f.join(',')} WHERE id=?`).run(...v); }
  return publicUser(getUserById(db, id));
}
function systemStats(db) {
  const u = db.prepare('SELECT COUNT(*) c, COALESCE(SUM(quota),0) q, COALESCE(SUM(used_quota),0) uq FROM users').get();
  const l = db.prepare('SELECT COUNT(*) c, COALESCE(SUM(quota),0) q, COALESCE(SUM(total_tokens),0) t FROM logs').get();
  const c = db.prepare('SELECT COUNT(*) c FROM channels').get();
  return { users: u.c, user_quota: u.q, user_used_quota: u.uq, requests: l.c, log_quota: l.q, tokens: l.t, channels: c.c };
}

module.exports = {
  open, migrate, seedChannels,
  hashPassword, verifyPassword,
  getUserByName, getUserById, isAdmin, createUser, publicUser, setDisplayName,
  setPassword: setPasswordReal, touchLogin, addUserUsage, addUserQuota, userDashboard,
  createSession, getSession, deleteSession,
  createToken, getToken, getTokenByPlain, listTokens, updateToken, deleteToken, touchToken, addTokenUsage,
  listChannels, listChannelsRaw, getChannel, channelsForModel, addChannelUsage,
  publicModelCatalog, pricingCatalog,
  insertLog, listLogs, logStatsByModel,
  listUsers, adminUpdateUser, systemStats,
  hashKey, newTokenKey,
};
