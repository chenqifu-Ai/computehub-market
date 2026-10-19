#!/usr/bin/env node
/**
 * backfill-sim.js — 会话块保真 · 参数化历史数据模拟回填生成器
 *
 * 数据源：scripts/sim-source.db（build-sim-source.js 构建的"会话块"库）
 * 以【会话块】为单位随机提取：
 *   - 块 = 真实连续会话（同模型+同渠道+间隔≤2min 的记录组）
 *   - 块内按原始顺序 + 原始间隔生成 → 输入递减/递增连续性保留
 *   - 块间按真实间隔节奏游走
 *
 * ★ 所有可调参数集中在 CONFIG 顶部。
 * 扰动规则（保真）：
 *   输入 = 源 × U(0.95,1.00)   缓存读 = 输入 × 源命中率（直接用真实命中率）
 *   未命中 = 输入 − 缓存读     输出/耗时/费用 = 源 × U(0.99,1.00)
 *
 * 用法：
 *   node scripts/backfill-sim.js                  # dry-run（时间序列样本）
 *   node scripts/backfill-sim.js --apply          # 写库
 *   node scripts/backfill-sim.js --apply --user 39 --profile heavy-cached
 *   node scripts/backfill-sim.js --rebuild        # 先重建数据源库
 */
const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');

const API = path.join(__dirname, '..');
const SRC_DB = path.join(__dirname, 'sim-source.db');

// ===================== 可调参数（改这里）=====================
const CONFIG = {
  user_id: 39,            // 目标用户
  profile: 'heavy-cached',// 数据池：heavy-cached / cached / no-cache / mixed / all
  t0: '2026-06-01T00:00:00+08:00',
  t1: '2026-10-19T14:50:00+08:00',
  peak_per_day: 2110,     // (已弃用, 改用 MONTH_COST 月级配额)
  ramp: { '2026-07': 0.10, '2026-08': 0.25, '2026-09': 0.50, '2026-10': 1.0 },
  jitter_day: 0.10,       // 每日单量波动 ±10%
  jitter_req: 0.05,       // 输入扰动幅度（100%-5% ~ 100%）
  weekend_factor: 0.8,    // 周末单量系数
  seed: 20261019,         // 随机种子（可复现）
  source_prefix: 'sim:',
  ip_pool: '192.168.2.',
  mark: null,
};
// ==============================================================

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const REBUILD = args.includes('--rebuild');
const userArg = args.indexOf('--user');
if (userArg >= 0) CONFIG.user_id = parseInt(args[userArg + 1], 10);
const profArg = args.indexOf('--profile');
if (profArg >= 0) CONFIG.profile = args[profArg + 1];
const T0 = Date.parse(CONFIG.t0);
const T1 = Date.parse(CONFIG.t1);

if (REBUILD) {
  console.log('→ 重建数据源库...');
  const { execSync } = require('node:child_process');
  execSync(`node --experimental-sqlite "${path.join(__dirname, 'build-sim-source.js')}"`, { stdio: 'inherit' });
}
if (!fs.existsSync(SRC_DB)) {
  console.error('❌ 数据源库不存在，先跑: node scripts/build-sim-source.js');
  process.exit(1);
}

const odb = new DatabaseSync(SRC_DB, { readOnly: true });
const db = new DatabaseSync(path.join(API, 'api.db'));
db.exec('PRAGMA journal_mode=WAL');
db.exec('PRAGMA busy_timeout=15000');

const QPS = 500000;
const MARK = CONFIG.mark || `sim_backfill_${CONFIG.user_id}_${new Date().toISOString().slice(0, 10).replace(/-/g, '')}`;

// ===== 读会话块 =====
const blocks = CONFIG.profile === 'all'
  ? odb.prepare('SELECT * FROM sim_blocks').all()
  : odb.prepare('SELECT * FROM sim_blocks WHERE profile=?').all(CONFIG.profile);
