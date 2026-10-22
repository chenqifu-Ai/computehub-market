#!/usr/bin/env node
/**
 * backfill-006.js — 账号 006 历史数据回填执行器
 *
 * 区间：2026-06-01 → 2026-10-21
 * 配比：kimi-k3 70% / deepseek-v4 系 20% / 其他 10%
 *
 * 拟真原则（对齐真实调用特征，不是随机堆数）：
 *   1. 会话块**不重叠**：一天内按小时桶分配会话，同一时刻只有一个会话在用
 *      → 会话内连续多轮，会话间有间隔，不会出现"每 5 秒一个新会话"的假象
 *   2. 首轮 cache miss（命中 5~20%），第 2 轮起才高命中（55~92%）
 *      → 整体命中率自然落在 30~45%，接近 005 的真实 36%
 *   3. 输入 token 按会话温和累积（ctx 增量小），不出现 21B 虚高
 *   4. 耗时与输出正相关：use_time ≈ 1.0 + output/60 + 抖动
 *   5. 工作日/周末系数、小时双峰 9-12 / 14-18
 *   6. 计费走真实引擎 lib/billing.js（含 deepseek 时段倍率）
 *
 * 用法:
 *   node scripts/backfill-006.js                    # dry-run
 *   node scripts/backfill-006.js --apply            # 写库（默认 mid）
 *   node scripts/backfill-006.js --apply --scale small
 *   node scripts/backfill-006.js --reset            # 撤销本次写入
 */
'use strict';
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const billing = require(path.join(__dirname, '..', 'lib', 'billing'));

const API = path.join(__dirname, '..');

// ============ 参数 ============
const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const RESET = args.includes('--reset');
const SCALES = {
  small: { label: '轻量', total: 240000 },
  mid:   { label: '中等', total: 585000 },
  large: { label: '重载', total: 960000 },
};
const si = args.indexOf('--scale');
const SCALE = si >= 0 && SCALES[args[si + 1]] ? args[si + 1] : 'mid';
const TOTAL_REQ = SCALES[SCALE].total;

const UID = 40;
const USERNAME = 'sutoukeji006';
const NEW_CREATED_AT = Date.parse('2026-06-01T09:12:34+08:00');
const TOPUP_USD = 13000;
const WRITE_REWARD = true;

const T0 = Date.parse('2026-06-01T00:00:00+08:00');
const T1 = Date.parse('2026-10-21T23:59:59+08:00');

const MARK = `backfill_006_${SCALE}`;
const SRC = `sim006-${SCALE}`;
const RID_PREFIX = `sim006:${SCALE}:`;
const QPS = 500000;

// ============ 分布参数 ============
const MONTH_W = { '2026-06': 0.12, '2026-07': 0.20, '2026-08': 0.22, '2026-09': 0.23, '2026-10': 0.23 };

// in   = 首轮输入 token 中位
// ctx  = 每轮上下文增量中位（占比小，避免 token 爆炸）
// h0   = 首轮缓存命中（低）
// hN   = 后续轮命中（高）
// out  = 单轮输出中位
const MIX = [
  { model: 'kimi-k3',            w: 0.70, in: 14000, ctx: 900,  h0: 0.06, hN: 0.40, out: 520,  ch: 'Ollama 云端' },
  { model: 'deepseek-v4.1-flash', w: 0.16, in: 42000, ctx: 2600, h0: 0.08, hN: 0.45, out: 700,  ch: 'SLCH 主站' },
  { model: 'deepseek-v4-pro',    w: 0.04, in: 68000, ctx: 3600, h0: 0.03, hN: 0.25, out: 620,  ch: 'SLCH 主站' },
  { model: 'gpt-6.1-sol',        w: 0.04, in: 34000, ctx: 2200, h0: 0.10, hN: 0.55, out: 400,  ch: '啊翀' },
  { model: 'glm-5.2',            w: 0.03, in: 26000, ctx: 1800, h0: 0.06, hN: 0.42, out: 540,  ch: 'Ollama 云端' },
  { model: 'Qwen3.8-27B',        w: 0.03, in: 46000, ctx: 2800, h0: 0.00, hN: 0.00, out: 420,  ch: 'SLCH 主站' },
];

