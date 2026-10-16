#!/usr/bin/env node
/** settle.js — 给每个用户生成结算清单（Excel）
 *  输出: logs/settle/ 下每人一个 xlsx + 一份汇总总表
 */
const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');
const xlsx = require('./lib/xlsx');

const DB = path.join(__dirname, 'api.db');
const OUT = path.join(__dirname, 'logs', 'settle');
fs.mkdirSync(OUT, { recursive: true });
const db = new DatabaseSync(DB);

const pad2 = n => String(n).padStart(2, '0');
const fmtTs = ms => { const d = new Date(ms); return `${d.getFullYear()}-${pad2(d.getMonth()+1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`; };
const usd = q => (q / 500000);                       // 数值, 用于计算
const usdS = q => '$' + (q / 500000).toFixed(6);
const TYPE = { consume:'消费', recharge:'充值', reward:'返利', system:'系统', admin:'管理' };

const users = db.prepare('SELECT * FROM users ORDER BY id').all();
const grand = { req:0, ok:0, err:0, tin:0, tout:0, tok:0, q:0, recharge:0 };

// ---- 汇总总表 ----
const masterHead = ['用户ID','用户名','角色','状态','注册时间','请求次数','成功','失败','输入token','输出token','总token','累计消费(USD)','累计充值(USD)','当前余额(USD)'];
const master = [masterHead];

