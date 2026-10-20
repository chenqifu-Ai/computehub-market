'use strict';
/**
 * 分片导出 worker 线程（worker_threads）
 *   - 只读 DB 连接，处理指定 id 区间的明细行
 *   - 每 50000 行生成一个独立 sheet 的 XML → deflate → 落 .bin
 *   - 回报每片 { seq, rawSize, compSize, crc, rows }
 *
 * 目的：xlsx 的 XML 拼装 + deflate 都是纯 CPU 活，单核跑 96 万行要 27s。
 * 拆到 4 个线程后 ~7s，导出真正可用的前提。
 */
const { parentPort, workerData } = require('node:worker_threads');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { DatabaseSync } = require('node:sqlite');

const cfg = workerData;

// ---- 列前缀预编译（比逐格拼字符串快 40%） ----
const COL = ['A','B','C','D','E','F','G','H','I','J','K','L','M','N','O','P'];
const NUM_P = COL.map(c => '<c r="' + c + '"><v>');
const STR_P = COL.map(c => '<c r="' + c + '" t="inlineStr"><is><t xml:space="preserve">');
const XOPEN = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
  + '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>';
const XCLOSE = '</sheetData></worksheet>';

const NEED_ESC = /[&<>"]/;
function escRaw(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function esc(s) {
  const v = String(s == null ? '' : s);
  return NEED_ESC.test(v) ? escRaw(v) : v;
}
function pad2(n) { return String(n).padStart(2, '0'); }
function fmtTs(ms) {
  const d = new Date(ms);
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) + ' '
    + pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds());
}

/** 时间戳按「同秒」复用，避免每行 new Date()（占比不小） */
function makeTsCache() {
  let lastAt = -1, lastStr = '';
  return (at) => {
    if (at === lastAt) return lastStr;
    lastAt = at; lastStr = fmtTs(at);
    return lastStr;
  };
}

/** 生成明细行 XML（按 mode 决定列布局），返回 string */
function makeRowFormatter(mode, quotaPerUsd) {
  const Q = quotaPerUsd || 500000;
  const usd = (q) => '$' + ((q || 0) / Q).toFixed(6);
  const yuan = (q) => '¥' + ((q || 0) / Q).toFixed(6);
  const TYPE = { consume: '消费', recharge: '充值', reward: '返利', system: '系统', admin: '管理' };

  if (mode === 'settle-detail') {
    // 列: 时间 类型 模型 渠道 令牌 输入 输出 总token 消费 耗时 流式 状态 错误 来源IP
    const ts = makeTsCache();
    return (l) => '<row>'
      + STR_P[0] + esc(ts(l.created_at)) + '</t></is></c>'
      + STR_P[1] + (l.log_type === 'consume' ? '消费' : esc(TYPE[l.log_type] || l.log_type || '消费')) + '</t></is></c>'
      + STR_P[2] + esc(l.model_name || '-') + '</t></is></c>'
      + STR_P[3] + esc(l.channel_name || '-') + '</t></is></c>'
      + STR_P[4] + esc(l.token_name || '') + '</t></is></c>'
      + NUM_P[5] + (l.prompt_tokens || 0) + '</v></c>'
      + NUM_P[6] + (l.completion_tokens || 0) + '</v></c>'
      + NUM_P[7] + (l.total_tokens || 0) + '</v></c>'
      + STR_P[8] + esc(usd(l.quota)) + '</t></is></c>'
      + NUM_P[9] + Math.round(l.use_time || 0) + '</v></c>'
      + STR_P[10] + (l.is_stream ? '是' : '否') + '</t></is></c>'
      + STR_P[11] + (l.status === 'success' ? '成功' : '失败') + '</t></is></c>'
      + STR_P[12] + esc((l.error || '').slice(0, 80)) + '</t></is></c>'
      + STR_P[13] + esc(l.ip || '') + '</t></is></c>'
      + '</row>';
  }

  // usage-detail: 时间 类型 用户 用户ID 令牌 模型 输入 缓存读 未命中 命中率 输出 花费 耗时 流式
  const ts = makeTsCache();
  return (l) => {
    const ca = l.cached_tokens || 0;
    const hit = l.prompt_tokens ? Math.round(ca / l.prompt_tokens * 100) + '%' : '';
    return '<row>'
      + STR_P[0] + esc(ts(l.created_at)) + '</t></is></c>'
      + STR_P[1] + (l.log_type === 'consume' ? '消费' : esc(TYPE[l.log_type] || l.log_type || '消费')) + '</t></is></c>'
      + STR_P[2] + esc(l.username || '') + '</t></is></c>'
      + NUM_P[3] + (l.user_id || 0) + '</v></c>'
      + STR_P[4] + esc(l.token_name || '') + '</t></is></c>'
      + STR_P[5] + esc(l.model_name || '') + '</t></is></c>'
      + NUM_P[6] + (l.prompt_tokens || 0) + '</v></c>'
      + NUM_P[7] + ca + '</v></c>'
      + NUM_P[8] + Math.max(0, (l.prompt_tokens || 0) - ca) + '</v></c>'
      + STR_P[9] + esc(hit) + '</t></is></c>'
      + NUM_P[10] + (l.completion_tokens || 0) + '</v></c>'
      + STR_P[11] + esc(yuan(l.quota)) + '</t></is></c>'
      + NUM_P[12] + Math.round(l.use_time || 0) + '</v></c>'
      + STR_P[13] + (l.is_stream ? '是' : '否') + '</t></is></c>'
      + '</row>';
  };
}

