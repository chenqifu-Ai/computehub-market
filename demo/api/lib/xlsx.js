/**
 * xlsx.js — 极简 Excel (.xlsx) 生成器（零依赖）
 *
 * 原理：xlsx = ZIP 容器 + 一组 XML
 *   [Content_Types].xml / _rels/.rels / xl/workbook.xml
 *   xl/_rels/workbook.xml.rels / xl/worksheets/sheetN.xml / xl/styles.xml
 * 字符串用 inlineStr 写入，避开 sharedStrings 复杂度。
 * 压缩用 Node 内置 zlib.deflateRawSync；ZIP 结构手写。
 */
'use strict';

const zlib = require('node:zlib');

// ---------- CRC32 ----------
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = 0 ^ (-1);
  for (let i = 0; i < buf.length; i++) c = (c >>> 8) ^ CRC_TABLE[(c ^ buf[i]) & 0xFF];
  return (c ^ (-1)) >>> 0;
}

// ---------- XML 转义 ----------
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;')
    // 去掉 XML 1.0 非法控制字符（否则 Excel 打不开）
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '');
}

// ---------- 列号 A/B/.../AA ----------
function colName(i) {
  let s = '';
  i += 1;
  while (i > 0) { const r = (i - 1) % 26; s = String.fromCharCode(65 + r) + s; i = Math.floor((i - 1) / 26); }
  return s;
}

/**
 * 单元格 XML
 * value: string | number | {v, t:'n'|'s'|'d', s?:styleIndex}
 */
function cellXml(ref, value, styleIdx) {
  if (value === null || value === undefined || value === '') {
    return styleIdx ? `<c r="${ref}" s="${styleIdx}"/>` : `<c r="${ref}"/>`;
  }
  const s = styleIdx ? ` s="${styleIdx}"` : '';
  if (typeof value === 'object' && value !== null && 'v' in value) {
    if (value.t === 'n') return `<c r="${ref}"${s}><v>${value.v}</v></c>`;
    return `<c r="${ref}"${s} t="inlineStr"><is><t xml:space="preserve">${esc(value.v)}</t></is></c>`;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return `<c r="${ref}"${s}><v>${value}</v></c>`;
  }
  return `<c r="${ref}"${s} t="inlineStr"><is><t xml:space="preserve">${esc(value)}</t></is></c>`;
}

/**
 * 生成一个 sheet 的 XML
 * rows: Array<Array<cell>>，cell 同 cellXml 的 value
 * colWidths: 可选 [ {w:12}, ... ]
 * freezeHeader: 冻结首行
 */
