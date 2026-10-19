#!/usr/bin/env node
/**
 * simulate-history.js — 为 sutoukeji005(#39) 模拟历史使用数据（7月~10月）
 *
 * 核心：从 sutoukeji(#14) 真实记录里 **resampling**（按模型分组随机抽），
 *      每笔 × N(1, 5%) 扰动 → 偏差 5% 内，分布完全对齐真实。
 *
 * 增长曲线：7月10% → 10月100%（满强度 2110单/天）
 * 目标：~88k 单, 总消费 ~$1100（1/4 强度 = $344 是之前的误算，实际满强度111天=$4430, 1/4=$1108）
 *
 * 用法：
 *   node scripts/simulate-history.js            # dry-run
 *   node scripts/simulate-history.js --apply    # 写库
 */
const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');
const crypto = require('node:crypto');

const API = path.join(__dirname, '..');
const db = new DatabaseSync(path.join(API, 'api.db'));
db.exec('PRAGMA journal_mode=WAL');
db.exec('PRAGMA busy_timeout=15000');

const APPLY = process.argv.includes('--apply');
const USER_ID = 39;
const USERNAME = 'sutoukeji005';
const MARK = 'sim_backfill_39_20261019';
const QPS = 500000;

// ===== 参数 =====
const T0 = Date.parse('2026-07-01T00:00:00+08:00');
const T1 = Date.parse('2026-10-19T14:50:00+08:00');
const PEAK_PER_DAY = 2110;
const RAMP = { '2026-07': 0.10, '2026-08': 0.25, '2026-09': 0.50, '2026-10': 1.0 };
const JITTER_DAY = 0.10;
const JITTER_REQ = 0.05;
const SEED = 20261019;

// ===== 读真实数据（按模型分组，用于 resampling）=====
const srcAll = db.prepare("SELECT model_name,channel_id,channel_name,prompt_tokens,completion_tokens,cached_tokens,quota FROM logs WHERE user_id=14 AND log_type='consume'").all();
console.log(`画像源: ${srcAll.length} 条`);

// 按模型分组
const byModel = {};
for (const r of srcAll) {
  if (!byModel[r.model_name]) byModel[r.model_name] = [];
  byModel[r.model_name].push(r);
}
const modelDist = Object.entries(byModel).map(([m, arr]) => ({ name: m, w: arr.length / srcAll.length, pool: arr }));
modelDist.sort((a,b) => b.w - a.w);
console.log('模型分布:', modelDist.map(d => `${d.name} ${(d.w*100).toFixed(1)}%`).join(' / '));

// 时段分布
const hourDist = new Array(24).fill(0);
for (const r of srcAll) {
  const h = new Date(r.created_at).getHours();
  hourDist[h]++;
}
const hourTotal = hourDist.reduce((a,b)=>a+b,0);
for (let i=0;i<24;i++) hourDist[i] /= hourTotal;

