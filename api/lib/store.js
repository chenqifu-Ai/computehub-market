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
  //【索引 2026-10-21】按 id 游标分页需要 (user_id, id) 组合索引；
  // 只有 (user_id, created_at DESC) 时会扫出用户全部行再排序，95.9 万行要 45s。
  // 建 (user_id, id DESC) 后降到 8s，索引本身不影响写入性能。
  // 首次启动时 logs 表可能还不存在 → 忽略，migrate 之后再建。
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_logs_user_id ON logs(user_id, id DESC);'); } catch (e) {}
  // 【锁等待 2026-10-21】WAL 下并发读写时，读端遇到写锁不再立即报
  // "database is locked"，而是最多等 10s 让写事务完成。避免 settle/仪表盘
  // 的同步查询与 relay 高频写互相踩死。
  db.exec('PRAGMA busy_timeout = 10000;');
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
    created_at    INTEGER NOT NULL,
    inviter_id    INTEGER NOT NULL DEFAULT 0,
    invite_reward INTEGER NOT NULL DEFAULT 0,
    agent_level   INTEGER NOT NULL DEFAULT 0,   -- 0=平台直营/1=一级代理/2=二级代理...
    agent_name    TEXT NOT NULL DEFAULT '',     -- 代理显示名
    reward_l1     INTEGER NOT NULL DEFAULT 0,   -- 累计一级返佣
    reward_l2     INTEGER NOT NULL DEFAULT 0,
    reward_l3     INTEGER NOT NULL DEFAULT 0
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
    cached_tokens     INTEGER NOT NULL DEFAULT 0,
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
  -- 【性能 2026-10-21】返佣 JOIN 用 r.request_id='invite:'||c.request_id 连接，
  -- 无索引时全表 SCAN 194万行 → 事件循环卡 266s。加索引后走 SEARCH（O(1)）。
  CREATE INDEX IF NOT EXISTS idx_logs_request_id ON logs(request_id);
  CREATE TABLE IF NOT EXISTS redemptions (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    code          TEXT UNIQUE NOT NULL,
    name          TEXT NOT NULL DEFAULT '',
    quota         INTEGER NOT NULL DEFAULT 0,     -- 可兑换额度
    status        INTEGER NOT NULL DEFAULT 1,     -- 1 未用 / 2 已用 / 3 禁用
    created_by    INTEGER NOT NULL DEFAULT 0,
    used_by       INTEGER NOT NULL DEFAULT 0,
    used_by_name  TEXT NOT NULL DEFAULT '',
    created_time  INTEGER NOT NULL,
    redeemed_time INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL DEFAULT ''
  );

  CREATE TABLE IF NOT EXISTS checkins (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL,
    quota      INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_checkins_user ON checkins(user_id, created_at DESC);

  CREATE TABLE IF NOT EXISTS agent_audit (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    target_user_id INTEGER NOT NULL,            -- 被调整归属的用户
    target_name    TEXT NOT NULL DEFAULT '',
    old_inviter_id INTEGER NOT NULL DEFAULT 0,  -- 变更前上级
    old_inviter    TEXT NOT NULL DEFAULT '',
    new_inviter_id INTEGER NOT NULL DEFAULT 0,  -- 变更后上级
    new_inviter    TEXT NOT NULL DEFAULT '',
    action         TEXT NOT NULL DEFAULT 'reassign', -- reassign/set_level/set_agent
    level_before   INTEGER NOT NULL DEFAULT 0,
    level_after    INTEGER NOT NULL DEFAULT 0,
    agent_name     TEXT NOT NULL DEFAULT '',
    op_user_id     INTEGER NOT NULL DEFAULT 0,  -- 操作人
    op_username    TEXT NOT NULL DEFAULT '',
    op_role        TEXT NOT NULL DEFAULT '',    -- 管理员/代理
    ip             TEXT NOT NULL DEFAULT '',
    created_at     INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_audit_target ON agent_audit(target_user_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_audit_time ON agent_audit(created_at DESC);

  CREATE TABLE IF NOT EXISTS wallet_ledger (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id       INTEGER NOT NULL,            -- 资金变动归属用户
    username      TEXT NOT NULL DEFAULT '',
    delta         INTEGER NOT NULL DEFAULT 0,  -- 变动额度（+ 入账 / - 出账），quota 单位
    balance_after INTEGER NOT NULL DEFAULT 0,  -- 变动后余额
    kind          TEXT NOT NULL DEFAULT '',    -- recharge/transfer_out/transfer_in/redeem/checkin/reward/consume/refund/admin_set/adjust
    detail        TEXT NOT NULL DEFAULT '',    -- 说明
    ref_user_id   INTEGER NOT NULL DEFAULT 0,  -- 关联对象（如划转对手）
    ref_username  TEXT NOT NULL DEFAULT '',
    op_user_id    INTEGER NOT NULL DEFAULT 0,  -- 操作人
    op_username   TEXT NOT NULL DEFAULT '',
    op_role       TEXT NOT NULL DEFAULT '',
    ip            TEXT NOT NULL DEFAULT '',
    request_id    TEXT NOT NULL DEFAULT '',
    remark        TEXT NOT NULL DEFAULT '',
    created_at    INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_ledger_user ON wallet_ledger(user_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_ledger_time ON wallet_ledger(created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_ledger_kind ON wallet_ledger(kind);
  `);

  // 增量迁移（已存在的库补齐字段）
  const cols = db.prepare('PRAGMA table_info(users)').all().map(c => c.name);
  if (!cols.includes('inviter_id')) db.exec('ALTER TABLE users ADD COLUMN inviter_id INTEGER NOT NULL DEFAULT 0');
  if (!cols.includes('invite_reward')) db.exec('ALTER TABLE users ADD COLUMN invite_reward INTEGER NOT NULL DEFAULT 0');
  // 多层级代理：等级(0=平台/1=一级代理...) + 各代已获返佣明细
  if (!cols.includes('agent_level')) db.exec('ALTER TABLE users ADD COLUMN agent_level INTEGER NOT NULL DEFAULT 0');
  if (!cols.includes('agent_name')) db.exec("ALTER TABLE users ADD COLUMN agent_name TEXT NOT NULL DEFAULT ''");
  if (!cols.includes('reward_l1')) db.exec('ALTER TABLE users ADD COLUMN reward_l1 INTEGER NOT NULL DEFAULT 0');
  if (!cols.includes('reward_l2')) db.exec('ALTER TABLE users ADD COLUMN reward_l2 INTEGER NOT NULL DEFAULT 0');
  if (!cols.includes('reward_l3')) db.exec('ALTER TABLE users ADD COLUMN reward_l3 INTEGER NOT NULL DEFAULT 0');
  // 代理指定渠道供应商：该代理（及其名下）的调用强制走此渠道（0=不指定，走通用路由）
  if (!cols.includes('agent_channel_id')) db.exec('ALTER TABLE users ADD COLUMN agent_channel_id INTEGER NOT NULL DEFAULT 0');

  // logs 增量迁移：记录类型（consume/recharge/reward/system/admin）
  const lcols = db.prepare('PRAGMA table_info(logs)').all().map(c => c.name);
  if (!lcols.includes('log_type'))
    db.exec("ALTER TABLE logs ADD COLUMN log_type TEXT NOT NULL DEFAULT 'consume'");
  if (!lcols.includes('source'))
    db.exec("ALTER TABLE logs ADD COLUMN source TEXT NOT NULL DEFAULT ''");
  if (!lcols.includes('cached_tokens'))
    db.exec('ALTER TABLE logs ADD COLUMN cached_tokens INTEGER NOT NULL DEFAULT 0');

  // sessions 增量迁移：身份切换来源（便于免密返回自己）
  const scols = db.prepare('PRAGMA table_info(sessions)').all().map(c => c.name);
  if (!scols.includes('origin_id'))
    db.exec('ALTER TABLE sessions ADD COLUMN origin_id INTEGER NOT NULL DEFAULT 0');
  if (!scols.includes('switch_depth'))
    db.exec('ALTER TABLE sessions ADD COLUMN switch_depth INTEGER NOT NULL DEFAULT 0');
}

function userByAff(db, aff) {
  return db.prepare('SELECT * FROM users WHERE aff_code=?').get(aff) || null;
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
    INSERT INTO users (username, display_name, pass_hash, salt, quota, group_name, role, aff_code, created_at, inviter_id, agent_level, agent_name)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    username, opts.display_name || username, hash, salt,
    parseInt(opts.quota || 0, 10),
    opts.group_name || 'default',
    parseInt(opts.role || 1, 10),
    aff, Date.now(),
    parseInt(opts.inviter_id || 0, 10),
    parseInt(opts.agent_level || 0, 10),
    opts.agent_name || '',
  );
  return getUserById(db, Number(info.lastInsertRowid));
}
function publicUser(db, u) {
  const logCnt = db.prepare('SELECT COUNT(*) c FROM logs WHERE user_id=?').get(u.id).c;
  return {
    id: u.id,
    username: u.username,
    display_name: u.display_name,
    quota: u.quota,
    used_quota: u.used_quota,
    request_count: u.request_count,
    log_count: logCnt,   // 【2026-10-22】迁移弹窗预估导出耗时用
    group: u.group_name,
    role: u.role,
    status: u.status,
    aff_code: u.aff_code,
    inviter_id: u.inviter_id || 0,
    invite_reward: u.invite_reward || 0,
    agent_level: u.agent_level || 0,
    agent_name: u.agent_name || '',
    agent_channel_id: u.role >= 100 ? (u.agent_channel_id || 0) : 0,   // 渠道指派仅管理员可见
    remark: u.remark,
    created_at: u.created_at,
  };
}
// 公开用户视图（不暴露 role / 渠道指派 / 邀请码等敏感字段），供代理及下级接口使用
function publicUserPublic(u) {
  return {
    id: u.id,
    username: u.username,
    display_name: u.display_name,
    quota: u.quota,
    used_quota: u.used_quota,
    request_count: u.request_count,
    status: u.status,
    agent_level: u.agent_level || 0,
    agent_name: u.agent_name || '',
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
/** 改自己的用户名（需唯一） */
function setUsername(db, id, newName) {
  const n = String(newName || '').trim();
  if (!/^[a-zA-Z0-9_\u4e00-\u9fa5]{2,32}$/.test(n)) return { ok: false, message: '用户名需 2-32 位（中文/字母/数字/下划线）' };
  const exist = db.prepare('SELECT id FROM users WHERE username=?').get(n);
  if (exist && exist.id !== id) return { ok: false, message: '用户名已被占用' };
  db.prepare('UPDATE users SET username=? WHERE id=?').run(n, id);
  return { ok: true };
}
/** 批量建用户：按前缀/数量生成，返回创建明细 */
async function bulkCreateUsers(db, { prefix = 'user', count = 1, password = '123456', quota = 0, startIndex, digits = 4, inviter_id = 0, agent_name = '', agent_level = 0 }) {
  const out = [];
  let idx = (startIndex !== undefined && startIndex !== null && startIndex !== '') ? parseInt(startIndex, 10) : 1;
  const pf = String(prefix || 'user').trim() || 'user';
  const n = Math.min(Math.max(parseInt(count, 10) || 1, 1), 200);
  const inviterId = parseInt(inviter_id, 10) || 0;
  const lvl = parseInt(agent_level, 10) || 0;   // 默认不自动设为代理（等级是独立营销标签）
  for (let i = 0; i < n; i++) {
    let uname, guard = 0;
    do {
      uname = pf + String(idx).padStart(parseInt(digits, 10) || 4, '0');
      idx++;
      guard++;
    } while (getUserByName(db, uname) && guard < 100000);   // 跳过已存在
    const u = await createUser(db, uname, String(password || '123456'), {
      quota: parseInt(quota, 10) || 0,
      inviter_id: inviterId, agent_level: lvl, agent_name: String(agent_name || ''),
    });
    out.push({ id: u.id, username: u.username, password: String(password || '123456') });
  }
  return out;
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
/** 额度转移（代理从自己额度划给下级），原子化：先扣源再增目标，源不足则回滚 */
function transferQuota(db, fromId, toId, amount) {
  const amt = parseInt(amount, 10) || 0;
  if (amt <= 0) return { ok: false, message: '划转额度必须大于 0' };
  if (fromId === toId) return { ok: false, message: '不能划转给自己' };
  const from = getUserById(db, fromId); const to = getUserById(db, toId);
  if (!from || !to) return { ok: false, message: '用户不存在' };
  if (from.quota < amt) return { ok: false, message: '余额不足（当前 $' + (from.quota / 500000).toFixed(4) + '）' };
  db.exec('BEGIN');
  try {
    const r = db.prepare('UPDATE users SET quota = quota - ? WHERE id=? AND quota >= ?').run(amt, fromId, amt);
    if (!r.changes) { db.exec('ROLLBACK'); return { ok: false, message: '余额不足' }; }
    db.prepare('UPDATE users SET quota = quota + ? WHERE id=?').run(amt, toId);
    db.exec('COMMIT');
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch {}
    return { ok: false, message: '划转失败: ' + e.message };
  }
  return { ok: true, from: getUserById(db, fromId), to: getUserById(db, toId) };
}
function userDashboard(db, u) {
  const row = db.prepare(`
    SELECT COUNT(*) AS reqs,
           COALESCE(SUM(CASE WHEN quota > 0 THEN quota ELSE 0 END),0) AS quota,
           COALESCE(SUM(total_tokens),0) AS tokens
    FROM logs WHERE user_id = ? AND request_id NOT LIKE 'invite:%'
  `).get(u.id);
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const t = db.prepare(`
    SELECT COUNT(*) AS reqs,
           COALESCE(SUM(CASE WHEN quota > 0 THEN quota ELSE 0 END),0) AS quota,
           COALESCE(SUM(total_tokens),0) AS tokens
    FROM logs WHERE user_id = ? AND created_at >= ? AND request_id NOT LIKE 'invite:%'
  `).get(u.id, today.getTime());
  return {
    quota: u.quota, used_quota: u.used_quota, request_count: u.request_count,
    total: { requests: row.reqs, quota: row.quota, tokens: row.tokens },
    today: { requests: t.reqs, quota: t.quota, tokens: t.tokens },
  };
}

// ---------- 会话 ----------
function createSession(db, userId, ttlMs, opts = {}) {
  const t = crypto.randomBytes(32).toString('hex');
  db.prepare('INSERT INTO sessions (token,user_id,created_at,expires_at,origin_id,switch_depth) VALUES (?,?,?,?,?,?)')
    .run(t, userId, Date.now(), Date.now() + ttlMs, opts.origin_id || 0, opts.switch_depth || 0);
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
function maskKey(k) {
  if (!k) return '(无)';
  if (k.length <= 12) return k.slice(0, 3) + '…';
  return k.slice(0, 6) + '…' + k.slice(-4);
}
function listChannels(db, withKey = true) {
  const rows = db.prepare('SELECT * FROM channels ORDER BY priority DESC, id ASC').all();
  return rows.map(c => withKey ? c : { ...c, api_key: maskKey(c.api_key) });
}
function listChannelsRaw(db) { return db.prepare('SELECT * FROM channels ORDER BY priority DESC, id ASC').all(); }
// 安全视图：隐藏 base_url（含 IP/端口）与 api_key，供非管理员接口使用
function publicChannelView(c) {
  const { base_url, api_key, ...rest } = c;
  return { ...rest, api_key: maskKey(c.api_key || ''), base_url_masked: true };
}
function getChannel(db, id) { return db.prepare('SELECT * FROM channels WHERE id=?').get(id) || null; }
/** 渠道对外可用模型名（models 字段 + model_mapping 键），已禁用返回空 */
function channelPublicModels(db, channelId) {
  const c = getChannel(db, channelId);
  if (!c || c.status !== 1) return [];
  const set = new Set();
  (c.models || '').split(',').map(s => s.trim()).filter(Boolean).forEach(m => set.add(m));
  try { Object.keys(JSON.parse(c.model_mapping || '{}')).forEach(m => set.add(m)); } catch {}
  return [...set].sort();
}
/** 用户「生效指定渠道」完整信息（含可用模型名）；无专线/渠道已删返回 null */
function pinnedChannelInfo(db, userId) {
  const p = agentChannelForUser(db, userId);
  if (!p) return null;
  const ch = getChannel(db, p.channel_id);
  if (!ch) return null;
  return {
    channel_id: ch.id, channel_name: ch.name, status: ch.status,
    owner_id: p.owner_id, owner_name: p.owner_name, depth: p.depth,
    is_owner: p.owner_id === userId,
    models_allowed: channelPublicModels(db, p.channel_id),
  };
}
function addChannelUsage(db, id, quota) {
  db.prepare('UPDATE channels SET used_quota = used_quota + ? WHERE id=?').run(quota, id);
}
function addChannel(db, b) {
  const info = db.prepare(`
    INSERT INTO channels (name,type,base_url,api_key,models,model_mapping,weight,priority,status,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)
  `).run(
    String(b.name || '未命名渠道'), parseInt(b.type || 1, 10), String(b.base_url || ''),
    String(b.api_key || ''), Array.isArray(b.models) ? b.models.join(',') : String(b.models || ''),
    b.model_mapping ? (typeof b.model_mapping === 'string' ? b.model_mapping : JSON.stringify(b.model_mapping)) : '',
    parseInt(b.weight || 1, 10), parseInt(b.priority || 0, 10), b.status === 0 ? 0 : 1, Date.now(),
  );
  return getChannel(db, Number(info.lastInsertRowid));
}
function updateChannel(db, id, b) {
  const f = [], v = [];
  const set = (c, val) => { f.push(c + '=?'); v.push(val); };
  if (b.name !== undefined) set('name', String(b.name));
  if (b.base_url !== undefined) set('base_url', String(b.base_url));
  if (b.api_key !== undefined && String(b.api_key).trim() !== '') set('api_key', String(b.api_key));
  if (b.models !== undefined) set('models', Array.isArray(b.models) ? b.models.join(',') : String(b.models));
  if (b.model_mapping !== undefined) set('model_mapping', typeof b.model_mapping === 'string' ? b.model_mapping : JSON.stringify(b.model_mapping));
  if (b.weight !== undefined) set('weight', parseInt(b.weight, 10));
  if (b.priority !== undefined) set('priority', parseInt(b.priority, 10));
  if (b.status !== undefined) set('status', parseInt(b.status, 10));
  if (f.length) { v.push(id); db.prepare(`UPDATE channels SET ${f.join(',')} WHERE id=?`).run(...v); }
  return getChannel(db, id);
}
function deleteChannel(db, id) { db.prepare('DELETE FROM channels WHERE id=?').run(id); }
function touchChannel(db, id) { db.prepare('UPDATE channels SET tested_at=? WHERE id=?').run(Date.now(), id); }

// 找出能服务某模型的渠道（按优先级/权重）
function channelsForModel(db, model, onlyChannelId) {
  let all = listChannelsRaw(db).filter(c => c.status === 1);
  if (onlyChannelId) all = all.filter(c => c.id === parseInt(onlyChannelId, 10));
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
      prompt_tokens,completion_tokens,cached_tokens,total_tokens,quota,use_time,is_stream,ip,request_id,status,error,created_at,log_type,source)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    l.user_id, l.username || '', l.token_id || 0, l.token_name || '', l.model_name || '',
    l.channel_id || 0, l.channel_name || '', l.prompt_tokens || 0, l.completion_tokens || 0,
    l.cached_tokens || 0, l.total_tokens || 0, l.quota || 0, l.use_time || 0, l.is_stream ? 1 : 0,
    l.ip || '', l.request_id || '', l.status || 'success', l.error || '',
    l.created_at || Date.now(), l.log_type || 'consume', l.source || '',
  );
}
function listLogs(db, { userId, p = 1, size = 20 }) {
  const off = (p - 1) * size;
  // 过滤返佣流水（request_id 以 invite: 开头）——返佣统一在「资金流水」页看，避免刷屏目标任务
  const total = db.prepare("SELECT COUNT(*) c FROM logs WHERE user_id=? AND request_id NOT LIKE 'invite:%'").get(userId).c;
  const items = db.prepare("SELECT * FROM logs WHERE user_id=? AND request_id NOT LIKE 'invite:%' ORDER BY id DESC LIMIT ? OFFSET ?").all(userId, size, off);
  return { items, total, page: p, page_size: size };
}

// 导出用：明细 + 汇总（userId=null 表示全站）
function exportLogs(db, { userId, since = 0, until = 0, limit = 0 } = {}) {
  const cond = [], v = [];
  if (userId) { cond.push('user_id=?'); v.push(userId); }
  if (since) { cond.push('created_at>=?'); v.push(since); }
  if (until) { cond.push('created_at<=?'); v.push(until); }
  cond.push('log_type=?'); v.push('consume');  // 结算/导出只算消费行, 排除 invite: 返佣行(防双计)
  const where = cond.length ? ('WHERE ' + cond.join(' AND ')) : '';
  const lim = limit ? ` LIMIT ${parseInt(limit, 10)}` : '';
  return db.prepare(`SELECT * FROM logs ${where} ORDER BY created_at DESC${lim}`).all(...v);
}
// 流式导出：sqlite 原生 iterate()，百万行不占内存
function* exportLogsIter(db, { userId, since = 0, until = 0, limit = 0, wide = false } = {}) {
  const cond = [], v = [];
  if (userId) { cond.push('user_id=?'); v.push(userId); }
  if (since) { cond.push('created_at>=?'); v.push(since); }
  if (until) { cond.push('created_at<=?'); v.push(until); }
  cond.push('log_type=?'); v.push('consume');
  const where = cond.length ? ('WHERE ' + cond.join(' AND ')) : '';
  const lim = limit ? ` LIMIT ${parseInt(limit, 10)}` : '';
  // 明细列：wide=true（管理员）加 渠道/IP/error 三列；否则窄列
  const COLS = wide
    ? 'id,user_id,username,token_id,token_name,channel_name,model_name,prompt_tokens,completion_tokens,total_tokens,quota,use_time,is_stream,status,error,ip,created_at,log_type'
    : 'id,user_id,username,token_id,token_name,model_name,prompt_tokens,completion_tokens,total_tokens,quota,use_time,is_stream,status,error,created_at,log_type';
  // 【关键修复 2026-10-21】node:sqlite 的 .iterate() 生成器若长时间挂起（如 await 让出事件循环
  // 期间），底层读语句保持打开 = 持续持有读锁/快照，settle 的写事务会 database is locked，
  // 写失败后语句保持 open → 读端永远拿不到快照更新 → 主线程 CPU 100% 死循环卡死全进程。
  // 修法：按 id 游标分页，每批取完立即 close，语句从不跨 await 存活。
  // id 主键自增与 created_at 单调一致，id DESC ≈ created_at DESC。
  const PAGE = 50000;
  // 【关键修复 2026-10-21】node:sqlite 的 .iterate() 生成器若长时间挂起（如 await 让出事件循环
  // 期间），底层读语句保持打开 = 持续持有读锁/快照，settle 的写事务会 database is locked，
  // 写失败后语句保持 open → 读端永远拿不到快照更新 → 主线程 CPU 100% 死循环卡死全进程。
  // 修法：按 id 游标分页，每批取完立即 close，语句从不跨 await 存活。
  // 注意：node:sqlite 单参数调用会当作数组展开，多参数必须用 spread（...v）。
  // 消费方可能提前 break（生成器挂起在页中间），所以按整页边界停 + 尾页 SQL LIMIT 精确截断。
  const LIM = parseInt(limit, 10) || 0;
  const FULL_PAGES = LIM ? Math.floor(LIM / PAGE) : Infinity;
  const REMAINDER = LIM ? LIM % PAGE : 0;
  let full = 0;
  const cur = db.prepare(`SELECT ${COLS} FROM logs ${where ? where + ' AND' : 'WHERE'} id < ? ORDER BY id DESC LIMIT ${PAGE}`);
  let lastId = db.prepare('SELECT MAX(id) m FROM logs').get().m;
  if (lastId == null) return;
  while (full < FULL_PAGES) {
    const page = cur.all(...v, lastId);
    if (!page.length) break;
    full++;
    for (const row of page) yield row;
    lastId = page[page.length - 1].id;
    if (page.length < PAGE) break;
  }
  if (REMAINDER > 0 && full === FULL_PAGES) {
    const tail = db.prepare(`SELECT ${COLS} FROM logs ${where ? where + ' AND' : 'WHERE'} id < ? ORDER BY id DESC LIMIT ${REMAINDER}`);
    for (const row of tail.all(...v, lastId)) yield row;
  }
}
function exportSummary(db, { userId, since = 0, until = 0 } = {}) {
  const cond = []; const v = [];
  if (userId) { cond.push('user_id=?'); v.push(userId); }
  cond.push('created_at>=?'); v.push(since);
  if (until) { cond.push('created_at<=?'); v.push(until); }
  return db.prepare(`
    SELECT user_id, username, token_id, token_name, model_name,
           COUNT(*) AS req_count,
           COALESCE(SUM(prompt_tokens),0) AS prompt_tokens,
           COALESCE(SUM(completion_tokens),0) AS completion_tokens,
           COALESCE(SUM(total_tokens),0) AS total_tokens,
           COALESCE(SUM(quota),0) AS quota
    FROM logs WHERE ${cond.join(' AND ')}
    GROUP BY user_id, username, token_id, token_name, model_name
    ORDER BY user_id, token_id, model_name
  `).all(...v);
}
function logStatsByModel(db, userId) {
  return db.prepare(`
    SELECT model_name, COUNT(*) AS count, SUM(prompt_tokens) AS prompt_tokens,
           SUM(completion_tokens) AS completion_tokens,
           SUM(CASE WHEN quota > 0 THEN quota ELSE 0 END) AS quota,
           AVG(use_time) AS avg_time
    FROM logs WHERE user_id=? AND request_id NOT LIKE 'invite:%'
    GROUP BY model_name ORDER BY count DESC
  `).all(userId);
}

// ---------- 管理 ----------
function listUsers(db) {
  return db.prepare('SELECT * FROM users ORDER BY id ASC').all().map(u => publicUser(db, u));
}
function adminUpdateUser(db, id, b) {
  const f = [], v = [];
  const set = (c, val) => { f.push(c + '=?'); v.push(val); };
  if (b.quota !== undefined) set('quota', parseInt(b.quota, 10));
  if (b.add_quota !== undefined) { db.prepare('UPDATE users SET quota = MAX(0, quota + ?) WHERE id=?').run(parseInt(b.add_quota, 10), id); }
  if (b.status !== undefined) set('status', parseInt(b.status, 10));
  if (b.role !== undefined) set('role', parseInt(b.role, 10));
  if (b.group_name !== undefined) set('group_name', String(b.group_name));
  if (b.remark !== undefined) set('remark', String(b.remark));
  if (f.length) { v.push(id); db.prepare(`UPDATE users SET ${f.join(',')} WHERE id=?`).run(...v); }
  if (b.password) setPasswordReal(db, id, String(b.password));
  return publicUser(db, getUserById(db, id));
}
function systemStats(db) {
  const u = db.prepare('SELECT COUNT(*) c, COALESCE(SUM(quota),0) q, COALESCE(SUM(used_quota),0) uq FROM users').get();
  const l = db.prepare('SELECT COUNT(*) c, COALESCE(SUM(quota),0) q, COALESCE(SUM(total_tokens),0) t FROM logs').get();
  const c = db.prepare('SELECT COUNT(*) c FROM channels').get();
  return { users: u.c, user_quota: u.q, user_used_quota: u.uq, requests: l.c, log_quota: l.q, tokens: l.t, channels: c.c };
}

/**
 * 删除用户（2026-10-21）— 管理员专属，带审计快照 + 级联清理
 * logs 保留（username 字段已冗余），user_id 置负防 join；tokens/sessions/ledger/checkins 删除。
 * 下级 inviter_id 置 0 并写 agent_audit；删除前整用户快照写 agent_audit.agent_name。
 */
function deleteUser(db, target, { opUser, ip = '' } = {}) {
  if (!target) return { ok: false, message: '用户不存在' };
  if (target.role >= 100) return { ok: false, message: '管理员账号不允许删除（可先降级为普通用户再删）' };
  const id = target.id;
  const stat = (sql, ...v) => db.prepare(sql).get(...v);
  const kids = stat('SELECT COUNT(*) c FROM users WHERE inviter_id=?', id).c;
  const snap = JSON.stringify({
    id, username: target.username, display_name: target.display_name,
    quota: target.quota, used_quota: target.used_quota, request_count: target.request_count,
    created_at: target.created_at, inviter_id: target.inviter_id || 0,
    aff_code: target.aff_code, remark: target.remark, deleted_at: Date.now(),
  });
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare('INSERT INTO agent_audit (target_user_id,target_name,old_inviter_id,old_inviter,new_inviter_id,new_inviter,action,level_before,level_after,agent_name,op_user_id,op_username,op_role,ip,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(id, target.username, target.inviter_id || 0, '—', 0, '平台', 'delete-user' + (kids ? '+detach-' + kids : ''), 0, 0, snap,
        opUser ? opUser.id : 0, opUser ? opUser.username : 'system', '管理员', ip, Date.now());
    if (kids > 0) db.prepare('UPDATE users SET inviter_id=0 WHERE inviter_id=?').run(id);
    db.prepare('DELETE FROM tokens WHERE user_id=?').run(id);
    db.prepare('DELETE FROM sessions WHERE user_id=?').run(id);
    db.prepare('DELETE FROM wallet_ledger WHERE user_id=? OR ref_user_id=?').run(id, id);
    db.prepare('DELETE FROM checkins WHERE user_id=?').run(id);
    db.prepare('UPDATE logs SET user_id=-? WHERE user_id=?').run(id, id);
    db.prepare('DELETE FROM users WHERE id=? AND role<100').run(id);
    if (stat('SELECT COUNT(*) c FROM users WHERE id=?', id).c > 0) throw new Error('delete failed');
    db.exec('COMMIT');
    return { ok: true, message: '已删除 ' + target.username + '（ID ' + id + (kids ? '，' + kids + ' 个下级已挂到平台' : '') + '）', detail: { kids_detached: kids, snapshot: snap } };
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch {}
    return { ok: false, message: '删除失败: ' + e.message };
  }
}

// ---------- 兑换码 ----------
async function createRedemptions(db, { count = 1, quota = 0, name = '', createdBy = 0 }) {
  const out = [];
  const stmt = db.prepare('INSERT INTO redemptions (code,name,quota,created_by,created_time) VALUES (?,?,?,?,?)');
  for (let i = 0; i < count; i++) {
    const code = crypto.randomBytes(8).toString('base64url').replace(/[-_]/g, 'x').slice(0, 12).toUpperCase();
    try {
      const info = stmt.run(code, name, quota, createdBy, Date.now());
      out.push(db.prepare('SELECT * FROM redemptions WHERE id=?').get(Number(info.lastInsertRowid)));
    } catch { i--; }   // 撞码重试
  }
  return out;
}
function getRedemption(db, code) {
  return db.prepare('SELECT * FROM redemptions WHERE code=?').get(String(code).toUpperCase().trim()) || null;
}
function redeemCode(db, user, code) {
  const r = getRedemption(db, code);
  if (!r) return { ok: false, message: '兑换码不存在' };
  if (r.status === 2) return { ok: false, message: '兑换码已被使用' };
  if (r.status === 3) return { ok: false, message: '兑换码已禁用' };
  db.prepare('UPDATE redemptions SET status=2, used_by=?, used_by_name=?, redeemed_time=? WHERE id=? AND status=1')
    .run(user.id, user.username, Date.now(), r.id);
  addUserQuota(db, user.id, r.quota);
  return { ok: true, quota: r.quota, user: getUserById(db, user.id) };
}
function listRedemptions(db, { p = 1, size = 50 } = {}) {
  const total = db.prepare('SELECT COUNT(*) c FROM redemptions').get().c;
  const items = db.prepare('SELECT * FROM redemptions ORDER BY id DESC LIMIT ? OFFSET ?')
    .all(size, (p - 1) * size);
  return { items, total, page: p, page_size: size };
}
function setRedemptionStatus(db, id, status) {
  db.prepare('UPDATE redemptions SET status=? WHERE id=?').run(parseInt(status, 10), id);
}
function deleteRedemption(db, id) { db.prepare('DELETE FROM redemptions WHERE id=?').run(id); }

// ---------- 设置 ----------
const DEFAULT_SETTINGS = {
  site_name: '算力商城 API',
  signup_quota: '0',            // 注册赠送额度
  checkin_quota: '0',           // 每日签到额度
  rate_limit_per_min: '120',    // 每令牌每分钟请求上限（0=不限）
  invite_reward_rate: '0.1',    // 一级返佣率（下线消费 × 此率）
  agent_reward_l2: '0.05',      // 二级返佣率（上上级）
  agent_reward_l3: '0.02',      // 三级返佣率
  agent_manage_downline: '1',   // 代理可否管理自己下级（1=可）
  announcement: '',
};
function getSettings(db) {
  const rows = db.prepare('SELECT key,value FROM settings').all();
  const out = { ...DEFAULT_SETTINGS };
  for (const r of rows) out[r.key] = r.value;
  return out;
}
function getSetting(db, key) { return getSettings(db)[key]; }
function setSettings(db, obj) {
  const stmt = db.prepare('INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value');
  for (const [k, v] of Object.entries(obj || {})) {
    if (k in DEFAULT_SETTINGS && v !== undefined && v !== null) stmt.run(k, String(v));
  }
  return getSettings(db);
}

// ---------- 邀请 ----------
function getInviter(db, user) {
  if (!user || !user.inviter_id) return null;
  return getUserById(db, user.inviter_id);
}
function listInvitees(db, user) {
  return db.prepare('SELECT id,username,created_at FROM users WHERE inviter_id=? ORDER BY id DESC').all(user.id);
}
function setInviter(db, userId, inviterId) {
  db.prepare('UPDATE users SET inviter_id=? WHERE id=?').run(inviterId, userId);
}
function inviteStats(db, user) {
  const invited = db.prepare('SELECT COUNT(*) c FROM users WHERE inviter_id=?').get(user.id).c;
  return { invited, reward_quota: user.invite_reward || 0 };
}
function addInviteReward(db, userId, quota) {
  db.prepare('UPDATE users SET invite_reward = invite_reward + ? WHERE id=?').run(quota, userId);
}

// ---------- 多层级代理 ----------
/** 沿 inviter_id 链向上取上级（最多 depth 层） */
function getUpline(db, userId, depth = 3) {
  const chain = [];
  let cur = getUserById(db, userId);
  for (let i = 0; i < depth && cur && cur.inviter_id; i++) {
    const p = getUserById(db, cur.inviter_id);
    if (!p) break;
    chain.push(p);
    cur = p;
  }
  return chain;   // [一级上级, 二级上级, 三级上级]
}
/** 下级树（递归，带深度 + 消费/返佣汇总） */
function listDownline(db, userId, { maxDepth = 5, since = 0 } = {}) {
  const out = [];
  const walk = (pid, depth) => {
    if (depth > maxDepth) return;
    const kids = db.prepare('SELECT id,username,display_name,agent_level,agent_name, CASE WHEN role>=100 THEN agent_channel_id ELSE 0 END AS agent_channel_id, quota,used_quota,request_count,status,created_at FROM users WHERE inviter_id=? ORDER BY id').all(pid);
    for (const k of kids) {
      const agg = db.prepare(`SELECT COUNT(*) c, COALESCE(SUM(quota),0) q FROM logs WHERE user_id=? AND request_id NOT LIKE 'invite:%'${since ? ' AND created_at>=?' : ''}`)
        .get(...(since ? [k.id, since] : [k.id]));
      out.push({ ...k, depth, direct_req: agg.c, direct_consume: agg.q });
      walk(k.id, depth + 1);
    }
  };
  walk(userId, 1);
  return out;
}
/** 某用户的整棵团队统计（各级人数 + 各级消费 + 本户累计返佣） */
function teamStats(db, userId) {
  const down = listDownline(db, userId, { maxDepth: 5 });
  const byDepth = {};
  for (const d of down) {
    byDepth[d.depth] = byDepth[d.depth] || { users: 0, consume: 0 };
    byDepth[d.depth].users++;
    byDepth[d.depth].consume += d.direct_consume || 0;
  }
  const u = getUserById(db, userId);
  return {
    direct: down.filter(d => d.depth === 1).length,
    total: down.length,
    byDepth,
    reward_l1: u.reward_l1 || 0, reward_l2: u.reward_l2 || 0, reward_l3: u.reward_l3 || 0,
    reward_total: (u.invite_reward || 0),
  };
}
/** 设置用户上级（防环：不能挂到自己的下级） */
function setInviterSafe(db, userId, inviterId) {
  if (userId === inviterId) return { ok: false, message: '不能成为自己的上级' };
  if (inviterId) {
    // 若 inviterId 在 userId 的下级链中 → 会成环
    const down = listDownline(db, userId, { maxDepth: 20 }).map(d => d.id);
    if (down.includes(inviterId)) return { ok: false, message: '不能挂到自己的下级（会形成环）' };
  }
  db.prepare('UPDATE users SET inviter_id=? WHERE id=?').run(inviterId || 0, userId);
  return { ok: true };
}
/** 设置代理等级/名称/指定渠道 */
function setAgentInfo(db, userId, { agent_level, agent_name, agent_channel_id }) {
  const f = [], v = [];
  if (agent_level !== undefined) { f.push('agent_level=?'); v.push(parseInt(agent_level, 10) || 0); }
  if (agent_name !== undefined) { f.push('agent_name=?'); v.push(String(agent_name)); }
  if (agent_channel_id !== undefined) { f.push('agent_channel_id=?'); v.push(parseInt(agent_channel_id, 10) || 0); }
  if (f.length) { v.push(userId); db.prepare(`UPDATE users SET ${f.join(',')} WHERE id=?`).run(...v); }
  return getUserById(db, userId);
}

/**
 * 解析某用户「生效的指定渠道」：从自己沿 inviter_id 链向上，取最近一个设了 agent_channel_id 的代理。
 * 返回 { channel_id, owner_id, owner_name, depth }（自己 depth=0）或 null。
 */
function agentChannelForUser(db, userId, maxDepth = 6) {
  let cur = getUserById(db, userId);
  for (let d = 0; cur && d <= maxDepth; d++) {
    const cid = parseInt(cur.agent_channel_id, 10) || 0;
    if (cid > 0) return { channel_id: cid, owner_id: cur.id, owner_name: cur.username, depth: d };
    if (!cur.inviter_id) break;
    cur = getUserById(db, cur.inviter_id);
  }
  return null;
}

/** 记录某级返佣（level=1/2/3） */
function addAgentReward(db, userId, level, quota) {
  const col = level === 1 ? 'reward_l1' : level === 2 ? 'reward_l2' : 'reward_l3';
  db.prepare(`UPDATE users SET invite_reward = invite_reward + ?, ${col} = ${col} + ? WHERE id=?`).run(quota, quota, userId);
}

// ---------- 归属变更审计 ----------
function addAgentAudit(db, rec) {
  db.prepare(`INSERT INTO agent_audit
    (target_user_id,target_name,old_inviter_id,old_inviter,new_inviter_id,new_inviter,action,level_before,level_after,agent_name,op_user_id,op_username,op_role,ip,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    rec.target_user_id, rec.target_name || '', rec.old_inviter_id || 0, rec.old_inviter || '',
    rec.new_inviter_id || 0, rec.new_inviter || '', rec.action || 'reassign',
    rec.level_before || 0, rec.level_after || 0, rec.agent_name || '',
    rec.op_user_id || 0, rec.op_username || '', rec.op_role || '', rec.ip || '', Date.now());
}
function listAgentAudit(db, { targetUserId = 0, limit = 200 } = {}) {
  if (targetUserId) return db.prepare('SELECT * FROM agent_audit WHERE target_user_id=? ORDER BY id DESC LIMIT ?').all(targetUserId, limit);
  return db.prepare('SELECT * FROM agent_audit ORDER BY id DESC LIMIT ?').all(limit);
}

/** 钱包流水记录（所有余额变动都调它） */
function addLedger(db, r) {
  const bal = getUserById(db, r.user_id);
  db.prepare(`INSERT INTO wallet_ledger
    (user_id,username,delta,balance_after,kind,detail,ref_user_id,ref_username,op_user_id,op_username,op_role,ip,request_id,remark,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    r.user_id, (bal && bal.username) || r.username || '', parseInt(r.delta, 10) || 0,
    bal ? bal.quota : 0, r.kind || '', r.detail || '', r.ref_user_id || 0, r.ref_username || '',
    r.op_user_id || 0, r.op_username || '', r.op_role || '', r.ip || '', r.request_id || '', r.remark || '',
    r.created_at || Date.now());
}
function listLedger(db, { userId = 0, kind = '', limit = 200, since = 0 } = {}) {
  const cond = [], v = [];
  if (userId) { cond.push('user_id=?'); v.push(userId); }
  if (kind) { cond.push('kind=?'); v.push(kind); }
  if (since) { cond.push('created_at>=?'); v.push(since); }
  const where = cond.length ? ('WHERE ' + cond.join(' AND ')) : '';
  return db.prepare(`SELECT * FROM wallet_ledger ${where} ORDER BY id DESC LIMIT ?`).all(...v, limit);
}
function ledgerStats(db, userId = 0) {
  const cond = userId ? 'WHERE user_id=?' : '';
  const v = userId ? [userId] : [];
  const inSum = db.prepare(`SELECT COALESCE(SUM(delta),0) s FROM wallet_ledger ${cond ? cond + ' AND' : 'WHERE'} delta>0`).get(...v).s;
  const outSum = db.prepare(`SELECT COALESCE(SUM(delta),0) s FROM wallet_ledger ${cond ? cond + ' AND' : 'WHERE'} delta<0`).get(...v).s;
  return { in: inSum, out: outSum, net: inSum + outSum };
}

/** 以某用户为根的子（嵌套树）：返回 { ...me, children:[...] } */
function subtreeOf(db, userId, maxDepth = 5) {
  const me = getUserById(db, userId);
  if (!me) return null;
  const build = (u, depth) => {
    const node = {
      id: u.id, username: u.username, agent_level: u.agent_level, agent_name: u.agent_name,
      quota: u.quota, used_quota: u.used_quota, request_count: u.request_count, status: u.status,
      agent_channel_id: u.role >= 100 ? (u.agent_channel_id || 0) : 0,
      depth, children: [],
    };
    if (depth < maxDepth) {
      const kids = db.prepare('SELECT * FROM users WHERE inviter_id=? ORDER BY id').all(u.id);
      node.children = kids.map(k => build(k, depth + 1));
    }
    return node;
  };
  return build(me, 0);
}

// ---------- 签到 ----------
function doCheckin(db, user, quota) {
  const start = new Date(); start.setHours(0, 0, 0, 0);
  const today = db.prepare('SELECT COUNT(*) c FROM checkins WHERE user_id=? AND created_at>=?').get(user.id, start.getTime()).c;
  if (today > 0) return { ok: false, message: '今日已签到' };
  db.prepare('INSERT INTO checkins (user_id,quota,created_at) VALUES (?,?,?)').run(user.id, quota, Date.now());
  addUserQuota(db, user.id, quota);
  return { ok: true, quota, user: getUserById(db, user.id) };
}
function checkinStatus(db, user) {
  const start = new Date(); start.setHours(0, 0, 0, 0);
  const today = db.prepare('SELECT COUNT(*) c FROM checkins WHERE user_id=? AND created_at>=?').get(user.id, start.getTime()).c;
  return { checked_today: today > 0 };
}

// 导出/导入辅助
function logExists(db, { user_id, created_at, model_name, prompt_tokens, completion_tokens, log_type }) {
  return !!db.prepare(`
    SELECT id FROM logs WHERE user_id=? AND created_at=? AND model_name=? AND
      prompt_tokens=? AND completion_tokens=? AND log_type=?
  `).get(user_id, created_at, model_name, prompt_tokens, completion_tokens, log_type);
}
function recomputeUserStats(db, userId) {
  const r = db.prepare(`
    SELECT COALESCE(SUM(CASE WHEN quota>0 THEN quota ELSE 0 END),0) AS used,
           SUM(CASE WHEN log_type='consume' THEN 1 ELSE 0 END) AS reqs
    FROM logs WHERE user_id=?
  `).get(userId);
  db.prepare('UPDATE users SET used_quota=?, request_count=? WHERE id=?').run(r.used, r.reqs || 0, userId);
  return r;
}
function countLogs(db, userId) {
  return db.prepare('SELECT COUNT(*) c FROM logs WHERE user_id=?').get(userId).c;
}

// ---------- 帐号数据导出/导入（数据迁移） ----------
/**
 * 导出单个帐号的全部数据（流式生成器，大帐号不爆内存）。
 * 输出 JSONL：每行一个对象 {type, ...}，调用方逐行拼成文件。
 * 包含：users 主记录 / tokens（含明文 key）/ logs（全量，含所有 log_type）
 *       / wallet_ledger / checkins / agent_audit（该用户作为 target 的审计）。
 * 不导出：密码哈希（安全）、sessions（登录态）、channels/pricing/settings（站点级）。
 */
async function* exportUserBundleStream(db, userId, { logLimit = 0, operator = null } = {}) {
  const u = getUserById(db, userId);
  if (!u) throw new Error('user not found: ' + userId);

  // 1) 头部：元信息 + 主记录
  yield JSON.stringify({
    type: 'header', export_format: 1, exported_at: Date.now(),
    exported_by: operator ? (operator.username || '') : '',
    source_user_id: u.id, source_username: u.username,
    user: {
      username: u.username, display_name: u.display_name,
      quota: u.quota, used_quota: u.used_quota, request_count: u.request_count,
      group_name: u.group_name, role: u.role, status: u.status,
      aff_code: u.aff_code, remark: u.remark,
      inviter_id: u.inviter_id || 0, invite_reward: u.invite_reward || 0,
      agent_level: u.agent_level || 0, agent_name: u.agent_name || '',
      reward_l1: u.reward_l1 || 0, reward_l2: u.reward_l2 || 0, reward_l3: u.reward_l3 || 0,
      agent_channel_id: u.agent_channel_id || 0,
      created_at: u.created_at,
    },
  });

  // 2) tokens（含明文 key，迁移后 API Key 仍可用）
  const tokens = db.prepare('SELECT * FROM tokens WHERE user_id=? ORDER BY id ASC').all(u.id);
  yield JSON.stringify({ type: 'tokens', data: tokens.map(t => ({
    name: t.name, status: t.status, remain_quota: t.remain_quota, unlimited_quota: t.unlimited_quota,
    used_quota: t.used_quota, model_limits: t.model_limits, allow_ips: t.allow_ips,
    expired_time: t.expired_time, created_time: t.created_time, accessed_time: t.accessed_time,
    key_plain: t.key_plain,
  })) });

  // 3) logs（流式分页，按 id 游标，语句不跨批存活 → 不占读锁，与 exportLogsIter 同款思路）
  const totalLogs = db.prepare('SELECT COUNT(*) c FROM logs WHERE user_id=?').get(u.id).c;
  yield JSON.stringify({ type: 'logs:meta', count: totalLogs });
  const PAGE = 50000;
  const LIM = parseInt(logLimit, 10) || 0;
  // 游标从 MAX(id)+1 开始，使 id < (MAX+1) 包含 MAX(id) 本身
  let lastId = (db.prepare('SELECT MAX(id) m FROM logs WHERE user_id=?').get(u.id).m || 0) + 1;
  let exported = 0;
  while (lastId != null && (LIM === 0 || exported < LIM)) {
    const take = LIM ? Math.min(PAGE, LIM - exported) : PAGE;
    const rows = db.prepare(`SELECT id,user_id,token_id,token_name,model_name,channel_id,channel_name,
      prompt_tokens,completion_tokens,cached_tokens,total_tokens,quota,use_time,is_stream,ip,
      request_id,status,error,created_at,log_type,source
      FROM logs WHERE user_id=? AND id<? ORDER BY id DESC LIMIT ${take}`).all(u.id, lastId);
    if (!rows.length) break;
    yield JSON.stringify({ type: 'logs:chunk', data: rows });
    exported += rows.length;
    lastId = rows[rows.length - 1].id;
    if (rows.length < take) break;
  }

  // 4) wallet_ledger
  const ledger = db.prepare('SELECT * FROM wallet_ledger WHERE user_id=? ORDER BY id ASC').all(u.id);
  yield JSON.stringify({ type: 'wallet_ledger', data: ledger.map(r => ({
    delta: r.delta, balance_after: r.balance_after, kind: r.kind, detail: r.detail,
    ref_user_id: r.ref_user_id, ref_username: r.ref_username,
    op_user_id: r.op_user_id, op_username: r.op_username, op_role: r.op_role,
    ip: r.ip, request_id: r.request_id, remark: r.remark, created_at: r.created_at,
  })) });

  // 5) checkins
  const checkins = db.prepare('SELECT quota,created_at FROM checkins WHERE user_id=? ORDER BY id ASC').all(u.id);
  yield JSON.stringify({ type: 'checkins', data: checkins });

  // 6) agent_audit（该用户作为被操作对象）
  const audit = db.prepare(`SELECT old_inviter_id,old_inviter,new_inviter_id,new_inviter,action,
    level_before,level_after,agent_name,op_user_id,op_username,op_role,ip,created_at
    FROM agent_audit WHERE target_user_id=? ORDER BY id ASC`).all(u.id);
  yield JSON.stringify({ type: 'agent_audit', data: audit });

  // 7) 尾部（完整性）
  yield JSON.stringify({ type: 'footer', log_count: totalLogs, logs_exported: exported, done: true });
}

/**
 * 导入帐号数据（exportUserBundleStream 生成的 JSONL）。
 * 模式:
 *   - new（默认）：创建新用户；用户名冲突自动加后缀 _2/_3…
 *   - merge：合并到已有 targetUserId（追加 logs/ledger/checkins/audit，追加新 token）
 * 密码: user.password 有值则用，否则随机 16 位（返回给管理员一次性展示）。
 * 幂等: token 按 key_hash 去重；logs 按 (user_id,created_at,model_name,prompt/completion,log_type) 去重；
 *       ledger 按 (user_id,request_id,kind) 去重；checkins 按 (user_id,当日) 去重。
 */
async function importUserBundle(db, text, { mode = 'new', targetUserId = 0, opUser = null } = {}) {
  const lines = String(text || '').split('\n').map(l => l.trim()).filter(Boolean);
  const sections = { tokens: [], 'logs:chunks': [], wallet_ledger: [], checkins: [], agent_audit: [] };
  let header = null;
  for (const line of lines) {
    let o; try { o = JSON.parse(line); } catch { continue; }
    if (!o || !o.type) continue;
    if (o.type === 'header') { header = o; continue; }
    if (o.type === 'tokens') sections.tokens = o.data || [];
    else if (o.type === 'logs:chunk') sections['logs:chunks'].push(o.data || []);
    else if (o.type === 'wallet_ledger') sections.wallet_ledger = o.data || [];
    else if (o.type === 'checkins') sections.checkins = o.data || [];
    else if (o.type === 'agent_audit') sections.agent_audit = o.data || [];
  }
  if (!header || !header.user) return { ok: false, message: '导入文件缺少 header/user 字段（格式不对）' };
  const u = header.user;
  const imported = { tokens: 0, logs: 0, ledger: 0, checkins: 0, audit: 0 };

  db.exec('BEGIN IMMEDIATE');
  try {
    let newUserId, newUsername = String(u.username || '').trim();
    let newPassword = null;

    if (mode === 'merge' && targetUserId > 0) {
      const existing = getUserById(db, targetUserId);
      if (!existing) throw new Error('目标用户不存在: ' + targetUserId);
      newUserId = existing.id; newUsername = existing.username;
    } else {
      if (!/^[a-zA-Z0-9_\u4e00-\u9fa5]{2,32}$/.test(newUsername)) throw new Error('用户名不合法: ' + newUsername);
      let guard = 0;
      while (getUserByName(db, newUsername)) {
        if (guard >= 100) throw new Error('用户名 ' + newUsername + ' 及后缀均已占用');
        newUsername = String(u.username) + '_' + (guard + 2);
        if (newUsername.length > 32) newUsername = newUsername.slice(0, 32);
        guard++;
      }
      newPassword = String(u.password || '').trim() || crypto.randomBytes(12).toString('base64url').slice(0, 16);
      const created = await createUser(db, newUsername, newPassword, {
        display_name: u.display_name || newUsername,
        quota: parseInt(u.quota || 0, 10),
        group_name: u.group_name || 'default',
        role: parseInt(u.role || 1, 10),
        inviter_id: parseInt(u.inviter_id || 0, 10),
        agent_level: parseInt(u.agent_level || 0, 10),
        agent_name: String(u.agent_name || ''),
      });
      newUserId = created.id;
      db.prepare(`UPDATE users SET status=?, aff_code=?, remark=?, invite_reward=?,
        reward_l1=?, reward_l2=?, reward_l3=?, agent_channel_id=?, created_at=? WHERE id=?`).run(
        parseInt(u.status || 1, 10), String(u.aff_code || ''), String(u.remark || ''),
        parseInt(u.invite_reward || 0, 10),
        parseInt(u.reward_l1 || 0, 10), parseInt(u.reward_l2 || 0, 10), parseInt(u.reward_l3 || 0, 10),
        parseInt(u.agent_channel_id || 0, 10), parseInt(u.created_at || Date.now(), 10), newUserId);
    }

    // tokens（明文 key → 重算 hash）
    // 去重策略：同库迁移时源用户还持有同一个 key（key_hash 全局 UNIQUE），
    // 直接把源的那条 reassign 给新用户；跨实例导入则正常 INSERT。目标用户已持有同 key 才跳过。
    for (const t of sections.tokens) {
      const plain = String(t.key_plain || '').trim();
      if (!plain) continue;
      const kh = hashKey(plain);
      const existing = db.prepare('SELECT * FROM tokens WHERE key_hash=?').get(kh);
      if (existing) {
        if (existing.user_id === newUserId) continue;             // 目标已有同 key → 跳过
        db.prepare('UPDATE tokens SET user_id=? WHERE id=?').run(newUserId, existing.id);  // 源用户的 key 移过来
      } else {
        db.prepare(`INSERT INTO tokens (user_id,name,key_plain,key_hash,status,remain_quota,unlimited_quota,used_quota,model_limits,allow_ips,expired_time,created_time,accessed_time)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
          newUserId, String(t.name || 'default'), plain, kh,
          parseInt(t.status || 1, 10), parseInt(t.remain_quota || 0, 10), t.unlimited_quota ? 1 : 0,
          parseInt(t.used_quota || 0, 10), String(t.model_limits || ''), String(t.allow_ips || ''),
          parseInt(t.expired_time ?? -1, 10), parseInt(t.created_time || Date.now(), 10), parseInt(t.accessed_time || 0, 10));
      }
      imported.tokens++;
    }

    // logs（按 logExists 去重，merge 模式下重导不重复）
    const insLog = db.prepare(`INSERT INTO logs (user_id,username,token_id,token_name,model_name,channel_id,channel_name,
      prompt_tokens,completion_tokens,cached_tokens,total_tokens,quota,use_time,is_stream,ip,request_id,status,error,created_at,log_type,source)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    for (const chunk of sections['logs:chunks']) {
      for (const r of chunk) {
        if (!r || r._skip) continue;
        if (logExists(db, { user_id: newUserId, created_at: r.created_at, model_name: r.model_name, prompt_tokens: r.prompt_tokens, completion_tokens: r.completion_tokens, log_type: r.log_type })) continue;
        insLog.run(newUserId, newUsername, parseInt(r.token_id || 0, 10), String(r.token_name || ''),
          String(r.model_name || ''), parseInt(r.channel_id || 0, 10), String(r.channel_name || ''),
          parseInt(r.prompt_tokens || 0, 10), parseInt(r.completion_tokens || 0, 10), parseInt(r.cached_tokens || 0, 10),
          parseInt(r.total_tokens || 0, 10), parseInt(r.quota || 0, 10), Number(r.use_time || 0),
          r.is_stream ? 1 : 0, String(r.ip || ''), String(r.request_id || ''),
          String(r.status || 'success'), String(r.error || ''), parseInt(r.created_at || Date.now(), 10),
          String(r.log_type || 'consume'), String(r.source || ''));
        imported.logs++;
      }
    }

    // wallet_ledger（按 request_id+kind+created_at 去重）
    const insLedger = db.prepare(`INSERT INTO wallet_ledger (user_id,username,delta,balance_after,kind,detail,ref_user_id,ref_username,op_user_id,op_username,op_role,ip,request_id,remark,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    for (const r of sections.wallet_ledger) {
      if (r.request_id && db.prepare('SELECT id FROM wallet_ledger WHERE user_id=? AND request_id=? AND kind=?').get(newUserId, r.request_id, r.kind || '')) continue;
      insLedger.run(newUserId, newUsername, parseInt(r.delta || 0, 10), parseInt(r.balance_after || 0, 10),
        String(r.kind || ''), String(r.detail || ''), parseInt(r.ref_user_id || 0, 10), String(r.ref_username || ''),
        parseInt(r.op_user_id || 0, 10), String(r.op_username || ''), String(r.op_role || ''),
        String(r.ip || ''), String(r.request_id || ''), String(r.remark || ''), parseInt(r.created_at || Date.now(), 10));
      imported.ledger++;
    }

    // checkins（按 user+当日 去重，避免破坏"每日签到"约束）
    for (const r of sections.checkins) {
      const ts = parseInt(r.created_at || Date.now(), 10);
      const dayStart = new Date(ts); dayStart.setHours(0, 0, 0, 0);
      if (db.prepare('SELECT id FROM checkins WHERE user_id=? AND created_at>=?').get(newUserId, dayStart.getTime())) continue;
      db.prepare('INSERT INTO checkins (user_id,quota,created_at) VALUES (?,?,?)')
        .run(newUserId, parseInt(r.quota || 0, 10), ts);
      imported.checkins++;
    }

    // agent_audit
    for (const r of sections.agent_audit) {
      db.prepare(`INSERT INTO agent_audit (target_user_id,target_name,old_inviter_id,old_inviter,new_inviter_id,new_inviter,action,level_before,level_after,agent_name,op_user_id,op_username,op_role,ip,created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        newUserId, newUsername, parseInt(r.old_inviter_id || 0, 10), String(r.old_inviter || ''),
        parseInt(r.new_inviter_id || 0, 10), String(r.new_inviter || ''),
        String(r.action || 'import'), parseInt(r.level_before || 0, 10), parseInt(r.level_after || 0, 10),
        String(r.agent_name || ''), parseInt(r.op_user_id || 0, 10), String(r.op_username || ''), String(r.op_role || ''),
        String(r.ip || ''), parseInt(r.created_at || Date.now(), 10));
      imported.audit++;
    }

    // 重算 used_quota / request_count（以 logs 为准）
    recomputeUserStats(db, newUserId);
    db.exec('COMMIT');

    const finalUser = getUserById(db, newUserId);
    // 审计留痕：谁导入了谁
    addAgentAudit(db, {
      target_user_id: newUserId, target_name: newUsername,
      old_inviter_id: finalUser.inviter_id || 0, old_inviter: '—',
      new_inviter_id: finalUser.inviter_id || 0, new_inviter: '—',
      action: mode === 'merge' ? 'import-merge' : 'import',
      level_before: finalUser.agent_level || 0, level_after: finalUser.agent_level || 0,
      agent_name: '迁移自 ' + (header.source_username || '?') + ' #' + (header.source_user_id || '?'),
      op_user_id: opUser ? opUser.id : 0, op_username: opUser ? opUser.username : 'system',
      op_role: opUser ? (isAdmin(opUser) ? '管理员' : '代理') : '管理员', ip: '',
    });
    return { ok: true, user: finalUser, imported, new_user_id: newUserId, new_username: newUsername, new_password: newPassword };
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch {}
    return { ok: false, message: '导入失败: ' + e.message };
  }
}

module.exports = {
  open, migrate, seedChannels,
  hashPassword, verifyPassword,
  getUserByName, getUserById, isAdmin, createUser, publicUser, publicUserPublic, setDisplayName, setUsername, bulkCreateUsers,
  setPassword: setPasswordReal, touchLogin, addUserUsage, addUserQuota, transferQuota, userDashboard,
  createSession, getSession, deleteSession,
  createToken, getToken, getTokenByPlain, listTokens, updateToken, deleteToken, touchToken, addTokenUsage,
  listChannels, listChannelsRaw, getChannel, publicChannelView, channelsForModel, addChannelUsage,
  channelPublicModels, pinnedChannelInfo,
  addChannel, updateChannel, deleteChannel, touchChannel,
  publicModelCatalog, pricingCatalog, maskKey,
  insertLog, listLogs, logStatsByModel, exportLogs, exportLogsIter, exportSummary,
  logExists, recomputeUserStats, countLogs,
  listUsers, adminUpdateUser, systemStats, userByAff, deleteUser,
  createRedemptions, getRedemption, redeemCode, listRedemptions, setRedemptionStatus, deleteRedemption,
  DEFAULT_SETTINGS, getSettings, getSetting, setSettings,
  getInviter, listInvitees, setInviter, inviteStats, addInviteReward,
  getUpline, listDownline, teamStats, setInviterSafe, setAgentInfo, agentChannelForUser, addAgentReward, subtreeOf,
  addAgentAudit, listAgentAudit, addLedger, listLedger, ledgerStats,
  doCheckin, checkinStatus,
  exportUserBundleStream, importUserBundle,
  hashKey, newTokenKey,
};
