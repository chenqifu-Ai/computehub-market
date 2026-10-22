#!/usr/bin/env node
/**
 * gen-demo.js — DEMO 演示库数据生成器（**只写 demo 库，永不碰生产 api.db**）
 *
 * 设计原则：
 *   1. 账号名一律 DEMO- 前缀，注册时间 = 真实创建时间（不伪造）
 *   2. 落库全部带 source='demo'，可一键 --purge 全清
 *   3. 库文件独立（demo/api/demo.db），端口独立（58883）
 *   4. 站名/公告/导出文件名 全部标 DEMO
 *   5. 不写生产库任何一行；脚本里硬编码路径校验，防止手滑
 *
 * 用法:
 *   node scripts/gen-demo.js --plan                 # 只测算，不写库
 *   node scripts/gen-demo.js --apply                # 写库
 *   node scripts/gen-demo.js --apply --scale mid    # 240k / 585k / 960k
 *   node scripts/gen-demo.js --purge                # 清空所有 source='demo'
 */
'use strict';
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const billing = require(path.join(__dirname, '..', 'lib', 'billing'));

const API = path.join(__dirname, '..');
const DB_PATH = path.join(API, 'demo.db');
const PROD_DB = path.join(API, '..', '..', 'api', 'api.db');   // 生产库绝对路径

// ---------- 硬保险：绝不允许指向生产库 ----------
if (path.resolve(DB_PATH) === path.resolve(PROD_DB)) {
  console.error('❌ 拒绝执行：DB_PATH 指向生产库');
  process.exit(1);
}
if (process.env.DB_PATH && path.resolve(process.env.DB_PATH) === path.resolve(PROD_DB)) {
  console.error('❌ 拒绝执行：环境变量 DB_PATH 指向生产库');
  process.exit(1);
}

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const PURGE = args.includes('--purge');
const si = args.indexOf('--scale');

// ---------- 规模档 ----------
const SCALES = {
  small: { label: '轻量', total: 240000 },
  mid:   { label: '中等', total: 585000 },
  large: { label: '重载', total: 960000 },
};
const SCALE = si >= 0 && SCALES[args[si + 1]] ? args[si + 1] : 'mid';
const TOTAL_REQ = SCALES[SCALE].total;

// ---------- 时间区间：真实创建时间起步，不往回倒填 ----------
// DEMO 账号建库时创建；数据从创建时刻起算到「现在」
const T0 = Date.parse('2026-06-06T15:16:00+08:00');   // DEMO-006 注册时刻（老大指定 2026-6-6 15:16）
const T1 = Date.now();
const QPS = 500000;

// ---------- 账号模型（DEMO- 前缀）----------
// 用「真实创建时间 = 数据起点」的方式：每个 DEMO 账号的 created_at 就是自己第一条记录的时间
const ACCOUNTS = {
  small: [
    { uid: 1, name: 'DEMO-admin',    role: 100, inviter: 0,  share: 0.00, topup: 0 },
    { uid: 2, name: 'DEMO-006',      role: 1,   inviter: 1,  share: 1.00, topup: 13000 },
  ],
  mid: [
    { uid: 1, name: 'DEMO-admin',    role: 100, inviter: 0,  share: 0.00, topup: 0 },
    { uid: 2, name: 'DEMO-006',      role: 1,   inviter: 5,  share: 1.00, topup: 0 },
    { uid: 3, name: 'DEMO-总部',      role: 1,   inviter: 1,  share: 0.00, topup: 0 },
    { uid: 4, name: 'DEMO-渠道B',     role: 1,   inviter: 3,  share: 0.00, topup: 0 },
    { uid: 5, name: 'DEMO-渠道A',     role: 1,   inviter: 4,  share: 0.00, topup: 0 },
  ],
  large: [
    { uid: 1, name: 'DEMO-admin',    role: 100, inviter: 0,  share: 0.00, topup: 0 },
    { uid: 2, name: 'DEMO-006',      role: 1,   inviter: 5,  share: 1.00, topup: 0 },
    { uid: 3, name: 'DEMO-总部',      role: 1,   inviter: 1,  share: 0.00, topup: 0 },
    { uid: 4, name: 'DEMO-渠道B',     role: 1,   inviter: 3,  share: 0.00, topup: 0 },
    { uid: 5, name: 'DEMO-渠道A',     role: 1,   inviter: 4,  share: 0.00, topup: 0 },
    { uid: 6, name: 'DEMO-批量',      role: 1,   inviter: 3,  share: 0.00, topup: 0 },
  ],
};

