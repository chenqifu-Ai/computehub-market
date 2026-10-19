#!/usr/bin/env node
/**
 * backfill-sim.js — 参数化历史数据模拟回填生成器
 *
 * 数据源：scripts/sim-source.db（build-sim-source.js 构建的真实用户分池）
 * 随机从池里 resampling + 可配置扰动，回填到指定用户。
 *
 * ★ 所有可调参数集中在下方 CONFIG，改参数重跑即可。
 * ★ 修复：use_time 从源记录 resampling（单位=秒，对齐真实）；
 *         cached 与 prompt 共享同一 jitter 因子（保证 cached≤prompt，命中率≤100%）
 *
 * 用法：
 *   node scripts/backfill-sim.js                          # dry-run（看样本+统计）
 *   node scripts/backfill-sim.js --apply                  # 写库
 *   node scripts/backfill-sim.js --apply --user 39        # 指定目标用户
 *   node scripts/backfill-sim.js --rebuild                # 先重建数据源库再跑
 */
const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');

const API = path.join(__dirname, '..');
const SRC_DB = path.join(__dirname, 'sim-source.db');

// ===================== 可调参数（改这里）=====================
const CONFIG = {
  user_id: 39,            // 目标用户（sutoukeji005）
  profile: 'heavy-cached',// 数据源池：heavy-cached / cached / no-cache / mixed / all
  // 时间区间（本地时区 +08:00）
  t0: '2026-07-01T00:00:00+08:00',
  t1: '2026-10-19T14:50:00+08:00',
  // 强度曲线：月 -> 满强度比例（满强度=peak_per_day）
  peak_per_day: 2110,
  ramp: { '2026-07': 0.10, '2026-08': 0.25, '2026-09': 0.50, '2026-10': 1.0 },
  // 随机变量
  jitter_day: 0.10,       // 每日单量波动 ±10%
  jitter_req: 0.05,       // 每笔 tokens 扰动 ±5%（prompt/cached 共享因子）
  weekend_factor: 0.8,    // 周末单量系数
  seed: 20261019,         // 随机种子（可复现）
  // 其他
  source_prefix: 'sim:',  // request_id 前缀（区分模拟数据）
  ip_pool: '192.168.2.',  // 模拟 IP 段
  mark: null,             // 幂等标记（默认自动）
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

// 重建数据源
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

// ===== 读数据源池 =====
let pool;
if (CONFIG.profile === 'all') {
  pool = odb.prepare('SELECT * FROM sim_records').all();
} else {
  pool = odb.prepare('SELECT * FROM sim_records WHERE profile=?').all(CONFIG.profile);
}
if (!pool.length) { console.error(`❌ 池 '${CONFIG.profile}' 无记录`); process.exit(1); }
// 按模型分组
const byModel = {};
for (const r of pool) { (byModel[r.model_name] ||= []).push(r); }
const modelDist = Object.entries(byModel).map(([m, a]) => ({ name: m, w: a.length / pool.length, pool: a }));
console.log(`数据源池 '${CONFIG.profile}': ${pool.length} 条`);
console.log('模型分布:', modelDist.map(d => `${d.name} ${(d.w * 100).toFixed(1)}%`).join(' / '));

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
function weightedPick(items, r) { let s = 0; for (const it of items) { s += it.w; if (r < s) return it; } return items[items.length - 1]; }
// 共享 jitter 因子：prompt 和 cached 用同一个，保证 cached≤prompt
function genRecord() {
  const md = weightedPick(modelDist, rand());
  const rec = md.pool[Math.floor(rand() * md.pool.length)];
  const f = 1 + (rand() * 2 - 1) * CONFIG.jitter_req; // 同一因子
  const pin = Math.max(1, Math.round((rec.prompt_tokens || 0) * f));
  const pc = Math.min(pin, Math.max(0, Math.round((rec.cached_tokens || 0) * f))); // ≤ prompt
  const pout = Math.max(0, Math.round((rec.completion_tokens || 0) * (1 + (rand() * 2 - 1) * CONFIG.jitter_req)));
  const quota = Math.max(0, Math.round((rec.quota || 0) * (1 + (rand() * 2 - 1) * CONFIG.jitter_req)));
  const use_time = Math.max(0, (rec.use_time || 0) * (1 + (rand() * 2 - 1) * CONFIG.jitter_req)); // 秒，对齐真实
  return { ...rec, pin, pc, pout, quota, use_time };
}

// ===== 天数计划 =====
const days = [];
for (let d = new Date(T0); d.getTime() <= T1; d.setDate(d.getDate() + 1)) {
  const key = d.toISOString().slice(0, 7);
  const ramp = CONFIG.ramp[key] ?? 1.0;
  const dow = d.getDay();
  const wf = (dow === 0 || dow === 6) ? CONFIG.weekend_factor : 1.0;
  const dj = 1 + (rand() * 2 - 1) * CONFIG.jitter_day;
  days.push({ date: new Date(d), n: Math.max(0, Math.round(CONFIG.peak_per_day * ramp * wf * dj)), month: key });
}
days[days.length - 1].n = Math.round(days[days.length - 1].n * ((T1 % 86400000) / 86400000 || 0.5));
const totalN = days.reduce((s, d) => s + d.n, 0);
console.log(`\n计划: ${days.length} 天, ${totalN} 单`);
for (const m of Object.keys(CONFIG.ramp).sort()) {
  const n = days.filter(x => x.month === m).reduce((s, x) => s + x.n, 0);
  console.log(`  ${m}: ${n} 单 (${(n / totalN * 100).toFixed(1)}%)`);
}

// ===== 预估 =====
let estCost = 0, estUT = 0;
for (let i = 0; i < 2000; i++) { const g = genRecord(); estCost += g.quota; estUT += g.use_time; }
const avgCost = estCost / 2000, avgUT = estUT / 2000;
console.log(`\n预估: 均$${(avgCost / QPS).toFixed(6)}/单 × ${totalN} = $${(avgCost * totalN / QPS).toFixed(2)}, 均耗时 ${avgUT.toFixed(1)}s`);

// ===== DRY-RUN =====
if (!APPLY) {
  console.log('\n=== 30 条样本（use_time 单位=秒, cached≤prompt）===');
  for (let i = 0; i < 30; i++) {
    const day = days[Math.floor(rand() * days.length)];
    const g = genRecord();
    const h = g.hour ?? 12;
    const ts = new Date(day.date); ts.setHours(h, Math.floor(rand() * 60), Math.floor(rand() * 60), 0);
    const ratio = g.pin ? (g.pc / g.pin * 100) : 0;
    console.log(`  ${ts.toISOString().slice(5, 19)} ${g.model_name.padEnd(20)} ${String(g.channel_name).padEnd(14)} in=${String(g.pin).padStart(7)} cached=${String(g.pc).padStart(7)}(${ratio.toFixed(0)}%) out=${g.pout} use=${g.use_time.toFixed(1)}s $${(g.quota / QPS).toFixed(5)}`);
  }
  console.log('\n(dry-run, 加 --apply 写库)');
  odb.close(); db.close();
  process.exit(0);
}

// ===== APPLY =====
const done = db.prepare('SELECT value FROM settings WHERE key=?').get(MARK);
if (done) { console.error(`❌ 已执行过 (${MARK}=${done.value})`); process.exit(1); }

const target = db.prepare('SELECT id,username,inviter_id FROM users WHERE id=?').get(CONFIG.user_id);
if (!target) { console.error('❌ 目标用户不存在'); process.exit(1); }

// 返佣链
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
// 预编译
const insMain = db.prepare(`INSERT INTO logs (user_id,username,token_id,token_name,model_name,channel_id,channel_name,
  prompt_tokens,completion_tokens,cached_tokens,total_tokens,quota,use_time,is_stream,ip,request_id,status,error,created_at,log_type,source)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
const insReward = db.prepare(`INSERT INTO logs (user_id,username,token_id,token_name,model_name,channel_id,channel_name,
  prompt_tokens,completion_tokens,cached_tokens,total_tokens,quota,use_time,is_stream,ip,request_id,status,error,created_at,log_type,source)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);

let nLogs = 0, nReward = 0, totalQuota = 0, over100 = 0;
const rewardDelta = {}, chDelta = {};

try {
  for (const day of days) {
    for (let i = 0; i < day.n; i++) {
      const g = genRecord();
      if (g.pc > g.pin) { g.pc = g.pin; over100++; }
      const h = g.hour ?? 12;
      const ts = new Date(day.date); ts.setHours(h, Math.floor(rand() * 60), Math.floor(rand() * 60), 0);
      const created_at = ts.getTime();
      if (created_at > T1) continue;
      const rid = CONFIG.source_prefix + crypto.randomBytes(8).toString('hex');
      const ip = CONFIG.ip_pool + (10 + Math.floor(rand() * 200));
      const tot = g.pin + g.pout + g.pc;

      insMain.run(CONFIG.user_id, target.username, 0, '', g.model_name, g.channel_id || 0, g.channel_name || '',
        g.pin, g.pout, g.pc, tot, g.quota, g.use_time, 0, ip, rid, 'success', '', created_at, 'consume', 'sim');
      nLogs++; totalQuota += g.quota;
      if (g.channel_id) chDelta[g.channel_id] = (chDelta[g.channel_id] || 0) + g.quota;

      for (let li = 0; li < upline.length && li < 3; li++) {
        const rate = RATES[li];
        if (!rate || rate <= 0) continue;
        const rw = Math.floor(g.quota * rate);
        if (rw <= 0) continue;
        insReward.run(upline[li].id, 'agent-reward-L' + (li + 1), 0, '返佣L' + (li + 1), g.model_name, 0, '',
          g.pin, g.pout, g.pc, tot, -rw, g.use_time, 0, ip, 'invite:' + rid, 'success', '', created_at, 'consume', 'sim');
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
    `模拟历史回填 共${nLogs}单 消费$${(totalQuota / QPS).toFixed(4)} [${CONFIG.profile}]`, 0, 'system', '系统', 'sim-backfill:' + CONFIG.user_id + ':' + Date.now(), Date.now());
  for (const [uid, rd] of Object.entries(rewardDelta)) {
    const rb = db.prepare('SELECT quota FROM users WHERE id=?').get(uid).quota;
    db.prepare(`INSERT INTO wallet_ledger (user_id,username,delta,balance_after,kind,detail,op_user_id,op_username,op_role,request_id,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(uid, rd.name, rd.ir, rb, 'adjust',
      `模拟历史返佣 L1 ${rd.l[0]} L2 ${rd.l[1]} L3 ${rd.l[2]}`, 0, 'system', '系统', 'sim-backfill:r' + uid + ':' + Date.now(), Date.now());
  }
  db.prepare('INSERT OR REPLACE INTO settings (key,value) VALUES (?,?)').run(MARK, 'done');
  db.exec('COMMIT');
  const dt = (Date.now() - tStart) / 1000;
  console.log(`\n✅ 完成 (${dt.toFixed(1)}s): ${nLogs} 主行 + ${nReward} 返佣行, cached>prompt 已钳制 ${over100} 条`);
  console.log(`   消费 $${(totalQuota / QPS).toFixed(4)}`);
  for (const [uid, rd] of Object.entries(rewardDelta)) console.log(`   返佣 #${uid} ${rd.name}: +$${(rd.ir / QPS).toFixed(4)}`);
  console.log(`   渠道:`, Object.entries(chDelta).map(([id, d]) => `#${id}+$${(d / QPS).toFixed(2)}`).join(' '));
} catch (e) {
  db.exec('ROLLBACK');
  console.error('❌ 失败已回滚:', e.message);
  process.exit(1);
}
odb.close(); db.close();