if (!blocks.length) { console.error(`❌ 池 '${CONFIG.profile}' 无块`); process.exit(1); }
for (const b of blocks) b.recs = JSON.parse(b.recs);
const totalRecs = blocks.reduce((s, b) => s + b.n, 0);
console.log(`数据源池 '${CONFIG.profile}': ${blocks.length} 块 / ${totalRecs} 条`);

// ===== 块大小分布（按记录数加权 → 长会话更多被抽到）=====
const sizeBuckets = [[1, 1], [2, 2], [3, 5], [6, 15], [16, 10 ** 9]];
const sizeDist = sizeBuckets.map(([lo, hi]) => ({
  lo, hi,
  w: blocks.filter(b => b.n >= lo && b.n <= hi).reduce((s, b) => s + b.n, 0) / totalRecs,
})).filter(d => d.w > 0);

// ===== 真实块间间隔（对数正态，从块内 gap 学）=====
const allGaps = [];
for (const b of blocks) for (const r of b.recs) if (r.gap > 0 && r.gap < 3600) allGaps.push(r.gap);
allGaps.sort((a, b) => a - b);
let gapMu = Math.log(15), gapSigma = 1.0;
if (allGaps.length >= 10) {
  const lg = allGaps.map(g => Math.log(g));
  gapMu = lg.reduce((a, b) => a + b, 0) / lg.length;
  gapSigma = Math.sqrt(lg.reduce((a, b) => a + (b - gapMu) ** 2, 0) / lg.length);
}
console.log(`块内间隔中位 ${allGaps[Math.floor(allGaps.length / 2)].toFixed(1)}s, 块间间隔拟合 logN(mu=${gapMu.toFixed(2)}, sigma=${gapSigma.toFixed(2)})`);

// ===== 小时密度（真实分布，从源记录学）=====
const hourDist = [4.4,5.4,2.3,1.0,1.0,1.0,1.0,1.0,1.0,1.0,5.5,9.5,2.2,3.9,9.0,11.9,10.5,5.0,2.5,0.8,1.6,5.0,9.5,4.0]; // %

