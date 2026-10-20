'use strict';
/**
 * 导出 worker（子进程）：整条导出链路都在这里跑
 *   - 打开只读 DB 连接，按 id 游标分页流式读（不跨 await 持锁）
 *   - 汇总 SQL（按模型/渠道/返佣/用户）
 *   - xlsx 分片拼装 + 落盘
 * 主进程只负责鉴权、登记任务、把进度透传出去 → 事件循环零阻塞。
 *
 * 用法: node export-worker.js <outFile> <mode>
 *   stdin: 单行 JSON 配置
 *   stdout: {"t":"progress",...} / {"t":"done",bytes} / {"t":"error",message}
 *
 * 模式:
 *   settle-single  { dbPath, userId, since, until, limit, quotaPerUsd }
 *   settle-all     { dbPath, since, until, perUserLimit, quotaPerUsd }
 *   usage          { dbPath, userId|null, since, until, limit, admin, all, quotaPerUsd }
 */
const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');
const xlsx = require('./xlsx');

const outFile = process.argv[2];
const mode = process.argv[3];

function pad2(n) { return String(n).padStart(2, '0'); }
function fmtTs(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} `
    + `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}
function send(o) { process.stdout.write(JSON.stringify(o) + '\n'); }

const TYPE_LABEL = { consume: '消费', recharge: '充值', reward: '返利', system: '系统', admin: '管理' };
function typeLabel(l) {
  if (l.log_type && TYPE_LABEL[l.log_type]) return TYPE_LABEL[l.log_type];
  return l.quota < 0 ? '返利' : '消费';
}

function openDb(p) {
  const db = new DatabaseSync(p, { readOnly: true });
  db.exec('PRAGMA busy_timeout = 15000;');
  return db;
}

/** 按 id 游标分页，语句永不跨 await 存活；每页取完即释放 */
function* pageRows(db, { where, params, cols, cap, pageSize = 50000 }) {
  const LIM = parseInt(cap, 10) || 0;
  let lastId = db.prepare('SELECT MAX(id) m FROM logs').get().m;
  if (lastId == null) return;
  let left = LIM || Infinity;
  const stmt = db.prepare(`SELECT ${cols} FROM logs WHERE ${where} AND id < ? ORDER BY id DESC LIMIT ?`);
  while (left > 0) {
    const lim = Math.min(pageSize, left === Infinity ? pageSize : left);
    const page = stmt.all(...params, lastId, lim);
    if (!page.length) break;
    for (const r of page) yield r;
    lastId = page[page.length - 1].id;
    left -= page.length;
    if (page.length < lim) break;
  }
}

function countRows(db, where, params) {
  return db.prepare(`SELECT COUNT(*) c FROM logs WHERE ${where}`).get(...params).c;
}

function writeXlsx(gen, out) {
  const fd = fs.openSync(out, 'w');
  try {
    for (const c of gen) {
      if (c && c.__xlsxProgress) { send({ t: 'progress', rows: c.rowsDone, chunks: c.chunksTotal, sent: c.chunksSent }); continue; }
      if (c && c.length) fs.writeSync(fd, c);
    }
  } finally {
    fs.closeSync(fd);
  }
  return fs.statSync(out).size;
}

