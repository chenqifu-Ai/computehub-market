#!/usr/bin/env node
/**
 * import-logs.js — 把 SLCH/New-API 导出的 usage-logs .xlsx 灌入本平台
 *
 * 用法:
 *   node import-logs.js <文件.xlsx> [选项]
 *
 * 选项:
 *   --user <用户名>      把导入记录归属到该用户（默认：从 xlsx「用户」列自动匹配/创建）
 *   --db <路径>          目标数据库（默认 ./api.db）
 *   --token-name <名>    若用户下无同名令牌，自动建一个（默认取 xlsx「令牌名称」列）
 *   --dry-run            只预览不写库
 *   --tag <标签>         来源标记（默认 slch-import）
 *
 * 特性:
 *   - 按 (user_id, created_at, model, prompt, completion, log_type) 去重，可重复执行
 *   - 保留原始时间戳（时间线连续）
 *   - 保留类型：消费/充值/系统/管理
 *   - 导入后重算用户 used_quota / request_count
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const xlsx = require('./lib/xlsx');
const store = require('./lib/store');

// ---------- 参数 ----------
const args = process.argv.slice(2);
const file = args.find(a => !a.startsWith('--'));
if (!file) {
  console.error('用法: node import-logs.js <文件.xlsx> [--user 用户名] [--db 路径] [--dry-run] [--tag 标签]');
  process.exit(1);
}
function opt(name, def) {
  const i = args.indexOf('--' + name);
  return i >= 0 ? args[i + 1] : def;
}
const FORCE_USER = opt('user', null);
const DB_PATH = opt('db', path.join(__dirname, 'api.db'));
const FORCE_TOKEN_NAME = opt('token-name', null);
const DRY = args.includes('--dry-run');
const TAG = opt('tag', 'slch-import');
const QPU = 500000;

// ---------- 解析金额 ----------
function parseAmount(s) {
  if (s == null) return 0;
  const m = String(s).replace(/[^\d.\-]/g, '');
  const v = parseFloat(m);
  return Number.isFinite(v) ? v : 0;
}
// "2026-09-15 08:33:12" → ms
function parseTime(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(String(s).trim());
  if (!m) return null;
  const [, Y, Mo, D, H, Mi, S] = m.map(Number);
  return new Date(Y, Mo - 1, D, H, Mi, S).getTime();
}
const TYPE_MAP = { '消费': 'consume', '充值': 'recharge', '系统': 'system', '管理': 'admin', '返利': 'reward' };

// ---------- 主流程 ----------
const db = store.open(DB_PATH);
store.migrate(db);

const wb = xlsx.read(fs.readFileSync(file));
// 找明细 sheet：优先名字含「记录/明细/日志」，否则第一个
const detail = wb.sheets.find(s => /记录|明细|日志|usage/i.test(s.name)) || wb.sheets[0];
console.log(`📄 ${path.basename(file)}`);
console.log(`   sheets: ${wb.sheets.map(s => s.name).join(', ')}`);
console.log(`   明细表: ${detail.name}（${detail.rows.length - 1} 行数据）`);

const header = detail.rows[0].map(h => String(h).trim());
const col = name => header.findIndex(h => h === name);
const CI = {
  time: col('时间'), type: col('类型'), user: col('用户'), uid: col('用户ID'),
  token: col('令牌名称'), model: col('模型'),
  pin: col('输入token数'), pout: col('输出token数'),
  cost: col('花费金额'), dur: col('用时(秒)'), stream: col('流式'),
};
if (CI.time < 0) { console.error('❌ 找不到「时间」列，表头: ' + header.join('|')); process.exit(1); }

// ---------- 用户解析 ----------
function resolveUser(username, srcUid) {
  if (FORCE_USER) username = FORCE_USER;
  let u = store.getUserByName(db, username);
  if (!u) {
    if (DRY) return { id: 0, username, created: true };
    // 自动建用户（不可登录：随机密码；如需登录请让管理员重置密码）
    const salt = crypto.randomBytes(16).toString('hex');
    const pass = crypto.randomBytes(24).toString('hex');
    // createUser 是异步的（scrypt），这里用同步流程：先建壳，再写 hash
    const aff = crypto.randomBytes(4).toString('hex').slice(0, 6);
    const info = db.prepare(`INSERT INTO users (username,display_name,pass_hash,salt,quota,group_name,role,aff_code,remark,created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`)
      .run(username, username, 'pending', salt, 0, 'default', 1, aff,
        `由 ${TAG} 导入自动创建（原平台UID=${srcUid}）`, Date.now());
    const id = Number(info.lastInsertRowid);
    // 同步写 scrypt 哈希（用 crypto.scryptSync）
    const hash = crypto.scryptSync(pass, salt, 64, { N: 16384, r: 8, p: 1 }).toString('hex');
    db.prepare('UPDATE users SET pass_hash=? WHERE id=?').run(hash, id);
    console.log(`   ➕ 新建用户 ${username} (id=${id}) —— 不可登录，需管理员重置密码`);
    u = store.getUserById(db, id);
    u.__created = true;
  }
  return u;
}

function resolveToken(userId, tokenName) {
  const name = FORCE_TOKEN_NAME || tokenName || 'imported';
  if (!name) return { id: 0, name: '' };
  const existing = db.prepare('SELECT * FROM tokens WHERE user_id=? AND name=?').get(userId, name);
  if (existing) return { id: existing.id, name };
  if (DRY) return { id: 0, name, created: true };
  const t = store.createToken(db, userId, { name, unlimited: true });
  console.log(`   ➕ 新建令牌 ${name} (id=${t.id})`);
  return { id: t.id, name };
}

// ---------- 逐行导入 ----------
let stat = { total: 0, ok: 0, dup: 0, skip: 0, quota: 0, tokens: 0 };
const usersTouched = new Set();
const userCache = new Map();
const tokenCache = new Map();

for (let i = 1; i < detail.rows.length; i++) {
  const r = detail.rows[i];
  if (!r || !r[CI.time]) { stat.skip++; continue; }
  stat.total++;

  const ts = parseTime(r[CI.time]);
  if (!ts) { stat.skip++; continue; }

  const rawType = String(r[CI.type] || '').trim();
  const logType = TYPE_MAP[rawType] || 'consume';
  const model = String(r[CI.model] || '').trim();
  const pin = parseInt(String(r[CI.pin] || '0').replace(/[^\d]/g, ''), 10) || 0;
  const pout = parseInt(String(r[CI.pout] || '0').replace(/[^\d]/g, ''), 10) || 0;
  const yuan = parseAmount(r[CI.cost]);
  const quota = Math.round(yuan * QPU);
  const dur = parseFloat(String(r[CI.dur] || '0').replace(/[^\d.]/g, '')) || 0;
  const isStream = String(r[CI.stream] || '').trim() === '是' ? 1 : 0;

  const uname = String(r[CI.user] || '').trim() || 'unknown';
  const srcUid = String(r[CI.uid] || '').trim();
  let u = userCache.get(uname);
  if (!u) { u = resolveUser(uname, srcUid); userCache.set(uname, u); }
  if (!u) { stat.skip++; continue; }

  const tname = String(r[CI.token] || '').trim();
  const tkey = u.id + '|' + tname;
  let tok = tokenCache.get(tkey);
  if (!tok) { tok = resolveToken(u.id, tname); tokenCache.set(tkey, tok); }

  // 去重（dry-run 下不查库，直接计为新增）
  if (!DRY && store.logExists(db, {
    user_id: u.id, created_at: ts, model_name: model,
    prompt_tokens: pin, completion_tokens: pout, log_type: logType,
  })) { stat.dup++; continue; }

  if (!DRY) {
    store.insertLog(db, {
      user_id: u.id, username: uname, token_id: tok.id, token_name: tok.name || '',
      model_name: model, channel_id: 0, channel_name: '（历史导入）',
      prompt_tokens: pin, completion_tokens: pout, total_tokens: pin + pout,
      quota, use_time: dur, is_stream: isStream,
      ip: '', request_id: `${TAG}:${i}`, status: 'success', error: '',
      created_at: ts, log_type: logType, source: TAG,
    });
  }
  stat.ok++;
  stat.quota += quota;
  stat.tokens += pin + pout;
  usersTouched.add(u.id);
}

// ---------- 重算统计 ----------
if (!DRY) {
  for (const uid of usersTouched) store.recomputeUserStats(db, uid);
}

console.log('\n' + (DRY ? '🔍 DRY-RUN（未写库）' : '✅ 导入完成'));
console.log(`   总行数   : ${stat.total}`);
console.log(`   新导入   : ${stat.ok}`);
console.log(`   重复跳过 : ${stat.dup}`);
console.log(`   无效跳过 : ${stat.skip}`);
console.log(`   消费额度 : ${stat.quota} quota (¥${(stat.quota / QPU).toFixed(6)})`);
console.log(`   总 tokens: ${stat.tokens.toLocaleString()}`);
console.log(`   涉及用户 : ${[...usersTouched].map(id => (store.getUserById(db, id) || {}).username).join(', ') || '-'}`);
if (!DRY) {
  for (const uid of usersTouched) {
    const u = store.getUserById(db, uid);
    console.log(`     - ${u.username}: ${store.countLogs(db, uid)} 条日志, 累计消费 ¥${(u.used_quota / QPU).toFixed(6)}, 请求 ${u.request_count}`);
  }
}
db.close();
