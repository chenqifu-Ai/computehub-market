#!/usr/bin/env node
/**
 * build-sim-source.js — 从 api.db 真实数据构建"会话块"数据源库
 *
 * 把各用户的真实消费记录按【会话块】聚组（同模型+同渠道+间隔≤2min），
 * 整块存入 scripts/sim-source.db，供 backfill-sim.js 以块为单位随机提取。
 * 块内保持原始顺序和间隔 → 模拟数据逐条看也像真会话（输入递减/递增连续）。
 *
 * 表 sim_blocks:
 *   profile, block_id, model_name, channel_id, channel_name,
 *   n, hour, gap_med,
 *   recs  — JSON: [{pin,pc,pout,quota,ut,gap}]  (gap=与上一条间隔秒, 首条=0)
 *
 * 用法：
 *   node scripts/build-sim-source.js            # 构建
 *   node scripts/build-sim-source.js --min 3    # 每池最少块数(块内≥2条才算块)
 */
const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');
const fs = require('node:fs');

const API = path.join(__dirname, '..');
const SRC = path.join(API, 'api.db');
const OUT = path.join(__dirname, 'sim-source.db');

const args = process.argv.slice(2);
const minArg = args.indexOf('--min');
const MIN_REC = minArg >= 0 ? parseInt(args[minArg + 1], 10) : 30; // 每用户最少记录数
const BLOCK_GAP_MS = 120000; // 同块最大间隔 2 分钟
const BLOCK_MIN = 2;         // 块最少记录数（1 条的当独立请求，也入池）

const PROFILE_MAP = {
  14: 'heavy-cached', 5: 'cached', 69: 'cached',
  8: 'no-cache', 7: 'no-cache', 12: 'mixed',
};

function autoProfile(rows) {
  const tot = rows.length;
  const pin = rows.reduce((s, r) => s + (r.prompt_tokens || 0), 0);
  const pc = rows.reduce((s, r) => s + (r.cached_tokens || 0), 0);
  const ratio = pin ? pc / pin : 0;
  if (tot >= 500 && ratio >= 0.2) return 'heavy-cached';
  if (ratio >= 0.3) return 'cached';
  if (ratio < 0.05) return 'no-cache';
  return 'mixed';
}

const sdb = new DatabaseSync(SRC);
sdb.exec('PRAGMA journal_mode=WAL');

if (fs.existsSync(OUT)) fs.unlinkSync(OUT);
const odb = new DatabaseSync(OUT);
odb.exec(`CREATE TABLE sim_blocks (
  profile TEXT, block_id INTEGER, model_name TEXT, channel_id INTEGER, channel_name TEXT,
  n INTEGER, hour INTEGER, gap_med REAL, recs TEXT
)`);
odb.exec('CREATE INDEX idx_bprofile ON sim_blocks(profile)');

const userRows = sdb.prepare(`
  SELECT u.id, u.username, l.model_name, l.channel_id, l.channel_name,
         l.prompt_tokens, l.completion_tokens, l.cached_tokens, l.total_tokens,
         l.quota, l.use_time, l.created_at
  FROM logs l JOIN users u ON u.id = l.user_id
  WHERE l.log_type='consume' AND l.username = u.username
    AND l.username NOT LIKE 'agent-reward%'
    AND l.request_id NOT LIKE 'sim:%' AND l.request_id NOT LIKE 'invite:%'
  ORDER BY u.id, l.created_at`).all();

const byUser = {};
for (const r of userRows) {
  if (!byUser[r.id]) byUser[r.id] = { username: r.username, rows: [] };
  byUser[r.id].rows.push(r);
}

const summary = {};
odb.exec('BEGIN');
const ins = odb.prepare(`INSERT INTO sim_blocks (profile,block_id,model_name,channel_id,channel_name,n,hour,gap_med,recs)
  VALUES (?,?,?,?,?,?,?,?,?)`);

let blockIdx = 0;
const dt = (ms) => new Date(ms);
for (const [uid, u] of Object.entries(byUser)) {
  if (u.rows.length < MIN_REC) continue;
  const profile = PROFILE_MAP[uid] || autoProfile(u.rows);

  // 聚块：同 model+channel 且间隔 ≤ 2min
  const blocks = [];
  let cur = null;
  for (const r of u.rows) {
    const key = `${r.model_name}|${r.channel_id || 0}`;
    const gapOk = cur && (r.created_at - cur.lastTs) <= BLOCK_GAP_MS;
    const sameKey = cur && cur.key === key;
    if (cur && sameKey && gapOk) {
      cur.recs.push(r);
      cur.lastTs = r.created_at;
    } else {
      if (cur) blocks.push(cur);
      cur = { key, profile, model_name: r.model_name, channel_id: r.channel_id || 0,
              channel_name: r.channel_name || '', recs: [r], lastTs: r.created_at };
    }
  }
  if (cur) blocks.push(cur);

  // 过滤太小的块（可选保留 1 条块）
  const good = blocks.filter(b => b.recs.length >= BLOCK_MIN || blocks.length < 10);
  const hourCnt = new Array(24).fill(0);
  for (const b of good) {
    blockIdx++;
    const recs = b.recs.map((r, i) => ({
      pin: r.prompt_tokens || 0,
      pc: Math.min(r.prompt_tokens || 0, r.cached_tokens || 0),
      pout: r.completion_tokens || 0,
      quota: r.quota || 0,
      ut: r.use_time || 0,
      gap: i === 0 ? 0 : Math.max(0, (r.created_at - b.recs[i - 1].created_at) / 1000),
    }));
    const gaps = recs.map(r => r.gap).filter(g => g > 0).sort((a, b2) => a - b2);
    const gapMed = gaps.length ? gaps[Math.floor(gaps.length / 2)] : 0;
    const hour = b.recs[0].created_at ? dt(b.recs[0].created_at).getHours() : 12;
    hourCnt[hour]++;
    ins.run(profile, blockIdx, b.model_name, b.channel_id, b.channel_name,
      recs.length, hour, gapMed, JSON.stringify(recs));
    summary[profile] = (summary[profile] || 0) + 1;
  }
}
odb.exec('COMMIT');

// 块内总记录数
const totalRecs = odb.prepare('SELECT SUM(n) s, COUNT(*) b FROM sim_blocks').get();
console.log('=== 会话块数据源库构建完成 ===');
console.log('输出:', OUT);
console.log(`总块数: ${totalRecs.b}  块内总记录: ${totalRecs.s}`);
console.log('用户池（≥' + MIN_REC + ' 条原始记录）:');
for (const [uid, u] of Object.entries(byUser)) {
  if (u.rows.length < MIN_REC) continue;
  const profile = PROFILE_MAP[uid] || autoProfile(u.rows);
  const nb = odb.prepare('SELECT COUNT(*) c FROM sim_blocks WHERE profile=?').get(profile).c;
  console.log(`  #${uid} ${u.username.padEnd(14)} → ${profile.padEnd(13)} ${u.rows.length} 条 → ${nb} 块`);
}
console.log('分池块数:');
for (const [p, n] of Object.entries(summary).sort((a, b) => b[1] - a[1])) console.log(`  ${p.padEnd(13)} ${n} 块`);
odb.close(); sdb.close();