// ===== PRNG =====
function mulberry32(seed) {
  return function () {
    seed |= 0; seed = seed + 0x6D2B79F5 | 0;
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(CONFIG.seed);
function randn() {
  let u = 0, v = 0; while (u === 0) u = rand(); while (v === 0) v = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
function sampleGap() { return Math.max(2, Math.min(1800, Math.exp(gapMu + gapSigma * randn()))); }
function weightedPick(items, r) { let s = 0; for (const it of items) { s += it.w; if (r < s) return it; } return items[items.length - 1]; }
function pickBlock() {
  const sz = weightedPick(sizeDist, rand());
  const cand = blocks.filter(b => b.n >= sz.lo && b.n <= sz.hi);
  const wsum = cand.reduce((s, b) => s + b.n, 0);
  let r = rand() * wsum;
  for (const b of cand) { r -= b.n; if (r < 0) return b; }
  return cand[cand.length - 1];
}
// 块内单条：输入 95-100%，缓存=输入×源命中率（真实），输出/耗时/费用 1% 内
function genRec(rec) {
  const srcHit = rec.pin > 0 ? rec.pc / rec.pin : 0;
  const pin = Math.max(1, Math.round(rec.pin * (0.95 + rand() * 0.05)));
  const pc = Math.min(pin, Math.round(pin * srcHit));
  const pout = Math.max(0, Math.round(rec.pout * (0.99 + rand() * 0.01)));
  const quota = Math.max(0, Math.round(rec.quota * (0.99 + rand() * 0.01)));
  const use_time = Math.max(0, rec.ut * (0.99 + rand() * 0.01));
  return { pin, pc, pout, quota, use_time };
}

// ===== 生成一天（按块拼装，块内原始间隔，块间真实间隔）=====
// 块内采样：长块按 (15/n) 概率抽条 → 每块贡献期望~15条，长会话不会霸屏；短块全取
function genDay(day, dayEnd, targetN) {
  const out = [];
  let t = day.getTime() + Math.floor(rand() * 3600000); // 从当天随机小时开始
  while (t < dayEnd && out.length < targetN) {
    const b = pickBlock();
    const p = Math.min(1, 15 / b.n); // 块内采样概率
    for (let i = 0; i < b.recs.length && t < dayEnd && out.length < targetN; i++) {
      if (rand() > p) continue;
      const rec = b.recs[i];
      out.push({ t: Math.floor(t), rec, model: b.model_name, cid: b.channel_id, cname: b.channel_name });
      t += (rec.gap || 2) * 1000;
    }
    t += sampleGap() * 1000; // 块间间隔
  }
  return out;
}

// ===== 天数计划（月级配额: 6月$600, 7-10月$1200-1500）=====
const MONTH_COST = { '2026-06': 480, '2026-07': 1300, '2026-08': 1350, '2026-09': 1400, '2026-10': 1450 }; // $/月
const COST_PER_REQ = 0.004668; // 实测单位成本($/单)
const days = [];
for (let d = new Date(T0); d.getTime() <= T1; d.setDate(d.getDate() + 1)) {
  const key = d.toISOString().slice(0, 7);
  const monthEnd = d.getTime() + 86400000 > T1 ? T1 : d.getTime() + 86400000;
  const dj = 1 + (rand() * 2 - 1) * CONFIG.jitter_day;
  const dow = d.getDay();
  const wf = (dow === 0 || dow === 6) ? CONFIG.weekend_factor : 1.0;
  // 当日目标单量 = 月目标 / 当月天数 / 单位成本, 受 t1 截断的天按比例
  const monthUsd = MONTH_COST[key] ?? MONTH_COST[Object.keys(MONTH_COST).pop()];
  // 当月天数(日历)
  const [yy, mm] = key.split('-').map(Number);
  const fullDays = new Date(yy, mm, 0).getDate();
  const monthStart = Math.max(T0, Date.parse(key + '-01T00:00:00+08:00'));
  const monthEndTs = Math.min(T1 + 86400000, Date.parse(key + '-01T00:00:00+08:00') + fullDays * 86400000);
  const monthDays = Math.max(0.5, (monthEndTs - monthStart) / 86400000);
  const dayFrac = Math.min(1, (monthEnd - d.getTime()) / 86400000); // 当天有效比例
  const n = Math.max(0, Math.round((monthUsd / monthDays / COST_PER_REQ) * wf * dj * dayFrac));
  // 按小时分布分配 + 每小时用真实间隔游走生成（桶配额×1.2 补偿; 总量以桶配额为准）
  const hourN = hourDist.map(h => Math.round(n * h / 100 * 1.2));
  const items = [];
  for (let h = 0; h < 24; h++) {
    let t = d.getTime() + h * 3600000;
    const hEnd = Math.min(monthEnd, t + 3600000);
    for (let i = 0; i < hourN[h] && t < hEnd && items.length < n; i++) {
      const b = pickBlock();
      const p = Math.min(1, 20 / b.n);
      let added = 0;
      for (let k = 0; k < b.recs.length && t < hEnd && items.length < n && added < 4; k++) {
        if (rand() > p) continue;
        items.push({ t: Math.floor(t), rec: b.recs[k], model: b.model_name, cid: b.channel_id, cname: b.channel_name });
        added++;
        t += (b.recs[k].gap || 2) * 1000;
      }
      if (added === 0) t += sampleGap() * 1000;
      else t += sampleGap() * 0.3 * 1000; // 同小时块间短间隔
    }
  }
  items.sort((a, b2) => a.t - b2.t);
  days.push({ date: new Date(d), month: key, items });
}
const totalN = days.reduce((s, d) => s + d.items.length, 0);
console.log(`\n计划: ${days.length} 天 (6月$600 → 7-10月$1200-1500/月)`);
for (const m of Object.keys(MONTH_COST).sort()) {
  const n = days.filter(x => x.month === m).reduce((s, x) => s + x.items.length, 0);
  console.log(`  ${m}: ${n} 单 ≈ $${(n * COST_PER_REQ).toFixed(0)}`);
}

// ===== DRY-RUN =====
if (!APPLY) {
  const mid = days[Math.floor(days.length / 2)];
  console.log(`\n=== 时间序列样本（${mid.month} 中段，显示块边界 ◆）===`);
  let lastBlock = null;
  const shown = mid.items.slice(0, 40);
  for (const it of shown) {
    const g = genRec(it.rec);
    const t = new Date(it.t);
    const local = `${t.getMonth() + 1}-${String(t.getDate()).padStart(2, '0')} ${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}:${String(t.getSeconds()).padStart(2, '0')}`;
    const hit = g.pin ? (g.pc / g.pin * 100) : 0;
    const bmark = (it !== shown[0] && it.rec !== lastBlock) ? ' ◆' : '';
    lastBlock = it.rec;
    console.log(`  ${local} ${it.model.slice(0, 18).padEnd(18)} ${String(it.cname).slice(0, 12).padEnd(12)} in=${String(g.pin).padStart(7)} cached=${String(g.pc).padStart(7)}(${hit.toFixed(0)}%) out=${g.pout} use=${g.use_time.toFixed(1)}s $${(g.quota / QPS).toFixed(5)}${bmark}`);
  }
  console.log('\n◆ = 新会话块开始（块内连续，块间随机间隔）');
  console.log('\n(dry-run, 加 --apply 写库)');
  odb.close(); db.close();
  process.exit(0);
}

// ===== APPLY =====
const done = db.prepare('SELECT value FROM settings WHERE key=?').get(MARK);
if (done) { console.error(`❌ 已执行过 (${MARK}=${done.value})`); process.exit(1); }
const target = db.prepare('SELECT id,username,inviter_id FROM users WHERE id=?').get(CONFIG.user_id);
if (!target) { console.error('❌ 目标用户不存在'); process.exit(1); }

const upline = [];
let cur = target;
while (cur && cur.inviter_id) {
  const p = db.prepare('SELECT id,username FROM users WHERE id=?').get(cur.inviter_id);
  if (!p) break; upline.push(p); cur = p;
}
const RATES = [
  parseFloat(db.prepare("SELECT value FROM settings WHERE key='invite_reward_rate'").get()?.value || '0'),
  parseFloat(db.prepare("SELECT value FROM settings WHERE key='agent_reward_l2'").get()?.value || '0'),
  parseFloat(db.prepare("SELECT value FROM settings WHERE key='agent_reward_l3'").get()?.value || '0'),
];

const tStart = Date.now();
db.exec('BEGIN IMMEDIATE');
const insMain = db.prepare(`INSERT INTO logs (user_id,username,token_id,token_name,model_name,channel_id,channel_name,
  prompt_tokens,completion_tokens,cached_tokens,total_tokens,quota,use_time,is_stream,ip,request_id,status,error,created_at,log_type,source)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
const insReward = db.prepare(`INSERT INTO logs (user_id,username,token_id,token_name,model_name,channel_id,channel_name,
  prompt_tokens,completion_tokens,cached_tokens,total_tokens,quota,use_time,is_stream,ip,request_id,status,error,created_at,log_type,source)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);

let nLogs = 0, nReward = 0, totalQuota = 0;
const rewardDelta = {}, chDelta = {};
try {
  for (const day of days) {
    for (const it of day.items) {
      const g = genRec(it.rec);
      const rid = CONFIG.source_prefix + crypto.randomBytes(8).toString('hex');
      const ip = CONFIG.ip_pool + (10 + Math.floor(rand() * 200));
      const tot = g.pin + g.pout + g.pc;
      insMain.run(CONFIG.user_id, target.username, 0, '', it.model, it.cid || 0, it.cname || '',
        g.pin, g.pout, g.pc, tot, g.quota, g.use_time, 0, ip, rid, 'success', '', it.t, 'consume', 'sim');
      nLogs++; totalQuota += g.quota;
      if (it.cid) chDelta[it.cid] = (chDelta[it.cid] || 0) + g.quota;
      for (let li = 0; li < upline.length && li < 3; li++) {
        const rate = RATES[li];
        if (!rate || rate <= 0) continue;
        const rw = Math.floor(g.quota * rate);
        if (rw <= 0) continue;
        insReward.run(upline[li].id, 'agent-reward-L' + (li + 1), 0, '返佣L' + (li + 1), it.model, 0, '',
          g.pin, g.pout, g.pc, tot, -rw, g.use_time, 0, ip, 'invite:' + rid, 'success', '', it.t, 'consume', 'sim');
        nReward++;
        const rd = rewardDelta[upline[li].id] || (rewardDelta[upline[li].id] = { name: upline[li].username, ir: 0, l: [0, 0, 0] });
        rd.ir += rw; rd.l[li] += rw;
      }
    }
  }
  db.prepare('UPDATE users SET quota = quota - ?, used_quota = used_quota + ?, request_count = request_count + ? WHERE id=?')
    .run(totalQuota, totalQuota, nLogs, CONFIG.user_id);
  for (const [uid, rd] of Object.entries(rewardDelta)) {
    db.prepare('UPDATE users SET invite_reward = invite_reward + ?, reward_l1 = reward_l1 + ?, reward_l2 = reward_l2 + ?, reward_l3 = reward_l3 + ? WHERE id=?')
      .run(rd.ir, rd.l[0], rd.l[1], rd.l[2], uid);
  }
  for (const [cid, d] of Object.entries(chDelta)) db.prepare('UPDATE channels SET used_quota = used_quota + ? WHERE id=?').run(d, cid);
  const bal = db.prepare('SELECT quota FROM users WHERE id=?').get(CONFIG.user_id).quota;
  db.prepare(`INSERT INTO wallet_ledger (user_id,username,delta,balance_after,kind,detail,op_user_id,op_username,op_role,request_id,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(CONFIG.user_id, target.username, -totalQuota, bal, 'adjust',
    `模拟历史回填(会话块) 共${nLogs}单 消费$${(totalQuota / QPS).toFixed(4)} [${CONFIG.profile}]`, 0, 'system', '系统', 'sim-backfill:' + CONFIG.user_id + ':' + Date.now(), Date.now());
  for (const [uid, rd] of Object.entries(rewardDelta)) {
    const rb = db.prepare('SELECT quota FROM users WHERE id=?').get(uid).quota;
    db.prepare(`INSERT INTO wallet_ledger (user_id,username,delta,balance_after,kind,detail,op_user_id,op_username,op_role,request_id,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(uid, rd.name, rd.ir, rb, 'adjust',
      `模拟历史返佣 L1 ${rd.l[0]} L2 ${rd.l[1]} L3 ${rd.l[2]}`, 0, 'system', '系统', 'sim-backfill:r' + uid + ':' + Date.now(), Date.now());
  }
  db.prepare('INSERT OR REPLACE INTO settings (key,value) VALUES (?,?)').run(MARK, 'done');
  db.exec('COMMIT');
  const dt = (Date.now() - tStart) / 1000;
  console.log(`\n✅ 完成 (${dt.toFixed(1)}s): ${nLogs} 主行 + ${nReward} 返佣行`);
  console.log(`   消费 $${(totalQuota / QPS).toFixed(4)}`);
  for (const [uid, rd] of Object.entries(rewardDelta)) console.log(`   返佣 #${uid} ${rd.name}: +$${(rd.ir / QPS).toFixed(4)}`);
  console.log(`   渠道:`, Object.entries(chDelta).map(([id, d]) => `#${id}+$${(d / QPS).toFixed(2)}`).join(' '));
} catch (e) {
  db.exec('ROLLBACK');
  console.error('❌ 失败已回滚:', e.message);
  process.exit(1);
}
odb.close(); db.close();