// ---------------------------------------------------------------- settle-single
function settleSingle(cfg) {
  const Q = cfg.quotaPerUsd || 500000;
  const usd = q => '$' + ((q || 0) / Q).toFixed(6);
  const db = openDb(cfg.dbPath);
  const u = db.prepare('SELECT * FROM users WHERE id=?').get(cfg.userId);
  if (!u) throw new Error('用户不存在: ' + cfg.userId);

  const since = cfg.since || 0, until = cfg.until || 0;
  const cond = ['user_id=?'], v = [u.id];
  if (since) { cond.push('created_at>=?'); v.push(since); }
  if (until) { cond.push('created_at<=?'); v.push(until); }
  const where = cond.join(' AND ');

  const agg = db.prepare(`SELECT COUNT(*) c,
      SUM(CASE WHEN status='success' THEN 1 ELSE 0 END) ok,
      SUM(CASE WHEN status!='success' THEN 1 ELSE 0 END) err,
      COALESCE(SUM(prompt_tokens),0) tin, COALESCE(SUM(completion_tokens),0) tout,
      COALESCE(SUM(total_tokens),0) tok, COALESCE(SUM(quota),0) q
    FROM logs WHERE ${where}`).get(...v);
  const rc = db.prepare(`SELECT COALESCE(SUM(quota),0) q FROM logs WHERE ${where} AND log_type='recharge'`).get(...v).q;
  const span = db.prepare('SELECT MIN(created_at) f, MAX(created_at) l FROM logs WHERE user_id=?').get(u.id);

  const cap = cfg.limit || 500000;
  const dw = `user_id=? AND log_type='consume'${since ? ' AND created_at>=?' : ''}${until ? ' AND created_at<=?' : ''}`;
  const dv = [u.id, ...(since ? [since] : []), ...(until ? [until] : [])];
  const detailCount = countRows(db, dw, dv);
  const totalRows = Math.min(detailCount, cap);

  const info = [
    ['结算清单', ''], ['用户名', u.username], ['用户ID', String(u.id)],
    ['角色', u.role >= 100 ? '管理员' : '用户'], ['状态', u.status === 1 ? '启用' : '禁用'],
    ['注册时间', fmtTs(u.created_at)],
    ['账期', (span.f && span.l) ? `${fmtTs(span.f)} ~ ${fmtTs(span.l)}` : '(无调用记录)'],
    ['', ''], ['结算项目', '金额(USD)'],
    ['累计充值', usd(rc)], ['累计消费', usd(agg.q)], ['当前余额', usd(u.quota)],
    ['', ''], ['调用统计', ''],
    ['请求总数', String(agg.c)], ['成功', String(agg.ok || 0)], ['失败', String(agg.err || 0)],
    ['输入token', String(agg.tin)], ['输出token', String(agg.tout)], ['总token', String(agg.tok)],
    ['明细行数', cap < detailCount ? `前 ${cap} 条(共 ${detailCount} 条, 已截断)` : String(detailCount)],
    ['导出时间', fmtTs(Date.now())],
  ];

  send({ t: 'progress', rows: 0, chunks: Math.max(1, Math.ceil(totalRows / 50000)), sent: 0 });

  const byModel = db.prepare(`SELECT model_name, COUNT(*) c, COALESCE(SUM(prompt_tokens),0) tin,
     COALESCE(SUM(completion_tokens),0) tout, COALESCE(SUM(total_tokens),0) tok, COALESCE(SUM(quota),0) q
     FROM logs WHERE ${where} GROUP BY model_name ORDER BY q DESC`).all(...v);
  const mSheet = [['模型', '请求次数', '输入token', '输出token', '总token', '消费(USD)']];
  let mR = 0, mI = 0, mO = 0, mT = 0, mQ = 0;
  for (const r of byModel) { mSheet.push([r.model_name, r.c, r.tin, r.tout, r.tok, usd(r.q)]); mR += r.c; mI += r.tin; mO += r.tout; mT += r.tok; mQ += r.q; }
  mSheet.push(['合计', mR, mI, mO, mT, usd(mQ)]);

  const byCh = db.prepare(`SELECT channel_name, COUNT(*) c, COALESCE(SUM(total_tokens),0) tok, COALESCE(SUM(quota),0) q
     FROM logs WHERE ${where} GROUP BY channel_name ORDER BY q DESC`).all(...v);
  const cSheet = [['渠道', '请求次数', '总token', '消费(USD)']];
  let cR = 0, cT = 0, cQ = 0;
  for (const r of byCh) { cSheet.push([r.channel_name || '-', r.c, r.tok, usd(r.q)]); cR += r.c; cT += r.tok; cQ += r.q; }
  cSheet.push(['合计', cR, cT, usd(cQ)]);

  const rwRows = db.prepare(`SELECT CASE WHEN username='agent-reward-L1' THEN 'L1'
     WHEN username='agent-reward-L2' THEN 'L2' ELSE 'L3' END lv, COUNT(*) c, COALESCE(SUM(quota),0) q
     FROM logs WHERE user_id=? AND log_type='consume' AND username LIKE 'agent-reward-L%' GROUP BY lv`).all(u.id);
  const rwSheet = [['返佣层级', '笔数', '返佣(USD)']];
  for (const r of rwRows) rwSheet.push([r.lv, r.c, usd(r.q)]);
  rwSheet.push(['合计', rwRows.reduce((a, r) => a + r.c, 0), usd(rwRows.reduce((a, r) => a + (r.q || 0), 0))]);

  const rwUsers = db.prepare(`SELECT u.id, u.username, COALESCE(SUM(r.quota),0) q
     FROM logs c
     JOIN logs r ON r.request_id = 'invite:' || c.request_id
     JOIN users u ON u.id = r.user_id
     WHERE c.user_id=? AND c.log_type='consume' AND c.username=? AND c.request_id NOT LIKE 'invite:%'
       AND r.log_type='consume' AND r.username LIKE 'agent-reward-L%'
     GROUP BY u.id ORDER BY q`).all(u.id, u.username);
  const rwSheet2 = [['返佣获得用户', 'ID', '返佣(USD)']];
  for (const r of rwUsers) rwSheet2.push([r.username, String(r.id), usd(r.q)]);

  const header = ['时间', '类型', '模型', '渠道', '令牌', '输入token', '输出token', '总token', '消费(USD)', '耗时(秒)', '流式', '状态', '错误', '来源IP'];
  const COLS = 'id,user_id,username,token_id,token_name,channel_name,model_name,prompt_tokens,completion_tokens,total_tokens,quota,use_time,is_stream,status,error,ip,created_at,log_type';

  function* rows() {
    for (const l of pageRows(db, { where: dw, params: dv, cols: COLS, cap })) {
      yield [fmtTs(l.created_at), TYPE_LABEL[l.log_type] || l.log_type || '消费', l.model_name || '-', l.channel_name || '-', l.token_name || '-',
        l.prompt_tokens, l.completion_tokens, l.total_tokens, usd(l.quota),
        Math.round(l.use_time || 0), l.is_stream ? '是' : '否', l.status === 'success' ? '成功' : '失败',
        (l.error || '').slice(0, 80), l.ip || ''];
    }
  }

  const gen = xlsx.buildChunked(header, rows, 50000, '调用明细', [
    { name: '结算概要', rows: info, colWidths: [16, 44] },
    { name: '按模型汇总', rows: mSheet, colWidths: [24, 10, 13, 13, 13, 14], freezeHeader: true },
    { name: '按渠道汇总', rows: cSheet, colWidths: [26, 10, 13, 14], freezeHeader: true },
    { name: '返佣汇总', rows: rwSheet.concat([['', ''], ['按用户', ''], ...rwSheet2]), colWidths: [20, 10, 14], freezeHeader: true },
  ], { totalRows });

  const bytes = writeXlsx(gen, outFile);
  db.close();
  send({ t: 'done', bytes, rows: totalRows });
}