for (const u of users) {
  const agg = db.prepare(`SELECT COUNT(*) c,
      SUM(CASE WHEN status='success' THEN 1 ELSE 0 END) ok,
      SUM(CASE WHEN status!='success' THEN 1 ELSE 0 END) err,
      COALESCE(SUM(prompt_tokens),0) tin, COALESCE(SUM(completion_tokens),0) tout,
      COALESCE(SUM(total_tokens),0) tok, COALESCE(SUM(quota),0) q
    FROM logs WHERE user_id=?`).get(u.id);
  const recharge = db.prepare(`SELECT COALESCE(SUM(quota),0) q FROM logs WHERE user_id=? AND log_type='recharge'`).get(u.id).q;
  grand.req += agg.c; grand.ok += agg.ok||0; grand.err += agg.err||0;
  grand.tin += agg.tin; grand.tout += agg.tout; grand.tok += agg.tok; grand.q += agg.q; grand.recharge += recharge;

  master.push([
    String(u.id), u.username, u.role===100?'管理员':'用户', u.status===1?'启用':'禁用',
    fmtTs(u.created_at), agg.c, agg.ok||0, agg.err||0,
    agg.tin, agg.tout, agg.tok, usdS(agg.q), usdS(recharge), usdS(u.quota),
  ]);

  // ---- 每人一个结算清单 ----
  const logs = db.prepare('SELECT * FROM logs WHERE user_id=? ORDER BY created_at ASC').all(u.id);

  // Sheet A: 结算概要
  const first = logs.length ? logs[0].created_at : u.created_at;
  const last  = logs.length ? logs[logs.length-1].created_at : u.created_at;
  const info = [
    ['结算清单', ''],
    ['用户名', u.username],
    ['用户ID', String(u.id)],
    ['角色', u.role===100?'管理员':'用户'],
    ['状态', u.status===1?'启用':'禁用'],
    ['注册时间', fmtTs(u.created_at)],
    ['账期', logs.length ? `${fmtTs(first)} ~ ${fmtTs(last)}` : '(无调用记录)'],
    ['', ''],
    ['结算项目', '金额(USD)'],
    ['累计充值', usdS(recharge)],
    ['累计消费', usdS(agg.q)],
    ['当前余额', usdS(u.quota)],
    ['', ''],
    ['调用统计', ''],
    ['请求总数', String(agg.c)],
    ['成功', String(agg.ok||0)],
    ['失败', String(agg.err||0)],
    ['输入token', String(agg.tin)],
    ['输出token', String(agg.tout)],
    ['总token', String(agg.tok)],
    ['生成时间', fmtTs(Date.now())],
  ];

  // Sheet B: 调用明细
  const detail = [['时间','类型','模型','渠道','令牌','输入token','输出token','总token','消费(USD)','耗时(秒)','流式','状态','错误','来源IP']];
  for (const l of logs) {
    detail.push([
      fmtTs(l.created_at), TYPE[l.log_type]||l.log_type||'消费', l.model_name||'-', l.channel_name||'-', l.token_name||'-',
      l.prompt_tokens, l.completion_tokens, l.total_tokens, usdS(l.quota),
      Math.round(l.use_time||0), l.is_stream?'是':'否', l.status==='success'?'成功':'失败',
      (l.error||'').slice(0,80), l.ip||'',
    ]);
  }

  // Sheet C: 按模型汇总
  const byModel = db.prepare(`SELECT model_name, COUNT(*) c, COALESCE(SUM(prompt_tokens),0) tin,
     COALESCE(SUM(completion_tokens),0) tout, COALESCE(SUM(total_tokens),0) tok, COALESCE(SUM(quota),0) q
     FROM logs WHERE user_id=? GROUP BY model_name ORDER BY q DESC`).all(u.id);
  const modelSheet = [['模型','请求次数','输入token','输出token','总token','消费(USD)']];
  let mR=0,mI=0,mO=0,mT=0,mQ=0;
  for (const r of byModel) { modelSheet.push([r.model_name, r.c, r.tin, r.tout, r.tok, usdS(r.q)]); mR+=r.c;mI+=r.tin;mO+=r.tout;mT+=r.tok;mQ+=r.q; }
  modelSheet.push(['合计', mR, mI, mO, mT, usdS(mQ)]);

  // Sheet D: 按渠道汇总
  const byCh = db.prepare(`SELECT channel_name, COUNT(*) c, COALESCE(SUM(total_tokens),0) tok, COALESCE(SUM(quota),0) q
     FROM logs WHERE user_id=? GROUP BY channel_name ORDER BY q DESC`).all(u.id);
  const chSheet = [['渠道','请求次数','总token','消费(USD)']];
  let cR=0,cT=0,cQ=0;
  for (const r of byCh) { chSheet.push([r.channel_name||'-', r.c, r.tok, usdS(r.q)]); cR+=r.c;cT+=r.tok;cQ+=r.q; }
  chSheet.push(['合计', cR, cT, usdS(cQ)]);

  const buf = xlsx.build([
    { name: '结算概要', rows: info, colWidths: [16, 40] },
    { name: '调用明细', rows: detail, colWidths: [19,8,22,24,14,11,11,11,13,8,6,7,40,16], freezeHeader: true },
    { name: '按模型汇总', rows: modelSheet, colWidths: [24,10,13,13,13,14], freezeHeader: true },
    { name: '按渠道汇总', rows: chSheet, colWidths: [26,10,13,14], freezeHeader: true },
  ]);
  const fname = `结算清单_${u.username}_${u.id}.xlsx`;
  fs.writeFileSync(path.join(OUT, fname), buf);
  console.log(`✅ ${fname.padEnd(40)} 日志${String(logs.length).padStart(4)}条 消费${usdS(agg.q)}`);
}

// ---- 写总表 ----
master.push(['合计','','','','', grand.req, grand.ok, grand.err, grand.tin, grand.tout, grand.tok,
  '$'+(grand.q/500000).toFixed(6), '$'+(grand.recharge/500000).toFixed(6), '']);
const mBuf = xlsx.build([{ name: '全部用户结算', rows: master, colWidths: [8,16,8,6,19,9,7,7,12,12,12,15,15,15], freezeHeader: true }]);
fs.writeFileSync(path.join(OUT, '结算清单_汇总总表.xlsx'), mBuf);

console.log('\n📊 汇总: 用户'+users.length+'个 | 请求'+grand.req+' | tokens'+grand.tok+' | 总消费$'+(grand.q/500000).toFixed(4));
console.log('📁 输出目录:', OUT);