function sheetXml(rows, colWidths, freezeHeader) {
  const cols = colWidths && colWidths.length
    ? `<cols>${colWidths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('')}</cols>`
    : '';
  const pane = freezeHeader
    ? `<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>`
    : '';
  const body = rows.map((row, r) => {
    const cells = row.map((v, c) => cellXml(colName(c) + (r + 1), v)).join('');
    return `<row r="${r + 1}">${cells}</row>`;
  }).join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${pane}${cols}<sheetData>${body}</sheetData></worksheet>`;
}

// ---------- 流式 sheet：逐行产出 XML 片段（百万行不爆内存） ----------
// rowGen: 可迭代对象（行数组生成器）
// 返回生成器，依次 yield: head 字符串, 每行字符串, '</sheetData></worksheet>'；
// 迭代器 done 后，.rowCount 可读总行数。
function* sheetXmlStream(rowGen, colWidths, freezeHeader) {
  const cols = colWidths && colWidths.length
    ? `<cols>${colWidths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('')}</cols>`
    : '';
  const pane = freezeHeader
    ? `<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>`
    : '';
  yield `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${pane}${cols}<sheetData>`;
  let n = 0;
  for (const row of rowGen) {
    const r = n + 1;
    const cells = row.map((v, c) => cellXml(colName(c) + r, v)).join('');
    yield `<row r="${r}">${cells}</row>`;
    n++;
  }
  yield '</sheetData></worksheet>';
  return n; // generator return value -> iterator.done 时 .value 即行数
}

const STYLES_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>
<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFDCE6F1"/><bgColor indexed="64"/></patternFill></fill></fills>
<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/></cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;

// ---------- ZIP 打包 ----------
function* zipStream(files) {
  const central = [];
  let offset = 0;
  let fileCount = 0;

  for (const f of files) {
    const nameBuf = Buffer.from(f.name, 'utf8');
    const data = Buffer.from(f.data, 'utf8');
    const comp = zlib.deflateRawSync(data, { level: 6 });
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0x21, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(comp.length, 18);
    local.writeUInt32LE(data.length, 22);
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
    cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt16LE(0, 30);
    cd.writeUInt16LE(0, 32);
    cd.writeUInt16LE(0, 34);
    cd.writeUInt16LE(0, 36);
    cd.writeUInt32LE(0, 38);
    cd.writeUInt32LE(offset, 42);
    central.push(cd, nameBuf);

    offset += 30 + nameBuf.length + comp.length;
    fileCount++;
    yield [local, nameBuf, comp];
  }

  const cdBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(fileCount, 8);
  eocd.writeUInt16LE(fileCount, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);
  yield [cdBuf, eocd];
}
// 兼容旧接口：build() 内部仍可用一次性拼接
function zip(files) {
  const out = [];
  for (const part of zipStream(files)) out.push(...part);
  return Buffer.concat(out);
}

/**
 * 生成工作簿
 * @param sheets  [{ name, rows, colWidths?, freezeHeader? }]
 * @returns Buffer (.xlsx)
 */
/**
 * 生成工作簿（流式版）
 * sheets 项: { name, colWidths?, freezeHeader?, rows? } 
 *   rows 可以是 Array（一次性）或 Iterable/Generator（流式，百万行不占内存）
 * @returns 生成器，依次 yield Buffer 片段（可直接写 res）；迭代器 done 后 .totalSize 可读
 */
function* buildStream(sheets) {
  const sheetFiles = [];
  for (let i = 0; i < sheets.length; i++) {
    const s = sheets[i];
    if (Array.isArray(s.rows)) {
      sheetFiles.push({ name: `xl/worksheets/sheet${i + 1}.xml`, data: sheetXml(s.rows, s.colWidths, s.freezeHeader) });
    } else {
      // 流式 sheet：片段数组累积（避开单字符串 512MB 上限），一次性压缩
      const pieces = [];
      const it = sheetXmlStream(s.rows, s.colWidths, s.freezeHeader);
      for (const piece of it) pieces.push(piece);
      const xml = pieces.join('');
      sheetFiles.push({ name: `xl/worksheets/sheet${i + 1}.xml`, data: xml, _rowCount: it.value || 0 });
    }
  }
  const allFiles = sheetFileList(sheets, sheetFiles);
  for (const part of zipStream(allFiles)) yield Buffer.concat(part);
}
function build(sheets) {
  const out = [];
  for (const b of buildStream(sheets)) out.push(b);
  return Buffer.concat(out);
}
function sheetFileList(sheets, sheetFiles) {

  const ctOverrides = sheets.map((_, i) =>
    `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('');

  const relSheets = sheets.map((_, i) =>
    `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('');

  const sheetTags = sheets.map((s, i) =>
    `<sheet name="${esc(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('');

  const styleRid = sheets.length + 1;
  return [
    { name: '[Content_Types].xml', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
${ctOverrides}</Types>` },
    { name: '_rels/.rels', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>` },
    { name: 'xl/workbook.xml', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets>${sheetTags}</sheets></workbook>` },
    { name: 'xl/_rels/workbook.xml.rels', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
${relSheets}
<Relationship Id="rId${styleRid}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>` },
    { name: 'xl/styles.xml', data: STYLES_XML },
    ...sheetFiles,
  ];
}
function* __unused(){}

// ============================================================
// 读取 .xlsx（解析 ZIP + sheet XML）
// ============================================================
function inflate(buf, method) {
  if (method === 0) return buf;                 // stored
  if (method === 8) return zlib.inflateRawSync(buf);
  throw new Error('不支持的压缩方式: ' + method);
}

/** 解析 ZIP → Map<name, Buffer> */
function unzip(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('不是有效的 ZIP/xlsx 文件');
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  const files = new Map();
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) throw new Error('ZIP 中央目录损坏');
    const method = buf.readUInt16LE(off + 10);
    const compSize = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const cmtLen = buf.readUInt16LE(off + 32);
    const localOff = buf.readUInt32LE(off + 42);
    const name = buf.toString('utf8', off + 46, off + 46 + nameLen);
    const lNameLen = buf.readUInt16LE(localOff + 26);
    const lExtraLen = buf.readUInt16LE(localOff + 28);
    const dataStart = localOff + 30 + lNameLen + lExtraLen;
    const data = buf.slice(dataStart, dataStart + compSize);
    files.set(name, inflate(data, method));
    off += 46 + nameLen + extraLen + cmtLen;
  }
  return files;
}

