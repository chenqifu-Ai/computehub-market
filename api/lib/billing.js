/**
 * billing.js — 计费引擎
 * quota 计价：quota = USD * QUOTA_PER_USD (500000)
 * 价格表：pricing.json（USD / 1M tokens），未列出的模型走默认价
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const QUOTA_PER_USD = 500000;
const PRICING_PATH = path.join(__dirname, '..', 'pricing.json');
const DEFAULT_PRICE = { input: 0.5, output: 1.5 };
// _comment 等非模型键，遍历时必须跳过
const META_KEYS = new Set(['_comment', '_note', '_readme', 'default']);

let PRICING = {};
let DEF = DEFAULT_PRICE;

/** 读盘（启动时 + 改价后热重载），返回是否成功 */
function reload() {
  try {
    const raw = JSON.parse(fs.readFileSync(PRICING_PATH, 'utf8'));
    const clean = {};
    for (const [k, v] of Object.entries(raw)) {
      if (k === 'default') continue;
      if (META_KEYS.has(k)) { clean[k] = v; continue; }   // 保留注释原文，写回时不丢
      if (v && typeof v === 'object' && Number.isFinite(+v.input) && Number.isFinite(+v.output)) {
        clean[k] = { input: +v.input, output: +v.output };
      }
    }
    PRICING = clean;
    DEF = (raw.default && Number.isFinite(+raw.default.input))
      ? { input: +raw.default.input, output: +raw.default.output }
      : DEFAULT_PRICE;
    return true;
  } catch {
    PRICING = {}; DEF = DEFAULT_PRICE;
    return false;
  }
}
reload();

// 单位：USD / 1M tokens
function priceOf(model) {
  const p = PRICING[model] || PRICING[String(model || '').toLowerCase()];
  return { input: p?.input ?? DEF.input, output: p?.output ?? DEF.output };
}

/** 是否显式定价（区别于走 default） */
function isPriced(model) {
  return !!(PRICING[model] || PRICING[String(model || '').toLowerCase()]);
}

/** 全部显式定价（不含 default / 注释），按模型名排序 */
function allPrices() {
  return Object.keys(PRICING).filter(k => !META_KEYS.has(k)).sort()
    .map(model => ({ model, input: PRICING[model].input, output: PRICING[model].output }));
}

/**
 * 设置/更新单模型价格（USD / 1M tokens）并落盘 + 热重载
 * @returns {{ok:boolean, model?:string, input?:number, output?:number, error?:string}}
 */
function setPrice(model, input, output) {
  model = String(model || "").trim();
  if (!model) return { ok: false, error: '模型名不能为空' };
  if (META_KEYS.has(model)) return { ok: false, error: `「${model}」是保留名，不能定价` };
  const i = Number(input), o = Number(output);
  if (!Number.isFinite(i) || !Number.isFinite(o)) return { ok: false, error: '价格必须是数字' };
  if (i < 0 || o < 0) return { ok: false, error: '价格不能为负' };
  if (i > 10000 || o > 10000) return { ok: false, error: '价格过大（上限 10000 USD/1M）' };

  let raw = {};
  try { raw = JSON.parse(fs.readFileSync(PRICING_PATH, 'utf8')); } catch { raw = {}; }
  raw[model] = { input: i, output: o };
  if (!raw.default) raw.default = { ...DEFAULT_PRICE };
  try {
    fs.writeFileSync(PRICING_PATH, JSON.stringify(raw, null, 2) + '\n');
  } catch (e) {
    return { ok: false, error: '写盘失败: ' + e.message };
  }
  reload();
  return { ok: true, model, input: i, output: o };
}

/** 删除某模型定价（回落 default） */
function deletePrice(model) {
  model = String(model || "").trim();
  if (!model || META_KEYS.has(model)) return { ok: false, error: '非法的模型名' };
  let raw = {};
  try { raw = JSON.parse(fs.readFileSync(PRICING_PATH, 'utf8')); } catch { return { ok: false, error: '价格表读取失败' }; }
  if (!(model in raw)) return { ok: false, error: '该模型没有显式定价' };
  delete raw[model];
  try { fs.writeFileSync(PRICING_PATH, JSON.stringify(raw, null, 2) + '\n'); }
  catch (e) { return { ok: false, error: '写盘失败: ' + e.message }; }
  reload();
  return { ok: true, model };
}

// 估算文本 token 数（无 usage 时的兜底）：中日韩 ~1 token/字，英文 ~1 token/4 字符
function estimateTokens(text) {
  if (!text) return 0;
  const s = String(text);
  let cjk = 0;
  for (const ch of s) {
    const c = ch.codePointAt(0);
    if ((c >= 0x4e00 && c <= 0x9fff) || (c >= 0x3040 && c <= 0x30ff) || (c >= 0xac00 && c <= 0xd7af)) cjk++;
  }
  const other = s.length - cjk;
  return Math.ceil(cjk * 1.0 + other / 4);
}

// 从上游响应解析 usage
function parseUsage(obj) {
  const u = obj && (obj.usage || obj.data?.usage);
  if (!u) return null;
  const prompt = u.prompt_tokens ?? u.input_tokens ?? 0;
  const completion = u.completion_tokens ?? u.output_tokens ?? 0;
  const total = u.total_tokens ?? (prompt + completion);
  return { prompt, completion, total };
}

// 计算 quota
function computeQuota(model, prompt, completion) {
  const p = priceOf(model);
  const usd = (prompt / 1e6) * p.input + (completion / 1e6) * p.output;
  return Math.max(0, Math.round(usd * QUOTA_PER_USD));
}

// quota → 展示美元
function quotaToUsd(q) {
  return q / QUOTA_PER_USD;
}

module.exports = {
  QUOTA_PER_USD, PRICING_PATH,
  priceOf, isPriced, allPrices, setPrice, deletePrice, reload,
  estimateTokens, parseUsage, computeQuota, quotaToUsd,
  get PRICING() { return PRICING; },
  get DEFAULT() { return DEF; },
};