// ---------------------------------------------------------------- settle-all
function settleAll(cfg) {
  const Q = cfg.quotaPerUsd || 500000;
  const usd = q => '$' + ((q || 0) / Q).toFixed(6);
  const db = openDb(cfg.dbPath);
  const since = cfg.since || 0, until = cfg.until || 0;
  const perUserLimit = cfg.perUserLimit || 10000;
  const users = db.prepare('SELECT id,username,role,status,quota,created_at FROM users ORDER BY id').all();

  const rangeCond = (uid) => {
    const cond = ['user_id=?'], v = [uid];
    if (since) { cond.push('created_at>=?'); v.push(since); }
    if (until) { cond.push('created_at<=?'); v.push(until); }
    return { where: cond.join(' AND '), v };
  };
  const aggOf = (uid) => { const r = rangeCond(uid); return db.prepare(`SELECT COUNT(*) c,
      SUM(CASE WHEN status='success' THEN 1 ELSE 0 END) ok, SUM(CASE WHEN status!='success' THEN 1 ELSE 0 END) err,
      COALESCE(SUM(prompt_tokens),0) tin, COALESCE(SUM(completion_tokens),0) tout,
      COALESCE(SUM(total_tokens),0) tok, COALESCE(SUM(quota),0) q
    FROM logs WHERE ${r.where}`).get(...r.v); };
  const rcOf = (uid) => { const r = rangeCond(uid); return db.prepare(`SELECT COALESCE(SUM(quota),0) q FROM logs WHERE ${r.where} AND log_type='recharge'`).get(...r.v).q; };
  const spanOf = (uid) => db.prepare('SELECT MIN(created_at) f, MAX(created_at) l FROM logs WHERE user_id=?').get(uid);

  const master = [['用户ID', '用户名', '角色', '状态', '账期起', '账期止', '请求次数', '成功', '失败', '输入token', '输出token', '总token', '累计消费(USD)', '累计充值(USD)', '当前余额(USD)']];
  const G = { c: 0, ok: 0, err: 0, tin: 0, tout: 0, tok: 0, q: 0, rc: 0 };
  const perUser = [];
  for (const u of users) {
    const agg = aggOf(u.id), rc = rcOf(u.id), sp = spanOf(u.id);
    G.c += agg.c; G.ok += agg.ok || 0; G.err += agg.err || 0;
    G.tin += agg.tin; G.tout += agg.tout; G.tok += agg.tok; G.q += agg.q; G.rc += rc;
    master.push([String(u.id), u.username, u.role >= 100 ? '管理员' : '用户', u.status === 1 ? '启用' : '禁用',
      fmtTs(sp.f || u.created_at), fmtTs(sp.l || u.created_at), agg.c, agg.ok || 0, agg.err || 0,
      agg.tin, agg.tout, agg.tok, usd(agg.q), usd(rc), usd(u.quota)]);
    perUser.push({ u, agg });
    send({ t: 'progress', rows: master.length, chunks: users.length, sent: 0 });
  }
  master.push(['合计', '', '', '', '', '', G.c, G.ok, G.err, G.tin, G.tout, G.tok, usd(G.q), usd(G.rc), '']);

  const sheets = [{ name: '全部用户结算', rows: master, colWidths: [8, 16, 8, 6, 19, 19, 9, 7, 7, 12, 12, 12, 15, 15, 15], freezeHeader: true }];
  const used = new Set(['全部用户结算']);
  const COLS = 'id,model_name,channel_name,prompt_tokens,completion_tokens,total_tokens,quota,status,created_at';
  for (const { u, agg } of perUser.slice(0, 40)) {
    if (!agg.c) continue;
    let base = u.username.replace(/[\\\/\?\*\[\]:]/g, '_').slice(0, 26);
    let nm = base, i = 2;
    while (used.has(nm)) nm = base + '_' + (i++);
    used.add(nm);
    const r = rangeCond(u.id);
    const where = `${r.where} AND log_type='consume'`;
    const cnt = countRows(db, where, r.v);
    const rows = [['结算:' + u.username + ' (ID ' + u.id + ')', ''],
      ['累计消费(USD)', usd(agg.q)], ['总token', String(agg.tok)], ['请求数', String(agg.c)],
      ['明细', cnt > perUserLimit ? `前 ${perUserLimit} 条(共 ${cnt} 条, 已截断)` : `${cnt} 条`],
      ['', ''], ['时间', '模型', '渠道', '输入token', '输出token', '总token', '消费(USD)', '状态']];
    for (const l of pageRows(db, { where, params: r.v, cols: COLS, cap: perUserLimit })) {
      rows.push([fmtTs(l.created_at), l.model_name || '-', l.channel_name || '-',
        l.prompt_tokens, l.completion_tokens, l.total_tokens, usd(l.quota),
        l.status === 'success' ? '成功' : '失败']);
    }
    sheets.push({ name: nm, rows, colWidths: [19, 24, 24, 11, 11, 11, 13, 7], freezeHeader: true });
    send({ t: 'progress', rows: master.length, chunks: perUser.length, sent: sheets.length - 1 });
  }

  const buf = xlsx.build(sheets);
  fs.writeFileSync(outFile, buf);
  db.close();
  send({ t: 'done', bytes: buf.length, rows: master.length });
}

