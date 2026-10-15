/**
 * ratelimit.js — 令牌/用户级限流（滑动窗口，内存）
 * 仅作用于 /v1/* 推理请求。
 */
'use strict';

const WINDOW_MS = 60 * 1000;
const buckets = new Map();   // key → [timestamps...]

function prune(arr, now) {
  const cut = now - WINDOW_MS;
  while (arr.length && arr[0] < cut) arr.shift();
}

/**
 * @returns {{ok:true, remaining:number}} | {{ok:false, retryAfter:number, limit:number}}
 */
function check(key, limitPerMin) {
  const limit = parseInt(limitPerMin, 10) || 0;
  if (limit <= 0) return { ok: true, remaining: -1 };   // 0 = 不限
  const now = Date.now();
  let arr = buckets.get(key);
  if (!arr) { arr = []; buckets.set(key, arr); }
  prune(arr, now);
  if (arr.length >= limit) {
    const retryAfter = Math.ceil((arr[0] + WINDOW_MS - now) / 1000);
    return { ok: false, retryAfter: Math.max(1, retryAfter), limit };
  }
  arr.push(now);
  return { ok: true, remaining: limit - arr.length };
}

// 定期清理空桶，防内存泄漏
setInterval(() => {
  const now = Date.now();
  for (const [k, arr] of buckets) {
    prune(arr, now);
    if (!arr.length) buckets.delete(k);
  }
}, WINDOW_MS).unref?.();

function stats() {
  let active = 0;
  for (const arr of buckets.values()) if (arr.length) active++;
  return { buckets: buckets.size, active };
}

module.exports = { check, stats, WINDOW_MS };
