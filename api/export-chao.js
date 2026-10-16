#!/usr/bin/env node
/** export-chao.js — 导出超智(chao_work01)调用明细为 Excel */
const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');
const xlsx = require('./lib/xlsx');

const DB = path.join(__dirname, 'api.db');
const db = new DatabaseSync(DB);
const USER = process.argv[2] || 'chao_work01';

const pad2 = n => String(n).padStart(2, '0');
const fmtTs = ts => {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
};
const fmtYuan = q => '¥' + ((q || 0) / 500000).toFixed(6);  // 与平台一致: quota/500000 = ¥1:1

const u = db.prepare('SELECT id,username,quota,used_quota,request_count FROM users WHERE username=?').get(USER);
if (!u) { console.error('用户不存在:', USER); process.exit(1); }

const rows = db.prepare('SELECT * FROM logs WHERE user_id=? ORDER BY created_at ASC').all(u.id);

// Sheet1: 明细
const detail = [['时间','类型','用户','用户ID','令牌名称','模型','渠道','输入token数','输出token数','总token数','花费金额','耗时(秒)','流式','状态','来源IP','请求ID']];
for (const l of rows) {
  detail.push([
    fmtTs(l.created_at), l.log_type || 'consume', l.username, String(l.user_id),
    l.token_name || '', l.model_name || '', l.channel_name || '',
    l.prompt_tokens, l.completion_tokens, l.total_tokens,
    fmtYuan(l.quota), Math.round(l.use_time || 0), l.is_stream ? '是' : '否',
    l.status, l.ip || '', l.request_id || '',
  ]);
}

// Sheet2: 按模型汇总
const summary = db.prepare(`SELECT model_name, COUNT(*) req_count, SUM(prompt_tokens) pin,
  SUM(completion_tokens) pout, SUM(total_tokens) tok, SUM(quota) q,
  SUM(CASE WHEN status='success' THEN 1 ELSE 0 END) ok,
  SUM(CASE WHEN status!='success' THEN 1 ELSE 0 END) err
  FROM logs WHERE user_id=? GROUP BY model_name ORDER BY req_count DESC`).all(u.id);

const sum = [['模型','请求次数','成功','失败','输入token数','输出token数','总token数','消费金额']];
let tR=0,tI=0,tO=0,tT=0,tQ=0,tOk=0,tErr=0;
for (const s of summary) {
  sum.push([s.model_name, s.req_count, s.ok, s.err, s.pin, s.pout, s.tok, fmtYuan(s.q)]);
  tR+=s.req_count; tI+=s.pin; tO+=s.pout; tT+=s.tok; tQ+=s.q; tOk+=s.ok; tErr+=s.err;
}
sum.push(['合计', tR, tOk, tErr, tI, tO, tT, fmtYuan(tQ)]);

// Sheet3: 按渠道汇总
const chSum = db.prepare(`SELECT channel_name, COUNT(*) req_count, SUM(prompt_tokens) pin,
  SUM(completion_tokens) pout, SUM(total_tokens) tok, SUM(quota) q
  FROM logs WHERE user_id=? GROUP BY channel_name ORDER BY req_count DESC`).all(u.id);
const ch = [['渠道','请求次数','输入token数','输出token数','总token数','消费金额']];
let cR=0,cI=0,cO=0,cT=0,cQ=0;
for (const s of chSum) { ch.push([s.channel_name||'-', s.req_count, s.pin, s.pout, s.tok, fmtYuan(s.q)]); cR+=s.req_count;cI+=s.pin;cO+=s.pout;cT+=s.tok;cQ+=s.q; }
ch.push(['合计', cR, cI, cO, cT, fmtYuan(cQ)]);

// Sheet4: 账户概览
const info = [
  ['账户概览', ''],
  ['用户名', u.username],
  ['用户ID', String(u.id)],
  ['当前余额', fmtYuan(u.quota)],
  ['累计消费', fmtYuan(u.used_quota)],
  ['累计请求数', String(u.request_count)],
  ['本次导出条数', String(rows.length)],
  ['首条时间', rows.length ? fmtTs(rows[0].created_at) : '-'],
  ['末条时间', rows.length ? fmtTs(rows[rows.length-1].created_at) : '-'],
  ['导出时间', fmtTs(Date.now())],
];

const buf = xlsx.build([
  { name: '调用明细', rows: detail, colWidths: [19,8,12,8,14,22,24,12,12,12,14,10,6,8,16,26], freezeHeader: true },
  { name: '按模型汇总', rows: sum, colWidths: [24,10,8,8,13,13,13,14], freezeHeader: true },
  { name: '按渠道汇总', rows: ch, colWidths: [26,10,13,13,13,14], freezeHeader: true },
  { name: '账户概览', rows: info, colWidths: [16,24] },
]);

const d = new Date();
const stamp = `${d.getFullYear()}${pad2(d.getMonth()+1)}${pad2(d.getDate())}-${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}`;
const out = path.join(__dirname, 'logs', `chao-work01-usage-${stamp}.xlsx`);
require('node:fs').writeFileSync(out, buf);
console.log('✅ 已导出:', out);
console.log('   明细', rows.length, '条 | 模型', summary.length, '个 | 渠道', chSum.length, '个');
console.log('   合计: 请求', tR, '| 成功', tOk, '| 失败', tErr, '| tokens', tT, '| 消费', fmtYuan(tQ));
