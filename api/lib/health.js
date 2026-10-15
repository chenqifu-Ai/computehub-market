/**
 * health.js — 渠道健康检查 + 自动熔断
 *
 * 策略（每 CH_N 次成功/失败滑动统计）：
 *   - 连续失败 >= FAIL_THRESHOLD → 熔断（冷却期 COOLDOWN_MS 内不再被选中）
 *   - 冷却到期后放行 1 次"探测请求"（half-open）；成功则恢复，失败则继续冷却
 *   - 主动探活：GET 上游 /models，每 PROBE_MS 一次（仅对启用渠道）
 *
 * 状态在内存中维护，重启即重置（渠道 status 字段是"人工开关"，与此互补）。
 */
'use strict';

const FAIL_THRESHOLD = parseInt(process.env.CIRCUIT_FAILS || '3', 10);
const COOLDOWN_MS = parseInt(process.env.CIRCUIT_COOLDOWN_MS || '60000', 10);
const PROBE_MS = parseInt(process.env.CHANNEL_PROBE_MS || '300000', 10); // 5min

const state = new Map();  // channelId → { fails, openUntil, total, ok, lastErr, lastOkAt, probeAt }

function get(id) {
  let s = state.get(id);
  if (!s) {
    s = { fails: 0, openUntil: 0, total: 0, ok: 0, err: 0, lastErr: '', lastOkAt: 0, latency: 0 };
    state.set(id, s);
  }
  return s;
}

/** 渠道当前是否可用（考虑熔断状态 + half-open 探测） */
function available(id) {
  const s = get(id);
  if (!s.openUntil) return true;
  const now = Date.now();
  if (now >= s.openUntil) {
    // 冷却结束 → half-open：只放行一次
    if (!s.halfOpenUsed) { s.halfOpenUsed = true; s.openUntil = 0; return true; }
    s.halfOpenUsed = false;
    s.openUntil = now + COOLDOWN_MS;
    return false;
  }
  return false;
}

function onSuccess(id, latencyMs) {
  const s = get(id);
  s.fails = 0;
  s.ok++;
  s.total++;
  s.openUntil = 0;
  s.halfOpenUsed = false;
  s.lastOkAt = Date.now();
  if (latencyMs != null) s.latency = latencyMs;
}

function onFailure(id, err) {
  const s = get(id);
  s.fails++;
  s.err++;
  s.total++;
  s.lastErr = String(err || '').slice(0, 300);
  if (s.fails >= FAIL_THRESHOLD) {
    s.openUntil = Date.now() + COOLDOWN_MS;   // 熔断
    console.warn(`[health] 渠道 ${id} 熔断 ${COOLDOWN_MS / 1000}s（连续失败 ${s.fails}）`);
  }
}

function snapshot() {
  const out = {};
  for (const [id, s] of state) {
    out[id] = {
      healthy: available(id),
      fails: s.fails, ok: s.ok, err: s.err,
      cooldown_remaining: s.openUntil > Date.now() ? Math.ceil((s.openUntil - Date.now()) / 1000) : 0,
      last_err: s.lastErr, last_ok_at: s.lastOkAt, latency: s.latency,
    };
  }
  return out;
}

/** 主动探活：GET {base}/models */
async function probeChannel(ch) {
  const url = ch.base_url.replace(/\/+$/, '') + '/models';
  const t0 = Date.now();
  try {
    const r = await fetch(url, {
      headers: ch.api_key ? { Authorization: '***' + ch.api_key } : {},
      signal: AbortSignal.timeout(15000),
    });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const j = await r.json();
    const n = (j.data || j.models || []).length;
    onSuccess(ch.id, Date.now() - t0);
    return { id: ch.id, name: ch.name, ok: true, models: n, latency: Date.now() - t0 };
  } catch (e) {
    onFailure(ch.id, e.message);
    return { id: ch.id, name: ch.name, ok: false, error: e.message, latency: Date.now() - t0 };
  }
}

async function probeAll(ctx) {
  const chs = ctx.store.listChannelsRaw(ctx.db).filter(c => c.status === 1);
  return Promise.all(chs.map(probeChannel));
}

let timer = null;
function startProber(ctx) {
  if (timer) clearInterval(timer);
  timer = setInterval(() => {
    probeAll(ctx).catch(e => console.error('[health] 探活失败', e.message));
  }, PROBE_MS);
  timer.unref?.();
  console.log(`[health] 渠道探活已启动（每 ${PROBE_MS / 1000}s，失败阈值 ${FAIL_THRESHOLD} 次 / 冷却 ${COOLDOWN_MS / 1000}s）`);
}

module.exports = { available, onSuccess, onFailure, snapshot, probeChannel, probeAll, startProber, FAIL_THRESHOLD, COOLDOWN_MS };