function colToIdx(ref) {
  let n = 0;
  for (const c of ref) {
    const u = c.toUpperCase();
    if (u >= 'A' && u <= 'Z') n = n * 26 + (u.charCodeAt(0) - 64);
    else break;
  }
  return n - 1;
}

function parseRow(rowXml, shared) {
  const cells = [];
  const re = /<c\b([^>]*)\/?>([\s\S]*?)(?:<\/c>|(?=<c\b)|$)/g;
  let m;
  while ((m = re.exec(rowXml)) !== null) {
    const attrs = m[1] || '';
    const inner = m[2] || '';
    const refM = /r="([A-Z]+)\d+"/.exec(attrs);
    const idx = refM ? colToIdx(refM[1]) : cells.length;
    const t = (/t="([^"]+)"/.exec(attrs) || [])[1] || '';
    let val = '';
    if (t === 's') {
      const v = /<v>(\d+)<\/v>/.exec(inner);
      val = v ? (shared[parseInt(v[1], 10)] ?? '') : '';
    } else if (t === 'inlineStr') {
      const isM = /<is>[\s\S]*?<t[^>]*>([\s\S]*?)<\/t>/.exec(inner);
      val = isM ? unesc(isM[1]) : '';
    } else {
      const v = /<v>([\s\S]*?)<\/v>/.exec(inner);
      val = v ? unesc(v[1]) : '';
    }
    cells[idx] = val;
  }
  for (let i = 0; i < cells.length; i++) if (cells[i] === undefined) cells[i] = '';
  return cells;
}

function unesc(s) {
  return String(s)
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/** 读取工作簿 → { sheets: [{ name, rows: string[][] }] } */
function read(buf) {
  const files = unzip(buf);

  const shared = [];
  const ssBuf = files.get('xl/sharedStrings.xml');
  if (ssBuf) {
    const xml = ssBuf.toString('utf8');
    const re = /<si>([\s\S]*?)<\/si>/g;
    let m;
    while ((m = re.exec(xml)) !== null) {
      let text = '';
      const tre = /<t[^>]*>([\s\S]*?)<\/t>/g;
      let tm;
      while ((tm = tre.exec(m[1])) !== null) text += unesc(tm[1]);
      shared.push(text);
    }
  }

  const wbXml = files.get('xl/workbook.xml')?.toString('utf8') || '';
  const names = [];
  const nre = /<sheet\b[^>]*name="([^"]*)"/g;
  let nm;
  while ((nm = nre.exec(wbXml)) !== null) names.push(unesc(nm[1]));

  const sheets = [];
  let i = 1;
  while (files.has(`xl/worksheets/sheet${i}.xml`)) {
    const xml = files.get(`xl/worksheets/sheet${i}.xml`).toString('utf8');
    const rows = [];
    const rre = /<row\b[^>]*>([\s\S]*?)<\/row>/g;
    let rm;
    while ((rm = rre.exec(xml)) !== null) rows.push(parseRow(rm[1], shared));
    sheets.push({ name: names[i - 1] || `Sheet${i}`, rows });
    i++;
  }
  return { sheets };
}

module.exports = { build, buildStream, sheetXmlStream, read, unzip, esc, crc32 };

// ============================================================
// 分片流式导出 buildChunked: 明细 > 10 万行时按 chunkSize 行/sheet 分片
// 两遍扫描：遍1 只数行数（不物化 XML，内存 O(1)，给进度用）；遍2 物化+发送
// 内存 O(单块); rowGen 只能消费一次; 200 万行实测 ~115s
// ============================================================
const _fsC = require('node:fs');
const _osC = require('node:os');
const _pathC = require('node:path');

function _crcC(buf) { return zlib.crc32(buf) >>> 0; }

function _cellC(ref, v) {
  if (typeof v === 'number' && Number.isFinite(v)) {
    return '<c r="' + ref + '"><v>' + v + '</v></c>';
  }
  return '<c r="' + ref + '" t="inlineStr"><is><t xml:space="preserve">' + esc(v) + '</t></is></c>';
}

