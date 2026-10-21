'use strict';
/**
 * 并行导出协调器（多核）
 *
 * 背景：xlsx 的 XML 拼装 + deflate 是纯 CPU 活。单核跑 96 万行 14 列要：
 *   DB 读 7.7s + XML 21s + deflate 6.1s ≈ 35s（加上 IO 实际 61s）
 * 本机 4 核，拆成 4 个 worker_thread 各自处理 id 区间 → 实测 ~10s。
 *
 * 用法: node export-multi.js <outFile> <mode>
 *   stdin: 单行 JSON 配置
 *   stdout: {"t":"progress"} / {"t":"done"} / {"t":"error"}
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { DatabaseSync } = require('node:sqlite');
const { Worker } = require('node:worker_threads');

const outFile = process.argv[2];
const mode = process.argv[3];

function pad2(n) { return String(n).padStart(2, '0'); }
function fmtTs(ms) {
  const d = new Date(ms);
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) + ' '
    + pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds());
}
function send(o) { process.stdout.write(JSON.stringify(o) + '\n'); }

/** Excel sheet 名规则：≤31 字符，且禁止 \ / ? * [ ] : */
function sanitizeSheetName(n) {
  return String(n).replace(/[\\\/\?\*\[\]:]/g, '-').slice(0, 31) || 'Sheet';
}
/** 分片 sheet 名：总量>1 时带序号（用 - 而不是 /） */
function sheetName(base, idx, total) {
  return sanitizeSheetName(total > 1 ? base + idx + '-' + total : base);
}