// ---------------------------------------------------------------- usage
function usage(cfg) {
  const Q = cfg.quotaPerUsd || 500000;
  const yuan = q => '¥' + ((q || 0) / Q).toFixed(6);
  const db = openDb(cfg.dbPath);
  const since = cfg.since || 0, until = cfg.until || 0;
  const cap = cfg.limit || 500000;

  const cond = [], v = [];
  if (cfg.userId) { cond.push('user_id=?'); v.push(cfg.userId); }
  cond.push('created_at>=?'); v.push(since);
  if (until) { cond.push('created_at<=?'); v.push(until); }
  const where = cond.join(' AND ');

  const summary = db.prepare(`SELECT user_id, username, token_id, token_name, model_name,
       COUNT(*) AS req_count,
       COALESCE(SUM(prompt_tokens),0) AS prompt_tokens,
       COALESCE(SUM(completion_tokens),0) AS completion_tokens,
       COALESCE(SUM(total_tokens),0) AS total_tokens,
       COALESCE(SUM(quota),0) AS quota
    FROM logs WHERE ${where}
    GROUP BY user_id, username, token_id, token_name, model_name
    ORDER BY user_id, token_id, model_name`).all(...v);

  const sum = [['用户', '用户ID', '令牌名称', '令牌ID', '模型', '请求次数', '输入token数', '输出token数', '总token数', '消费金额']];
  let tReq = 0, tIn = 0, tOut = 0, tTok = 0, tQ = 0;
  for (const s of summary) {
    sum.push([s.username, String(s.user_id), s.token_name || '-', String(s.token_id || ''), s.model_name, s.req_count,
      s.prompt_tokens, s.completion_tokens, s.total_tokens, yuan(s.quota)]);
    tReq += s.req_count; tIn += s.prompt_tokens; tOut += s.completion_tokens; tTok += s.total_tokens; tQ += s.quota;
  }
  sum.push(['合计', '', '', '', '', tReq, tIn, tOut, tTok, yuan(tQ)]);

  const header = ['时间', '类型', '用户', '用户ID', '令牌名称', '模型', '输入token数', '缓存读token数', '未命中token数', '命中率', '输出token数', '花费金额', '用时(秒)', '流式'];
  const dw = `${where} AND log_type='consume'`;
  const detailCount = countRows(db, dw, v);
  const totalRows = Math.min(detailCount, cap);
  send({ t: 'progress', rows: 0, chunks: Math.max(1, Math.ceil(totalRows / 50000)), sent: 0 });

  const COLS = 'id,user_id,username,token_name,model_name,prompt_tokens,completion_tokens,total_tokens,quota,use_time,is_stream,created_at,log_type,cached_tokens';
  function* rows() {
    for (const r of pageRows(db, { where: dw, params: v, cols: COLS, cap })) {
      const ca = r.cached_tokens || 0;
      yield [fmtTs(r.created_at), typeLabel(r), r.username, String(r.user_id), r.token_name || '', r.model_name || '',
        r.prompt_tokens, ca, Math.max(0, (r.prompt_tokens || 0) - ca),
        r.prompt_tokens ? Math.round(ca / r.prompt_tokens * 100) + '%' : '',
        r.completion_tokens, yuan(r.quota), Math.round(r.use_time || 0), r.is_stream ? '是' : '否'];
    }
  }

  const gen = xlsx.buildChunked(header, rows, 50000, cfg.all ? '全部明细' : '使用日志',
    [{ name: '按模型汇总', rows: sum, colWidths: [14, 9, 16, 9, 24, 10, 13, 13, 13, 13], freezeHeader: true }],
    { totalRows });

  const bytes = writeXlsx(gen, outFile);
  db.close();
  send({ t: 'done', bytes, rows: totalRows });
}

const MODES = { 'settle-single': settleSingle, 'settle-all': settleAll, 'usage': usage };

let input = '';
process.stdin.on('data', (d) => { input += d.toString('utf8'); });
process.stdin.on('end', () => {
  let cfg;
  try { cfg = JSON.parse(input); } catch (e) { send({ t: 'error', message: 'bad cfg: ' + e.message }); process.exit(1); }
  const fn = MODES[mode];
  if (!fn) { send({ t: 'error', message: 'unknown mode: ' + mode }); process.exit(1); }
  try {
    fn(cfg);
    process.exit(0);
  } catch (e) {
    send({ t: 'error', message: e.stack || e.message });
    process.exit(1);
  }
});
process.on('uncaughtException', (e) => { send({ t: 'error', message: e.stack || e.message }); process.exit(1); });