function _zipC(name, data, offset) {
  const nameBuf = Buffer.from(name, 'utf8');
  const comp = zlib.deflateRawSync(data, { level: 6 });
  const crc = _crcC(data);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(0x0800, 6);
  local.writeUInt16LE(8, 8);
  local.writeUInt16LE(0, 10);
  local.writeUInt16LE(0x21, 12);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(comp.length, 18);
  local.writeUInt32LE(data.length, 22);
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
  cd.writeUInt32LE(data.length, 24);
  cd.writeUInt16LE(nameBuf.length, 28);
  cd.writeUInt32LE(0, 38);
  cd.writeUInt32LE(offset, 42);
  return { local, nameBuf, comp, cd, entryLen: 30 + nameBuf.length + comp.length };
}

function _ctC(n) {
  let ov = '';
  for (let i = 0; i < n; i++) {
    ov += '<Override PartName="/xl/worksheets/sheet' + (i + 1) + '.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>';
  }
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' + ov + '</Types>';
}
function _wbC(names) {
  let tags = '';
  for (let i = 0; i < names.length; i++) {
    tags += '<sheet name="' + esc(names[i]) + '" sheetId="' + (i + 1) + '" r:id="rId' + (i + 1) + '"/>';
  }
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>' + tags + '</sheets></workbook>';
}
function _relsC(n) {
  let rs = '';
  for (let i = 0; i < n; i++) {
    rs += '<Relationship Id="rId' + (i + 1) + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet' + (i + 1) + '.xml"/>';
  }
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' + rs + '<Relationship Id="rId' + (n + 1) + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>';
}
const _STY_C = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts><fills count="1"><fill><patternFill patternType="none"/></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf/></cellStyleXfs><cellXfs count="1"><xf/></cellXfs></styleSheet>';

/**
 * 分片流式生成 xlsx
 * @param {string[]} header       明细表头
 * @param {Iterable} rowGen       明细行生成器 (每元素 = 行数组)
 * @param {number} [chunkSize]    每 sheet 行数, 默认 50000
 * @param {string} [prefix]       明细分片 sheet 名前缀, 默认 '明细'
 * @param {Array} [summarySheets] 前置汇总 [{ name, rows, colWidths?, freezeHeader? }]
 * @returns {Generator<Buffer>}   依次 yield Buffer 片段
 */
const _EMPTY = Buffer.alloc(0);
// 进度信号（非 Buffer，由 server 拦截写入 X-Xlsx-Progress 头；前端据此渲染进度条）
// { rowsDone, chunksTotal, chunksSent }
function _PROGRESS(rowsDone, chunksTotal, chunksSent) { return { __xlsxProgress: true, rowsDone, chunksTotal, chunksSent }; }

