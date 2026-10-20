'use strict';
/** xlsx 生成子进程（worker 模式）
 *  CPU 密集任务（XML拼装+crc32+deflate）放独立进程，不卡主进程事件循环。
 *  协议:
 *   stdin: {"t":"init", header:[], chunkSize, prefix, summarySheets:[]}
 *          {"t":"rows", rows:[[...]]}  可多次（每批 ≤5000 行控内存/消息大小）
 *          {"t":"end"}
 *   stdout: {"t":"progress", rows, chunks}
 *           {"t":"done", bytes, ms}
 *           {"t":"error", message}
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const xlsx = require('./xlsx');

const outFile = process.argv[2];
let header, chunkSize, prefix, summarySheets;
const rowsAcc = [];
let started = false;

function send(o) { process.stdout.write(JSON.stringify(o) + '\n'); }

function* rowGen() {
  for (let i = 0; i < rowsAcc.length; i++) yield rowsAcc[i];
}

function runExport() {
  if (started) return;
  started = true;
  const t0 = Date.now();
  const gen = xlsx.buildChunked(header, rowGen, chunkSize, prefix, summarySheets);
  const out = fs.createWriteStream(outFile);
  for (const c of gen) {
    if (c && c.__xlsxProgress) { send({ t: 'progress', rows: c.rowsDone, chunks: c.chunksTotal }); continue; }
    if (c && c.length) out.write(c);
  }
  out.end();
  out.on('finish', () => { send({ t: 'done', bytes: fs.statSync(outFile).size, ms: Date.now() - t0 }); process.exit(0); });
  out.on('error', (e) => { send({ t: 'error', message: e.message }); process.exit(1); });
}

let inputBuf = '';
process.stdin.on('data', (d) => {
  inputBuf += d.toString('utf8');
  let idx;
  while ((idx = inputBuf.indexOf('\n')) >= 0) {
    const line = inputBuf.slice(0, idx);
    inputBuf = inputBuf.slice(idx + 1);
    if (!line.trim()) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    if (msg.t === 'init') {
      header = msg.header; chunkSize = msg.chunkSize || 50000;
      prefix = msg.prefix || '明细'; summarySheets = msg.summarySheets || [];
    } else if (msg.t === 'rows') {
      rowsAcc.push.apply(rowsAcc, msg.rows);
    } else if (msg.t === 'end') {
      runExport();
    }
  }
});
process.stdin.on('end', () => { if (rowsAcc.length || header) runExport(); });
process.on('uncaughtException', (e) => { send({ t: 'error', message: e.message }); process.exit(1); });
