#!/usr/bin/env node
/**
 * backfill-pricing.js — 定价修正后的历史回填（补扣 + 重算汇总）
 *
 * 背景：啊翀 9 模型曾缺定价，历史记录走了 default 价 → 少收。
 *      补齐定价只影响新请求；本脚本把【修复生效前】受影响的记录按新价重算。
 *
 * 影响范围：
 *   - logs.quota（主消费行 + 对应返佣行）
 *   - users.quota（余额补扣）、users.used_quota
 *   - users.invite_reward / reward_l1|l2|l3（返佣重算）
 *   - tokens.used_quota、channels.used_quota
 *   - wallet_ledger 新增 kind='adjust' 流水（每笔补扣/返佣差一条，留痕可对账）
 *
 * 幂等：--apply 成功后写 settings.pricing_backfill_<TAG>=done，重复运行会拒绝。
 * 默认 dry-run（只报告），加 --apply 才真正写库。
 *
 * 用法：
 *   node scripts/backfill-pricing.js                 # 预览
 *   node scripts/backfill-pricing.js --apply         # 执行
 *   node scripts/backfill-pricing.js --tag v1        # 自定义标记
 */
const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');
const fs = require('node:fs');

const API = path.join(__dirname, '..');
const billing = require(path.join(API, 'lib', 'billing'));

const MODELS = ['codex-auto-review', 'gpt-5.6-luna', 'gpt-5.6-sol', 'gpt-5.6-terra',
  'gpt-6-astra', 'gpt-6-luna', 'gpt-6-sol', 'gpt-6.1-sol', 'gpt-reserve'];
// 修复生效时刻（服务重启应用新 pricing.json）
const CUTOFF = Date.parse('2026-10-19T12:24:19+08:00');

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const TAG = (() => { const i = args.indexOf('--tag'); return i >= 0 ? args[i + 1] : '20261019'; })();
const MARK = 'pricing_backfill_' + TAG;

const db = new DatabaseSync(path.join(API, 'api.db'));
db.exec('PRAGMA journal_mode=WAL');
db.exec('PRAGMA busy_timeout=15000');

const RATES = [
  parseFloat(db.prepare("SELECT value FROM settings WHERE key='invite_reward_rate'").get()?.value || '0'),
  parseFloat(db.prepare("SELECT value FROM settings WHERE key='agent_reward_l2'").get()?.value || '0'),
  parseFloat(db.prepare("SELECT value FROM settings WHERE key='agent_reward_l3'").get()?.value || '0'),
];

// 已执行过？
const done = db.prepare('SELECT value FROM settings WHERE key=?').get(MARK);
if (done && APPLY) { console.error(`❌ 已执行过（${MARK}=${done.value}），拒绝重复回填。`); process.exit(1); }

const ph = MODELS.map(() => '?').join(',');
const mains = db.prepare(`
  SELECT * FROM logs
  WHERE model_name IN (${ph}) AND log_type='consume'
    AND username NOT LIKE 'agent-reward%'
    AND created_at < ?
  ORDER BY created_at ASC`).all(...MODELS, CUTOFF);

console.log(`修复生效时刻: ${new Date(CUTOFF).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`);
console.log(`返佣率 L1/L2/L3 = ${RATES.join(' / ')}`);
console.log(`受影响主消费行: ${mains.length}\n`);

const usd = q => '$' + (q / billing.QUOTA_PER_USD).toFixed(4);
const plan = [];  // {main, newQ, delta, rewards:[{row,newR,delta}]}
const userAgg = {};   // uid -> {usd_delta, quota_delta, used_delta, name}
const rewardAgg = {}; // uid -> {reward_delta, byLevel}
const tokAgg = {}, chAgg = {};

for (const m of mains) {
  const newQ = billing.computeQuota(m.model_name, m.prompt_tokens || 0, m.completion_tokens || 0,
    m.cached_tokens || 0, new Date(m.created_at));
  const delta = newQ - (m.quota || 0);
  if (delta === 0) continue;

  // 对应返佣行
  const rw = db.prepare(`SELECT * FROM logs WHERE request_id=? AND username LIKE 'agent-reward%'`)
    .all('invite:' + m.request_id);
  const rewards = [];
  for (const r of rw) {
    const lv = parseInt((r.username.match(/L(\d)/) || [])[1] || '0', 10);
    const rate = RATES[lv - 1] || 0;
    const newR = rate > 0 ? -Math.floor(newQ * rate) : 0;   // 返佣 log 行（负向）
    const logDelta = newR - (r.quota || 0);
    const posDelta = -logDelta;                              // invite_reward 累计（正向）
    if (logDelta !== 0) rewards.push({ row: r, newR, logDelta, posDelta, level: lv });
  }

  plan.push({ m, newQ, delta, rewards });

  const ua = userAgg[m.user_id] || (userAgg[m.user_id] = { name: m.username, quota_delta: 0, used_delta: 0 });
  ua.quota_delta -= delta; ua.used_delta += delta;
  for (const rw2 of rewards) {
    const ra = rewardAgg[rw2.row.user_id] || (rewardAgg[rw2.row.user_id] = { name: rw2.row.username, delta: 0, lv: {} });
    ra.delta += rw2.posDelta; ra.lv[rw2.level] = (ra.lv[rw2.level] || 0) + rw2.posDelta;
  }
  tokAgg[m.token_id] = (tokAgg[m.token_id] || 0) + delta;
  chAgg[m.channel_id] = (chAgg[m.channel_id] || 0) + delta;
}