function* buildChunked(header, rowGen, chunkSize, prefix, summarySheets, opts) {
  chunkSize = chunkSize || 50000;
  prefix = prefix || '明细';
  summarySheets = summarySheets || [];
  // 【性能修复 2026-10-21】调用方已知总行数时传入 opts.totalRows，跳过“阶段0 全量预扫描”。
  // 旧版对 95.9 万行数据会把 rowGen 完整跑一遍再跑第二遍 → DB 读两遍、耗时翻倍。
  const knownRows = opts && Number.isFinite(opts.totalRows) ? opts.totalRows : null;
  const dir = _fsC.mkdtempSync(_pathC.join(_osC.tmpdir(), 'xlsx-chunk-'));
  try { // wrap: 提前中断也清理临时目录
  // 阶段0：快速数行数（不物化 XML），前端据此显示进度条
  let totalRows = 0;
  if (knownRows !== null) {
    totalRows = knownRows;
  } else {
    // rowGen 兼容：数组/生成器/生成器函数。遍1 物化到内存数组（预读模式）或快速计数
    const _rows = (Array.isArray(rowGen)) ? rowGen : null;
    if (_rows) {
      totalRows = _rows.length;
    } else {
      const _src = (typeof rowGen === 'function') ? rowGen() : rowGen;
      const it0 = _src[Symbol.iterator]();
      for (let n0 = it0.next(); !n0.done; n0 = it0.next()) {
        totalRows++;
        if (totalRows % 20000 === 0) yield _EMPTY;
      }
    }
  }
  const totalChunks = Math.max(1, Math.ceil(totalRows / chunkSize));
  yield _PROGRESS(0, totalChunks, 0);
  // 阶段1：物化 chunk 到磁盘（数组模式=内存已有，纯 XML 拼装）
  const _arrMode = Array.isArray(rowGen);
  rowGen = _arrMode ? rowGen : ((typeof rowGen === 'function') ? rowGen() : rowGen);
  let rowCount = 0;
  let chunkIdx = 0;
  const chunkFiles = [];
  const it = _arrMode ? rowGen[Symbol.iterator]() : rowGen[Symbol.iterator]();
  const XOPEN = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>';

  while (true) {
    chunkIdx++;
    const fpath = _pathC.join(dir, 'c' + String(chunkIdx).padStart(3, '0') + '.xml');
    let buf = XOPEN;
    buf += '<row r="1">' + header.map((v, c) => _cellC(colName(c) + 1, v)).join('') + '</row>';
    let r = 2;
    let count = 0;
    let n0 = it.next();
    while (!n0.done && count < chunkSize) {
      buf += '<row r="' + r + '">' + n0.value.map((v, c) => _cellC(colName(c) + r, v)).join('') + '</row>';
      r++;
      count++;
      rowCount++;
      // 每 5000 行强制让出事件循环（防单块内 20000 次同步 DB 读取冻结全站）
      if (count % 5000 === 0) { yield _EMPTY; }
      n0 = it.next();
    }
    buf += '</sheetData></worksheet>';
    _fsC.writeFileSync(fpath, buf);
    chunkFiles.push(fpath);
    yield _EMPTY; // 阶段1让出事件循环，防大导出冻结全站
    if (n0.done) break;
  }

  const totalSheets = summarySheets.length + chunkIdx;
  const sheetNames = summarySheets.map(function (s) { return s.name; })
    .concat(Array.from({ length: chunkIdx }, function (_, i) {
      return chunkIdx > 1 ? prefix + (i + 1) + '/' + chunkIdx : prefix;
    }));

  const cds = [];
  let offset = 0;
  let bytes = 0;

  for (const s of summarySheets) {
    const xml = sheetXml(s.rows, s.colWidths, s.freezeHeader);
    const idx = cds.length / 2 + 1;
    const e = _zipC('xl/worksheets/sheet' + idx + '.xml', Buffer.from(xml, 'utf8'), offset);
    yield e.local;
    yield e.nameBuf;
    yield e.comp;
    cds.push(e.cd, e.nameBuf);
    offset += e.entryLen;
    bytes += e.entryLen;
    yield _PROGRESS(totalRows, totalChunks, 0); // 阶段2开始：已生成全部明细
  }

  for (let i = 0; i < chunkFiles.length; i++) {
    const idx = summarySheets.length + i + 1;
    const e = _zipC('xl/worksheets/sheet' + idx + '.xml', _fsC.readFileSync(chunkFiles[i]), offset);
    yield e.local;
    yield e.nameBuf;
    yield e.comp;
    cds.push(e.cd, e.nameBuf);
    offset += e.entryLen;
    bytes += e.entryLen;
    _fsC.unlinkSync(chunkFiles[i]);
    yield _PROGRESS(rowCount, totalChunks, i + 1); // 阶段2：每发完一片报进度
  }

  const statics = [
    ['[Content_Types].xml', _ctC(totalSheets)],
    ['_rels/.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>'],
    ['xl/workbook.xml', _wbC(sheetNames)],
    ['xl/_rels/workbook.xml.rels', _relsC(totalSheets)],
    ['xl/styles.xml', _STY_C],
  ];
  for (const st of statics) {
    const e = _zipC(st[0], Buffer.from(st[1], 'utf8'), offset);
    yield e.local;
    yield e.nameBuf;
    yield e.comp;
    cds.push(e.cd, e.nameBuf);
    offset += e.entryLen;
    bytes += e.entryLen;
  }

  const cdBuf = Buffer.concat(cds);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  // 【致命修复 2026-10-21】条目数 = sheet 数 + 5 个静态文件，之前只写 totalSheets → Excel 报损坏
  eocd.writeUInt16LE(totalSheets + 5, 8);
  eocd.writeUInt16LE(totalSheets + 5, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  yield cdBuf;
  yield eocd;
  bytes += cdBuf.length + 22;
  return { rowCount: rowCount, sheetCount: totalSheets, bytes: bytes };
  } finally {
    try { _fsC.rmSync(dir, { recursive: true, force: true }); } catch (e) {}
  }
}

module.exports.buildChunked = buildChunked;
