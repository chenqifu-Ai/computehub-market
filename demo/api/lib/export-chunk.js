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
// 【修复 2026-10-21】单元格引用必须带行号：r="A" 是非法 ref，Excel 打开直接报"文件已损坏"。
// 改成按行号生成前缀（每行 14 次字符串拼接，开销可忽略）。
const numP = (c, r) => '<c r="' + COL[c] + r + '"><v>';
// 去掉每格 xml:space="preserve"（40MB/96万行 × 14 列 = 大量冗余字节，压缩后再省 ~20%）
// 需要保留前导/尾随空格的字段极少，且业务数据本身不会带空格。
const strP = (c, r) => '<c r="' + COL[c] + r + '" t="inlineStr"><is><t>';
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
    return (l, r) => '<row r="' + r + '">'
      + strP(0, r) + esc(ts(l.created_at)) + '</t></is></c>'
      + strP(1, r) + (l.log_type === 'consume' ? '消费' : esc(TYPE[l.log_type] || l.log_type || '消费')) + '</t></is></c>'
      + strP(2, r) + esc(l.model_name || '-') + '</t></is></c>'
      + strP(3, r) + esc(l.channel_name || '-') + '</t></is></c>'
      + strP(4, r) + esc(l.token_name || '') + '</t></is></c>'
      + numP(5, r) + (l.prompt_tokens || 0) + '</v></c>'
      + numP(6, r) + (l.completion_tokens || 0) + '</v></c>'
      + numP(7, r) + (l.total_tokens || 0) + '</v></c>'
      + strP(8, r) + esc(usd(l.quota)) + '</t></is></c>'
      + numP(9, r) + Math.round(l.use_time || 0) + '</v></c>'
      + strP(10, r) + (l.is_stream ? '是' : '否') + '</t></is></c>'
      + strP(11, r) + (l.status === 'success' ? '成功' : '失败') + '</t></is></c>'
      + strP(12, r) + esc((l.error || '').slice(0, 80)) + '</t></is></c>'
      + strP(13, r) + esc(l.ip || '') + '</t></is></c>'
      + '</row>';
  }

  // usage-detail: 时间 类型 用户 用户ID 令牌 模型 输入 缓存读 未命中 命中率 输出 花费 耗时 流式
  const ts = makeTsCache();
  return (l, r) => {
    const ca = l.cached_tokens || 0;
    const hit = l.prompt_tokens ? Math.round(ca / l.prompt_tokens * 100) + '%' : '';
    return '<row r="' + r + '">'
      + strP(0, r) + esc(ts(l.created_at)) + '</t></is></c>'
      + strP(1, r) + (l.log_type === 'consume' ? '消费' : esc(TYPE[l.log_type] || l.log_type || '消费')) + '</t></is></c>'
      + strP(2, r) + esc(l.username || '') + '</t></is></c>'
      + numP(3, r) + (l.user_id || 0) + '</v></c>'
      + strP(4, r) + esc(l.token_name || '') + '</t></is></c>'
      + strP(5, r) + esc(l.model_name || '') + '</t></is></c>'
      + numP(6, r) + (l.prompt_tokens || 0) + '</v></c>'
      + numP(7, r) + ca + '</v></c>'
      + numP(8, r) + Math.max(0, (l.prompt_tokens || 0) - ca) + '</v></c>'
      + strP(9, r) + esc(hit) + '</t></is></c>'
      + numP(10, r) + (l.completion_tokens || 0) + '</v></c>'
      + strP(11, r) + esc(yuan(l.quota)) + '</t></is></c>'
      + numP(12, r) + Math.round(l.use_time || 0) + '</v></c>'
      + strP(13, r) + (l.is_stream ? '是' : '否') + '</t></is></c>'
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
    '<c r="' + COL[c] + '1" t="inlineStr"><is><t>' + esc(v) + '</t></is></c>').join('') + '</row>';

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
    parentPort.postMessage({ t: 'progress', idx: cfg.idx, rows: rowsDone, parts: seq });
  }

  let cursor = cfg.hi + 1;   // 半开区间上界（不含）
  while (rowsDone < cfg.cap) {
    const lim = Math.min(BATCH, cfg.cap - rowsDone);
    const rows = stmt.all(cfg.hi, cfg.lo, ...fixed, cursor, lim);
    if (!rows.length) break;
    for (const l of rows) {
      // 行号 = pendingRows + 2（第 1 行是表头）
      pending.push(fmtRow(l, pendingRows + 2));
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
