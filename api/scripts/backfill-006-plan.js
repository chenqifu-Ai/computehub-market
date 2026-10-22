#!/usr/bin/env node
/**
 * backfill-006-plan.js — 账号 006 历史数据方案测算（只读，不写库）
 *
 * 目标：2026-06-01 → 2026-10-21，模型配比 kimi-k3 70% / deepseek-v4* 20% / 其他 10%
 * 特性：
 *   - 按真实计费引擎（lib/billing.js）逐小时加权算钱，含 deepseek 时段倍率
 *   - 三档规模方案对比，供老大选
 *   - 输出月度/每日/每小时分布 + 金额闭环 + 数据体量风险
 *
 * 用法: node scripts/backfill-006-plan.js [--scale mid]
 */
'use strict';
const path = require('node:path');
const billing = require(path.join(__dirname, '..', 'lib', 'billing'));

const QPS = 500000;
const T0 = Date.parse('2026-06-01T00:00:00+08:00');
const T1 = Date.parse('2026-10-21T23:59:59+08:00');

// ---- 三档规模 ----
const SCALES = {
  small: { label: '轻量（试用型）', total: 240000 },
  mid:   { label: '中等（推荐）',   total: 585000 },
  large: { label: '重载（对标005）', total: 960000 },
};
const arg = process.argv.indexOf('--scale');
const SCALE = arg >= 0 ? (SCALES[process.argv[arg + 1]] ? process.argv[arg + 1] : 'mid') : 'mid';
const TOTAL_REQ = SCALES[SCALE].total;

// ---- 月度权重（新账号爬坡：6月试水 → 9-10月稳定）----
const MONTH_W = { '2026-06': 0.12, '2026-07': 0.20, '2026-08': 0.22, '2026-09': 0.23, '2026-10': 0.23 };

// ---- 模型配比 ----
// in   = 单次输入 token 中位数（含缓存部分）
// hit  = 缓存命中率
// out  = 单次输出 token 中位数
// tmed = 单次耗时中位数（秒）
const MIX = [
  { model: 'kimi-k3',            w: 0.70, in: 12000, hit: 0.62, out: 520,  tmed: 11.0, ch: 'Ollama 云端' },
  { model: 'deepseek-v4.1-flash', w: 0.16, in: 55000, hit: 0.76, out: 780,  tmed: 7.5,  ch: 'SLCH 主站' },
  { model: 'deepseek-v4-pro',    w: 0.04, in: 95000, hit: 0.35, out: 620,  tmed: 14.0, ch: 'SLCH 主站' },
  { model: 'gpt-6.1-sol',        w: 0.04, in: 40000, hit: 0.85, out: 420,  tmed: 10.5, ch: '啊翀' },
  { model: 'glm-5.2',            w: 0.03, in: 30000, hit: 0.80, out: 560,  tmed: 9.0,  ch: 'Ollama 云端' },
  { model: 'Qwen3.8-27B',        w: 0.03, in: 60000, hit: 0.00, out: 430,  tmed: 12.0, ch: 'SLCH 主站' },
];

// ---- 小时分布（业务型双峰：9-12 / 14-18）----
const HOUR_W = [
  0.6,0.4,0.3,0.3,0.4,0.8,1.6,3.2,5.4,8.6,9.8,9.2,
  6.2,5.8,8.8,9.4,8.6,7.2,5.4,4.2,3.6,3.0,2.0,1.2
];
const HW_SUM = HOUR_W.reduce((a, b) => a + b, 0);

const DOW_F = [0.42, 1.0, 1.0, 1.0, 1.0, 1.02, 0.58];  // 周日..周六

// ---- 按小时加权算单次成本（含 peak 倍率）----
function perReqCost(m) {
  const cached = Math.round(m.in * m.hit);
  let usd = 0;
  for (let h = 0; h < 24; h++) {
    // 构造该小时的上海时间样本（2026-06-01 是周一，取任意工作日即可）
    const when = new Date(Date.UTC(2026, 5, 1, h - 8, 0, 0));  // UTC h-8 = 上海 h 点
    usd += (HOUR_W[h] / HW_SUM) * (billing.computeQuota(m.model, m.in, m.out, cached, when) / QPS);
  }
  return usd;
}