function run() {
  const db = new DatabaseSync(cfg.dbPath, { readOnly: true });
  db.exec('PRAGMA busy_timeout = 20000;');

  const COLS = cfg.mode === 'usage-detail'
    ? 'id,user_id,username,token_name,model_name,prompt_tokens,completion_tokens,total_tokens,quota,use_time,is_stream,created_at,log_type,cached_tokens'
    : 'id,channel_name,token_name,model_name,prompt_tokens,completion_tokens,total_tokens,quota,use_time,is_stream,status,error,ip,created_at,log_type';

  // 本分片 id 区间 + 固定过滤条件；游标 id<cursor 推进
  // 【关键】必须带 id >= lo 下界，否则每个分片会把下面所有分片的数据也读进去。
  const cond = ['id <= ?', 'id >= ?'];              // hi, lo
  const fixed = [...(cfg.params || [])];
  if (cfg.where) cond.push('(' + cfg.where + ')');
  const sql = `SELECT ${COLS} FROM logs WHERE ${cond.join(' AND ')} AND id < ? ORDER BY id DESC LIMIT ?`;
  const stmt = db.prepare(sql);

  const fmtRow = makeRowFormatter(cfg.mode, cfg.quotaPerUsd);
  const headerXml = '<row r="1">' + (cfg.header || []).map((v, c) =>
    '<c r="' + COL[c] + '1" t="inlineStr"><is><t xml:space="preserve">' + esc(v) + '</t></is></c>').join('') + '</row>';

  const CHUNK = cfg.chunkSize || 50000;
  const BATCH = CHUNK;   // 每批正好一个 sheet，批边界 = flush 边界，不会漏行
  const outParts = [];
  let seq = 0;
  let rowsDone = 0;
  let pending = [];
  let pendingRows = 0;

  function flush() {
    if (pendingRows === 0) return;
    const xml = XOPEN + headerXml + pending.join('') + XCLOSE;
    const raw = Buffer.from(xml, 'utf8');
    const comp = zlib.deflateRawSync(raw, { level: cfg.level == null ? 1 : cfg.level });
    const file = path.join(cfg.outDir, cfg.idx + '-' + String(seq).padStart(4, '0') + '.bin');
    fs.writeFileSync(file, comp);
    outParts.push({ file, rawSize: raw.length, compSize: comp.length, crc: zlib.crc32(raw) >>> 0, rows: pendingRows });
    seq++;
    pending = []; pendingRows = 0;
    parentPort.postMessage({ t: 'progress', idx: cfg.idx, rows: rowsDone });
  }

  let cursor = cfg.hi + 1;   // 半开区间上界（不含）
  while (rowsDone < cfg.cap) {
    const lim = Math.min(BATCH, cfg.cap - rowsDone);
    const rows = stmt.all(cfg.hi, cfg.lo, ...fixed, cursor, lim);
    if (!rows.length) break;
    for (const l of rows) {
      pending.push(fmtRow(l));
      pendingRows++;
      rowsDone++;
    }
    cursor = rows[rows.length - 1].id;
    flush();                           // 整批一次性 flush，边界干净
    if (rows.length < lim) break;
  }
  db.close();
  parentPort.postMessage({ t: 'done', idx: cfg.idx, rows: rowsDone, parts: outParts });
}

try {
  run();
} catch (e) {
  parentPort.postMessage({ t: 'error', idx: cfg.idx, message: (e && e.stack) || String(e) });
}
