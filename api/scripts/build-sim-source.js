#!/usr/bin/env node
/**
 * build-sim-source.js — 从 api.db 真实数据构建"模拟数据源库"
 *
 * 把各用户的真实消费记录抽出来，按【用户类型/画像】分池，
 * 存成独立只读源库 scripts/sim-source.db，供 backfill-sim.js 随机提取。
 *
 * 用户类型（自动按行为特征归类，也可 --profiles 手动指定）：
 *   heavy-cached   高强度+高缓存（如 sutoukeji）
 *   cached         中强度+高缓存（如 cqf / CY001）
 *   no-cache       中强度+无缓存（如 chao_work01 / 中物）
 *   mixed          小样本混合（如 fuzhi_agent）
 *
 * 源库表 sim_records：
 *   profile, model_name, channel_id, channel_name,
 *   prompt_tokens, completion_tokens, cached_tokens,
 *   total_tokens, quota, use_time, hour
 *
 * 用法：
 *   node scripts/build-sim-source.js            # 构建
 *   node scripts/build-sim-source.js --min 100  # 每池最少记录数
 */
const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');

const API = path.join(__dirname, '..');
const SRC = path.join(API, 'api.db');
const OUT = path.join(__dirname, 'sim-source.db');

const args = process.argv.slice(2);
const minArg = args.indexOf('--min');
const MIN = minArg >= 0 ? parseInt(args[minArg + 1], 10) : 30;

// 手动画像映射（可改）：userId -> profile
const PROFILE_MAP = {
  14: 'heavy-cached',  // sutoukeji  高强度+缓存
  5:  'cached',        // cqf        中强度+高缓存
  69: 'cached',        // CY001      高缓存
  8:  'no-cache',      // chao_work01 无缓存
  7:  'no-cache',      // 中物        无缓存
  12: 'mixed',         // fuzhi_agent 小样本
};

function autoProfile(rows) {
  const tot = rows.length;
  const pin = rows.reduce((s, r) => s + (r.prompt_tokens || 0), 0);
  const pc = rows.reduce((s, r) => s + (r.cached_tokens || 0), 0);
  const ratio = pin ? pc / pin : 0;
  const perDay = tot; // 简化：用总量
  if (tot >= 500 && ratio >= 0.2) return 'heavy-cached';
  if (ratio >= 0.3) return 'cached';
  if (ratio < 0.05) return 'no-cache';
  return 'mixed';
}

const sdb = new DatabaseSync(SRC);
sdb.exec('PRAGMA journal_mode=WAL');

// 建目标库（覆盖）
if (require('node:fs').existsSync(OUT)) require('node:fs').unlinkSync(OUT);
const odb = new DatabaseSync(OUT);
odb.exec(`CREATE TABLE sim_records (
  profile TEXT, model_name TEXT, channel_id INTEGER, channel_name TEXT,
  prompt_tokens INTEGER, completion_tokens INTEGER, cached_tokens INTEGER,
  total_tokens INTEGER, quota INTEGER, use_time REAL, hour INTEGER
)`);
odb.exec('CREATE INDEX idx_profile ON sim_records(profile)');

// 收集各用户
const userRows = sdb.prepare(`
  SELECT u.id, u.username, l.model_name, l.channel_id, l.channel_name,
         l.prompt_tokens, l.completion_tokens, l.cached_tokens, l.total_tokens,
         l.quota, l.use_time, l.created_at
  FROM logs l JOIN users u ON u.id = l.user_id
  WHERE l.log_type='consume' AND l.username = u.username
    AND l.username NOT LIKE 'agent-reward%'
    AND l.request_id NOT LIKE 'sim:%' AND l.request_id NOT LIKE 'invite:%'
  ORDER BY u.id`).all();

// 按用户分组
const byUser = {};
for (const r of userRows) {
  if (!byUser[r.id]) byUser[r.id] = { username: r.username, rows: [] };
  byUser[r.id].rows.push(r);
}

const summary = {};
odb.exec('BEGIN');
const ins = odb.prepare(`INSERT INTO sim_records (profile,model_name,channel_id,channel_name,
  prompt_tokens,completion_tokens,cached_tokens,total_tokens,quota,use_time,hour)
  VALUES (?,?,?,?,?,?,?,?,?,?,?)`);

const dt = (ms) => new Date(ms);
for (const [uid, u] of Object.entries(byUser)) {
  if (u.rows.length < MIN) continue;
  const profile = PROFILE_MAP[uid] || autoProfile(u.rows);
  let n = 0;
  for (const r of u.rows) {
    if (!r.model_name) continue;
    ins.run(profile, r.model_name, r.channel_id || 0, r.channel_name || '',
      r.prompt_tokens || 0, r.completion_tokens || 0, r.cached_tokens || 0,
      r.total_tokens || 0, r.quota || 0, r.use_time || 0,
      r.created_at ? dt(r.created_at).getHours() : 12);
    n++;
  }
  if (n > 0) summary[profile] = (summary[profile] || 0) + n;
}
odb.exec('COMMIT');

console.log('=== 数据源库构建完成 ===');
console.log('输出:', OUT);
console.log('用户池（≥' + MIN + ' 条）:');
for (const [uid, u] of Object.entries(byUser)) {
  if (u.rows.length < MIN) continue;
  const profile = PROFILE_MAP[uid] || autoProfile(u.rows);
  const pin = u.rows.reduce((s, r) => s + (r.prompt_tokens || 0), 0);
  const pc = u.rows.reduce((s, r) => s + (r.cached_tokens || 0), 0);
  console.log(`  #${uid} ${u.username.padEnd(14)} → ${profile.padEnd(13)} ${u.rows.length} 条 缓存 ${pin ? (pc / pin * 100).toFixed(0) : 0}%`);
}
console.log('分池记录数:');
for (const [p, n] of Object.entries(summary).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${p.padEnd(13)} ${n}`);
}
const total = Object.values(summary).reduce((a, b) => a + b, 0);
console.log(`总计 ${total} 条源记录`);
odb.close(); sdb.close();