function daysBetween() {
  const out = [];
  for (let t = T0; t <= T1; t += 86400000) {
    const key = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit' }).format(new Date(t)).slice(0, 7);
    out.push({ t, key, dow: new Date(t + 8 * 3600000).getUTCDay() });
  }
  return out;
}

function buildPlan(total) {
  const days = daysBetween();
  const byMonth = {};
  for (const d of days) (byMonth[d.key] = byMonth[d.key] || []).push(d);

  const dayPlan = [];
  for (const [m, ds] of Object.entries(byMonth)) {
    const wsum = ds.reduce((a, d) => a + DOW_F[d.dow], 0);
    const monthTotal = total * (MONTH_W[m] || 0);
    for (const d of ds) {
      d.n = Math.round(monthTotal * DOW_F[d.dow] / wsum);
      dayPlan.push(d);
    }
  }
  return { days, byMonth, dayPlan, nAll: dayPlan.reduce((a, d) => a + d.n, 0) };
}

// ---- 主输出 ----
const P = buildPlan(TOTAL_REQ);
const N = P.nAll;

console.log('='.repeat(80));
console.log(`账号 006 (sutoukeji006) 历史数据回填方案 — ${SCALES[SCALE].label}`);
console.log(`区间 2026-06-01 → 2026-10-21（143 天）`);
console.log('='.repeat(80));

console.log('\n【一】月度单量节奏（新账号爬坡）');
console.log('月份      天数   单量     占比   日均    说明');
const mRows = [];
for (const m of Object.keys(P.byMonth).sort()) {
  const ds = P.byMonth[m];
  const n = ds.reduce((a, d) => a + d.n, 0);
  mRows.push({ m, days: ds.length, n });
}
for (const r of mRows) {
  const note = r.m === '2026-06' ? '试水期' : r.m === '2026-10' ? '截至 21 日' : '稳定期';
  console.log(`${r.m}  ${String(r.days).padStart(3)}  ${String(r.n).padStart(7)}  ${(r.n / N * 100).toFixed(1).padStart(5)}%  ${String(Math.round(r.n / r.days)).padStart(5)}   ${note}`);
}
console.log(`${'合计'.padEnd(8)} ${String(P.days.length).padStart(3)}  ${String(N).padStart(7)}  100.0%  ${String(Math.round(N / P.days.length)).padStart(5)}`);

console.log('\n【二】模型配比 / 单价 / 成本');
console.log('模型                  占比    单量     输入tok   命中   输出tok  单次耗时  $/次      小计($)');
let grand = 0;
const mixRows = [];
for (const m of MIX) {
  const n = Math.round(N * m.w);
  const per = perReqCost(m);
  const sub = per * n;
  grand += sub;
  mixRows.push({ ...m, n, per, sub });
  console.log(`${m.model.padEnd(21)} ${(m.w*100).toFixed(0).padStart(3)}%  ${String(n).padStart(7)}  ${String(m.in).padStart(8)}  ${(m.hit*100).toFixed(0).padStart(3)}%  ${String(m.out).padStart(7)}  ${m.tmed.toFixed(1).padStart(6)}s  ${per.toFixed(5).padStart(8)}  ${sub.toFixed(0).padStart(9)}`);
}
console.log(`${'合计'.padEnd(21)} 100%  ${String(N).padStart(7)}  ${''.padStart(8)}  ${''.padStart(4)}  ${''.padStart(7)}  ${''.padStart(7)}  ${(grand/N).toFixed(5).padStart(8)}  ${grand.toFixed(0).padStart(9)}`);

// 三档对比
console.log('\n【三】规模档位对比');
console.log('档位              总单量     累计消费     月均消费   日单量中位');
for (const [k, s] of Object.entries(SCALES)) {
  const pp = buildPlan(s.total);
  let g = 0;
  for (const m of MIX) g += perReqCost(m) * Math.round(pp.nAll * m.w);
  const d = pp.dayPlan.map(x => x.n).sort((a, b) => a - b);
  console.log(`${s.label.padEnd(16)} ${String(pp.nAll).padStart(7)}  $${g.toFixed(0).padStart(9)}  $${(g/4.7).toFixed(0).padStart(8)}  ${String(d[Math.floor(d.length/2)]).padStart(6)}${k === SCALE ? '  ← 当前方案' : ''}`);
}