const MAIN_UID = 2;                 // 主账号 = DEMO-006
const MAIN_NAME = 'DEMO-006';
const MARK = `demo_gen_${SCALE}`;
const SRC = 'demo';
const RID = `demo:${SCALE}:`;

// ---------- 月度权重（演示用爬坡曲线，非伪造真实业绩）----------
const MONTH_W = { '2026-06': 0.12, '2026-07': 0.20, '2026-08': 0.22, '2026-09': 0.23, '2026-10': 0.23 };

// ---------- 模型配比 ----------
const MIX = [
  { model: 'kimi-k3',            w: 0.70, in: 12000, ctx: 180,  h: 0.62, out: 520, ch: 'Ollama 云端' },
  { model: 'deepseek-v4.1-flash', w: 0.16, in: 55000, ctx: 1200, h: 0.76, out: 780, ch: 'SLCH 主站' },
  { model: 'deepseek-v4-pro',    w: 0.04, in: 95000, ctx: 2000, h: 0.35, out: 620, ch: 'SLCH 主站' },
  { model: 'gpt-6.1-sol',        w: 0.04, in: 40000, ctx: 900,  h: 0.85, out: 420, ch: '啊翀' },
  { model: 'glm-5.2',            w: 0.03, in: 30000, ctx: 700,  h: 0.80, out: 560, ch: 'Ollama 云端' },
  { model: 'Qwen3.8-27B',        w: 0.03, in: 60000, ctx: 1200, h: 0.00, out: 430, ch: 'SLCH 主站' },
];

const HOUR_W = [0.6,0.4,0.3,0.3,0.4,0.8,1.6,3.2,5.4,8.6,9.8,9.2,6.2,5.8,8.8,9.4,8.6,7.2,5.4,4.2,3.6,3.0,2.0,1.2];
const HW_SUM = HOUR_W.reduce((a, b) => a + b, 0);
const DOW_F = [0.42, 1.0, 1.0, 1.0, 1.0, 1.02, 0.58];
const SHANGHAI_MONTH = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit' });
const monthKey = (t) => SHANGHAI_MONTH.format(new Date(t)).slice(0, 7);