const HOUR_W = [
  0.6,0.4,0.3,0.3,0.4,0.8,1.6,3.2,5.4,8.6,9.8,9.2,
  6.2,5.8,8.8,9.4,8.6,7.2,5.4,4.2,3.6,3.0,2.0,1.2
];
const HW_SUM = HOUR_W.reduce((a, b) => a + b, 0);
const DOW_F = [0.42, 1.0, 1.0, 1.0, 1.0, 1.02, 0.58];

// ============ PRNG ============
function mulberry32(a) {
  return function () {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(20261021);
function jitter(v, pct) { return Math.max(1, Math.round(v * (1 + (rand() * 2 - 1) * pct))); }
function pickModel() {
  let r = rand(), s = 0;
  for (const m of MIX) { s += m.w; if (r < s) return m; }
  return MIX[0];
}

// ============ 计划：按天 × 小时桶分配会话，会话块不重叠 ============
// 关键：005 实测相邻单间隔 p50=5.6s / p90=24.6s / 每秒钟数中位 1
// → 真实形态是「单机串行连续调用」，不是多会话并发。
// 所以会话块必须真正连续（轮间隔 4~25s），且会话间不能占满一小时，
// 否则单量根本塞不进去（上一版只能生成 14.7 万 / 目标 58.5 万）。
function buildPlan(total) {
  const days = [];
  for (let t = T0; t <= T1; t += 86400000) {
    const key = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit' })
      .format(new Date(t)).slice(0, 7);
    days.push({ t, key, dow: new Date(t + 8 * 3600000).getUTCDay(), reqs: 0 });
  }
  const byMonth = {};
  for (const d of days) (byMonth[d.key] = byMonth[d.key] || []).push(d);
  for (const [m, ds] of Object.entries(byMonth)) {
    const wsum = ds.reduce((a, d) => a + DOW_F[d.dow], 0);
    const monthTotal = total * (MONTH_W[m] || 0);
    for (const d of ds) d.reqs = Math.round(monthTotal * DOW_F[d.dow] / wsum);
  }

  // 每天：把 reqs 按小时权重分到 24 个桶；桶内用「会话块连续 + 会话间填充」的策略塞满
  const sessions = [];
  for (const d of days) {
    if (!d.reqs) continue;
    for (let h = 0; h < 24; h++) {
      const quota = Math.round(d.reqs * HOUR_W[h] / HW_SUM);
      if (quota <= 0) continue;
      const hStart = d.t + h * 3600000;
      const hEnd = Math.min(hStart + 3600000, T1);
      const span = hEnd - hStart;
      if (span <= 60000) continue;

      // ---- 先切会话块：3~15 轮，尽量贴近真实分布 ----
      const blocks = [];
      let left = quota;
      while (left > 0) {
        const n = Math.max(1, Math.min(left, 3 + Math.floor(rand() * 13)));
        blocks.push(n);
        left -= n;
      }

      // ---- 每个会话块的「轮内间隔」（连续对话，4~25s）----
      const blockGaps = blocks.map(n => {
        const g = [0];
        for (let k = 1; k < n; k++) g.push(Math.round(3500 + rand() * 21500));
        return g;
      });
      const blockDur = blockGaps.map(g => g.reduce((a, b) => a + b, 0));
      const busyTotal = blockDur.reduce((a, b) => a + b, 0);

      // ---- 会话间空闲：用小时剩余时间均摊 ----
      // 若忙时已超过窗口 → 压缩轮内间隔（保底 2s），保证全部塞进本小时
      let scaleGap = 1;
      const idleBudget = Math.max(0, span * 0.92 - busyTotal);
      if (busyTotal > span * 0.92) scaleGap = (span * 0.92) / busyTotal;
      const k = blocks.length;
      const idlePer = k > 1 ? idleBudget / (k - 1) : 0;

      let cursor = hStart + (k > 1 ? Math.floor(rand() * Math.min(idlePer * 1.5, 60000)) : Math.floor(rand() * 60000));
      for (let bi = 0; bi < k; bi++) {
        const n = blocks[bi];
        const g = blockGaps[bi].map(x => Math.round(x * scaleGap));
        sessions.push({ start: cursor, n, m: pickModel(), gaps: g, day: d });
        cursor += g.reduce((a, b) => a + b, 0);
        if (bi < k - 1) {
          // 会话间间隔：均摊 + 强抖动（对数正态感），但不超过下一个会话可用余量
          const jit = idlePer * (0.25 + rand() * 1.5);
          cursor += Math.min(Math.round(jit), Math.max(1000, Math.round(idlePer * 2.2)));
        }
      }
    }
  }
  sessions.sort((a, b) => a.start - b.start);
  return sessions;
}

// ============ 生成单条 ============
function genReq(sess, turn) {
  const m = sess.m;
  // 输入：首轮 base，后续温和累积
  const base = sess.baseIn;
  let pin = turn === 0 ? base : Math.round(base + turn * jitter(m.ctx, 0.3));
  pin = Math.max(80, Math.min(pin, 200000));

  // 缓存：首轮低命中，后续高命中
  let hitRate;
  if (turn === 0) hitRate = Math.max(0, m.h0 + (rand() * 2 - 1) * 0.04);
  else hitRate = Math.max(0, Math.min(0.90, m.hN + (rand() * 2 - 1) * 0.08));
  let pc = Math.round(pin * hitRate);
  pc = Math.max(0, Math.min(pc, pin));

  const pout = Math.max(8, jitter(m.out, 0.70));
  const tot = pin + pout;
  const ut = Math.max(0.6, +(1.0 + pout / 60 + rand() * 3.0).toFixed(2));

  const quota = billing.computeQuota(m.model, pin, pout, pc, new Date(sess.tsFor[turn]));
  return { pin, pout, pc, tot, ut, quota, model: m.model, ch: m.ch };
}

// ============ 主流程 ============
function main() {
  const db = new DatabaseSync(path.join(API, 'api.db'));
  db.exec('PRAGMA journal_mode=WAL');
  db.exec('PRAGMA busy_timeout=20000');

  const target = db.prepare('SELECT id,username,created_at,quota,inviter_id FROM users WHERE id=?').get(UID);
  if (!target) { console.error(`❌ 用户 ${UID} 不存在`); process.exit(1); }
  if (target.username !== USERNAME) { console.error(`❌ ${UID} 是 ${target.username}`); process.exit(1); }

  // ---------- RESET ----------
  if (RESET) {
    const n = db.prepare('SELECT COUNT(*) c FROM logs WHERE source=?').get(SRC).c;
    if (!n) { console.log('无本方案数据'); process.exit(0); }
    console.log(`将删除 ${n} 行 (source=${SRC}) 并回滚…`);
    db.exec('BEGIN IMMEDIATE');
    try {
      const spent = db.prepare("SELECT COALESCE(SUM(quota),0) q FROM logs WHERE source=? AND log_type='consume' AND username NOT LIKE 'agent-reward%' AND quota>0").get(SRC).q;
      const cnt = db.prepare("SELECT COUNT(*) c FROM logs WHERE source=? AND log_type='consume' AND username NOT LIKE 'agent-reward%'").get(SRC).c;
      const rwSum = db.prepare("SELECT COALESCE(SUM(-quota),0) q FROM logs WHERE source=? AND username LIKE 'agent-reward%'").get(SRC).q;
      db.prepare('DELETE FROM logs WHERE source=?').run(SRC);
      db.prepare('DELETE FROM wallet_ledger WHERE request_id LIKE ?').run('sim006:%');
      db.prepare('UPDATE users SET quota=quota+?, used_quota=MAX(0,used_quota-?), request_count=MAX(0,request_count-?) WHERE id=?')
        .run(spent, spent, cnt, UID);
      // 回滚返佣
      for (const u of db.prepare('SELECT id FROM users WHERE id IN (5,7,1)').all()) {
        db.prepare('UPDATE users SET invite_reward=MAX(0,invite_reward-?), reward_l1=MAX(0,reward_l1-?), reward_l2=MAX(0,reward_l2-?), reward_l3=MAX(0,reward_l3-?), quota=quota-? WHERE id=?')
          .run(0, 0, 0, 0, Math.round(rwSum / 3), u.id);
      }
      db.prepare('UPDATE users SET created_at=? WHERE id=?').run(target.created_at, UID);
      db.prepare('DELETE FROM settings WHERE key=?').run(MARK);
      db.exec('COMMIT');
      console.log(`✅ 已回滚 ${n} 行`);
    } catch (e) { db.exec('ROLLBACK'); console.error('❌', e.message); }
    process.exit(0);
  }

  const done = db.prepare('SELECT value FROM settings WHERE key=?').get(MARK);
  if (APPLY && done) { console.error(`❌ 已执行过 (${MARK}=${done.value})，重跑先 --reset`); process.exit(1); }

  // ---------- 生成计划 ----------
  console.log(`生成计划 (${SCALES[SCALE].label} ${TOTAL_REQ.toLocaleString()} 单)…`);
  const t0 = Date.now();
  const sessions = buildPlan(TOTAL_REQ);
  const planReqs = sessions.reduce((a, s) => a + s.n, 0);
  console.log(`  会话 ${sessions.length.toLocaleString()} 块 / ${planReqs.toLocaleString()} 单 / 生成 ${Date.now() - t0}ms`);

  // 展开成请求（会话内按 gaps 递增）
  const reqs = [];
  for (const s of sessions) {
    s.baseIn = jitter(s.m.in, 0.40);
    s.tsFor = [];
    let ts = s.start;
    for (let k = 0; k < s.n; k++) {
      ts += s.gaps[k];
      s.tsFor.push(ts);
      reqs.push({ ts, sess: s, turn: k });
    }
  }
  reqs.sort((a, b) => a.ts - b.ts);
  if (reqs.length > TOTAL_REQ) reqs.length = TOTAL_REQ;

  // ---------- 生成记录 ----------
  const gen = reqs.map(r => genReq(r.sess, r.turn));

  let sumQ = 0, tIn = 0, tOut = 0, tCache = 0;
  const byModel = {};
  for (let i = 0; i < reqs.length; i++) {
    const g = gen[i];
    sumQ += g.quota; tIn += g.pin; tOut += g.pout; tCache += g.pc;
    const k = g.model;
    byModel[k] = byModel[k] || { n: 0, q: 0, tin: 0, tout: 0, tc: 0 };
    byModel[k].n++; byModel[k].q += g.quota; byModel[k].tin += g.pin; byModel[k].tout += g.pout; byModel[k].tc += g.pc;
  }
  const usd = q => q / QPS;

  console.log('\n=== 模型分布 ===');
  console.log('模型                  单量     占比   $/单     消费($)');
  for (const m of MIX) {
    const b = byModel[m.model] || { n: 0, q: 0 };
    console.log(`${m.model.padEnd(21)} ${String(b.n).padStart(7)} ${(b.n/reqs.length*100).toFixed(1).padStart(5)}%  ${(usd(b.q)/Math.max(1,b.n)).toFixed(5)} ${usd(b.q).toFixed(0).padStart(9)}`);
  }
  console.log(`${'合计'.padEnd(21)} ${String(reqs.length).padStart(7)} 100.0%  ${(usd(sumQ)/reqs.length).toFixed(5)} ${usd(sumQ).toFixed(0).padStart(9)}`);

  console.log('\n=== 月度分布 ===');
  const byMonth = {};
  for (let i = 0; i < reqs.length; i++) {
    const mk = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit' }).format(new Date(reqs[i].ts)).slice(0, 7);
    byMonth[mk] = byMonth[mk] || { n: 0, q: 0 };
    byMonth[mk].n++; byMonth[mk].q += gen[i].quota;
  }
  for (const k of Object.keys(byMonth).sort()) {
    console.log(`${k}  ${String(byMonth[k].n).padStart(7)} 单  $${usd(byMonth[k].q).toFixed(0).padStart(7)}`);
  }

  console.log('\n=== token / 缓存 ===');
  console.log(`输入 ${(tIn/1e9).toFixed(2)}B  缓存读 ${(tCache/1e9).toFixed(2)}B (${(tCache/tIn*100).toFixed(0)}%)  未命中 ${((tIn-tCache)/1e9).toFixed(2)}B`);
  console.log(`输出 ${(tOut/1e9).toFixed(2)}B   合计 ${((tIn+tOut)/1e9).toFixed(2)}B`);
  console.log('\n=== 金额 ===');
  console.log(`累计消费 $${usd(sumQ).toFixed(2)}  期初 $${TOPUP_USD}  期末 $${(TOPUP_USD - usd(sumQ)).toFixed(2)}`);
  console.log(`返佣 L1 $${(usd(sumQ)*0.15).toFixed(0)} / L2 $${(usd(sumQ)*0.05).toFixed(0)} / L3 $${(usd(sumQ)*0.02).toFixed(0)}`);

  // 会话连续性抽样
  console.log('\n=== 抽样：一个完整会话（展示上下文累积与缓存命中）===');
  const pick = sessions[Math.floor(sessions.length * 0.6)];
  for (let k = 0; k < pick.n; k++) {
    const idx = reqs.findIndex(r => r.sess === pick && r.turn === k);
    if (idx < 0) continue;
    const g = gen[idx], d = new Date(reqs[idx].ts);
    const lt = `${d.getMonth()+1}-${String(d.getDate()).padStart(2,'0')} ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}:${String(d.getSeconds()).padStart(2,'0')}`;
    console.log(`  第${k+1}轮 ${lt} ${g.model.padEnd(20)} in=${String(g.pin).padStart(6)} cache=${String(g.pc).padStart(6)}(${(g.pc/g.pin*100).toFixed(0)}%) out=${String(g.pout).padStart(4)} ${g.ut.toFixed(1)}s $${usd(g.quota).toFixed(5)}`);
  }

  console.log('\n=== 抽样：跨会话间隔（同一天 20 条）===');
  const dayPick = reqs.filter(r => new Date(r.ts).toISOString().slice(0,10) === new Date(reqs[Math.floor(reqs.length/2)].ts).toISOString().slice(0,10)).slice(20, 40);
  let prev = null;
  for (const r of dayPick) {
    const i = reqs.indexOf(r), g = gen[i], d = new Date(r.ts);
    const gap = prev ? ((r.ts - prev) / 1000).toFixed(0) + 's' : '-';
    const lt = `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}:${String(d.getSeconds()).padStart(2,'0')}`;
    console.log(`  ${lt} +${gap.padStart(6)} ${g.model.slice(0,16).padEnd(16)} in=${String(g.pin).padStart(6)} $${usd(g.quota).toFixed(5)}`);
    prev = r.ts;
  }

  if (!APPLY) {
    console.log('\n(dry-run，未写库。加 --apply 执行)');
    db.close();
    return;
  }

  // ---------- 写库 ----------
  const insLog = db.prepare(`INSERT INTO logs (user_id,username,token_id,token_name,model_name,channel_id,channel_name,
    prompt_tokens,completion_tokens,cached_tokens,total_tokens,quota,use_time,is_stream,ip,request_id,status,error,created_at,log_type,source)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const insLedger = db.prepare(`INSERT INTO wallet_ledger (user_id,username,delta,balance_after,kind,detail,op_user_id,op_username,op_role,request_id,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`);

  const upline = [];
  let cur = target;
  while (cur && cur.inviter_id) {
    const p = db.prepare('SELECT id,username,inviter_id FROM users WHERE id=?').get(cur.inviter_id);
    if (!p) break;
    upline.push(p); cur = p;
  }
  const RATES = [0.15, 0.05, 0.02];

  const tStart = Date.now();

  // 1) 充值 + 注册时间
  db.exec('BEGIN IMMEDIATE');
  try {
    insLog.run(UID, USERNAME, 0, '', '', 0, '', 0, 0, 0, 0, TOPUP_USD * QPS, 0, 0, '', RID_PREFIX + 'topup', 'success', '', NEW_CREATED_AT + 60000, 'recharge', SRC);
    insLedger.run(UID, USERNAME, TOPUP_USD * QPS, target.quota + TOPUP_USD * QPS, 'recharge', `历史期初充值 $${TOPUP_USD}`, 0, 'system', '系统', RID_PREFIX + 'topup', NEW_CREATED_AT + 60000);
    db.prepare('UPDATE users SET quota=quota+?, created_at=? WHERE id=?').run(TOPUP_USD * QPS, NEW_CREATED_AT, UID);
    db.exec('COMMIT');
    console.log(`\n✅ 充值 $${TOPUP_USD}，注册时间 → ${new Date(NEW_CREATED_AT).toISOString().slice(0,10)}`);
  } catch (e) { db.exec('ROLLBACK'); console.error('❌ 充值失败:', e.message); process.exit(1); }

  // 2) 分批消费行
  const BATCH = 5000;
  let written = 0, rewardRows = 0;
  const rewardSum = [0, 0, 0];

  for (let off = 0; off < reqs.length; off += BATCH) {
    const end = Math.min(off + BATCH, reqs.length);
    db.exec('BEGIN IMMEDIATE');
    try {
      for (let i = off; i < end; i++) {
        const r = reqs[i], g = gen[i];
        const rid = RID_PREFIX + crypto.randomBytes(6).toString('hex');
        const ip = '192.168.2.' + (20 + Math.floor(rand() * 180));
        insLog.run(UID, USERNAME, 0, '', g.model, 0, g.ch,
          g.pin, g.pout, g.pc, g.tot, g.quota, g.ut, 0, ip, rid, 'success', '', r.ts, 'consume', SRC);
        written++;
        if (WRITE_REWARD) {
          for (let li = 0; li < upline.length && li < 3; li++) {
            const rw = Math.floor(g.quota * RATES[li]);
            if (rw <= 0) continue;
            insLog.run(upline[li].id, 'agent-reward-L' + (li + 1), 0, '返佣L' + (li + 1), g.model, 0, '',
              g.pin, g.pout, g.pc, g.tot, -rw, g.ut, 0, ip, 'invite:' + rid, 'success', '', r.ts, 'consume', SRC);
            rewardRows++;
            rewardSum[li] += rw;
          }
        }
      }
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      console.error(`\n❌ 批次 ${off} 失败:`, e.message);
      process.exit(1);
    }
    process.stdout.write(`\r  写库 ${end.toLocaleString()}/${reqs.length.toLocaleString()} (${(end/reqs.length*100).toFixed(0)}%) ${((Date.now()-tStart)/1000).toFixed(0)}s`);
  }
  console.log('');

  // 3) 结算
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare('UPDATE users SET quota=quota-?, used_quota=used_quota+?, request_count=request_count+? WHERE id=?')
      .run(sumQ, sumQ, written, UID);
    for (let li = 0; li < upline.length && li < 3; li++) {
      if (!rewardSum[li]) continue;
      const u = upline[li];
      db.prepare('UPDATE users SET invite_reward=invite_reward+?, reward_l1=reward_l1+?, reward_l2=reward_l2+?, reward_l3=reward_l3+?, quota=quota+? WHERE id=?')
        .run(rewardSum[li], li === 0 ? rewardSum[li] : 0, li === 1 ? rewardSum[li] : 0, li === 2 ? rewardSum[li] : 0, rewardSum[li], u.id);
    }
    const bal = db.prepare('SELECT quota FROM users WHERE id=?').get(UID).quota;
    insLedger.run(UID, USERNAME, -sumQ, bal, 'consume', `历史回填 ${written} 单 $${usd(sumQ).toFixed(2)} [${SCALE}]`, 0, 'system', '系统', RID_PREFIX + 'settle', Date.now());
    db.prepare('INSERT OR REPLACE INTO settings (key,value) VALUES (?,?)').run(MARK, String(written));
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); console.error('❌ 结算失败:', e.message); process.exit(1); }

  console.log(`\n✅ 完成 ${((Date.now()-tStart)/1000).toFixed(0)}s`);
  console.log(`   主记录 ${written.toLocaleString()} + 返佣 ${rewardRows.toLocaleString()} 行`);
  console.log(`   累计消费 $${usd(sumQ).toFixed(2)} / 期末余额 $${(TOPUP_USD - usd(sumQ)).toFixed(2)}`);
  for (let li = 0; li < upline.length && li < 3; li++) {
    if (rewardSum[li]) console.log(`   L${li+1} ${upline[li].username} +$${usd(rewardSum[li]).toFixed(2)}`);
  }
  db.close();
}

main();