console.log('\n【四】token 总量');
let tIn = 0, tOut = 0, tCache = 0;
for (const r of mixRows) { tIn += r.n * r.in; tOut += r.n * r.out; tCache += r.n * r.in * r.hit; }
console.log(`输入 token : ${(tIn/1e9).toFixed(2)} B`);
console.log(`  缓存读   : ${(tCache/1e9).toFixed(2)} B  (${(tCache/tIn*100).toFixed(0)}%)`);
console.log(`  未命中   : ${((tIn-tCache)/1e9).toFixed(2)} B  (${(100-tCache/tIn*100).toFixed(0)}%)`);
console.log(`输出 token : ${(tOut/1e9).toFixed(2)} B`);
console.log(`合计       : ${((tIn+tOut)/1e9).toFixed(2)} B`);

console.log('\n【五】金额闭环');
const opening = Math.ceil((grand + 500) / 1000) * 1000;
const rw = grand * (0.15 + 0.05 + 0.02);
console.log(`期初余额（建议）: $${opening.toFixed(0)}`);
console.log(`累计消费        : $${grand.toFixed(0)}`);
console.log(`期末余额        : $${(opening - grand).toFixed(0)}`);
console.log(`上级返佣支出    : $${rw.toFixed(0)}  (L1 15% + L2 5% + L3 2%)`);
console.log(`  上级链: 006 → #5 cqf → #7 中物 → #1 admin`);
console.log(`  #5  cqf   +$${(grand*0.15).toFixed(0)} (L1)`);
console.log(`  #7  中物   +$${(grand*0.05).toFixed(0)} (L2)`);
console.log(`  #1  admin +$${(grand*0.02).toFixed(0)} (L3)`);

console.log('\n【六】时间分布');
const daily = P.dayPlan.map(d => d.n).sort((a, b) => a - b);
const pct = q => daily[Math.floor(daily.length * q)];
console.log(`日单量  min ${daily[0]} / 中位 ${pct(0.5)} / p90 ${pct(0.9)} / max ${daily[daily.length-1]}`);
const wd = P.dayPlan.filter(d => d.dow >= 1 && d.dow <= 5);
const we = P.dayPlan.filter(d => d.dow === 0 || d.dow === 6);
console.log(`工作日日均 ${Math.round(wd.reduce((a,d)=>a+d.n,0)/wd.length)}  |  周末日均 ${Math.round(we.reduce((a,d)=>a+d.n,0)/we.length)}`);
console.log('小时内分布:');
for (let h = 0; h < 24; h += 6) {
  const seg = [];
  for (let i = h; i < h + 6; i++) seg.push(`${String(i).padStart(2,'0')}点 ${(HOUR_W[i]/HW_SUM*100).toFixed(1)}%`);
  console.log('  ' + seg.join('  '));
}
console.log(`峰值小时占比 ${(Math.max(...HOUR_W)/HW_SUM*100).toFixed(1)}% (10 点), 峰值小时单量 ≈ ${Math.round(Math.max(...HOUR_W)/HW_SUM * N / P.days.length)}`);

console.log('\n【七】数据体量与执行风险');
console.log(`主记录      : ${N.toLocaleString()} 行`);
console.log(`返佣记录    : ${(N*3).toLocaleString()} 行 (L1/L2/L3 各一条，request_id = invite:<主行id>)`);
console.log(`合计新增    : ${(N*4).toLocaleString()} 行`);
console.log(`当前 DB     : 465 MB / 194 万行（≈0.24 KB/行）`);
console.log(`预计增长    : ~${((N*4*0.24)/1024).toFixed(0)} MB → ${(465 + (N*4*0.24)/1024).toFixed(0)} MB`);
console.log(`磁盘剩余    : 7.3 GB  ${((N*4*0.24)/1024) < 2000 ? '✅ 充足' : '⚠️ 注意'}`);
console.log(`预计耗时    : ${Math.ceil(N*4/20000)} ~ ${Math.ceil(N*4/8000)} 分钟（批内事务）`);

console.log('\n' + '='.repeat(80));
console.log('以上仅为测算，未写库。');
console.log(`执行命令（确认后）：node scripts/backfill-006.js --apply --scale ${SCALE}`);
console.log('='.repeat(80));