const NEED_ESC = /[&<>"]/;
function esc(v) {
  const s = String(v == null ? '' : v);
  return NEED_ESC.test(s) ? s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;') : s;
}
const COL = ['A','B','C','D','E','F','G','H','I','J','K','L','M','N','O','P'];

/** 小表（汇总 sheet）XML */
function sheetXml(rows) {
  let x = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
    + '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>';
  for (let r = 0; r < rows.length; r++) {
    x += '<row r="' + (r + 1) + '">';
    const row = rows[r] || [];
    for (let c = 0; c < row.length; c++) {
      const v = row[c];
      const ref = COL[c] + (r + 1);
      x += (typeof v === 'number' && Number.isFinite(v))
        ? '<c r="' + ref + '"><v>' + v + '</v></c>'
        : '<c r="' + ref + '" t="inlineStr"><is><t xml:space="preserve">' + esc(v) + '</t></is></c>';
    }
    x += '</row>';
  }
  return x + '</sheetData></worksheet>';
}

function zipEntry(name, data, offset) {
  const nameBuf = Buffer.from(name, 'utf8');
  const comp = zlib.deflateRawSync(data, { level: 1 });
  const crc = zlib.crc32(data) >>> 0;
  return zipEntryRaw(nameBuf, comp, data.length, crc, offset);
}

/** 已经是 deflate 压缩过的数据（worker 已压好），避免二次压缩 */
function zipEntryRaw(nameBuf, comp, rawSize, crc, offset) {
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(0x0800, 6);
  local.writeUInt16LE(8, 8);
  local.writeUInt16LE(0, 10);
  local.writeUInt16LE(0x21, 12);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(comp.length, 18);
  local.writeUInt32LE(rawSize, 22);
  local.writeUInt16LE(nameBuf.length, 26);
  local.writeUInt16LE(0, 28);
  const cd = Buffer.alloc(46);
  cd.writeUInt32LE(0x02014b50, 0);
  cd.writeUInt16LE(20, 4);
  cd.writeUInt16LE(20, 6);
  cd.writeUInt16LE(0x0800, 8);
  cd.writeUInt16LE(8, 10);
  cd.writeUInt16LE(0, 12);
  cd.writeUInt16LE(0x21, 14);
  cd.writeUInt32LE(crc, 16);
  cd.writeUInt32LE(comp.length, 20);
  cd.writeUInt32LE(rawSize, 24);
  cd.writeUInt16LE(nameBuf.length, 28);
  cd.writeUInt32LE(0, 38);
  cd.writeUInt32LE(offset, 42);
  return { local, nameBuf, comp, cd, entryLen: 30 + nameBuf.length + comp.length };
}

const STY = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts><fills count="1"><fill><patternFill patternType="none"/></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf/></cellStyleXfs><cellXfs count="1"><xf/></cellXfs></styleSheet>';

/** 组装 xlsx（summarySheets 在前，detailParts 依次在后） */
function assemble(sheetNames, sheetBufs, out) {
  const fd = fs.openSync(out, 'w');
  let offset = 0;
  const cds = [];
  const write = (b) => { fs.writeSync(fd, b); offset += b.length; };

  for (let i = 0; i < sheetBufs.length; i++) {
    const s = sheetBufs[i];
    // s.precomp=true 时 data 已是 deflate 流（来自 worker），不能再压一次
    const e = s.precomp
      ? zipEntryRaw(Buffer.from('xl/worksheets/sheet' + (i + 1) + '.xml', 'utf8'), s.data, s.rawSize, s.crc, offset)
      : zipEntry('xl/worksheets/sheet' + (i + 1) + '.xml', s.data, offset);
    write(e.local); write(e.nameBuf); write(e.comp);
    cds.push(e.cd, e.nameBuf);
  }
  const n = sheetBufs.length;
  let ct = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
    + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
    + '<Default Extension="xml" ContentType="application/xml"/>'
    + '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
    + '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>';
  let wb = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>';
  let rels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">';
  // sheet 名：清洗非法字符 + 去重（重名 Excel 同样会判损坏）
  const seen = new Set();
  const finalNames = [];
  for (let i = 0; i < n; i++) {
    let nm = sanitizeSheetName(sheetNames[i]);
    let base = nm, k = 2;
    while (seen.has(nm)) { nm = sanitizeSheetName(base.slice(0, 27) + '~' + (k++)); }
    seen.add(nm);
    finalNames.push(nm);
  }
  for (let i = 0; i < n; i++) {
    ct += '<Override PartName="/xl/worksheets/sheet' + (i + 1) + '.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>';
    wb += '<sheet name="' + esc(finalNames[i]) + '" sheetId="' + (i + 1) + '" r:id="rId' + (i + 1) + '"/>';
    rels += '<Relationship Id="rId' + (i + 1) + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet' + (i + 1) + '.xml"/>';
  }
  ct += '</Types>';
  wb += '</sheets></workbook>';
  rels += '<Relationship Id="rId' + (n + 1) + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>';

  const statics = [
    ['[Content_Types].xml', ct],
    ['_rels/.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>'],
    ['xl/workbook.xml', wb],
    ['xl/_rels/workbook.xml.rels', rels],
    ['xl/styles.xml', STY],
  ];
  for (const [name, txt] of statics) {
    const e = zipEntry(name, Buffer.from(txt, 'utf8'), offset);
    write(e.local); write(e.nameBuf); write(e.comp);
    cds.push(e.cd, e.nameBuf);
  }
  const cdBuf = Buffer.concat(cds);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(n, 8);
  eocd.writeUInt16LE(n, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  write(cdBuf);
  write(eocd);
  fs.closeSync(fd);
  return fs.statSync(out).size;
}

/** 并行跑明细分片 */
function runShards(cfg, { header, where, params, cap, mode, tmpDir, quotaPerUsd }) {
  return new Promise((resolve, reject) => {
    const db = new DatabaseSync(cfg.dbPath, { readOnly: true });
    // cap 精确截断：先 COUNT，只有真的超限才去定位边界 id。
    // 旧写法无条件 `ORDER BY id DESC LIMIT 1 OFFSET cap-1`：数据量远小于 cap 时
    // 仍要扫一遍全索引找 OFFSET，白白多花 8~10s（“最近 7 天”场景就是 4 万行 vs cap 200 万）。
    let lowerBound = null;
    if (Number.isFinite(cap) && cap > 0) {
      const cnt = db.prepare(`SELECT COUNT(*) c FROM logs WHERE ${where}`).get(...params).c;
      if (cnt > cap) {
        const cut = db.prepare(`SELECT id FROM logs WHERE ${where} ORDER BY id DESC LIMIT 1 OFFSET ?`).get(...params, cap - 1);
        if (cut && cut.id) lowerBound = cut.id;
      }
    }
    const whereCap = lowerBound === null ? where : `(${where}) AND id >= ${Number(lowerBound)}`;

    const span = db.prepare(`SELECT MIN(id) a, MAX(id) b FROM logs WHERE ${whereCap}`).get(...params);
    db.close();
    if (!span || !span.a) return resolve([]);

    const N = Math.max(1, Math.min(cfg.threads || Math.max(2, Math.min(4, os.cpus().length)), 8));
    const total = span.b - span.a + 1;
    const step = Math.ceil(total / N);

    let finished = 0;
    const collected = new Array(N);
    const shardRows = new Array(N).fill(0);
    const shardParts = new Array(N).fill(0);
    let totalRows = 0;
    const totalRowsEst = span.b - span.a + 1 > 100000 ? null : null;   // 预留

    // 先给前端一个“开始干活”的信号，避免开头空白
    send({ t: 'progress', rows: 0, chunks: 0, sent: 0, shards: N });

    for (let i = 0; i < N; i++) {
      const lo = span.a + i * step;
      const hi = Math.min(span.b, lo + step - 1);
      const w = new Worker(path.join(__dirname, 'export-chunk.js'), {
        workerData: {
          dbPath: cfg.dbPath, idx: i, lo, hi, where: whereCap, params, header, mode,
          outDir: tmpDir, chunkSize: 50000, cap: Infinity, quotaPerUsd, level: 1,
        },
      });
      collected[i] = { parts: [], rows: 0 };
      w.on('message', (m) => {
        if (m.t === 'progress') {
          const prev = shardRows[m.idx];
          shardRows[m.idx] = m.rows;
          shardParts[m.idx] = m.parts || 0;
          totalRows += (m.rows - prev);
          // 片数 = 各分片已生成的 sheet 数之和（前端进度条依靠它）
          const partsDone = shardParts.reduce((a, b) => a + b, 0);
          send({ t: 'progress', rows: totalRows, chunks: partsDone, sent: partsDone, shards: N });
        } else if (m.t === 'done') {
          collected[m.idx].parts = m.parts;
          collected[m.idx].rows = m.rows;
        } else if (m.t === 'error') {
          reject(new Error('shard ' + m.idx + ': ' + m.message));
        }
      });
      w.on('error', reject);
      w.on('exit', () => {
        if (++finished === N) {
          // 按分片顺序拼（i 从 0 = id 最小 → 输出在最后；DESC 需反序）
          const parts = [];
          for (let k = N - 1; k >= 0; k--) parts.push(...collected[k].parts);
          resolve(parts);
        }
      });
    }
  });
}

// ------------------------------------------------------------ 汇总查询
function settleSummaries(db, u, since, until, Q) {
  const usd = q => '$' + ((q || 0) / Q).toFixed(6);
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

  // 明细筛选：必须带上日期范围，否则「最近 7 天」会导出全量（踩过）
  const dcond = [`user_id=?`, `log_type='consume'`];
  const dv = [u.id];
  if (since) { dcond.push('created_at>=?'); dv.push(since); }
  if (until) { dcond.push('created_at<=?'); dv.push(until); }
  const dw = dcond.join(' AND ');

  const byModel = db.prepare(`SELECT model_name, COUNT(*) c, COALESCE(SUM(prompt_tokens),0) tin,
     COALESCE(SUM(completion_tokens),0) tout, COALESCE(SUM(total_tokens),0) tok, COALESCE(SUM(quota),0) q
     FROM logs WHERE ${where} GROUP BY model_name ORDER BY q DESC`).all(...v);
  const mSheet = [['模型', '请求次数', '输入token', '输出token', '总token', '消费(USD)']];
  let mR = 0, mI = 0, mO = 0, mT = 0, mQ = 0;
  for (const r of byModel) { mSheet.push([r.model_name || '-', r.c, r.tin, r.tout, r.tok, usd(r.q)]); mR += r.c; mI += r.tin; mO += r.tout; mT += r.tok; mQ += r.q; }
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

  return { agg, rc, span, dw, dv, mSheet, cSheet, rwSheet, rwSheet2, usd };
}

function run() {
  let input = '';
  process.stdin.on('data', d => { input += d.toString('utf8'); });
  process.stdin.on('end', async () => {
    let cfg;
    try { cfg = JSON.parse(input); } catch (e) { send({ t: 'error', message: 'bad cfg: ' + e.message }); process.exit(1); }
    const Q = cfg.quotaPerUsd || 500000;
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xlsx-multi-'));
    const db = new DatabaseSync(cfg.dbPath, { readOnly: true });
    db.exec('PRAGMA busy_timeout = 20000;');

    try {
      if (mode === 'settle-single') {
        const u = db.prepare('SELECT * FROM users WHERE id=?').get(cfg.userId);
        if (!u) throw new Error('用户不存在: ' + cfg.userId);
        const { agg, rc, span, dw, dv, mSheet, cSheet, rwSheet, rwSheet2, usd } = settleSummaries(db, u, cfg.since, cfg.until, Q);
        const cap = cfg.limit || 500000;

        const detailCount = db.prepare(`SELECT COUNT(*) c FROM logs WHERE ${dw}`).get(...dv).c;
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
        db.close();

        const header = ['时间', '类型', '模型', '渠道', '令牌', '输入token', '输出token', '总token', '消费(USD)', '耗时(秒)', '流式', '状态', '错误', '来源IP'];
        const parts = await runShards(cfg, {
          header, where: dw, params: dv, cap, mode: 'settle-detail', tmpDir, quotaPerUsd: Q,
        });

        const sumBufs = [
          { data: Buffer.from(sheetXml(info), 'utf8') },
          { data: Buffer.from(sheetXml(mSheet), 'utf8') },
          { data: Buffer.from(sheetXml(cSheet), 'utf8') },
          { data: Buffer.from(sheetXml(rwSheet.concat([['', ''], ['按用户', ''], ...rwSheet2])), 'utf8') },
        ];
        const names = ['结算概要', '按模型汇总', '按渠道汇总', '返佣汇总'];
        const total = parts.length;
        parts.forEach((p, i) => {
          sumBufs.push({ data: fs.readFileSync(p.file), precomp: true, rawSize: p.rawSize, crc: p.crc });
          // 【修复 2026-10-21】sheet 名禁用字符 \ / ? * [ ] : —— 原先用 "1/2" 导致 Excel 报文件损坏
          names.push(sheetName(total > 1 ? '调用明细' : '调用明细', i + 1, total));
          fs.unlinkSync(p.file);
        });
        const bytes = assemble(names, sumBufs, outFile);
        fs.rmSync(tmpDir, { recursive: true, force: true });
        send({ t: 'done', bytes, rows: parts.reduce((a, p) => a + p.rows, 0) });
        process.exit(0);
      }

      if (mode === 'usage') {
        const since = cfg.since || 0, until = cfg.until || 0;
        const cond = [], v = [];
        if (cfg.userId) { cond.push('user_id=?'); v.push(cfg.userId); }
        cond.push('created_at>=?'); v.push(since);
        if (until) { cond.push('created_at<=?'); v.push(until); }
        const whereR = cond.join(' AND ');

        const summary = db.prepare(`SELECT user_id, username, token_id, token_name, model_name,
             COUNT(*) AS req_count,
             COALESCE(SUM(prompt_tokens),0) AS prompt_tokens,
             COALESCE(SUM(completion_tokens),0) AS completion_tokens,
             COALESCE(SUM(total_tokens),0) AS total_tokens,
             COALESCE(SUM(quota),0) AS quota
          FROM logs WHERE ${whereR}
          GROUP BY user_id, username, token_id, token_name, model_name
          ORDER BY user_id, token_id, model_name`).all(...v);
        const yuan = q => '¥' + ((q || 0) / Q).toFixed(6);
        const sum = [['用户', '用户ID', '令牌名称', '令牌ID', '模型', '请求次数', '输入token数', '输出token数', '总token数', '消费金额']];
        let tReq = 0, tIn = 0, tOut = 0, tTok = 0, tQ = 0;
        for (const s of summary) {
          sum.push([s.username, String(s.user_id), s.token_name || '-', String(s.token_id || ''), s.model_name,
            s.req_count, s.prompt_tokens, s.completion_tokens, s.total_tokens, yuan(s.quota)]);
          tReq += s.req_count; tIn += s.prompt_tokens; tOut += s.completion_tokens; tTok += s.total_tokens; tQ += s.quota;
        }
        sum.push(['合计', '', '', '', '', tReq, tIn, tOut, tTok, yuan(tQ)]);
        db.close();

        const dw = `${whereR} AND log_type='consume'`;
        const header = ['时间', '类型', '用户', '用户ID', '令牌名称', '模型', '输入token数', '缓存读token数', '未命中token数', '命中率', '输出token数', '花费金额', '用时(秒)', '流式'];
        const parts = await runShards(cfg, { header, where: dw, params: v, cap: cfg.limit || 500000, mode: 'usage-detail', tmpDir, quotaPerUsd: Q });

        const bufs = [{ data: Buffer.from(sheetXml(sum), 'utf8') }];
        const names = ['按模型汇总'];
        const total = parts.length;
        const baseName = cfg.all ? '全部明细' : '使用日志';
        parts.forEach((p, i) => {
          bufs.push({ data: fs.readFileSync(p.file), precomp: true, rawSize: p.rawSize, crc: p.crc });
          names.push(sheetName(baseName, i + 1, total));
          fs.unlinkSync(p.file);
        });
        const bytes = assemble(names, bufs, outFile);
        fs.rmSync(tmpDir, { recursive: true, force: true });
        send({ t: 'done', bytes, rows: parts.reduce((a, p) => a + p.rows, 0) });
        process.exit(0);
      }

      throw new Error('unknown mode: ' + mode);
    } catch (e) {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
      send({ t: 'error', message: (e && e.stack) || String(e) });
      process.exit(1);
    }
  });
}

process.on('uncaughtException', (e) => { send({ t: 'error', message: (e && e.stack) || String(e) }); process.exit(1); });
run();