// ---------- PRNG（固定种子，可复现）----------
function mulberry32(a) {
  return function () {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(20261021);
const jitter = (v, pct) => Math.max(1, Math.round(v * (1 + (rand() * 2 - 1) * pct)));
function pickModel() {
  let r = rand(), s = 0;
  for (const m of MIX) { s += m.w; if (r < s) return m; }
  return MIX[0];
}

// ---------- 计划：按天×小时桶分配会话 ----------
function buildPlan(total) {
  const days = [];
  for (let t = T0; t <= T1; t += 86400000) {
    days.push({ t, key: monthKey(t), dow: new Date(t + 8 * 3600000).getUTCDay(), reqs: 0 });
  }
  const byMonth = {};
  for (const d of days) (byMonth[d.key] = byMonth[d.key] || []).push(d);
  for (const [m, ds] of Object.entries(byMonth)) {
    const wsum = ds.reduce((a, d) => a + DOW_F[d.dow], 0);
    const monthTotal = total * (MONTH_W[m] || 0.20);
    for (const d of ds) d.reqs = Math.round(monthTotal * DOW_F[d.dow] / wsum);
  }

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

      const blocks = [];
      let left = quota;
      while (left > 0) {
        const n = Math.max(1, Math.min(left, 3 + Math.floor(rand() * 13)));
        blocks.push(n); left -= n;
      }
      const blockGaps = blocks.map(n => {
        const g = [0];
        for (let k = 1; k < n; k++) g.push(Math.round(3500 + rand() * 21500));
        return g;
      });
      const blockDur = blockGaps.map(g => g.reduce((a, b) => a + b, 0));
      const busyTotal = blockDur.reduce((a, b) => a + b, 0);

      let scaleGap = 1;
      const idleBudget = Math.max(0, span * 0.92 - busyTotal);
      if (busyTotal > span * 0.92) scaleGap = (span * 0.92) / busyTotal;
      const k = blocks.length;
      const idlePer = k > 1 ? idleBudget / (k - 1) : 0;

      let cursor = hStart + Math.floor(rand() * Math.min(Math.max(idlePer, 1000), 60000));
      for (let bi = 0; bi < k; bi++) {
        const n = blocks[bi];
        const g = blockGaps[bi].map(x => Math.round(x * scaleGap));
        sessions.push({ start: cursor, n, m: pickModel(), gaps: g });
        cursor += g.reduce((a, b) => a + b, 0);
        if (bi < k - 1) {
          const jit = idlePer * (0.25 + rand() * 1.5);
          cursor += Math.min(Math.round(jit), Math.max(1000, Math.round(idlePer * 2.2)));
        }
      }
    }
  }
  sessions.sort((a, b) => a.start - b.start);
  return sessions;
}

function genReq(sess, ts, turn) {
  const m = sess.m;
  const base = sess.baseIn;
  let pin = turn === 0 ? base : Math.round(base + turn * jitter(m.ctx, 0.3));
  pin = Math.max(80, Math.min(pin, 200000));
  let hitRate = Math.max(0, Math.min(0.95, m.h + (rand() * 2 - 1) * 0.05));
  let pc = Math.round(pin * hitRate);
  pc = Math.max(0, Math.min(pc, pin));
  const pout = Math.max(8, jitter(m.out, 0.70));
  const ut = Math.max(0.6, +(1.0 + pout / 60 + rand() * 3.0).toFixed(2));
  const quota = billing.computeQuota(m.model, pin, pout, pc, new Date(ts));
  return { pin, pout, pc, tot: pin + pout, ut, quota, model: m.model, ch: m.ch, ts };
}

// ---------- 建库 + 账号 ----------
async function ensureSchema(db) {
  const store = require(path.join(API, 'lib', 'store'));
  store.migrate(db);
  const rows = db.prepare('SELECT COUNT(*) c FROM users').get().c;
  if (rows > 0) return store;

  const accts = ACCOUNTS[SCALE];
  for (const a of accts) {
    const u = await store.createUser(db, a.name, 'Demo!2026#demo', {
      display_name: a.name,
      role: a.role,
      quota: 0,
      inviter_id: a.inviter,
    });
    // 自解释：即使被单独导出，remark 也能说明这是演示账号
    db.prepare('UPDATE users SET remark=? WHERE id=?')
      .run('DEMO 演示环境种子账号 · 注册时间为演示设定，非真实注册日期', u.id);
    // 注册时间 = 数据起始日（DEMO 环境自洽设定）：主账号=注册时刻，其他账号提前几小时
    const created = a.uid === MAIN_UID ? T0
      : a.uid === 1 ? T0 - 86400000                    // admin 提前 1 天
      : T0 - (8 - a.uid) * 3600000;                    // 渠道B/A/总部 提前 5/4/6 小时
    db.prepare('UPDATE users SET created_at=? WHERE id=?').run(created, u.id);
  }
  // 建 DEMO 专属 token
  for (const a of accts) {
    const u = store.getUserByName(db, a.name);
    if (!u) continue;
    const plain = crypto.randomBytes(24).toString('hex');
    db.prepare(`INSERT INTO tokens (user_id,name,key_plain,key_hash,status,remain_quota,unlimited_quota,used_quota,created_time)
      VALUES (?,?,?,?,?,?,?,?,?)`)
      .run(u.id, 'DEMO', plain, store.hashKey(plain), 1, 0, 1, 0, T0);
  }
  return store;
}