const sumDelta = plan.reduce((s, p) => s + p.delta, 0);
const sumOld = plan.reduce((s, p) => s + (p.m.quota || 0), 0);
const sumNew = plan.reduce((s, p) => s + p.newQ, 0);

console.log('=== 主消费补扣汇总 ===');
for (const [uid, a] of Object.entries(userAgg)) {
  const u = db.prepare('SELECT username,quota FROM users WHERE id=?').get(uid);
  console.log(`  #${uid} ${a.name}: 余额补扣 ${usd(-a.quota_delta)}  新余额→ ${usd((u?.quota || 0) + a.quota_delta)}`);
}
console.log(`\n  记账合计 ${usd(sumOld)} → ${usd(sumNew)}  补扣差额 ${usd(sumDelta)}`);

console.log('\n=== 返佣重算汇总（计入 invite_reward，不直接进余额）===');
for (const [uid, a] of Object.entries(rewardAgg)) {
  console.log(`  #${uid} ${a.name}: invite_reward ${a.delta >= 0 ? '+' : ''}${a.delta}` +
    ` (L1 ${a.lv[1] || 0} / L2 ${a.lv[2] || 0} / L3 ${a.lv[3] || 0})`);
}

console.log('\n=== 令牌 / 渠道 used_quota 增量 ===');
for (const [tid, d] of Object.entries(tokAgg)) console.log(`  token #${tid}: +${d}`);
for (const [cid, d] of Object.entries(chAgg)) console.log(`  channel #${cid}: +${d}`);

console.log(`\n受影响主行 ${plan.length} 笔，返佣行 ${plan.reduce((s, p) => s + p.rewards.length, 0)} 笔`);

if (!APPLY) {
  console.log('\n（dry-run，未写库。加 --apply 执行）');
  process.exit(0);
}

// ---------- 执行 ----------
db.exec('BEGIN IMMEDIATE');
try {
  const now = Date.now();
  let nLedger = 0;
  for (const { m, newQ, delta, rewards } of plan) {
    // 1) 主行 quota
    db.prepare('UPDATE logs SET quota=? WHERE id=?').run(newQ, m.id);
    // 2) 余额 + 汇总
    db.prepare('UPDATE users SET quota = quota - ?, used_quota = used_quota + ? WHERE id=?').run(delta, delta, m.user_id);
    // 3) 留痕：补扣（负数）
    const bal = db.prepare('SELECT quota FROM users WHERE id=?').get(m.user_id).quota;
    db.prepare(`INSERT INTO wallet_ledger (user_id,username,delta,balance_after,kind,detail,op_user_id,op_username,op_role,request_id,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(
      m.user_id, m.username, -delta, bal, 'adjust',
      `定价修正补扣 ${m.model_name} 原 ${usd(m.quota || 0)}→${usd(newQ)}（ref log#${m.id}）`,
      0, 'system', '系统', 'pricing-backfill:' + m.id, now);
    nLedger++;
    // 4) 返佣行
    for (const r of rewards) {
      db.prepare('UPDATE logs SET quota=? WHERE id=?').run(r.newR, r.row.id);
      const col = r.level === 1 ? 'reward_l1' : r.level === 2 ? 'reward_l2' : 'reward_l3';
      db.prepare(`UPDATE users SET invite_reward = invite_reward + ?, ${col} = ${col} + ? WHERE id=?`)
        .run(r.posDelta, r.posDelta, r.row.user_id);
      const rbal = db.prepare('SELECT quota FROM users WHERE id=?').get(r.row.user_id).quota;
      db.prepare(`INSERT INTO wallet_ledger (user_id,username,delta,balance_after,kind,detail,op_user_id,op_username,op_role,request_id,created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(
        r.row.user_id, r.row.username, r.posDelta, rbal, 'adjust',
        `定价修正返佣重算 L${r.level}（ref log#${r.row.id}）`,
        0, 'system', '系统', 'pricing-backfill:r' + r.row.id, now);
      nLedger++;
    }
    // 5) 令牌 / 渠道
    db.prepare('UPDATE tokens SET used_quota = used_quota + ? WHERE id=?').run(delta, m.token_id);
    db.prepare('UPDATE channels SET used_quota = used_quota + ? WHERE id=?').run(delta, m.channel_id);
  }
  db.prepare("INSERT OR REPLACE INTO settings (key,value) VALUES (?,?)").run(MARK, 'done');
  db.exec('COMMIT');
  console.log(`\n✅ 回填完成：修正 ${plan.length} 主行，写入 ${nLedger} 条 adjust 流水，标记 ${MARK}=done`);
} catch (e) {
  db.exec('ROLLBACK');
  console.error('❌ 失败已回滚:', e.message);
  process.exit(1);
}
