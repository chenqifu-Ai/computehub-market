/**
 * billing.js — 计费引擎
 * quota 计价：quota = USD * QUOTA_PER_USD (500000)
 * 价格表：pricing.json（USD / 1M tokens），未列出的模型走默认价
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const QUOTA_PER_USD = 500000;

let PRICING = {};
try {
  PRICING = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'pricing.json'), 'utf8'));
} catch { PRICING = { default: { input: 0.5, output: 1.5 } }; }
const DEF = PRICING.default || { input: 0.5, output: 1.5 };

// 单位：USD / 1M tokens
function priceOf(model) {
  const p = PRICING[model] || PRICING[String(model || '').toLowerCase()];
  return { input: p?.input ?? DEF.input, output: p?.output ?? DEF.output };
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

module.exports = { QUOTA_PER_USD, priceOf, estimateTokens, parseUsage, computeQuota, quotaToUsd, PRICING };
