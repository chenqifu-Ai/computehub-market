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
function zip(files) {
  const chunks = [];
  const central = [];
  let offset = 0;

  for (const f of files) {
    const nameBuf = Buffer.from(f.name, 'utf8');
    const data = Buffer.from(f.data, 'utf8');
    const comp = zlib.deflateRawSync(data, { level: 6 });
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);          // version needed
    local.writeUInt16LE(0x0800, 6);      // flags: UTF-8
    local.writeUInt16LE(8, 8);           // method: deflate
    local.writeUInt16LE(0, 10);          // time
    local.writeUInt16LE(0x21, 12);       // date (1980-01-01)
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(comp.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    chunks.push(local, nameBuf, comp);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);             // version made by
    cd.writeUInt16LE(20, 6);             // version needed
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

    offset += local.length + nameBuf.length + comp.length;
  }

  const cdBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...chunks, cdBuf, eocd]);
}

/**
 * 生成工作簿
 * @param sheets  [{ name, rows, colWidths?, freezeHeader? }]
 * @returns Buffer (.xlsx)
 */
function build(sheets) {
  const sheetFiles = sheets.map((s, i) => ({
    name: `xl/worksheets/sheet${i + 1}.xml`,
    data: sheetXml(s.rows, s.colWidths, s.freezeHeader),
  }));

  const ctOverrides = sheets.map((_, i) =>
    `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('');

  const relSheets = sheets.map((_, i) =>
    `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('');

  const sheetTags = sheets.map((s, i) =>
    `<sheet name="${esc(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('');

  const styleRid = sheets.length + 1;

  return zip([
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
  ]);
}

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

module.exports = { build, read, unzip, esc, crc32 };