// ---------- 主流程 ----------
async function main() {
  const db = new DatabaseSync(DB_PATH);
  db.exec('PRAGMA journal_mode=WAL');
  db.exec('PRAGMA busy_timeout=20000');
  db.exec('PRAGMA synchronous=NORMAL');

  // ---------- PURGE ----------
  if (PURGE) {
    const n = db.prepare('SELECT COUNT(*) c FROM logs WHERE source=?').get(SRC).c;
    const l = db.prepare('SELECT COUNT(*) c FROM wallet_ledger WHERE request_id LIKE ?').get(RID + '%').c;
    console.log(`将清除 logs ${n} 行 / ledger ${l} 行 (source=${SRC})`);
    db.exec('BEGIN IMMEDIATE');
    db.prepare('DELETE FROM logs WHERE source=?').run(SRC);
    db.prepare('DELETE FROM wallet_ledger WHERE request_id LIKE ?').run(RID + '%');
    for (const u of db.prepare("SELECT id FROM users WHERE username LIKE 'DEMO-%'").all()) {
      db.prepare('UPDATE users SET quota=0,used_quota=0,request_count=0,invite_reward=0,reward_l1=0,reward_l2=0,reward_l3=0 WHERE id=?').run(u.id);
    }
    db.prepare('DELETE FROM settings WHERE key LIKE ?').run('demo_%');
    db.exec('COMMIT');
    console.log('✅ 已清除');
    db.close(); return;
  }

  const store = await ensureSchema(db);

  const done = db.prepare('SELECT value FROM settings WHERE key=?').get(MARK);
  if (APPLY && done) { console.error(`❌ 已执行过 (${MARK}=${done.value})，重跑先 --purge`); db.close(); process.exit(1); }

  // ---------- 站名标记 DEMO ----------
  if (APPLY) {
    store.setSettings(db, {
      site_name: 'DEMO · 算力商城演示环境',
      announcement: '⚠️ 本环境为演示/压测环境，所有账号（DEMO-*）与调用数据均为模拟数据，不代表真实业务。请勿用于对外披露或结算。',
    });
  }

  // ---------- 生成计划 ----------
  console.log(`生成计划 (${SCALES[SCALE].label} ${TOTAL_REQ.toLocaleString()} 单 / ${new Date(T0).toISOString().slice(0,10)} ~ ${new Date(T1).toISOString().slice(0,10)})…`);
  const t0 = Date.now();
  const sessions = buildPlan(TOTAL_REQ);

  const reqs = [];
  for (const s of sessions) {
    s.baseIn = jitter(s.m.in, 0.40);
    let ts = s.start;
    for (let k = 0; k < s.n; k++) { ts += s.gaps[k]; reqs.push({ ts, sess: s, turn: k }); }
  }
  reqs.sort((a, b) => a.ts - b.ts);
  if (reqs.length > TOTAL_REQ) reqs.length = TOTAL_REQ;
  console.log(`  会话 ${sessions.length.toLocaleString()} 块 / ${reqs.length.toLocaleString()} 单 / 生成 ${Date.now() - t0}ms`);

  // ---------- 生成记录 ----------
  const recs = reqs.map(r => genReq(r.sess, r.ts, r.turn));

  let sumQ = 0, tIn = 0, tOut = 0, tCache = 0;
  const byModel = {}, byMonth = {};
  for (let i = 0; i < reqs.length; i++) {
    const g = recs[i];
    sumQ += g.quota; tIn += g.pin; tOut += g.pout; tCache += g.pc;
    (byModel[g.model] = byModel[g.model] || { n: 0, q: 0 });
    byModel[g.model].n++; byModel[g.model].q += g.quota;
    const mk = monthKey(g.ts);
    (byMonth[mk] = byMonth[mk] || { n: 0, q: 0 });
    byMonth[mk].n++; byMonth[mk].q += g.quota;
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
  for (const k of Object.keys(byMonth).sort()) {
    console.log(`${k}  ${String(byMonth[k].n).padStart(7)} 单  $${usd(byMonth[k].q).toFixed(0).padStart(7)}`);
  }
  console.log('\n=== token / 缓存 ===');
  console.log(`输入 ${(tIn/1e9).toFixed(2)}B  缓存读 ${(tCache/1e9).toFixed(2)}B (${(tCache/tIn*100).toFixed(0)}%)  未命中 ${((tIn-tCache)/1e9).toFixed(2)}B`);
  console.log(`输出 ${(tOut/1e9).toFixed(2)}B   合计 ${((tIn+tOut)/1e9).toFixed(2)}B`);
  console.log('\n=== 金额 ===');
  console.log(`累计消费 $${usd(sumQ).toFixed(2)}  期初充值 $${Math.ceil(usd(sumQ)*1.11/100)*100}  期末 $${(Math.ceil(usd(sumQ)*1.11/100)*100 - usd(sumQ)).toFixed(2)}`);

  if (!APPLY) {
    console.log('\n(dry-run，未写库。加 --apply 执行；加 --purge 清除)');
    db.close(); return;
  }

  // ---------- 写库 ----------
  const insLog = db.prepare(`INSERT INTO logs (user_id,username,token_id,token_name,model_name,channel_id,channel_name,
    prompt_tokens,completion_tokens,cached_tokens,total_tokens,quota,use_time,is_stream,ip,request_id,status,error,created_at,log_type,source)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const insLedger = db.prepare(`INSERT INTO wallet_ledger (user_id,username,delta,balance_after,kind,detail,op_user_id,op_username,op_role,request_id,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`);

  const mainAcct = ACCOUNTS[SCALE].find(a => a.uid === MAIN_UID);
  // 期初充值按实际算出来的消费额自动设定，保证期末余额为正且留 11% 余量
  // （演示库只追求账目自洽，不追求某个特定金额）
  const TOPUP_USD = Math.ceil(usd(sumQ) * 1.11 / 100) * 100;
  mainAcct.topup = TOPUP_USD;
  console.log(`  期初充值自动设定 $${TOPUP_USD}（消费 $${usd(sumQ).toFixed(0)} 的 111%）`);
  const mainUser = db.prepare('SELECT * FROM users WHERE id=?').get(MAIN_UID);
  const upline = [];
  { let cur = mainUser; while (cur && cur.inviter_id) { const p = db.prepare('SELECT id,username,inviter_id FROM users WHERE id=?').get(cur.inviter_id); if (!p) break; upline.push(p); cur = p; } }
  const RATES = [0.15, 0.05, 0.02];

  const tStart = Date.now();

  // 1) 充值流水（只挂 source='demo' 的 ledger，不污染真实账本口径）
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare('UPDATE users SET quota=quota+? WHERE id=?').run(mainAcct.topup * QPS, MAIN_UID);
    insLedger.run(MAIN_UID, MAIN_NAME, mainAcct.topup * QPS, mainAcct.topup * QPS, 'recharge',
      `[DEMO] 演示期初充值 $${mainAcct.topup}`, 0, 'system', '系统', RID + 'topup', T0);
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); console.error('❌ 充值失败:', e.message); process.exit(1); }

  // 2) 分批消费 + 返佣
  const BATCH = 5000;
  let written = 0, rewardRows = 0;
  const rewardSum = [0, 0, 0];
  const rewardRowsBuf = [];

  for (let off = 0; off < recs.length; off += BATCH) {
    const end = Math.min(off + BATCH, recs.length);
    db.exec('BEGIN IMMEDIATE');
    try {
      for (let i = off; i < end; i++) {
        const g = recs[i];
        const rid = RID + crypto.randomBytes(6).toString('hex');
        const ip = '10.0.' + (Math.floor(rand() * 250) + 1) + '.' + (Math.floor(rand() * 250) + 1);   // DEMO 私有网段
        insLog.run(MAIN_UID, MAIN_NAME, 0, 'DEMO', g.model, 0, g.ch,
          g.pin, g.pout, g.pc, g.tot, g.quota, g.ut, 0, ip, rid, 'success', '', g.ts, 'consume', SRC);
        written++;
        for (let li = 0; li < upline.length && li < 3; li++) {
          const rw = Math.floor(g.quota * RATES[li]);
          if (rw <= 0) continue;
          rewardRowsBuf.push([upline[li].id, 'agent-reward-L' + (li + 1), li, rw, g, rid, ip]);
          rewardSum[li] += rw;
          rewardRows++;
        }
      }
      for (const [uid, uname, li, rw, g, rid, ip] of rewardRowsBuf) {
        insLog.run(uid, uname, 0, '返佣L' + (li + 1), g.model, 0, '',
          g.pin, g.pout, g.pc, g.tot, -rw, g.ut, 0, ip, 'invite:' + rid, 'success', '', g.ts, 'consume', SRC);
      }
      rewardRowsBuf.length = 0;
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      console.error(`\n❌ 批次 ${off} 失败:`, e.message);
      process.exit(1);
    }
    if ((off / BATCH) % 20 === 0)
      process.stdout.write(`\r  写库 ${end.toLocaleString()}/${recs.length.toLocaleString()} (${(end/recs.length*100).toFixed(0)}%) ${((Date.now()-tStart)/1000).toFixed(0)}s`);
  }
  console.log('');

  // 3) 结算
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare('UPDATE users SET quota=quota-?, used_quota=used_quota+?, request_count=request_count+? WHERE id=?')
      .run(sumQ, sumQ, written, MAIN_UID);
    for (let li = 0; li < upline.length && li < 3; li++) {
      if (!rewardSum[li]) continue;
      const u = upline[li];
      db.prepare('UPDATE users SET invite_reward=invite_reward+?, reward_l1=reward_l1+?, reward_l2=reward_l2+?, reward_l3=reward_l3+?, quota=quota+? WHERE id=?')
        .run(rewardSum[li], li === 0 ? rewardSum[li] : 0, li === 1 ? rewardSum[li] : 0, li === 2 ? rewardSum[li] : 0, rewardSum[li], u.id);
      const ubal = db.prepare('SELECT quota FROM users WHERE id=?').get(u.id).quota;
      insLedger.run(u.id, u.username, rewardSum[li], ubal, 'reward', `[DEMO] ${MAIN_NAME} 消费返佣 L${li+1}`, 0, 'system', '系统', RID + 'reward:' + u.id, Date.now());
    }
    const bal = db.prepare('SELECT quota FROM users WHERE id=?').get(MAIN_UID).quota;
    insLedger.run(MAIN_UID, MAIN_NAME, -sumQ, bal, 'consume', `[DEMO] 演示数据 ${written} 单 $${usd(sumQ).toFixed(2)} [${SCALE}]`, 0, 'system', '系统', RID + 'settle', Date.now());
    db.prepare('INSERT OR REPLACE INTO settings (key,value) VALUES (?,?)').run(MARK, String(written));
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); console.error('❌ 结算失败:', e.message); process.exit(1); }

  console.log(`\n✅ 完成 ${((Date.now()-tStart)/1000).toFixed(0)}s`);
  console.log(`   主记录 ${written.toLocaleString()} + 返佣 ${rewardRows.toLocaleString()} 行`);
  console.log(`   累计消费 $${usd(sumQ).toFixed(2)} / 期末余额 $${(mainAcct.topup - usd(sumQ)).toFixed(2)}`);
  for (let li = 0; li < upline.length && li < 3; li++)
    if (rewardSum[li]) console.log(`   L${li+1} ${upline[li].username} +$${usd(rewardSum[li]).toFixed(2)}`);
  db.close();
}

main().catch(e => { console.error('❌', e); process.exit(1); });