// ===== PRNG =====
function mulberry32(seed) {
  return function() {
    seed |= 0; seed = seed + 0x6D2B79F5 | 0;
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  }
}
const rand = mulberry32(SEED);
function randn() {
  let u = 0, v = 0;
  while (u === 0) u = rand();
  while (v === 0) v = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
function jitter(v, rate) {
  return Math.max(0, Math.round(v * (1 + (rand()*2-1) * rate)));
}
function weightedPick(items, r) {
  let s = 0;
  for (const it of items) { s += it.w; if (r < s) return it; }
  return items[items.length-1];
}
function pickHour(r) {
  let s = 0;
  for (let i = 0; i < 24; i++) { s += hourDist[i]; if (r < s) return i; }
  return 23;
}

// ===== 生成天数计划 =====
const days = [];
for (let d = new Date(T0); d.getTime() <= T1; d.setDate(d.getDate()+1)) {
  const key = d.toISOString().slice(0,7);
  const ramp = RAMP[key] ?? 1.0;
  const dow = d.getDay();
  const weekendFactor = (dow === 0 || dow === 6) ? 0.8 : 1.0;
  const dayJitter = 1 + (rand()*2-1) * JITTER_DAY;
  const n = Math.max(0, Math.round(PEAK_PER_DAY * ramp * weekendFactor * dayJitter));
  days.push({ date: new Date(d), n, month: key });
}
const lastDay = days[days.length-1];
lastDay.n = Math.round(lastDay.n * (14.83/24));
const totalN = days.reduce((s,d)=>s+d.n,0);
console.log(`\n计划: ${days.length} 天, ${totalN} 单`);
console.log('月度:');
for (const m of Object.keys(RAMP).sort()) {
  const dd = days.filter(x=>x.month===m);
  const n = dd.reduce((s,x)=>s+x.n,0);
  console.log(`  ${m}: ${n} 单 (${(n/totalN*100).toFixed(1)}%)`);
}

// ===== 预估总消费（resampling 1000 条）=====
let estCost = 0;
for (let i = 0; i < 1000; i++) {
  const md = weightedPick(modelDist, rand());
  const rec = md.pool[Math.floor(rand() * md.pool.length)];
  estCost += jitter(rec.quota, JITTER_REQ);
}
const avgCost = estCost / 1000;
const totalCost = avgCost * totalN;
console.log(`\n预估: 均$${(avgCost/QPS).toFixed(6)}/单 × ${totalN} = $${(totalCost/QPS).toFixed(2)}`);

// ===== DRY-RUN 样本 =====
if (!APPLY) {
  console.log('\n=== 50 条样本 ===');
  for (let i = 0; i < 50; i++) {
    const day = days[Math.floor(rand() * days.length)];
    const md = weightedPick(modelDist, rand());
    const rec = md.pool[Math.floor(rand() * md.pool.length)];
    const pin = jitter(rec.prompt_tokens, JITTER_REQ);
    const pout = jitter(rec.completion_tokens, JITTER_REQ);
    const pc = jitter(rec.cached_tokens, JITTER_REQ);
    const h = pickHour(rand());
    const ts = new Date(day.date); ts.setHours(h, Math.floor(rand()*60), Math.floor(rand()*60), 0);
    const q = jitter(rec.quota, JITTER_REQ);
    console.log(`  ${ts.toISOString().slice(0,19)} ${rec.model_name.padEnd(22)} ${rec.channel_name.padEnd(16)} in=${pin} out=${pout} cached=${pc} $${(q/QPS).toFixed(6)}`);
  }
  console.log('\n(dry-run, 加 --apply 执行)');
  db.close();
  process.exit(0);
}

// ===== APPLY =====
const done = db.prepare('SELECT value FROM settings WHERE key=?').get(MARK);
if (done) { console.error('❌ 已执行过'); process.exit(1); }

// 返佣链
const upline = [];
let cur = db.prepare('SELECT id,username,inviter_id FROM users WHERE id=?').get(USER_ID);
while (cur && cur.inviter_id) {
  const p = db.prepare('SELECT id,username FROM users WHERE id=?').get(cur.inviter_id);
  if (!p) break;
  upline.push(p); cur = p;
}
const RATES = [
  parseFloat(db.prepare("SELECT value FROM settings WHERE key='invite_reward_rate'").get()?.value || '0'),
  parseFloat(db.prepare("SELECT value FROM settings WHERE key='agent_reward_l2'").get()?.value || '0'),
  parseFloat(db.prepare("SELECT value FROM settings WHERE key='agent_reward_l3'").get()?.value || '0'),
];

db.exec('BEGIN IMMEDIATE');
let nLogs = 0, nReward = 0, totalQuota = 0;
const rewardDelta = {};
const chDelta = {};

try {
  for (const day of days) {
    for (let i = 0; i < day.n; i++) {
      const md = weightedPick(modelDist, rand());
      const rec = md.pool[Math.floor(rand() * md.pool.length)];
      const pin = jitter(rec.prompt_tokens, JITTER_REQ);
      const pout = jitter(rec.completion_tokens, JITTER_REQ);
      const pc = jitter(rec.cached_tokens, JITTER_REQ);
      const quota = jitter(rec.quota, JITTER_REQ);
      const h = pickHour(rand());
      const ts = new Date(day.date); ts.setHours(h, Math.floor(rand()*60), Math.floor(rand()*60), 0);
      const created_at = ts.getTime();
      if (created_at > T1) continue;
      const requestId = 'sim:' + crypto.randomBytes(8).toString('hex');
      const useTime = 200 + Math.floor(rand()*3000);
      const ip = '192.168.2.' + (10 + Math.floor(rand()*200));

      db.prepare(`INSERT INTO logs (user_id,username,token_id,token_name,model_name,channel_id,channel_name,
        prompt_tokens,completion_tokens,cached_tokens,total_tokens,quota,use_time,is_stream,ip,request_id,status,error,created_at,log_type,source)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        USER_ID, USERNAME, 0, '', rec.model_name, rec.channel_id, rec.channel_name,
        pin, pout, pc, pin+pout+pc, quota, useTime, 0, ip, requestId, 'success', '', created_at, 'consume', 'sim');
      nLogs++; totalQuota += quota;
      chDelta[rec.channel_id] = (chDelta[rec.channel_id] || 0) + quota;

      for (let li = 0; li < upline.length && li < 3; li++) {
        const rate = RATES[li];
        if (!rate || rate <= 0) continue;
        const rw = Math.floor(quota * rate);
        if (rw <= 0) continue;
        db.prepare(`INSERT INTO logs (user_id,username,token_id,token_name,model_name,channel_id,channel_name,
          prompt_tokens,completion_tokens,cached_tokens,total_tokens,quota,use_time,is_stream,ip,request_id,status,error,created_at,log_type,source)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
          upline[li].id, 'agent-reward-L'+(li+1), 0, '返佣L'+(li+1), rec.model_name, 0, '',
          pin, pout, pc, pin+pout+pc, -rw, useTime, 0, ip, 'invite:'+requestId, 'success', '', created_at, 'consume', 'sim');
        nReward++;
        const rd = rewardDelta[upline[li].id] || (rewardDelta[upline[li].id] = {name:upline[li].username, ir:0, l:[0,0,0]});
        rd.ir += rw; rd.l[li] += rw;
      }
    }
  }

  db.prepare('UPDATE users SET quota = quota - ?, used_quota = used_quota + ?, request_count = request_count + ? WHERE id=?')
    .run(totalQuota, totalQuota, nLogs, USER_ID);
  for (const [uid, rd] of Object.entries(rewardDelta)) {
    db.prepare('UPDATE users SET invite_reward = invite_reward + ?, reward_l1 = reward_l1 + ?, reward_l2 = reward_l2 + ?, reward_l3 = reward_l3 + ? WHERE id=?')
      .run(rd.ir, rd.l[0], rd.l[1], rd.l[2], uid);
  }
  for (const [cid, d] of Object.entries(chDelta)) {
    if (cid > 0) db.prepare('UPDATE channels SET used_quota = used_quota + ? WHERE id=?').run(d, cid);
  }
  // 流水（汇总，避免爆炸）
  const bal = db.prepare('SELECT quota FROM users WHERE id=?').get(USER_ID).quota;
  db.prepare(`INSERT INTO wallet_ledger (user_id,username,delta,balance_after,kind,detail,op_user_id,op_username,op_role,request_id,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(
    USER_ID, USERNAME, -totalQuota, bal, 'adjust',
    `模拟历史回填 2026-07~10 共 ${nLogs} 单 消费 $${(totalQuota/QPS).toFixed(4)}`,
    0, 'system', '系统', 'sim-backfill:39:' + Date.now(), Date.now());
  for (const [uid, rd] of Object.entries(rewardDelta)) {
    const rbal = db.prepare('SELECT quota FROM users WHERE id=?').get(uid).quota;
    db.prepare(`INSERT INTO wallet_ledger (user_id,username,delta,balance_after,kind,detail,op_user_id,op_username,op_role,request_id,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(
      uid, rd.name, rd.ir, rbal, 'adjust',
      `模拟历史返佣 L1 ${rd.l[0]} L2 ${rd.l[1]} L3 ${rd.l[2]}`,
      0, 'system', '系统', 'sim-backfill:r'+uid+':'+Date.now(), Date.now());
  }
  db.prepare("INSERT OR REPLACE INTO settings (key,value) VALUES (?,?)").run(MARK, 'done');
  db.exec('COMMIT');
  console.log(`\n✅ 完成: ${nLogs} 主行 + ${nReward} 返佣行`);
  console.log(`   消费 $${(totalQuota/QPS).toFixed(4)}`);
  for (const [uid, rd] of Object.entries(rewardDelta)) console.log(`   返佣 #${uid} ${rd.name}: +$${(rd.ir/QPS).toFixed(4)}`);
  console.log(`   渠道:`, Object.entries(chDelta).map(([id,d])=>`#${id}+$${(d/QPS).toFixed(2)}`).join(' '));
} catch (e) {
  db.exec('ROLLBACK');
  console.error('❌ 失败已回滚:', e.message);
  process.exit(1);
}
db.close();
