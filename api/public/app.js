/* 算力商城 API 平台 · 控制台逻辑 */
'use strict';

const $ = id => document.getElementById(id);
const SKEY = 'ch-api-session';
const SCHEME = 'Bea' + 'rer ';
let SESSION = localStorage.getItem(SKEY) || null;
let ME = null;
let IS_ADMIN = false;
let logPage = 1;
const LOG_SIZE = 20;
let allModels = [];

// ---------- 工具 ----------
function toast(msg, type) {
  const t = $('toast');
  t.textContent = msg;
  t.className = 'toast ' + (type || 'ok');
  clearTimeout(t._h);
  t._h = setTimeout(() => t.classList.add('hidden'), 3200);
}
async function api(path, opts = {}) {
  const r = await fetch(path, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      ...(SESSION ? { Authorization: SCHEME + SESSION } : {}),
      ...(opts.headers || {}),
    },
  });
  const j = await r.json().catch(() => ({ success: false, message: 'invalid JSON' }));
  j.__status = r.status;
  return j;
}
function fmtUsd(quota) { return '$' + ((quota || 0) / 500000).toFixed(4); }
function fmtTok(n) { return (n || 0).toLocaleString('en-US'); }
function fmtMe(n) { return n >= 10000 ? (n / 10000).toFixed(2) + ' 万' : fmtTok(n); }
function fmtTime(ms) {
  if (!ms) return '—';
  const d = new Date(ms); const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
function fmtTsCsv(ms) {
  if (!ms) return '';
  const d = new Date(ms); const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

// ---------- 登录 / 注册 ----------
let authTab = 'login';
document.querySelectorAll('.tab').forEach(tab => {
  tab.onclick = () => {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    authTab = tab.dataset.tab;
    $('authSubmit').textContent = authTab === 'login' ? '登录' : '注册';
    $('authMsg').textContent = '';
    $('affWrap').classList.toggle('hidden', authTab !== 'register');
  };
});

$('authForm').onsubmit = async e => {
  e.preventDefault();
  const username = $('authUser').value.trim();
  const password = $('authPass').value;
  const body = { username, password };
  if (authTab === 'register') body.aff_code = $('authAff').value.trim();
  const ep = authTab === 'login' ? '/api/user/login' : '/api/user/register';
  $('authSubmit').disabled = true;
  $('authMsg').textContent = '处理中…';
  try {
    const j = await api(ep, { method: 'POST', body: JSON.stringify(body) });
    if (j.success) {
      if (authTab === 'login') {
        SESSION = j.data.token;
        localStorage.setItem(SKEY, SESSION);
        ME = j.data;
        toast('✅ 登录成功，欢迎 ' + (ME.display_name || ME.username));
        enterApp();
      } else {
        toast('✅ 注册成功，请登录');
        document.querySelector('[data-tab="login"]').click();
        $('authPass').value = '';
        $('authUser').value = username;
      }
    } else {
      $('authMsg').className = 'auth-msg err';
      $('authMsg').textContent = j.message || '操作失败';
    }
  } catch (err) {
    $('authMsg').className = 'auth-msg err';
    $('authMsg').textContent = '请求失败: ' + err.message;
  }
  $('authSubmit').disabled = false;
};

$('btnLogout').onclick = async () => {
  try { await api('/api/user/logout', { method: 'POST' }); } catch {}
  SESSION = null; localStorage.removeItem(SKEY); location.reload();
};

// ---------- 身份切换 ----------
$('btnSwitch').onclick = openSwitchDialog;
async function openSwitchDialog() {
  const j = await api('/api/user/switchable');
  if (!j.success) return toast(j.message, 'err');
  const d = j.data;
  const isSelf = d.origin.id === d.current.id;
  const opt = (u, tag) => `<option value="${u.id}">${esc(u.username)}${tag ? ' — ' + tag : ''}</option>`;
  const downOpts = d.downline.map(u => opt(u, '下级 L' + u.depth + (u.agent_name ? ' · ' + u.agent_name : ''))).join('');
  const upOpts = d.upline.map(u => opt(u, '上级（需密码）')).join('');
  const allOpts = (d.all || []).map(u => opt(u, (u.role >= 100 ? '管理员' : '用户') + (u.agent_name ? ' · ' + u.agent_name : ''))).join('');
  openModal(`
    <h3>🔄 切换身份</h3>
    <p class="muted">当前身份：<b>${esc(d.current.username)}</b>${isSelf ? '' : '（原始登录：' + esc(d.origin.username) + '）'}</p>
    ${d.is_admin ? `
    <label>🔑 管理员：切换到任意用户（无需密码）</label>
    <input id="swAllFilter" placeholder="输入用户名/ID 过滤" oninput="filterSwitchAll()">
    <select id="swAll" size="8" style="width:100%">
      <option value="${d.origin.id}">↩ 返回本人（${esc(d.origin.username)}）</option>
      ${allOpts}
    </select>` : `
    <label>切换到下级（无需密码）</label>
    <select id="swDown" style="width:100%">
      <option value="">— 选择下级 —</option>
      <option value="${d.origin.id}">↩ 返回本人（${esc(d.origin.username)}）</option>
      ${downOpts}
    </select>
    ${upOpts ? `
    <label>切换到上级（需该上级密码）</label>
    <select id="swUp" style="width:100%">
      <option value="">— 选择上级 —</option>
      ${upOpts}
    </select>
    <label>上级密码</label>
    <input id="swPw" type="password" placeholder="输入所选上级的密码">` : ''}`}
    ${!d.is_admin && !downOpts && !upOpts ? '<p class="muted" style="margin-top:10px">你目前没有可切换的下级或上级。</p>' : ''}
    <div class="modal-actions">
      <button class="btn-ghost" onclick="closeModal()">取消</button>
      <button class="btn-primary" onclick="doSwitch()">切换</button>
    </div>`);
}
function filterSwitchAll() {
  const kw = ($('swAllFilter').value || '').trim().toLowerCase();
  Array.from($('swAll').options).forEach(o => {
    if (o.value === '') return;
    o.style.display = (!kw || o.textContent.toLowerCase().includes(kw)) ? '' : 'none';
  });
}
async function doSwitch() {
  let target = '', password = '';
  if ($('swAll')) { target = $('swAll').value; }
  else {
    const up = $('swUp') ? $('swUp').value : '';
    const down = $('swDown') ? $('swDown').value : '';
    if (up) { target = up; password = ($('swPw') || {}).value || ''; if (!password) return toast('切换到上级需要输入密码', 'err'); }
    else if (down) { target = down; }
  }
  if (!target) return toast('请选择要切换到的用户', 'err');
  const j = await api('/api/user/impersonate', { method: 'POST', body: JSON.stringify({ target, password }) });
  if (!j.success) return toast(j.message, 'err');
  SESSION = j.data.token;
  localStorage.setItem(SKEY, SESSION);
  toast('已切换到 ' + j.data.user.username);
  closeModal();
  setTimeout(() => location.reload(), 500);
}

// ---------- 进入控制台 ----------
async function bootstrap() {
  const site = await api('/api/settings');
  if (site.success && site.data.site_name) {
    $('authTitle').textContent = site.data.site_name;
    $('sideSite').textContent = site.data.site_name;
    document.title = site.data.site_name;
  }
  if (!SESSION) return showAuth();
  const j = await api('/api/user/self');
  if (j.success) { ME = j.data; return enterApp(); }
  SESSION = null; localStorage.removeItem(SKEY); showAuth();
}
function showAuth() { $('appView').classList.add('hidden'); $('authView').classList.remove('hidden'); }

function enterApp() {
  $('authView').classList.add('hidden');
  $('appView').classList.remove('hidden');
  IS_ADMIN = (ME.role || 0) >= 100;
  $('sideUser').innerHTML = `<b>${esc(ME.display_name || ME.username)}</b>ID: ${ME.id}${IS_ADMIN ? ' · 管理员' : ''}`;
  document.querySelectorAll('.admin-only').forEach(e => e.classList.toggle('hidden', !IS_ADMIN));
  const base = location.origin;
  document.querySelectorAll('.docBase').forEach(e => e.textContent = base);
  refreshBalance();
  loadAnnounce();
  checkinState();
  goto('dashboard');
}

function refreshBalance() {
  const s = fmtUsd(ME.quota);
  $('balancePill').textContent = '余额 ' + s;
  $('dBalance').textContent = s;
  $('dUsed').textContent = fmtUsd(ME.used_quota);
  $('dReqs').textContent = fmtMe(ME.request_count);
  $('tpBalance').textContent = s;
  $('tpUsed').textContent = fmtUsd(ME.used_quota);
  $('invReward').textContent = fmtUsd(ME.invite_reward || 0);
}

async function loadAnnounce() {
  const j = await api('/api/settings');
  const a = j.success && j.data.announcement;
  $('announce').classList.toggle('hidden', !a);
  if (a) $('announce').textContent = '📢 ' + a;
}

// ---------- 导航 ----------
const TITLES = {
  dashboard: '仪表盘', tokens: '令牌管理', models: '模型目录', logs: '使用日志',
  topup: '充值兑换', invite: '邀请返利', team: '代理团队', ledger: '资金流水', profile: '个人设置', channels: '渠道管理',
  users: '用户管理', agenttree: '代理管理', settings: '系统设置', docs: '接入文档',
};
document.querySelectorAll('.side-nav a').forEach(a => { a.onclick = () => goto(a.dataset.page); });
function goto(page) {
  document.querySelectorAll('.side-nav a').forEach(a => a.classList.toggle('active', a.dataset.page === page));
  document.querySelectorAll('.page').forEach(p => p.classList.toggle('hidden', p.id !== 'page-' + page));
  $('pageTitle').textContent = TITLES[page] || page;
  const fn = {
    dashboard: loadDashboard, tokens: loadTokens, models: loadModels, logs: () => loadLogs(1),
    topup: loadTopup, invite: loadInvite, profile: loadProfile, channels: loadChannels,
    users: loadUsers, team: loadTeam, ledger: loadLedger, agenttree: loadAgentTree, settings: loadSettings, docs: () => {},
  }[page];
  if (page === 'team') {
    // 默认树状视图
    $('teamTreeBox').classList.remove('hidden'); $('teamTable').classList.add('hidden');
    $('btnTmTree').classList.add('active'); $('btnTmList').classList.remove('active');
  }
  if (fn) fn();
}

// ---------- 仪表盘 ----------
async function loadDashboard() {
  const j = await api('/api/user/dashboard');
  if (j.success) {
    const d = j.data;
    ME.quota = d.quota; ME.used_quota = d.used_quota; ME.request_count = d.request_count;
    $('dBalance').textContent = fmtUsd(d.quota);
    $('dUsed').textContent = fmtUsd(d.used_quota);
    $('dReqs').textContent = fmtMe(d.request_count);
    $('dToday').textContent = fmtMe(d.today.requests);
    $('tReq').textContent = fmtTok(d.today.requests);
    $('tTok').textContent = fmtTok(d.today.tokens);
    $('tCost').textContent = fmtUsd(d.today.quota);
    refreshBalance();
  }
  const st = await api('/api/status');
  if (st.success) {
    $('sysCh').textContent = `${st.data.active} / ${st.data.healthy}`;
    $('sysRl').textContent = '滑动窗口 60s';
  }
  const mm = await api('/api/models');
  if (mm.success) $('sysModels').textContent = mm.data.count;

  const s = await api('/api/log/model');
  const rows = (s.success ? s.data : []).slice(0, 10);
  $('dModelStats').innerHTML = rows.length ? rows.map(r => `
    <tr><td class="mono">${esc(r.model_name)}</td><td>${fmtTok(r.count)}</td>
    <td>${fmtTok(r.prompt_tokens)}</td><td>${fmtTok(r.completion_tokens)}</td>
    <td>${fmtUsd(r.quota)}</td></tr>`).join('')
    : '<tr><td colspan="5" class="empty">暂无数据</td></tr>';
}

// ---------- 令牌 ----------
async function loadTokens() {
  const j = await api('/api/token/');
  if (!j.success) return toast(j.message, 'err');
  const items = j.data.items || [];
  $('tokenBody').innerHTML = items.length ? items.map(t => `
    <tr>
      <td>${esc(t.name)}</td>
      <td><span class="tag ${t.status === 1 ? 'on' : 'off'}">${t.status === 1 ? '启用' : '禁用'}</span></td>
      <td>${t.unlimited_quota ? '无限' : fmtUsd(t.remain_quota)}</td>
      <td>${fmtUsd(t.used_quota)}</td>
      <td class="mono">${esc(t.model_limits || '不限')}</td>
      <td class="mono">${esc(t.key)}</td>
      <td>${fmtTime(t.accessed_time)}</td>
      <td class="actions">
        <button class="btn-ghost sm" onclick="showKey(${t.id})">查看</button>
        <button class="btn-ghost sm" onclick="editToken(${t.id},'${esc(t.name)}',${t.status},${t.unlimited_quota},${t.remain_quota},'${esc(t.model_limits)}')">编辑</button>
        <button class="btn-ghost sm btn-danger" onclick="delToken(${t.id},'${esc(t.name)}')">删除</button>
      </td>
    </tr>`).join('') : '<tr><td colspan="8" class="empty">还没有令牌，点右上角新建</td></tr>';
}

$('btnNewToken').onclick = () => {
  openModal(`
    <h3>新建令牌</h3>
    <label>名称</label><input id="tkName" placeholder="例如 production" value="default">
    <label>额度</label>
    <select id="tkUnlimited"><option value="1">无限额度</option><option value="0">限额</option></select>
    <div id="tkQuotaWrap" class="hidden"><label>额度（美元）</label><input id="tkQuota" type="number" value="5" step="0.5"></div>
    <label>模型限制（逗号分隔，留空=不限）</label><input id="tkModels" placeholder="deepseek-v4-flash,Qwen3.8-27B">
    <label>IP 白名单（逗号分隔，留空=不限）</label><input id="tkIps" placeholder="">
    <div class="modal-actions">
      <button class="btn-ghost" onclick="closeModal()">取消</button>
      <button class="btn-primary" onclick="createToken()">创建</button>
    </div>`);
  $('tkUnlimited').onchange = () => $('tkQuotaWrap').classList.toggle('hidden', $('tkUnlimited').value === '1');
};

async function createToken() {
  const body = {
    name: $('tkName').value.trim() || 'default',
    unlimited_quota: $('tkUnlimited').value === '1',
    remain_quota: Math.round((parseFloat($('tkQuota').value) || 0) * 500000),
    model_limits: $('tkModels').value.trim(),
    allow_ips: $('tkIps').value.trim(),
  };
  const j = await api('/api/token/', { method: 'POST', body: JSON.stringify(body) });
  if (!j.success) return toast(j.message, 'err');
  const key = 'sk-' + j.data.key_plain;
  openModal(`
    <h3>令牌创建成功</h3>
    <p class="muted">这是唯一一次显示完整 Key，请立即复制保存。</p>
    <pre class="code" style="margin-top:12px">${esc(key)}</pre>
    <div class="modal-actions"><button class="btn-primary" onclick="copyText('${esc(key)}');closeModal()">复制并关闭</button></div>`);
  loadTokens();
}

function editToken(id, name, status, unlimited, remain, limits) {
  openModal(`
    <h3>编辑令牌「${esc(name)}」</h3>
    <label>名称</label><input id="etName" value="${esc(name)}">
    <label>状态</label>
    <select id="etStatus"><option value="1" ${status === 1 ? 'selected' : ''}>启用</option><option value="2" ${status === 2 ? 'selected' : ''}>禁用</option></select>
    <label>模型限制（逗号分隔，留空=不限）</label><input id="etModels" value="${esc(limits)}">
    <div class="modal-actions">
      <button class="btn-ghost" onclick="closeModal()">取消</button>
      <button class="btn-primary" onclick="saveToken(${id})">保存</button>
    </div>`);
}
async function saveToken(id) {
  const b = {
    id, name: $('etName').value.trim(), status: parseInt($('etStatus').value, 10),
    model_limits: $('etModels').value.trim(),
  };
  const j = await api('/api/token/update', { method: 'POST', body: JSON.stringify(b) });
  if (!j.success) return toast(j.message, 'err');
  closeModal(); toast('✅ 已保存'); loadTokens();
}

async function showKey(id) {
  const j = await api('/api/token/key?id=' + id);
  if (!j.success) return toast(j.message, 'err');
  openModal(`
    <h3>令牌 Key</h3>
    <pre class="code">${esc(j.data.key)}</pre>
    <div class="modal-actions"><button class="btn-primary" onclick="copyText('${esc(j.data.key)}');closeModal()">复制并关闭</button></div>`);
}

async function delToken(id, name) {
  if (!confirm('确认删除令牌「' + name + '」？删除后使用该令牌的请求会立即失败。')) return;
  const j = await api('/api/token/delete', { method: 'POST', body: JSON.stringify({ id }) });
  if (!j.success) return toast(j.message, 'err');
  toast('已删除'); loadTokens();
}

// ---------- 模型目录 ----------
async function loadModels() {
  const [m, p] = await Promise.all([api('/api/models'), api('/api/pricing')]);
  if (!m.success) return;
  const priceMap = {};
  (p.success ? p.data : []).forEach(x => priceMap[x.model] = x);
  allModels = m.data.models.map(name => ({ name, ...(priceMap[name] || {}) }));
  $('modelCount').textContent = allModels.length + ' 个';
  if (p.success && p.default && $('defaultPrice')) {
    $('defaultPrice').textContent = `（默认 $${fmtPrice(p.default.input)} / $${fmtPrice(p.default.output)}）`;
  }
  renderPricingAlert(p);
  renderModels(allModels);
}
// 未定价告警条：在售模型走了 default = 静默亏损风险
function renderPricingAlert(p) {
  const box = $('pricingAlert');
  if (!box) return;
  const al = (p && p.alert) || {};
  const n = al.unpriced_count || 0;
  if (!n) {
    box.classList.add('hidden');
    box.innerHTML = '';
  } else {
    const d = al.default || {};
    const names = (al.unpriced || []);
    const shown = names.slice(0, 8).map(x => `<span class="mono">${esc(x)}</span>`).join(' ');
    const more = names.length > 8 ? ` …等 ${names.length} 个` : '';
    box.classList.remove('hidden');
    box.innerHTML = `⚠️ <b>${n} 个在售模型未定价</b>，正按默认价 <span class="mono">$${fmtPrice(d.input)}/$${fmtPrice(d.output)}</span> 计费，可能<b>静默亏损</b>。` +
      `<span style="flex:1"></span>${IS_ADMIN ? `<button class="btn-ghost sm" onclick="filterUnpriced()">仅看未定价</button>` : ''}` +
      `<div style="width:100%;margin-top:6px;font-size:12px;opacity:.9">${shown}${more}</div>`;
  }
  const note = $('unpricedNote');
  if (note) note.innerHTML = n ? `🔴 标红模型 = 未定价（走默认价）` : '';
}
function filterUnpriced() {
  if ($('modelSearch')) $('modelSearch').value = '';
  renderModels(allModels.filter(x => !x.priced));
}
function renderModels(list) {
  const col = IS_ADMIN ? 7 : 6;
  $('modelBody').innerHTML = list.length ? list.map(x => `
    <tr${!x.priced ? ' style="background:rgba(232,84,84,.07)"' : ''}><td class="mono">${esc(x.name)}</td><td>${x.channels || 1}</td>
    <td class="mono">$${fmtPrice(x.input)}</td><td class="mono">$${fmtPrice(x.output)}</td>
    <td class="mono">$${fmtPrice(x.cached)}</td>
    <td>${x.priced
      ? (x.peak ? `<span class="tag warn" title="高峰 ${(x.peak.windows||[]).map(w=>w.join('-')).join('/')} ×${x.peak.multiplier}（Asia/Shanghai）">时段 ×${x.peak.multiplier}${x.peak_now > 1 ? ' 生效中' : ''}</span>` : '<span class="tag on">已定价</span>')
      : '<span class="tag danger blink" title="未显式定价，走默认价 → 有亏损风险">未定价</span>'}</td>
    ${IS_ADMIN ? `<td class="actions">
        <button class="btn-ghost sm" onclick='editPrice(${JSON.stringify(x.name)},${x.input},${x.output},${x.cached ?? 'undefined'},${JSON.stringify(x.peak || null)})'>改价</button>
        ${x.priced ? `<button class="btn-ghost sm btn-danger" onclick="delPrice('${esc(x.name)}')">去定价</button>` : ''}
      </td>` : ''}</tr>`).join('')
    : `<tr><td colspan="${col}" class="empty">无匹配模型</td></tr>`;
}
// 价格展示：≥1 保留 2 位，<1 保留 4 位（¥0.1 而不是 $0.1000）
function fmtPrice(v) {
  const n = Number(v || 0);
  return n >= 1 ? n.toFixed(2) : n.toFixed(4);
}
// 改价弹窗（复用：新增/编辑）
function editPrice(model, input, output, cached, peak) {
  const isNew = input === undefined;
  const peakOn = !!(peak && peak.windows && peak.windows.length);
  openModal(`
    <h3>${isNew ? '新增/修改定价' : '修改定价 · ' + esc(model)}</h3>
    <label>模型名</label>
    <input id="prModel" value="${esc(model || '')}" ${isNew ? '' : 'readonly style="opacity:.6"'} placeholder="如 deepseek-v4-flash">
    <label>输入价（非缓存输入，USD / 1M tokens）</label>
    <input id="prIn" type="number" step="0.00001" min="0" value="${isNew ? '' : input}" placeholder="0.1">
    <label>补全价（输出，USD / 1M tokens）</label>
    <input id="prOut" type="number" step="0.00001" min="0" value="${isNew ? '' : output}" placeholder="0.3">
    <label>缓存读价（USD / 1M tokens，留空 = 输入价 ×0.1）</label>
    <input id="prCache" type="number" step="0.00001" min="0" value="${isNew || cached === undefined ? '' : cached}" placeholder="0.01">
    <label style="margin-top:10px"><input type="checkbox" id="prPeak" ${peakOn ? 'checked' : ''}> 高峰时段倍率（上游 9-12 / 14-18 点 ×2）</label>
    <input id="prPeakMul" type="number" step="0.1" min="1" value="${peakOn ? peak.multiplier : 2}" placeholder="2" style="margin-top:4px">
    <p class="muted" style="font-size:12px;margin:6px 0">换算：quota = ((输入−缓存)×输入价 + 补全×补全价 + 缓存×缓存价)/1e6 × 500000（× 高峰倍率）</p>
    <div class="modal-actions">
      <button class="btn-ghost" onclick="closeModal()">取消</button>
      <button class="btn-primary" onclick="savePrice()">保存</button>
    </div>`);
}
async function savePrice() {
  const b = { model: $('prModel').value.trim(), input: $('prIn').value, output: $('prOut').value };
  const ca = $('prCache').value.trim();
  if (ca !== '') b.cached = ca;
  if ($('prPeak').checked) {
    b.peak = { windows: [[9, 12], [14, 18]], multiplier: parseFloat($('prPeakMul').value) || 2 };
  } else {
    b.peak = false;   // 清除时段倍率
  }
  if (!b.model) return toast('请填写模型名', 'err');
  if (b.input === '' || b.output === '') return toast('请填写输入/补全价格', 'err');
  const j = await api('/api/pricing/update', { method: 'POST', body: JSON.stringify(b) });
  if (!j.success) return toast(j.message, 'err');
  closeModal(); toast(j.message || '✅ 已定价'); loadModels();
}
async function delPrice(model) {
  if (!confirm(`确认删除「${model}」的定价？\n删除后将回落默认价。`)) return;
  const j = await api('/api/pricing/delete', { method: 'POST', body: JSON.stringify({ model }) });
  if (!j.success) return toast(j.message, 'err');
  toast('已删除定价，回落默认价'); loadModels();
}
// 全部价格表（管理员）：含未上架但有定价的模型
async function showAllPrices() {
  const j = await api('/api/pricing/all');
  if (!j.success) return toast(j.message, 'err');
  const rows = j.data.map(x => `<tr><td class="mono">${esc(x.model)}</td><td class="mono">$${fmtPrice(x.input)}</td><td class="mono">$${fmtPrice(x.output)}</td><td class="mono">$${fmtPrice(x.cached)}</td>` +
    `<td><button class="btn-ghost sm" onclick="editPrice('${esc(x.model)}',${x.input},${x.output},${x.cached ?? 'undefined'})">改价</button></td></tr>`).join('');
  openModal(`
    <h3>全部价格表 <span class="badge">${j.data.length}</span></h3>
    <p class="muted" style="font-size:12px;margin:0 0 8px">含已定价但当前未上架的模型；默认价 <span class="mono">$${fmtPrice(j.default.input)}/$${fmtPrice(j.default.output)}/$${fmtPrice(j.default.cached)}</span></p>
    <div style="max-height:52vh;overflow:auto">
      <table class="tbl"><thead><tr><th>模型名</th><th>输入 $/1M</th><th>补全 $/1M</th><th>缓存 $/1M</th><th>操作</th></tr></thead><tbody>${rows}</tbody></table>
    </div>
    <div class="modal-actions"><button class="btn-ghost" onclick="closeModal()">关闭</button></div>`);
}
$('modelSearch').oninput = e => {
  const q = e.target.value.toLowerCase();
  renderModels(allModels.filter(x => x.name.toLowerCase().includes(q)));
};

// ---------- 日志 ----------
// 渠道列仅管理员可见（权限加固：渠道数据不暴露给代理及以下）
(function initLogHead() {
  const th = $('logHead') && $('logHead').querySelector('tr');
  if (th && IS_ADMIN) {
    const cell = document.createElement('th');
    cell.textContent = '渠道';
    th.insertBefore(cell, th.children[3]);  // 令牌之后
  }
})();
async function loadLogs(p) {
  logPage = p;
  const j = await api(`/api/log/self?p=${p}&size=${LOG_SIZE}`);
  if (!j.success) return;
  const d = j.data;
  $('logTotal').textContent = `共 ${d.total} 条`;
  $('logPage').textContent = `第 ${d.page} / ${Math.max(1, Math.ceil(d.total / LOG_SIZE))} 页`;
  $('logBody').innerHTML = d.items.length ? d.items.map(l => `
    <tr>
      <td>${fmtTime(l.created_at)}</td>
      <td class="mono">${esc(l.model_name)}</td>
      <td>${esc(l.token_name)}</td>
      ${IS_ADMIN ? `<td>${esc(l.channel_name)}</td>` : ''}
      <td>${fmtTok(l.prompt_tokens)}</td>
      <td>${l.cached_tokens ? `<span title="命中 ${l.cached_tokens} / 输入 ${l.prompt_tokens}">${fmtTok(l.cached_tokens)}</span>` : '<span class="muted">—</span>'}</td>
      <td>${l.prompt_tokens ? fmtTok(l.prompt_tokens - (l.cached_tokens || 0)) : '<span class="muted">—</span>'}</td>
      <td>${l.prompt_tokens ? hitRateTag(l.cached_tokens, l.prompt_tokens) : '<span class="muted">—</span>'}</td>
      <td>${fmtTok(l.completion_tokens)}</td>
      <td>${(l.use_time || 0).toFixed(1)}s</td>
      <td>${l.quota < 0 ? '+' + fmtUsd(-l.quota) : fmtUsd(l.quota)}</td>
      <td><span class="tag ${l.status === 'success' ? 'on' : 'off'}">${l.status === 'success' ? '成功' : '失败'}</span></td>
    </tr>`).join('') : '<tr><td colspan="12" class="empty">暂无日志</td></tr>';
  lastLogs = d.items;
}
// 缓存命中率标签：0% 灰（全 miss）/ <50% 橙 / ≥50% 绿
function hitRateTag(cached, prompt) {
  const p = Number(prompt) || 0;
  if (!p) return '<span class="muted">—</span>';
  const r = Math.round((Number(cached) || 0) / p * 100);
  const cls = r === 0 ? '' : (r < 50 ? 'warn' : 'on');
  return `<span class="tag ${cls}" title="命中 ${cached || 0} / 输入 ${p}">${r}%</span>`;
}
let lastLogs = [];
$('logPrev').onclick = () => loadLogs(Math.max(1, logPage - 1));
$('logNext').onclick = () => loadLogs(logPage + 1);
$('btnExportLogs').onclick = () => {
  if (!lastLogs.length) return toast('当前页无数据', 'err');
  const head = ['时间', '模型', '令牌', ...(IS_ADMIN ? ['渠道'] : []), '输入tok', '缓存读tok', '未命中tok', '命中率', '输出tok', '总tok', '耗时s', 'quota', '状态'];
  const rows = lastLogs.map(l => [
    fmtTsCsv(l.created_at), l.model_name, l.token_name, ...(IS_ADMIN ? [l.channel_name] : []),
    l.prompt_tokens, l.cached_tokens || 0, (l.prompt_tokens || 0) - (l.cached_tokens || 0),
    l.prompt_tokens ? Math.round((l.cached_tokens || 0) / l.prompt_tokens * 100) + '%' : '',
    l.completion_tokens, l.total_tokens, l.use_time, l.quota, l.status,
  ]);
  const csv = [head, ...rows].map(r => r.map(c => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\n');
  const blob = new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `logs-${Date.now()}.csv`;
  a.click();
  toast('已导出当前页');
};

// 服务端生成 xlsx（双 sheet：明细 + 按模型汇总）
function downloadXlsx(all) {
  const url = `/api/log/export?${all ? 'all=1&' : ''}limit=2000000`;
  return downloadXlsxJob(url);
}
function downloadXlsxJob(url) {
  // 异步导出：提交任务 → 轮询状态 → 完成后下载文件
  api(url, { method: 'GET' }).then(j => {
    if (!j.success) return toast(j.message || '导出失败', 'err');
    const job = j.job;
    toast('导出任务已启动，后台生成中（不影响页面操作）…');
    const timer = setInterval(async () => {
      try {
        const r = await fetch(`/api/log/export/job?meta=1&job=${job}`, { headers: { Authorization: SCHEME + SESSION } });
        const ct = r.headers.get('content-type') || '';
        if (ct.includes('json')) {
          const s = await r.json();
          if (s.status === 'running') return; // 继续轮询
          if (s.status === 'error') { clearInterval(timer); return toast('导出失败：' + s.error, 'err'); }
          // 任务已完成，触发下载
          clearInterval(timer);
          await downloadAuthed(`/api/log/export/job?job=${job}`, '正在下载导出文件…');
        } else {
          // content-type 是 xlsx = 已完成，downloadAuthed 会处理 blob
          clearInterval(timer);
          await downloadAuthed(`/api/log/export/job?job=${job}`, '正在下载导出文件…');
        }
      } catch (e) { /* 网络抖动，继续轮询 */ }
    }, 3000);
  }).catch(e => toast('导出提交失败：' + e.message, 'err'));
}
// 带鉴权下载：用 fetch 流式读（边下边显示进度，不全攒内存），文件名从 Content-Disposition 解析
// 带鉴权下载（断点续传版 2026-10-22）：
//  - fetch 流式读 + 进度条（不变）
//  - 网络中断自动用 Range: bytes=N- 续传（服务端已支持 Accept-Ranges，文件保留 24h）
//  - 最多自动重试 5 次，全部失败才报错
async function downloadAuthed(url, tip) {
  toast(tip || '正在导出…');
  const box = $("dlProgress");
  const bar = $("dlBar");
  const txt = $("dlText");
  const show = (t) => { if (txt) txt.textContent = t; if (box) box.classList.remove('hidden'); };
  const hide = () => { if (box) box.classList.add('hidden'); if (window.__dlPaintTimer) { clearInterval(window.__dlPaintTimer); window.__dlPaintTimer = null; } };
  const t0 = performance.now();
  show((tip || '正在导出…') + ' 准备中… 已用 0s');
  if (bar) bar.style.width = '3%';
  window.__dlPaintTimer = setInterval(() => {
    const el = (performance.now() - t0) / 1000;
    if (txt) txt.textContent = (tip || '正在导出…') + ` 准备中… 已用 ${el.toFixed(0)}s（数据量大请耐心等待，请勿关闭页面）`;
  }, 500);

  const chunks = [];
  let fname = 'export.xlsx';
  let total = 0;
  let got = 0;
  let pRows = 0, pCTotal = 0, pCSent = 0;
  let serverRanges = false;
  const MAX_RETRY = 5;

  const paint = (retrying) => {
    if (window.__dlPaintTimer) { clearInterval(window.__dlPaintTimer); window.__dlPaintTimer = null; }
    const elapsed = ((performance.now() - t0) / 1000).toFixed(0);
    let line, pct;
    if (retrying) {
      line = `⚠️ 网络中断，正在从 ${(got / 1024 / 1024).toFixed(1)}MB 断点续传… 已用 ${elapsed}s`;
      pct = total ? got / total : null;
    } else if (pCTotal > 0) {
      const sentPct = pCSent / pCTotal;
      pct = 0.5 * sentPct;
      line = pCSent > 0 ? '正在下载 ' + pCSent + '/' + pCTotal + ' 片 · ' + (got / 1024 / 1024).toFixed(1) + 'MB · 已用 ' + elapsed + 's'
                        : '正在生成文件… ' + pRows + ' 行 / ' + pCTotal + ' 片 · 已用 ' + elapsed + 's';
      if (total) pct = Math.max(pct, 0.5 + 0.5 * got / total);
    } else if (total) {
      pct = got / total;
      line = '正在下载 ' + (got / 1024 / 1024).toFixed(1) + ' / ' + (total / 1024 / 1024).toFixed(1) + 'MB · 已用 ' + elapsed + 's';
    } else {
      pct = null;
      line = '正在下载 ' + (got / 1024 / 1024).toFixed(1) + 'MB · 已用 ' + elapsed + 's（数据量大请耐心等待，请勿关闭页面）';
    }
    show(line);
    if (bar) bar.style.width = (pct != null ? Math.min(99, pct * 100) : 6) + '%';
  };

  try {
    for (let attempt = 0; attempt <= MAX_RETRY; attempt++) {
      const headers = SESSION ? { Authorization: SCHEME + SESSION } : {};
      // 断点续传：已有部分数据且服务端支持 Range → 从断点继续拉
      const resume = attempt > 0 && serverRanges && got > 0;
      if (resume) headers['Range'] = 'bytes=' + got + '-';
      let r;
      try {
        r = await fetch(url, { headers });
      } catch (e) {
        if (attempt < MAX_RETRY && (resume || serverRanges)) {
          paint(true);
          await new Promise(res => setTimeout(res, 2000 * (attempt + 1)));
          continue;
        }
        throw e;
      }
      if (!r.ok && r.status !== 206) {
        if (r.status === 416) { hide(); toast('服务器文件已过期（保留 24 小时），请重新导出', 'err'); return; }
        const e = await r.json().catch(() => ({}));
        hide();
        return toast('导出失败：' + (e.message || r.status), 'err');
      }
      if (resume && r.status !== 206) {
        chunks.length = 0; got = 0; total = 0;
      }
      serverRanges = (r.headers.get('accept-ranges') || '').includes('bytes');
      const cd = r.headers.get('content-disposition') || '';
      const m = cd.match(/filename\*=UTF-8''([^;]+)/i) || cd.match(/filename="?([^";]+)"?/i);
      if (m) { try { fname = decodeURIComponent(m[1]); } catch { fname = m[1]; } }
      if (r.status === 200) {
        if (attempt > 0 && !serverRanges) { chunks.length = 0; got = 0; }
        total = Number(r.headers.get('content-length')) || total;
      } else if (r.status === 206) {
        const cr = r.headers.get('content-range') || '';
        const cm = cr.match(/\/(\d+)$/);
        if (cm) total = parseInt(cm[1], 10);
      }
      if (!r.body) {
        const blob = await r.blob();
        hide();
        return saveBlob(blob, fname);
      }
      const reader = r.body.getReader();
      let lastPaint = 0;
      let broken = false;
      while (true) {
        let rd;
        try { rd = await reader.read(); }
        catch (e) { broken = true; break; }
        const { done, value } = rd;
        if (done) break;
        chunks.push(value);
        got += value.length;
        const hp = r.headers.get('x-xlsx-progress');
        if (hp) { try { const p = JSON.parse(hp); pRows = p.rowsDone || 0; pCTotal = p.chunksTotal || 0; pCSent = p.chunksSent || 0; } catch {} }
        const now = Date.now();
        if (now - lastPaint > 300) { lastPaint = now; paint(); }
      }
      try { reader.releaseLock(); } catch {}
      if (!broken) break;
      if (attempt >= MAX_RETRY) throw new Error('网络中断且重试 ' + MAX_RETRY + ' 次未成功（已收 ' + (got / 1024 / 1024).toFixed(1) + 'MB）');
      paint(true);
      await new Promise(res => setTimeout(res, 2000 * (attempt + 1)));
    }
    const blob = new Blob(chunks, { type: 'application/octet-stream' });
    if (total && blob.size !== total) throw new Error('文件不完整（' + blob.size + '/' + total + ' 字节），请重试');
    hide();
    saveBlob(blob, fname);
  } catch (e) { hide(); toast('导出失败：' + e.message, 'err'); }
}
function saveBlob(blob, fname) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = fname;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  toast('已导出：' + fname);
}
// 【修复 2026-10-21】之前这两个按钮直接调 downloadXlsx(全量)，没有时间段选择，
// 一点就是 96 万行。现在和结算导出一样先弹时间范围。
function askUsageRange(all) {
  openModal(`
    <h3>📜 导出使用日志 Excel</h3>
    <p class="muted">范围：<b>${all ? '全站所有用户' : '我自己'}</b></p>
    <label>快捷时间段</label>
    <div style="display:flex;gap:6px;flex-wrap:wrap" id="uQuick">
      <button type="button" class="btn-ghost sm uq" data-days="1">今天</button>
      <button type="button" class="btn-ghost sm uq" data-days="7">近7天</button>
      <button type="button" class="btn-ghost sm uq" data-days="30">近30天</button>
      <button type="button" class="btn-ghost sm uq" data-days="0">全部</button>
    </div>
    <div style="display:flex;align-items:center;gap:8px;margin-top:8px">
      <label style="margin:0">自定义天数</label>
      <input id="uDays" type="number" min="0" value="7" style="width:110px" placeholder="0=全部">
      <span class="muted" id="uDaysHint">当前：近 7 天</span>
    </div>
    <label>或：起始日期</label>
    <input id="uFrom" type="date">
    <label>结束日期</label>
    <input id="uTo" type="date">
    <p class="muted" style="margin-top:8px">留空 + 0 = 导出全部历史（数据量大，会明显变慢）。</p>
    <div class="modal-actions">
      <button class="btn-ghost" onclick="closeModal()">取消</button>
      <button class="btn-primary" onclick="doUsageExport(${all ? 'true' : 'false'})">导出</button>
    </div>`);
  const inp = $('uDays'), hint = $('uDaysHint');
  const sync = () => {
    const d = parseInt(inp.value || '0', 10) || 0;
    if (hint) hint.textContent = d > 0 ? `当前：近 ${d} 天` : '当前：全部历史';
    document.querySelectorAll('#uQuick .uq').forEach(b => b.classList.toggle('active', parseInt(b.dataset.days, 10) === d));
  };
  document.querySelectorAll('#uQuick .uq').forEach(btn => {
    btn.onclick = () => { inp.value = btn.dataset.days; sync(); };
  });
  inp.oninput = sync;
  sync();
}
function doUsageExport(all) {
  const from = ($('uFrom') && $('uFrom').value) || '';
  const to = ($('uTo') && $('uTo').value) || '';
  const days = parseInt(($('uDays') && $('uDays').value) || '0', 10) || 0;
  closeModal();
  let url = `/api/log/export?${all ? 'all=1&' : ''}limit=2000000`;
  if (from || to) {
    if (from) url += '&from=' + new Date(from + 'T00:00:00').getTime();
    if (to) { const e = new Date(to + 'T00:00:00'); e.setDate(e.getDate() + 1); url += '&until=' + (e.getTime() - 1); }
  } else if (days === 1) {
    const d0 = new Date(); d0.setHours(0, 0, 0, 0);
    url += '&from=' + d0.getTime();
  } else if (days > 0) {
    url += '&days=' + days;
  }
  downloadXlsxJob(url);
}
$('btnExportXlsx').onclick = () => askUsageRange(false);
if ($('btnExportAll')) $('btnExportAll').onclick = () => askUsageRange(true);

// 结算清单下载：先弹「时间段选择」弹窗（不再直接导全部）
function downloadSettle(user) {
  openModal(`
    <h3>📊 导出结算清单</h3>
    <p class="muted">范围：<b>${user === 'all' ? '全部用户' : user === 'me' ? '我自己' : ('用户 #' + user)}</b></p>
    <label>快捷时间段</label>
    <div style="display:flex;gap:6px;flex-wrap:wrap" id="stQuick">
      <button type="button" class="btn-ghost sm stq" data-days="1">今天</button>
      <button type="button" class="btn-ghost sm stq" data-days="7">近7天</button>
      <button type="button" class="btn-ghost sm stq" data-days="30">近30天</button>
      <button type="button" class="btn-ghost sm stq" data-days="0">全部</button>
    </div>
    <div style="display:flex;align-items:center;gap:8px;margin-top:8px">
      <label style="margin:0">自定义天数</label>
      <input id="stDays" type="number" min="0" value="0" style="width:110px" placeholder="0=全部">
      <span class="muted" id="stDaysHint">当前：全部历史</span>
    </div>
    <label>或：起始日期</label>
    <input id="stFrom" type="date">
    <label>结束日期</label>
    <input id="stTo" type="date">
    <p class="muted" style="margin-top:8px">填了起止日期则以日期为准；否则用快捷天数 / 自定义天数。留空 + 0 = 导出全部历史。</p>
    <div class="modal-actions">
      <button class="btn-ghost" onclick="closeModal()">取消</button>
      <button class="btn-primary" onclick="doSettleExport('${user}')">导出</button>
    </div>`);
  // 【修复 2026-10-21】快捷按钮之前写 $('stDays').value，但弹窗里根本没有这个元素，
  // 点击直接抛 TypeError 被静默吞掉 → doSettleExport 读到 undefined → days=0 → 永远导全量。
  // 现在：真实 input#stDays + 按钮写值后同步高亮。
  const daysInput = $('stDays');
  const hint = $('stDaysHint');
  const syncHint = () => {
    const d = parseInt(daysInput.value || '0', 10) || 0;
    if (hint) hint.textContent = d > 0 ? `当前：近 ${d} 天` : '当前：全部历史';
    document.querySelectorAll('#stQuick .stq').forEach(b => {
      b.classList.toggle('active', parseInt(b.dataset.days, 10) === d);
    });
  };
  document.querySelectorAll('#stQuick .stq').forEach(btn => {
    btn.onclick = () => { daysInput.value = btn.dataset.days; syncHint(); };
  });
  daysInput.oninput = syncHint;
  syncHint();
}
function doSettleExport(user) {
  let qs = '/api/settle/export?user=' + encodeURIComponent(user) + '&limit=2000000';
  const from = ($('stFrom') && $('stFrom').value) || '';
  const to = ($('stTo') && $('stTo').value) || '';
  const daysIn = $('stDays');
  const days = daysIn ? (parseInt(daysIn.value || '0', 10) || 0) : 0;
  if (from || to) {
    // 自定义日期优先：用浏览器本地 0 点 / 23:59:59.999，避免「今天」少算几小时
    if (from) qs += '&from=' + new Date(from + 'T00:00:00').getTime();
    if (to) {
      const end = new Date(to + 'T00:00:00');
      end.setDate(end.getDate() + 1);
      qs += '&until=' + (end.getTime() - 1);
    }
  } else if (days === 1) {
    // 「今天」= 本地当天 0 点至今（旧逻辑 days=1 是「最近 24 小时」，会把昨天下午也带上）
    const d0 = new Date(); d0.setHours(0, 0, 0, 0);
    qs += '&from=' + d0.getTime();
  } else if (days > 0) {
    qs += '&days=' + days;
  }
  closeModal();
  // 异步 job 模式：提交后轮询状态，完成自动下载（大数据量不卡页面）
  const scopeTxt = (from || to) ? `${from || '最早'} ~ ${to || '现在'}`
    : days === 1 ? '今天'
    : days > 0 ? `近 ${days} 天`
    : '全部历史';
  settleJobExport(qs, '正在生成结算清单（' + scopeTxt + '）');
}
async function settleJobExport(qs, tip) {
  const box = $("dlProgress"); const bar = $("dlBar"); const txt = $("dlText");
  const show = (t) => { if (txt) txt.textContent = t; if (box) box.classList.remove('hidden'); };
  const hide = () => { if (box) box.classList.add('hidden'); };
  const t0 = performance.now();
  show(tip + ' 提交中… 已用 0s');
  if (bar) bar.style.width = '5%';
  try {
    const r = await fetch(qs, { headers: SESSION ? { Authorization: SCHEME + SESSION } : {} });
    const j = await r.json().catch(() => ({}));
    if (!j.success || !j.job) { hide(); return toast(j.message || '导出失败', 'err'); }
    const job = j.job;
    // 轮询状态
    // 【修复 2026-10-21】必须带 meta=1：不带时任务 done 后接口直接回文件二进制，
    // sr.json() 解析失败 → sj 为空 → 落入 else 无限轮询，页面永远停在「已用 Ns」。
    const tick = async () => {
      const elapsed = ((performance.now() - t0) / 1000).toFixed(0);
      try {
        const sr = await fetch(`/api/log/export/job?meta=1&job=${job}`, { headers: { Authorization: SCHEME + SESSION }, signal: AbortSignal.timeout(15000) });
        const sj = await sr.json().catch(() => ({}));
        if (sj.status === 'running') {
          const p = sj.progress || {};
          const rows = p.rows || 0, chunks = p.chunks || 0;
          show(`正在生成结算清单… ${rows ? rows.toLocaleString() + ' 行' : '读取中'}${chunks ? ' / ' + chunks + ' 片' : ''} · 已用 ${elapsed}s（数据量大请耐心等待，请勿关闭页面）`);
          if (bar) bar.style.width = Math.min(90, 5 + chunks * 4) + '%';
          setTimeout(tick, 1500);
        } else if (sj.status === 'error') {
          hide(); toast('导出失败：' + (sj.error || '未知错误'), 'err');
        } else if (sj.status === 'done') {
          // 下载文件
          show('生成完成，正在下载…');
          if (bar) bar.style.width = '100%';
          await downloadAuthed(`/api/log/export/job?job=${job}`, '结算清单');
          setTimeout(hide, 1500);
        } else {
          setTimeout(tick, 1500);
        }
      } catch (e) {
        // 单次请求超时/网络抖动不该中断轮询
        let n = (tick._fails = (tick._fails || 0) + 1);
        if (n > 20) { hide(); return toast('导出状态查询失败，请到下载中心查看', 'err'); }
        setTimeout(tick, 2000);
      }
    };
    setTimeout(tick, 1000);
  } catch (e) { hide(); toast('导出失败：' + e.message, 'err'); }
}
if ($('btnSettleAll')) $('btnSettleAll').onclick = () => downloadSettle('all');
if ($('btnSettleSelf')) $('btnSettleSelf').onclick = () => downloadSettle('me');
if ($('btnSettleMyTeam')) $('btnSettleMyTeam').onclick = () => downloadSettle('me');

// ---------- 充值 / 签到 ----------
async function loadTopup() {
  const j = await api('/api/settings');
  if (j.success) $('checkinQuota').textContent = fmtUsd(parseInt(j.data.checkin_quota || '0', 10));
  const me = await api('/api/user/self');
  if (me.success) { ME = me.data; refreshBalance(); }
  checkinState();
}
async function checkinState() {
  const j = await api('/api/user/checkin');
  if (j.success) {
    $('checkinState').textContent = j.data.checked_today ? '✅ 今日已签到' : '今日还未签到';
    $('btnCheckin').textContent = j.data.checked_today ? '📅 已签到' : '📅 签到';
  }
}
async function doCheckin() {
  const j = await api('/api/user/checkin', { method: 'POST' });
  if (!j.success) return toast(j.message, 'err');
  toast('✅ ' + j.message);
  ME = j.data; refreshBalance(); checkinState();
}
$('btnCheckin').onclick = doCheckin;
$('btnCheckin2').onclick = doCheckin;

$('btnTopup').onclick = async () => {
  const code = $('topupCode').value.trim();
  if (!code) return toast('请输入兑换码', 'err');
  const j = await api('/api/user/topup', { method: 'POST', body: JSON.stringify({ code }) });
  if (!j.success) return toast(j.message, 'err');
  toast('✅ ' + j.message);
  ME = j.data; $('topupCode').value = ''; refreshBalance();
};

// ---------- 邀请 ----------
async function loadInvite() {
  const j = await api('/api/user/invite');
  if (!j.success) return;
  const d = j.data;
  ME.invite_reward = d.stats.reward_quota;
  $('inviteCode').textContent = d.aff_code;
  $('invCount').textContent = d.stats.invited;
  $('invReward').textContent = fmtUsd(d.stats.reward_quota);
  $('invRate').textContent = (d.reward_rate * 100).toFixed(0) + '%';
  $('inviteBody').innerHTML = d.invitees.length ? d.invitees.map(u => `
    <tr><td>${esc(u.username)}</td><td>${fmtTime(u.created_at)}</td></tr>`).join('')
    : '<tr><td colspan="2" class="empty">还没有邀请记录</td></tr>';
  $('btnCopyInvite').onclick = () => {
    const link = `${location.origin}/?aff=${d.aff_code}`;
    copyText(link);
  };
}

// ---------- 渠道 ----------
let CH_LIST = [];   // 渠道缓存（供代理设置弹窗选择指定渠道）
async function loadChannels() {
  const j = await api('/api/channel/');
  if (!j.success) { $('channelBody').innerHTML = `<tr><td colspan="9" class="empty">${esc(j.message)}</td></tr>`; return; }
  CH_LIST = j.data;
  $('channelBody').innerHTML = j.data.length ? j.data.map(c => {
    const h = c.health || {};
    const healthy = c.status !== 1 ? '<span class="tag off">已禁用</span>'
      : (h.healthy === false ? `<span class="tag warn">熔断 ${h.cooldown_remaining || 0}s</span>` : '<span class="tag on">正常</span>');
    return `<tr>
      <td>${c.id}</td><td>${esc(c.name)}</td><td class="mono">${esc(c.base_url)}</td>
      <td class="mono">${esc(c.api_key)}</td>
      <td>${(c.models || '').split(',').filter(Boolean).length}</td>
      <td>${c.priority}</td>
      <td><span class="tag ${c.status === 1 ? 'on' : 'off'}">${c.status === 1 ? '启用' : '禁用'}</span></td>
      <td>${healthy}${h.last_err ? `<div class="muted" style="font-size:11px" title="${esc(h.last_err)}">${esc((h.last_err || '').slice(0, 40))}</div>` : ''}</td>
      <td class="actions">
        <button class="btn-ghost sm" onclick="editChannel(${c.id})">编辑</button>
        <button class="btn-ghost sm" onclick="syncChannelModels(${c.id},'${esc(c.name)}')">同步模型</button>
        <button class="btn-ghost sm" onclick="testChannel(${c.id},'${esc(c.name)}')">测试</button>
        <button class="btn-ghost sm" onclick="toggleChannel(${c.id},${c.status})">${c.status === 1 ? '禁用' : '启用'}</button>
        <button class="btn-ghost sm btn-danger" onclick="delChannel(${c.id},'${esc(c.name)}')">删除</button>
      </td>
    </tr>`;
  }).join('') : '<tr><td colspan="9" class="empty">无渠道</td></tr>';
}
async function testChannel(id, name) {
  toast('测试中…');
  const j = await api('/api/channel/test', { method: 'POST', body: JSON.stringify({ id }) });
  toast((j.message || name), j.success ? 'ok' : 'err');
  loadChannels();
}
async function toggleChannel(id, status) {
  const j = await api('/api/channel/update', { method: 'POST', body: JSON.stringify({ id, status: status === 1 ? 0 : 1 }) });
  if (!j.success) return toast(j.message, 'err');
  toast('已切换'); loadChannels();
}
async function delChannel(id, name) {
  if (!confirm('确认删除渠道「' + name + '」？')) return;
  const j = await api('/api/channel/delete', { method: 'POST', body: JSON.stringify({ id }) });
  if (!j.success) return toast(j.message, 'err');
  toast('已删除'); loadChannels();
}
// ---------- 渠道 新建/编辑（共用弹窗）+ 探测回填 + 同步 ----------
let CH_EDIT_ID = 0;   // 0 = 新建
$('btnNewChannel').onclick = () => openChannelModal(null);
function openChannelModal(c) {
  CH_EDIT_ID = c ? c.id : 0;
  const v = c || { name: '', base_url: '', api_key: '', models: '', priority: 50, weight: 1, model_mapping: '' };
  let mapStr = '';
  if (v.model_mapping) {
    try { mapStr = typeof v.model_mapping === 'string' ? v.model_mapping : JSON.stringify(v.model_mapping); } catch { mapStr = ''; }
  }
  openModal(`
    <h3>${c ? '编辑渠道 · #' + c.id : '新建渠道'}</h3>
    <label>名称</label><input id="chName" value="${esc(v.name)}" placeholder="例如 某某中转站">
    <label>上游地址（OpenAI 兼容 /v1）</label><input id="chUrl" value="${esc(v.base_url)}" placeholder="https://api.example.com/v1">
    <label>API Key${c ? '（留空 = 不修改）' : ''}</label><input id="chKey" placeholder="${c ? '留空保持不变' : 'sk-...'}">
    <label>模型列表（逗号分隔）</label>
    <textarea id="chModels" rows="4" style="width:100%;font-family:ui-monospace,monospace" placeholder="deepseek-v4-flash,gpt-oss:20b">${esc(v.models || '')}</textarea>
    <div style="margin:-6px 0 10px">
      <button class="btn-ghost sm" onclick="probeIntoModal()">🔍 探测上游并填充</button>
      <span id="chProbeMsg" class="muted" style="font-size:12px;margin-left:8px"></span>
    </div>
    <label>优先级（越大越优先）</label><input id="chPrio" type="number" value="${esc(v.priority)}">
    <label>权重（同优先级分流）</label><input id="chWeight" type="number" value="${esc(v.weight)}">
    <label>模型映射（可选，JSON 如 {"对外名":"上游名"}）</label><input id="chMap" value="${esc(mapStr)}" placeholder="">
    <div class="modal-actions">
      <button class="btn-ghost" onclick="closeModal()">取消</button>
      <button class="btn-primary" onclick="saveChannel()">${c ? '保存' : '创建'}</button>
    </div>`);
}
// 弹窗内探测：把上游模型回填到「模型列表」输入框
async function probeIntoModal() {
  const msg = $('chProbeMsg');
  const base_url = $('chUrl').value.trim();
  const key = $('chKey').value.trim();
  if (!base_url) return toast('请先填写上游地址', 'err');
  msg.textContent = '探测中…';
  // 编辑态且未重填 key → 用渠道已存的 key 探测（persist:false 仅拉取，不落库）
  const body = (CH_EDIT_ID && !key) ? { id: CH_EDIT_ID, persist: false } : { base_url, api_key: key };
  const j = await api('/api/channel/models', { method: 'POST', body: JSON.stringify(body) });
  if (!j.success) { msg.textContent = '❌ ' + j.message; return toast('探测失败', 'err'); }
  $('chModels').value = (j.data.models || []).join(',');
  msg.textContent = `✅ 拉回 ${j.data.count} 个模型，已填充`;
  toast(`✅ 已填充 ${j.data.count} 个模型`);
}
async function saveChannel() {
  const maps = $('chMap').value.trim();
  const b = {
    name: $('chName').value.trim(), base_url: $('chUrl').value.trim(),
    models: $('chModels').value.split(',').map(s => s.trim()).filter(Boolean),
    priority: parseInt($('chPrio').value, 10) || 0, weight: parseInt($('chWeight').value, 10) || 1,
  };
  const key = $('chKey').value.trim();
  if (key) b.api_key = key;               // 留空 = 不修改（更新接口只在非空时写 key）
  if (maps) { try { b.model_mapping = JSON.parse(maps); } catch { return toast('模型映射不是合法 JSON', 'err'); } }
  if (!b.base_url) return toast('请填写上游地址', 'err');
  if (!b.models.length) return toast('模型列表为空：可点「🔍 探测上游并填充」或手动填写', 'err');
  let j;
  if (CH_EDIT_ID) { b.id = CH_EDIT_ID; j = await api('/api/channel/update', { method: 'POST', body: JSON.stringify(b) }); }
  else            { j = await api('/api/channel/', { method: 'POST', body: JSON.stringify(b) }); }
  if (!j.success) return toast(j.message, 'err');
  closeModal(); toast(CH_EDIT_ID ? '✅ 渠道已更新' : '✅ 渠道已创建'); loadChannels();
}
async function editChannel(id) {
  const j = await api('/api/channel/');
  if (!j.success) return toast(j.message, 'err');
  const c = (j.data || []).find(x => x.id === id);
  if (!c) return toast('渠道不存在', 'err');
  openChannelModal(c);   // api_key 是脱敏串，弹窗里留空即不修改
}
// 列表一键「同步模型」：探测上游 → 直接落库
async function syncChannelModels(id, name) {
  if (!confirm(`同步「${name}」的模型列表？\n将探测上游 /models 并覆盖该渠道的模型清单。`)) return;
  toast('探测中…');
  const j = await api('/api/channel/models', { method: 'POST', body: JSON.stringify({ id }) });
  if (!j.success) return toast(j.message || '探测失败', 'err');
  toast(`✅ ${name} 模型已同步 ${j.data.count} 个`);
  loadChannels();
}
$('btnProbeGo').onclick = async () => {
  const base_url = $('probeUrl').value.trim();
  if (!base_url) return toast('请输入上游地址', 'err');
  $('probeResult').textContent = '探测中…';
  const j = await api('/api/channel/models', { method: 'POST', body: JSON.stringify({ base_url, api_key: $('probeKey').value.trim() }) });
  $('probeResult').textContent = j.success
    ? `✅ 共 ${j.data.count} 个模型：${j.data.models.slice(0, 30).join(', ')}${j.data.count > 30 ? ' …' : ''}`
    : '❌ ' + j.message;
};
$('btnNewPrice').onclick = () => editPrice('', undefined, undefined);
$('btnAllPrices').onclick = showAllPrices;

// ---------- 用户管理 ----------
async function loadUsers() {
  const j = await api('/api/admin/user/list');
  if (!j.success) { $('userBody').innerHTML = `<tr><td colspan="9" class="empty">${esc(j.message)}</td></tr>`; return; }
  $('userCount').textContent = j.data.length + ' 人';
  $('userBody').innerHTML = j.data.map(u => `
    <tr>
      <td>${u.id}</td><td>${esc(u.username)}</td>
      <td>${u.role >= 100 ? '<span class="tag admin">管理员</span>' : '<span class="tag">用户</span>'}</td>
      <td><span class="tag ${u.status === 1 ? 'on' : 'off'}">${u.status === 1 ? '正常' : '禁用'}</span></td>
      <td>${fmtUsd(u.quota)}</td><td>${fmtUsd(u.used_quota)}</td>
      <td>${fmtMe(u.request_count)}</td>
      <td>${u.inviter_id ? '有' : '—'}${u.invite_reward ? ' / ' + fmtUsd(u.invite_reward) : ''}</td>
      <td class="actions">
        <button class="btn-ghost sm" onclick="editUser(${u.id},'${esc(u.username)}',${u.status},${u.role},'${esc(u.remark || '')}')">管理</button>
        <button class="btn-ghost sm" onclick="downloadSettle(${u.id})">结算</button>
        <button class="btn-ghost sm" title="导出该帐号全部数据（令牌/日志/流水/签到），用于迁移到其他实例" onclick="exportAccount(${u.id},'${esc(u.username)}','${u.log_count || 0}')">📦迁移</button>
        ${u.role >= 100 ? '' : `<button class="btn-ghost sm btn-danger" onclick="deleteUser(${u.id},'${esc(u.username)}')">删除</button>`}
      </td>
    </tr>`).join('');
  loadRedemptions();
  loadAudit();
}

// ---------- 帐号数据迁移 ----------
// 一键导出单个帐号：流式下载 JSONL（令牌含明文 key / 全量日志 / 资金流水 / 签到 / 审计）
async function exportAccount(id, name, logCount) {
  const lc = parseInt(logCount || 0, 10);
  // 预估：jsonl ~530B/行；gz 压缩后 ~13%（实测 394MB→52MB）
  const estMB = lc * 530 / 1048576;
  const estGzMB = estMB * 0.15 + 0.5;
  const estGenS = lc === 0 ? 0 : Math.min(210, Math.max(0.3, lc / 10000 * 0.21));
  const fmtT = s => s < 1 ? '<1s' : s < 60 ? Math.round(s) + 's' : Math.round(s / 6) / 10 + ' 分钟';
  // 【2026-10-22 v4 正经版】弹一个真下载面板（不是 confirm），给两个按钮：
  //   📦 .gz 压缩包（推荐，52MB 级传输快） / 📄 .jsonl 原始包
  // 都走 <a download> 浏览器原生下载器：零 JS 内存 + 系统级断点续传 + 通知栏进度
  const hasGz = estMB > 5;   // >5MB 提供 gz 选项
  openModal(`
    <h3>📦 导出迁移包 — ${esc(name)}（#${id}）</h3>
    <p class="muted">包含：余额/角色/代理 · API 令牌（明文 key）· 全部日志 · 资金流水 · 签到<br>
       ⏱️ 原始包 ≈${estMB.toFixed(0)}MB${hasGz ? ' · 压缩包 ≈' + estGzMB.toFixed(0) + 'MB' : ''}${lc ? '（' + lc.toLocaleString() + ' 行日志）' : ''} · ${estGenS < 1 ? '已就绪秒下' : '首次生成约 ' + fmtT(estGenS)}
    </p>
    <p class="muted" style="margin-top:6px">📥 下载走浏览器下载管理器（系统级断点续传；中断重新点同一按钮即续传）</p>
    <div style="display:flex;gap:10px;margin-top:16px;flex-wrap:wrap">
      ${hasGz ? `<button class="btn-primary" id="migGzBtn">📦 下载压缩包 .gz（≈${estGzMB.toFixed(0)}MB，快）</button>` : ''}
      <button class="btn-ghost ${hasGz ? '' : 'btn-primary'}" id="migRawBtn">📄 原始包 .jsonl（≈${estMB.toFixed(0)}MB）</button>
    </div>
    <div id="migSt" class="muted" style="margin-top:12px"></div>
  `);
  const st = $('migSt');
  const doDl = async (gz) => {
    const btn = gz ? $('migGzBtn') : $('migRawBtn');
    if (btn) btn.disabled = true;
    st.textContent = '检查服务器包状态…';
    try {
      // probe
      let hasFile = false, size = 0, gzReady = false, gzSize = 0;
      const pj = await api(`/api/admin/user/export?id=${id}&probe=1`);
      if (pj) { hasFile = !!pj.hasFile; size = pj.size || 0; gzReady = !!pj.gzReady; gzSize = pj.gzSize || 0; }
      st.textContent = gz ? (gzReady ? `压缩包已就绪（${(gzSize / 1048576).toFixed(1)}MB），开始下载…` : '服务器正在压缩（几十秒），完成后自动开始下载…')
                          : (hasFile ? `原始包已就绪（${(size / 1048576).toFixed(1)}MB），开始下载…` : '服务器正在生成包，完成后自动开始下载…');
      // 无包 → 触发服务端生成/压缩（等完成返回才继续）
      const prep = gz ? 'prepare-gz' : 'prepare';
      const pr = await api(`/api/admin/user/export?${prep}=1&id=${id}`);
      if (!pr || (pr.ok === false && pr.success === false)) throw new Error((pr && pr.message) || '准备失败');
      if (gz && pr.gzSize) st.textContent = `压缩完成（${(pr.gzSize / 1048576).toFixed(1)}MB），开始下载…`;
      // 交浏览器下载器
      const url = gz
        ? `/api/admin/user/export-gz?id=${id}&resume=1&offset=0&token=${encodeURIComponent(SESSION)}`
        : `/api/admin/user/export?id=${id}&resume=1&offset=0&token=${encodeURIComponent(SESSION)}`;
      const a = document.createElement('a');
      a.href = url;
      a.download = gz ? `帐号迁移_${name}_${id}.jsonl.gz` : `帐号迁移_${name}_${id}.jsonl`;
      document.body.appendChild(a); a.click(); a.remove();
      st.innerHTML = '📥 已交给浏览器下载——请看<b>浏览器下载栏/系统通知</b>的进度。断线后重新点本页按钮即自动续传。';
      if (btn) btn.disabled = false;
    } catch (e) {
      st.innerHTML = '<span style="color:#f66">❌ ' + esc(e.message) + '</span>';
      if (btn) btn.disabled = false;
    }
  };
  if ($('migGzBtn')) $('migGzBtn').onclick = () => doDl(true);
  if ($('migRawBtn')) $('migRawBtn').onclick = () => doDl(false);
}

// 导入帐号：上传 .jsonl（可另存新帐号，或合并到已有帐号）
function openImportAccount() {
  api('/api/admin/user/list').then(j => {
    const users = j.success ? j.data : [];
    const opts = users.map(u => `<option value="${u.id}">#${u.id} ${esc(u.username)}${u.agent_level ? ' (L' + u.agent_level + ')' : ''}${u.role >= 100 ? ' (管理员)' : ''}</option>`).join('');
    openModal(`
    <h3>📥 导入帐号（数据迁移）</h3>
    <p class="muted">上传从其他实例导出的 <code>.jsonl</code> 帐号迁移文件。<br>
      包含：用户主记录（余额/角色/代理）、API 令牌（key 保持可用）、全部日志、资金流水、签到、审计。</p>
    <label>迁移文件（.jsonl）</label>
    <input type="file" id="impFile" accept=".jsonl,.json,.txt">
    <label>导入方式</label>
    <select id="impMode" style="width:100%">
      <option value="new">➕ 新建帐号（用户名冲突自动加后缀 _2/_3…）</option>
      <option value="merge">🔀 合并到已有帐号（追加日志/流水/令牌，保留目标帐号现有数据）</option>
    </select>
    <div id="impTargetWrap" style="display:none">
      <label>目标帐号</label>
      <select id="impTarget" style="width:100%"><option value="">— 选择目标帐号 —</option>${opts}</select>
    </div>
    <label>密码（新建模式生效，留空 = 随机生成并显示一次）</label>
    <input id="impPass" placeholder="留空随机">
    <div class="modal-actions">
      <button class="btn-ghost" onclick="closeModal()">取消</button>
      <button class="btn-primary" id="impGo" onclick="doImportAccount()">导入</button>
    </div>`);
    $('impMode').onchange = () => { $('impTargetWrap').style.display = $('impMode').value === 'merge' ? '' : 'none'; };
  });
}
async function doImportAccount() {
  const f = $('impFile').files[0];
  if (!f) return toast('请选择迁移文件', 'err');
  const mode = $('impMode').value;
  const targetId = parseInt($('impTarget').value || '0', 10);
  if (mode === 'merge' && !targetId) return toast('请选择目标帐号', 'err');
  const pw = $('impPass').value || '';
  const btn = $('impGo'); btn.disabled = true; btn.textContent = '导入中…';
  try {
    const text = await f.text();
    let qs = '?mode=' + mode;
    if (mode === 'merge') qs += '&target_id=' + targetId;
    const body = { data: text };
    if (pw) body.password = pw;
    const j = await api('/api/admin/user/import' + qs, { method: 'POST', body: JSON.stringify(body) });
    if (!j.success) return toast(j.message || '导入失败', 'err');
    let msg = j.message;
    if (j.data && j.data.new_password) msg += `\n\n新帐号：${j.data.new_username}\n密码：${j.data.new_password}\n（请立刻告知用户并修改）`;
    closeModal();
    alert('✅ ' + msg);
    loadUsers();
  } catch (e) {
    toast('导入失败：' + e.message, 'err');
  } finally { btn.disabled = false; btn.textContent = '导入'; }
}

// 迁移进度浮层（导出大文件时显示）
let __migEl = null;
function showMigrateProgress(tip) {
  hideMigrateProgress();
  __migEl = document.createElement('div');
  __migEl.style.cssText = 'position:fixed;left:50%;top:16px;transform:translateX(-50%);z-index:9999;background:#1f2937;color:#fff;padding:10px 18px;border-radius:8px;font-size:13px;box-shadow:0 6px 24px rgba(0,0,0,.3);max-width:80vw';
  __migEl.textContent = tip;
  document.body.appendChild(__migEl);
}
function setMigrateProgress(tip) { if (__migEl) __migEl.textContent = tip; }
function hideMigrateProgress() { if (__migEl) { __migEl.remove(); __migEl = null; } }

// ---------- 归属变更审计日志 ----------
async function loadAudit() {
  const kw = ($('auditFilter') && $('auditFilter').value.trim()) || '';
  const q = kw ? ('?user=' + encodeURIComponent(kw)) : '';
  const j = await api('/api/agent/audit' + q);
  if (!j.success) { $('auditBody').innerHTML = `<tr><td colspan="9" class="empty">${esc(j.message)}</td></tr>`; return; }
  const rows = kw ? j.data.filter(r => String(r.target_user_id) === kw || (r.target_name || '').includes(kw)) : j.data;
  $('auditCount').textContent = rows.length + ' 条';
  if (!rows.length) { $('auditBody').innerHTML = '<tr><td colspan="9" class="empty">暂无记录</td></tr>'; return; }
  $('auditBody').innerHTML = rows.map(r => `
    <tr>
      <td>${fmtTime(r.created_at)}</td>
      <td>${esc(r.op_username)}</td>
      <td>${esc(r.op_role)}</td>
      <td>${esc(r.target_name)} <span class="muted">#${r.target_user_id}</span></td>
      <td>${esc(r.old_inviter)}</td>
      <td><b>${esc(r.new_inviter)}</b></td>
      <td>${r.level_before !== r.level_after ? ('L' + r.level_before + ' → L' + r.level_after) : ('L' + r.level_after)}</td>
      <td>${esc(r.action)}</td>
      <td>${esc(r.ip || '—')}</td>
    </tr>`).join('');
}
if ($('btnReloadAudit')) $('btnReloadAudit').onclick = loadAudit;
if ($('auditFilter')) $('auditFilter').oninput = () => { clearTimeout(window.__auditT); window.__auditT = setTimeout(loadAudit, 300); };
$('btnReloadUsers').onclick = () => { loadUsers(); };
$('btnViewTree').onclick = () => showUserTree();
if ($('btnBulkCreate')) $('btnBulkCreate').onclick = openBulkCreate;
if ($('btnImportAccount')) $('btnImportAccount').onclick = openImportAccount;
function openBulkCreate() {
  api('/api/admin/user/list').then(j => {
    const users = j.success ? j.data : [];
    const agentOpts = users.filter(u => u.agent_level > 0 || u.role >= 100)
      .map(u => `<option value="${u.id}" data-aname="${esc(u.agent_name || '')}">#${u.id} ${esc(u.username)}${u.agent_level ? ' (L' + u.agent_level + ' ' + esc(u.agent_name || '') + ')' : (u.role >= 100 ? ' (管理员)' : '')}</option>`).join('');
    const allOpts = users.map(u => `<option value="${u.id}" data-aname="${esc(u.agent_name || '')}">#${u.id} ${esc(u.username)}${u.agent_level ? ' (L' + u.agent_level + ')' : ''}</option>`).join('');
    openModal(`
    <h3>➕ 批量建用户</h3>
    <p class="muted">按「前缀 + 序号」自动生成用户名，默认密码 <code>123456</code>（用户登录后可自行修改）。</p>
    <label>用户名前缀</label>
    <input id="bcPrefix" value="user" placeholder="如 user / 客户 / cs">
    <label>数量（1-200）</label>
    <input id="bcCount" type="number" value="10" min="1" max="200">
    <label>起始序号（可选）</label>
    <input id="bcStart" type="number" placeholder="留空自动（从 1 开始）">
    <label>序号位数</label>
    <input id="bcDigits" type="number" value="4" min="1" max="8">
    <label>默认密码</label>
    <input id="bcPass" value="123456">
    <label>初始额度（USD，可选，0 = 不送）</label>
    <input id="bcQuota" type="number" value="0" step="0.5">
    <label>归属代理（可选，建好的用户成为其下级）</label>
    <select id="bcInviter" style="width:100%">
      <option value="0" data-aname="">— 不挂代理（平台直营）—</option>
      <optgroup label="代理">${agentOpts}</optgroup>
      <optgroup label="全部用户">${allOpts}</optgroup>
    </select>
    <p class="muted" style="margin-top:10px">示例：前缀 <code>user</code> + 位数 4 → user0001, user0002 …</p>
    <div class="modal-actions">
      <button class="btn-ghost" onclick="closeModal()">取消</button>
      <button class="btn-primary" onclick="doBulkCreate()">创建</button>
    </div>`);
  });
}
async function doBulkCreate() {
  const prefix = ($('bcPrefix').value || 'user').trim();
  const count = parseInt($('bcCount').value, 10) || 1;
  const startIndex = $('bcStart').value;
  const digits = parseInt($('bcDigits').value, 10) || 4;
  const password = $('bcPass').value || '123456';
  const quotaUsd = parseFloat($('bcQuota').value) || 0;
  const inviter_id = parseInt($('bcInviter').value, 10) || 0;
  const sel = $('bcInviter').selectedOptions[0];
  const agent_name = sel ? (sel.dataset.aname || '') : '';
  if (count < 1 || count > 200) return toast('数量需在 1-200 之间', 'err');
  const j = await api('/api/admin/user/bulk', { method: 'POST', body: JSON.stringify({
    prefix, count, startIndex, digits, password, quota: Math.round(quotaUsd * 500000), inviter_id, agent_name,
  }) });
  if (!j.success) return toast(j.message, 'err');
  closeModal();
  const list = (j.data || []).map(u => u.username).join(', ');
  openModal(`
    <h3>✅ ${esc(j.message)}</h3>
    <p class="muted">默认密码：<code>${esc(password)}</code>${inviter_id ? ' ｜ 已挂到代理 #' + inviter_id : '（平台直营）'}（建议提醒用户首次登录后修改）</p>
    <textarea readonly style="width:100%;height:180px;font-family:monospace">${esc(list)}</textarea>
    <div class="modal-actions">
      <button class="btn-ghost" onclick="copyText(\`${list}\`)">复制用户名</button>
      <button class="btn-primary" onclick="closeModal();loadUsers()">完成</button>
    </div>`);
}
$('btnViewList').onclick = () => {
  $('userTreeBox').classList.add('hidden'); $('userTable').classList.remove('hidden');
  $('btnViewTree').classList.remove('active'); $('btnViewList').classList.add('active');
  loadUsers();
};

let ALLUSERS = [];
function showUserTree() {
  $('userTreeBox').classList.remove('hidden'); $('userTable').classList.add('hidden');
  $('btnViewTree').classList.add('active'); $('btnViewList').classList.remove('active');
  loadUserTree();
}
async function loadUserTree() {
  const j = await api('/api/admin/agent/tree');
  if (!j.success) { $('userTreeBox').innerHTML = `<div class="empty">${esc(j.message)}</div>`; return; }
  const render = (n) => {
    const kids = n.children || [];
    const hasKids = kids.length > 0;
    return `
    <div class="tree-node" data-nid="${n.id}">
      <div class="tree-line">
        ${hasKids
          ? `<span class="tree-toggle" onclick="toggleTreeNode(this)">+</span>`
          : '<span class="tree-toggle empty">·</span>'}
        <span class="tname">${esc(n.username)}</span>
        <span class="tlevel">${n.agent_level ? '代理L' + n.agent_level + (n.agent_name ? ' · ' + esc(n.agent_name) : '') : '普通用户'}</span>
        <span class="tmeta">ID ${n.id}</span>
        <span class="tmeta">余额 ${fmtUsd(n.quota || 0)} | 已用 ${fmtUsd(n.used_quota || 0)}</span>
        <button class="btn-ghost sm" onclick="editUpline(${n.id},'${esc(n.username)}')">改上级</button>
        <button class="btn-ghost sm" onclick="editUser(${n.id},'${esc(n.username)}',${n.status || 1},${n.role || 1},'${esc(n.remark || '')}')">管理</button>
        ${(n.role || 1) >= 100 || n.id === (ME && ME.id) ? '' : `<button class="btn-ghost sm btn-danger" onclick="deleteUser(${n.id},'${esc(n.username)}')">删除</button>`}
      </div>
      ${hasKids ? `<div class="tree-children">${kids.map(render).join('')}</div>` : ''}
    </div>`;
  };
  $('userTreeBox').innerHTML = j.data.length ? j.data.map(render).join('') : '<div class="empty">暂无用户</div>';
  initTreeCollapse('userTreeBox');
}

// 改上级：可指定任意用户为上级（admin 可重挂任何人）
async function editUpline(id, name) {
  const j = await api('/api/admin/user/list');
  const all = (j.success ? j.data : []).filter(u => u.id !== id);
  const self = j.success ? j.data.find(u => u.id === id) : null;
  const cur = self ? (self.inviter_id || 0) : 0;
  const opts = all.map(u => `<option value="${u.id}" ${u.id === cur ? 'selected' : ''}>#${u.id} ${esc(u.username)}</option>`).join('');
  openModal(`
    <h3>设置「${esc(name)}」(ID ${id}) 的上级</h3>
    <p class="muted">选择新的上级用户（可搜用户名）；选「无上级」则归平台直营。</p>
    <label>输入关键字筛选</label>
    <input id="upFilter" placeholder="输入用户名/ID 过滤" oninput="filterUplineOptions()">
    <label>上级用户</label>
    <select id="upSelect" size="8" style="width:100%">
      <option value="0" ${cur === 0 ? 'selected' : ''}>— 无上级（平台直营）—</option>
      ${opts}
    </select>
    <p class="muted" style="margin-top:8px">⚠️ 不能挂到自己的下级（会形成环）。</p>
    <div class="modal-actions">
      <button class="btn-ghost" onclick="closeModal()">取消</button>
      <button class="btn-primary" onclick="saveUpline(${id})">保存</button>
    </div>`);
}
function filterUplineOptions() {
  const kw = $('upFilter').value.trim().toLowerCase();
  const sel = $('upSelect');
  Array.from(sel.options).forEach(o => {
    if (o.value === '0') return;
    o.style.display = (!kw || o.textContent.toLowerCase().includes(kw)) ? '' : 'none';
  });
}
async function saveUpline(id) {
  const inviter = parseInt($('upSelect').value, 10) || 0;
  const j = await api('/api/admin/agent/set', { method: 'POST', body: JSON.stringify({ user_id: id, inviter_id: inviter }) });
  if (!j.success) return toast(j.message, 'err');
  toast('已更新上级');
  closeModal();
  loadUserTree();
}
async function deleteUser(id, name) {
  const input = prompt(`⚠️ 删除用户「${name}」(ID ${id})\n\n将清除其令牌/会话/流水/签到记录，下级账号挂回平台。\n此操作不可恢复！\n\n请输入用户名以确认：`);
  if (input === null) return;
  if (input.trim() !== name) return toast('输入不一致，已取消', 'err');
  const j = await api('/api/admin/user/delete', { method: 'POST', body: JSON.stringify({ id, confirm: name }) });
  if (!j.success) return toast(j.message, 'err');
  toast('✅ ' + (j.message || '已删除'));
  loadUsers(); loadUserTree();
}
function editUser(id, name, status, role, remark) {
  openModal(`
    <h3>管理用户「${esc(name)}」(ID ${id})</h3>
    <label>充值（美元，正数加、负数扣）</label><input id="euAdd" type="number" value="1" step="0.5">
    <label>充值后的总余额（美元，留空则不改）</label><input id="euQuota" type="number" step="0.5" placeholder="绝对余额，可选">
    <label>状态</label>
    <select id="euStatus"><option value="1" ${status === 1 ? 'selected' : ''}>正常</option><option value="2" ${status === 2 ? 'selected' : ''}>禁用</option></select>
    <label>角色</label>
    <select id="euRole"><option value="1" ${role < 100 ? 'selected' : ''}>普通用户</option><option value="100" ${role >= 100 ? 'selected' : ''}>管理员</option></select>
    <label>重置密码（留空不改，≥ 6 位）</label><input id="euPass" type="text" placeholder="例如 ZhongWu@2026!">
    <label>备注</label><input id="euRemark" value="${esc(remark || '')}" placeholder="可选">
    <div class="modal-actions">
      <button class="btn-ghost" onclick="closeModal()">取消</button>
      <button class="btn-primary" onclick="saveUser(${id})">保存</button>
    </div>`);
}
async function saveUser(id) {
  const add = parseFloat($('euAdd').value) || 0;
  const b = {
    id, status: parseInt($('euStatus').value, 10), role: parseInt($('euRole').value, 10),
    remark: $('euRemark').value.trim(),
  };
  if (add) b.add_quota = Math.round(add * 500000);
  const q = $('euQuota').value.trim();
  if (q !== '') b.quota = Math.round(parseFloat(q) * 500000);
  const pw = $('euPass').value.trim();
  if (pw) {
    if (pw.length < 6) return toast('密码至少 6 位', 'err');
    b.password = pw;
  }
  const j = await api('/api/admin/user/update', { method: 'POST', body: JSON.stringify(b) });
  if (!j.success) return toast(j.message, 'err');
  closeModal(); toast('✅ 已保存'); loadUsers();
}

// ---------- 兑换码管理 ----------
async function loadRedemptions() {
  const j = await api('/api/admin/redemption/?p=1&size=50');
  if (!j.success) return;
  $('redeemCount').textContent = j.data.total + ' 个';
  $('redeemBody').innerHTML = j.data.items.length ? j.data.items.map(r => {
    const st = r.status === 1 ? '<span class="tag on">未使用</span>'
      : r.status === 2 ? '<span class="tag">已使用</span>' : '<span class="tag off">已禁用</span>';
    return `<tr>
      <td>${r.id}</td><td class="mono">${esc(r.code)}</td><td>${fmtUsd(r.quota)}</td>
      <td>${esc(r.name)}</td><td>${st}</td><td>${esc(r.used_by_name || '—')}</td>
      <td class="actions">
        <button class="btn-ghost sm" onclick="copyText('${esc(r.code)}')">复制</button>
        ${r.status === 1 ? `<button class="btn-ghost sm" onclick="toggleRedeem(${r.id},3)">禁用</button>` : ''}
        ${r.status === 3 ? `<button class="btn-ghost sm" onclick="toggleRedeem(${r.id},1)">启用</button>` : ''}
        <button class="btn-ghost sm btn-danger" onclick="delRedeem(${r.id})">删除</button>
      </td>
    </tr>`;
  }).join('') : '<tr><td colspan="7" class="empty">还没有兑换码</td></tr>';
}
async function toggleRedeem(id, status) {
  const j = await api('/api/admin/redemption/update', { method: 'POST', body: JSON.stringify({ id, status }) });
  if (!j.success) return toast(j.message, 'err');
  loadRedemptions();
}
async function delRedeem(id) {
  if (!confirm('确认删除该兑换码？')) return;
  await api('/api/admin/redemption/delete', { method: 'POST', body: JSON.stringify({ id }) });
  loadRedemptions();
}
$('btnGenRedeem').onclick = () => {
  openModal(`
    <h3>生成兑换码</h3>
    <label>数量（1-500）</label><input id="rdCount" type="number" value="10" min="1" max="500">
    <label>面额（美元）</label><input id="rdQuota" type="number" value="5" step="0.5">
    <label>备注</label><input id="rdName" placeholder="例如 双十一活动">
    <div class="modal-actions">
      <button class="btn-ghost" onclick="closeModal()">取消</button>
      <button class="btn-primary" onclick="genRedeem()">生成</button>
    </div>`);
};
async function genRedeem() {
  const b = {
    count: parseInt($('rdCount').value, 10) || 1,
    quota: Math.round((parseFloat($('rdQuota').value) || 0) * 500000),
    name: $('rdName').value.trim(),
  };
  const j = await api('/api/admin/redemption/', { method: 'POST', body: JSON.stringify(b) });
  if (!j.success) return toast(j.message, 'err');
  const codes = j.data.codes.map(c => c.code);
  openModal(`
    <h3>已生成 ${j.data.count} 个兑换码</h3>
    <pre class="code" style="max-height:260px;overflow:auto">${esc(codes.join('\n'))}</pre>
    <div class="modal-actions">
      <button class="btn-ghost" onclick="closeModal()">关闭</button>
      <button class="btn-primary" onclick="copyText(\`${codes.join('\\n')}\`);closeModal()">全部复制</button>
    </div>`);
  loadRedemptions();
}

// ---------- 设置 ----------
async function loadSettings() {
  const j = await api('/api/settings');
  if (j.success) {
    const s = j.data;
    $('sSiteName').value = s.site_name || '';
    $('sSignup').value = s.signup_quota || 0;
    $('sCheckin').value = s.checkin_quota || 0;
    $('sRate').value = s.rate_limit_per_min || 0;
    $('sInvite').value = s.invite_reward_rate || 0;
    if ($('sR2')) $('sR2').value = s.agent_reward_l2 || 0;
    if ($('sR3')) $('sR3').value = s.agent_reward_l3 || 0;
    $('sAnnounce').value = s.announcement || '';
  }
  const st = await api('/api/admin/stats');
  if (st.success) {
    const d = st.data;
    $('sysStats').innerHTML = `
      <div><b>${d.users}</b><span>用户数</span></div>
      <div><b>${d.requests}</b><span>总请求</span></div>
      <div><b>${fmtTok(d.tokens)}</b><span>总 Tokens</span></div>
      <div><b>${fmtUsd(d.log_quota)}</b><span>平台总流水</span></div>
      <div><b>${d.channels}</b><span>渠道数</span></div>`;
  }
  // 【2026-10-21】运营面板：今日请求/错误率/上游余额/Top错误
  const ops = st.success ? st.ops : null;
  const el = $('opsPanel');
  if (el && ops) {
    const t = ops.today || {};
    const rows = (ops.top_errors || []).map(r =>
      `<tr><td class="mono">${esc(r.model_name)}</td><td>${r.c}</td><td class="mono" style="max-width:340px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc((r.sample||'').slice(0,90))}</td></tr>`).join('');
    const ups = (ops.upstream_balance || []).map(u => {
      const b = u.balance;
      if (!b) return `<div><b>—</b><span>${esc(u.name)}</span></div>`;
      const pct = (b.used != null && b.limit > 0) ? Math.min(100, Math.round(b.used / b.limit * 100)) : null;
      const rem = (b.limit != null && b.used != null) ? (b.limit - b.used).toFixed(2) : '—';
      return `<div><b>$${rem}${pct != null ? ` <small style="color:${pct > 85 ? '#ff7b72' : '#7ee787'}">${pct}%</small>` : ''}</b><span>${esc(u.name)}</span></div>`;
    }).join('');
    el.innerHTML = `
      <div class="mini-row" style="display:flex;gap:18px;flex-wrap:wrap;margin-bottom:10px">
        <div><b>${fmtMe(t.requests || 0)}</b><span>今日请求</span></div>
        <div><b style="color:${ops.error_rate > 5 ? '#ff7b72' : '#7ee787'}">${ops.error_rate}%</b><span>错误率</span></div>
        <div><b>${fmtUsd(Math.round((t.usd || 0) * 500000))}</b><span>今日消费</span></div>
        <div><b>${t.active_users || 0}</b><span>活跃用户</span></div>
      </div>
      <div style="font-size:12.5px;color:var(--dim);margin-bottom:6px">上游余额（尽力探测）</div>
      <div style="display:flex;gap:18px;flex-wrap:wrap">${ups || '<span class="muted">无数据</span>'}</div>
      ${rows ? `<table class="tbl" style="margin-top:10px"><thead><tr><th>错误模型</th><th>次数</th><th>样例</th></tr></thead><tbody>${rows}</tbody></table>` : ''}`;
  } else if (el) el.innerHTML = '<span class="muted">运营数据加载失败</span>';
}
$('btnSaveSettings').onclick = async () => {
  const b = {
    site_name: $('sSiteName').value.trim(),
    signup_quota: $('sSignup').value, checkin_quota: $('sCheckin').value,
    rate_limit_per_min: $('sRate').value, invite_reward_rate: $('sInvite').value,
    agent_reward_l2: $('sR2') ? $('sR2').value : undefined, agent_reward_l3: $('sR3') ? $('sR3').value : undefined,
    announcement: $('sAnnounce').value.trim(),
  };
  const j = await api('/api/settings', { method: 'POST', body: JSON.stringify(b) });
  if (!j.success) return toast(j.message, 'err');
  toast('✅ 设置已保存');
  $('sideSite').textContent = b.site_name || '算力商城';
  document.title = b.site_name || '算力商城';
  loadAnnounce();
};

// ---------- 个人设置 ----------
async function loadProfile() {
  const j = await api('/api/user/self');
  if (!j.success) return;
  ME = j.data;
  $('pfUser').textContent = ME.username;
  $('pfId').textContent = ME.id;
  $('pfRole').textContent = ME.role >= 100 ? '管理员' : '普通用户';
  $('pfGroup').textContent = ME.group;
  $('pfAff').textContent = ME.aff_code;
  $('pfCreated').textContent = fmtTime(ME.created_at);
  $('pfName').value = ME.display_name || '';
  if ($('pfUsername')) $('pfUsername').value = ME.username || '';
  $('pwOld').value = ''; $('pwNew').value = ''; $('pwNew2').value = '';
  $('pwMsg').textContent = '';
}

$('btnSaveUsername').onclick = async () => {
  const un = $('pfUsername').value.trim();
  if (!un) return toast('用户名不能为空', 'err');
  if (un === ME.username) return toast('用户名未变化', 'err');
  const j = await api('/api/user/update', { method: 'POST', body: JSON.stringify({ username: un }) });
  if (!j.success) return toast(j.message, 'err');
  ME = j.data;
  $('pfUser').textContent = ME.username;
  $('sideUser').innerHTML = `<b>${esc(ME.display_name || ME.username)}</b>ID: ${ME.id}${IS_ADMIN ? ' · 管理员' : ''}`;
  toast('✅ ' + j.message);
};

$('btnSaveName').onclick = async () => {
  const dn = $('pfName').value.trim();
  if (!dn) return toast('昵称不能为空', 'err');
  const j = await api('/api/user/update', { method: 'POST', body: JSON.stringify({ display_name: dn }) });
  if (!j.success) return toast(j.message, 'err');
  ME = j.data;
  $('sideUser').innerHTML = `<b>${esc(ME.display_name || ME.username)}</b>ID: ${ME.id}${IS_ADMIN ? ' · 管理员' : ''}`;
  toast('✅ ' + j.message);
};

$('btnChangePw').onclick = async () => {
  const oldpw = $('pwOld').value;
  const np = $('pwNew').value;
  const np2 = $('pwNew2').value;
  const msg = $('pwMsg');
  msg.className = 'auth-msg err';
  if (!oldpw) { msg.textContent = '请输入当前密码'; return; }
  if (np.length < 6) { msg.textContent = '新密码至少 6 位'; return; }
  if (np !== np2) { msg.textContent = '两次输入的新密码不一致'; return; }
  if (np === oldpw) { msg.textContent = '新密码不能与当前密码相同'; return; }
  $('btnChangePw').disabled = true;
  const j = await api('/api/user/update', { method: 'POST', body: JSON.stringify({ old_password: oldpw, password: np }) });
  $('btnChangePw').disabled = false;
  if (!j.success) { msg.textContent = j.message; return; }
  msg.className = 'auth-msg';
  msg.textContent = '✅ 密码已修改，正在退出登录…';
  toast('✅ 密码已修改，请用新密码重新登录');
  setTimeout(async () => {
    try { await api('/api/user/logout', { method: 'POST' }); } catch {}
    SESSION = null; localStorage.removeItem(SKEY); location.reload();
  }, 1500);
};

// ---------- 资金流水 ----------
const LEDGER_KIND = { recharge: '充值', transfer_in: '划入', transfer_out: '划出', redeem: '兑换码', checkin: '签到', reward: '返佣', consume: '消费', opening: '期初余额', adjust: '调整', refund: '退款' };
async function loadLedger() {
  const kw = ($('ledgerFilter') && $('ledgerFilter').value.trim()) || '';
  const kind = ($('ledgerKind') && $('ledgerKind').value) || '';
  let url = '/api/ledger?limit=300';
  if (kw && IS_ADMIN) url += '&user=' + encodeURIComponent(kw);
  if (kind) url += '&kind=' + encodeURIComponent(kind);
  const j = await api(url);
  if (!j.success) { $('ledgerBody').innerHTML = `<tr><td colspan="8" class="empty">${esc(j.message)}</td></tr>`; return; }
  const rows = j.data;
  $('ledgerCount').textContent = rows.length + ' 条';
  let tin = 0, tout = 0;
  for (const r of rows) { if (r.delta > 0) tin += r.delta; else tout += r.delta; }
  $('ledgerStats').innerHTML = `
    <div><b>${fmtUsd(tin)}</b><span>入账合计</span></div>
    <div><b>${fmtUsd(tout)}</b><span>出账合计</span></div>
    <div><b>${fmtUsd(tin + tout)}</b><span>净变动</span></div>`;
  if (!rows.length) { $('ledgerBody').innerHTML = '<tr><td colspan="8" class="empty">暂无流水</td></tr>'; return; }
  $('ledgerBody').innerHTML = rows.map(r => {
    const cls = r.delta >= 0 ? 'on' : 'off';
    return `
    <tr>
      <td>${fmtTime(r.created_at)}</td>
      <td>${esc(r.username)} <span class="muted">#${r.user_id}</span></td>
      <td><span class="tag ${cls}">${LEDGER_KIND[r.kind] || esc(r.kind)}</span></td>
      <td style="color:${r.delta >= 0 ? '#4ade80' : '#f87171'};font-weight:600">${r.delta >= 0 ? '+' : ''}${fmtUsd(r.delta)}</td>
      <td>${fmtUsd(r.balance_after)}</td>
      <td class="muted">${esc(r.detail || '')}</td>
      <td>${esc(r.op_username || '—')}${r.op_role ? ' <span class="muted">(' + esc(r.op_role) + ')</span>' : ''}</td>
      <td class="muted">${esc(r.ip || '—')}</td>
    </tr>`;
  }).join('');
}
if ($('btnReloadLedger')) $('btnReloadLedger').onclick = loadLedger;
if ($('ledgerFilter')) $('ledgerFilter').oninput = () => { clearTimeout(window.__lgT); window.__lgT = setTimeout(loadLedger, 300); };
if ($('ledgerKind')) $('ledgerKind').onchange = loadLedger;

// ---------- 层级树折叠 ----------
// 渲染后初始化：默认展开一层（根节点展开，深层收起）
function initTreeCollapse(boxId) {
  const box = document.getElementById(boxId);
  if (!box) return;
  const nodes = box.querySelectorAll('.tree-node');
  nodes.forEach((node, idx) => {
    const toggle = node.querySelector(':scope > .tree-line > .tree-toggle');
    const kids = node.querySelector(':scope > .tree-children');
    if (!toggle || !kids) return;
    // 默认：根节点（无父 .tree-children）展开；有父的收起
    const inChild = node.parentElement && node.parentElement.classList.contains('tree-children');
    if (inChild) {
      kids.classList.add('collapsed');
      toggle.textContent = '+';
    } else {
      toggle.textContent = '−';
    }
  });
}
function toggleTreeNode(el) {
  const node = el.closest('.tree-node');
  if (!node) return;
  const kids = node.querySelector(':scope > .tree-children');
  if (!kids) return;
  const collapsed = kids.classList.toggle('collapsed');
  el.textContent = collapsed ? '+' : '−';
}
// 全局展开/收起
function expandAllTree(boxId, expand) {
  const box = document.getElementById(boxId);
  if (!box) return;
  box.querySelectorAll('.tree-children').forEach(k => k.classList.toggle('collapsed', !expand));
  box.querySelectorAll('.tree-toggle').forEach(t => { if (!t.classList.contains('empty')) t.textContent = expand ? '−' : '+'; });
}

// ---------- 代理团队 ----------
// 代理团队页视图切换
if ($('btnTmTree')) $('btnTmTree').onclick = () => {
  $('teamTreeBox').classList.remove('hidden'); $('teamTable').classList.add('hidden');
  $('btnTmTree').classList.add('active'); $('btnTmList').classList.remove('active');
};
if ($('btnTmList')) $('btnTmList').onclick = () => {
  $('teamTreeBox').classList.add('hidden'); $('teamTable').classList.remove('hidden');
  $('btnTmList').classList.add('active'); $('btnTmTree').classList.remove('active');
};

async function loadTeam() {
  const j = await api('/api/agent/team');
  if (!j.success) { $('teamBody').innerHTML = `<tr><td colspan="9" class="empty">${esc(j.message)}</td></tr>`; return; }
  const d = j.data, s = d.stats, by = s.byDepth || {};
  $('tmDirect').textContent = s.direct;
  $('tmTotal').textContent = s.total;
  $('tmReward').textContent = fmtUsd(s.reward_total);
  $('tmL1').textContent = fmtUsd(s.reward_l1);
  $('tmL2').textContent = fmtUsd(s.reward_l2);
  $('tmL3').textContent = fmtUsd(s.reward_l3);
  const up = (d.upline || []).map(p => `${esc(p.username)}${p.agent_level ? ' (L' + p.agent_level + ')' : ''}`);
  $('tmUpline').textContent = up.length ? ('我的上级：' + up.join(' → ')) : '我的上级：平台直营（无上级）';
  $('tmBadge').textContent = d.downline.length + ' 人';
  // 树状视图（以我为首）
  const st = d.subtree;
  if (st && $('teamTreeBox')) {
    const rnode = (n) => {
      const kids = n.children || [];
      const hasKids = kids.length > 0;
      return `
      <div class="tree-node" data-nid="${n.id}">
        <div class="tree-line">
          ${hasKids ? `<span class="tree-toggle" onclick="toggleTreeNode(this)">+</span>` : '<span class="tree-toggle empty">·</span>'}
          <span class="tname">${esc(n.username)}${n.id === d.me.id ? ' (我)' : ''}</span>
          <span class="tlevel">${n.agent_level ? 'L' + n.agent_level + (n.agent_name ? ' · ' + esc(n.agent_name) : '') : '普通用户'}</span>
          <span class="tmeta">ID ${n.id}</span>
          <span class="tmeta">余额 ${fmtUsd(n.quota || 0)} | 已用 ${fmtUsd(n.used_quota || 0)}</span>
          ${n.id !== d.me.id ? `<button class="btn-ghost sm" onclick="openTransfer(${n.id},'${esc(n.username)}')">💰划转</button>` : ''}
        </div>
        ${hasKids ? `<div class="tree-children">${kids.map(rnode).join('')}</div>` : ''}
      </div>`;
    };
    $('teamTreeBox').innerHTML = st ? rnode(st) : '<div class="empty">暂无团队</div>';
    initTreeCollapse('teamTreeBox');
  }
  if (!d.downline.length) { $('teamBody').innerHTML = '<tr><td colspan="9" class="empty">暂无下级成员</td></tr>'; return; }
  $('teamBody').innerHTML = d.downline.map(m => `
    <tr>
      <td>${m.id}</td><td>${esc(m.username)}</td>
      <td><span class="tree-badge">L${m.depth}</span></td>
      <td>${m.agent_level ? ('L' + m.agent_level + ' ' + esc(m.agent_name || '')) : '—'}</td>
      <td>${fmtUsd(m.quota)}</td><td>${fmtUsd(m.used_quota)}</td><td>${fmtMe(m.request_count)}</td>
      <td><span class="tag ${m.status === 1 ? 'on' : 'off'}">${m.status === 1 ? '正常' : '禁用'}</span></td>
      <td class="actions">${m.depth === 1 ? `<button class="btn-ghost sm" onclick="reassignDown(${m.id},'${esc(m.username)}')">切层级</button>` : ''}<button class="btn-ghost sm" onclick="openTransfer(${m.id},'${esc(m.username)}')">💰划转</button></td>
    </tr>`).join('');
}

// 代理自助：切换自己「下1级用户」的归属（可挂到自己或团队内其他下级）
// 代理给下级划转额度（从自己余额）
function openTransfer(id, name) {
  openModal(`
    <h3>💰 给「${esc(name)}」划转额度</h3>
    <p class="muted">从你自己的余额中划出一部分给该下级。我的余额：<b>${fmtUsd(ME.quota)}</b></p>
    <label>划转金额（USD）</label>
    <input id="tfAmt" type="number" value="1" step="0.5" min="0.01">
    <label>快捷</label>
    <div style="display:flex;gap:6px;flex-wrap:wrap">
      ${[1, 5, 10, 50].map(v => `<button class="btn-ghost sm" onclick="$('tfAmt').value=${v}">$${v}</button>`).join('')}
      <button class="btn-ghost sm" onclick="$('tfAmt').value=($('tfAmt').value===''?'':'')">清空</button>
    </div>
    <div class="modal-actions">
      <button class="btn-ghost" onclick="closeModal()">取消</button>
      <button class="btn-primary" onclick="doTransfer(${id})">确认划转</button>
    </div>`);
}
async function doTransfer(id) {
  const usd = parseFloat($('tfAmt').value) || 0;
  if (usd <= 0) return toast('划转金额必须大于 0', 'err');
  const j = await api('/api/agent/transfer', { method: 'POST', body: JSON.stringify({ user_id: id, amount: Math.round(usd * 500000) }) });
  if (!j.success) return toast(j.message, 'err');
  ME = j.data.from;
  refreshBalance();
  closeModal();
  toast('✅ ' + j.message);
  loadTeam();
}

async function reassignDown(id, name) {  const j = await api('/api/agent/team');
  if (!j.success) return toast(j.message, 'err');
  const me = j.data.me;
  // 可选上级 = 自己 + 自己的全部下级
  const cands = [{ id: me.id, username: me.username + '（我）' }, ...j.data.downline.filter(d => d.id !== id).map(d => ({ id: d.id, username: d.username + ' (L' + d.depth + ')' }))];
  const cur = (j.data.downline.find(d => d.id === id) || {});
  const opts = cands.map(c => `<option value="${c.id}">${esc(c.username)}</option>`).join('');
  openModal(`
    <h3>切换「${esc(name)}」的归属</h3>
    <p class="muted">把它挂到团队成员下（可选择自己 = 收归直属）。</p>
    <label>新的上级</label>
    <select id="downSel" style="width:100%">${opts}</select>
    <div class="modal-actions">
      <button class="btn-ghost" onclick="closeModal()">取消</button>
      <button class="btn-primary" onclick="saveReassign(${id})">保存</button>
    </div>`);
}
async function saveReassign(id) {
  const inviter_id = parseInt($('downSel').value, 10);
  const j = await api('/api/agent/reassign', { method: 'POST', body: JSON.stringify({ user_id: id, inviter_id }) });
  if (!j.success) return toast(j.message, 'err');
  toast('已切换归属');
  closeModal();
  if (typeof loadTeam === 'function') loadTeam();
}

// ---------- 代理管理（管理员） ----------
async function loadAgentTree() {
  const j = await api('/api/admin/agent/tree');
  if (!j.success) { $('treeBox').innerHTML = `<div class="empty">${esc(j.message)}</div>`; return; }
  const st = await api('/api/settings');
  if (st.success) {
    $('cfgR1').textContent = (parseFloat(st.data.invite_reward_rate || 0) * 100).toFixed(0) + '%';
    $('cfgR2').textContent = (parseFloat(st.data.agent_reward_l2 || 0) * 100).toFixed(0) + '%';
    $('cfgR3').textContent = (parseFloat(st.data.agent_reward_l3 || 0) * 100).toFixed(0) + '%';
  }
  const render = (n, lvl) => {
    const kids = n.children || [];
    const hasKids = kids.length > 0;
    return `
    <div class="tree-node" data-nid="${n.id}">
      <div class="tree-line">
        ${hasKids
          ? `<span class="tree-toggle" onclick="toggleTreeNode(this)">+</span>`
          : '<span class="tree-toggle empty">·</span>'}
        <span class="tname">${esc(n.username)}</span>
        <span class="tlevel">${n.agent_level ? '代理L' + n.agent_level + (n.agent_name ? ' · ' + esc(n.agent_name) : '') : '普通用户'}</span>
        <span class="tmeta">ID ${n.id}</span>
        ${n.quota !== undefined ? `<span class="tmeta">余额 ${fmtUsd(n.quota)} | 已用 ${fmtUsd(n.used_quota || 0)}</span>` : ''}
        <button class="btn-ghost sm" onclick="downloadSettle(${n.id})">结算</button>
        <button class="btn-ghost sm" onclick="editAgent(${n.id},'${esc(n.username)}',${n.agent_level || 0},'${esc(n.agent_name || '')}',${n.agent_channel_id || 0})">设置</button>
      </div>
      ${hasKids ? `<div class="tree-children">${kids.map(c => render(c, lvl + 1)).join('')}</div>` : ''}
    </div>`;
  };
  $('treeBox').innerHTML = j.data.length ? j.data.map(r => render(r, 0)).join('') : '<div class="empty">暂无用户</div>';
  initTreeCollapse('treeBox');
}
$('btnReloadTree').onclick = loadAgentTree;
if ($('btnSettleAgents')) $('btnSettleAgents').onclick = () => {
  openModal(`
    <h3>📊 导出全部代理结算</h3>
    <p class="muted">每个代理的团队结算总表 + 明细 sheet。</p>
    <label>快捷时间段</label>
    <div style="display:flex;gap:6px;flex-wrap:wrap" id="agQuick">
      <button type="button" class="btn-ghost sm agq" data-days="1">今天</button>
      <button type="button" class="btn-ghost sm agq" data-days="7">近7天</button>
      <button type="button" class="btn-ghost sm agq" data-days="30">近30天</button>
      <button type="button" class="btn-ghost sm agq" data-days="0">全部</button>
    </div>
    <div style="display:flex;align-items:center;gap:8px;margin-top:8px">
      <label style="margin:0">自定义天数</label>
      <input id="agDays" type="number" min="0" value="0" style="width:110px" placeholder="0=全部">
      <span class="muted" id="agDaysHint">当前：全部历史</span>
    </div>
    <label>或：起始日期</label>
    <input id="agFrom" type="date">
    <label>结束日期</label>
    <input id="agTo" type="date">
    <div class="modal-actions">
      <button class="btn-ghost" onclick="closeModal()">取消</button>
      <button class="btn-primary" onclick="doAgentSettleExport()">导出</button>
    </div>`);
  // 同 downloadSettle 的修复：原先快捷按钮写 $('agDays') 但元素不存在 → 点击报错 → 永远全量
  const agInput = $('agDays'), agHint = $('agDaysHint');
  const agSync = () => {
    const d = parseInt(agInput.value || '0', 10) || 0;
    if (agHint) agHint.textContent = d > 0 ? `当前：近 ${d} 天` : '当前：全部历史';
    document.querySelectorAll('#agQuick .agq').forEach(b => b.classList.toggle('active', parseInt(b.dataset.days, 10) === d));
  };
  document.querySelectorAll('#agQuick .agq').forEach(btn => {
    btn.onclick = () => { agInput.value = btn.dataset.days; agSync(); };
  });
  agInput.oninput = agSync;
  agSync();
};
function doAgentSettleExport() {
  let qs = '/api/admin/agent/settle';
  const from = ($('agFrom') && $('agFrom').value) || '';
  const to = ($('agTo') && $('agTo').value) || '';
  const agIn = $('agDays');
  const days = agIn ? (parseInt(agIn.value || '0', 10) || 0) : 0;
  const addQ = (k, v) => { qs += (qs.includes('?') ? '&' : '?') + k + '=' + v; };
  if (from || to) {
    if (from) addQ('from', new Date(from + 'T00:00:00').getTime());
    if (to) {
      const end = new Date(to + 'T00:00:00');
      end.setDate(end.getDate() + 1);
      addQ('until', end.getTime() - 1);
    }
  } else if (days === 1) {
    const d0 = new Date(); d0.setHours(0, 0, 0, 0);
    addQ('from', d0.getTime());
  } else if (days > 0) {
    addQ('days', days);
  }
  const scopeTxt = (from || to) ? `${from || '最早'} ~ ${to || '现在'}`
    : days === 1 ? '今天'
    : days > 0 ? `近 ${days} 天`
    : '全部历史';
  closeModal();
  downloadAuthed(qs, '正在导出全部代理结算清单（' + scopeTxt + '）…');
}

async function editAgent(id, name, level, aname, chId) {
  if (!CH_LIST.length) {
    try { const jc = await api('/api/channel/'); if (jc.success) CH_LIST = jc.data; } catch (e) {}
  }
  const chOpts = CH_LIST.map(c =>
    `<option value="${c.id}" data-cname="${esc(c.name)}" ${Number(chId) === c.id ? 'selected' : ''}>#${c.id} ${esc(c.name)}${c.status === 1 ? '' : '（已禁用）'}</option>`).join('');
  openModal(`
    <h3>设置代理「${esc(name)}」(ID ${id})</h3>
    <label>上级用户 ID（0 = 无上级/平台直营）</label>
    <input id="agUp" type="number" value="0" min="0" placeholder="输入上级的 用户ID">
    <label>代理等级</label>
    <select id="agLevel">
      <option value="0" ${level === 0 ? 'selected' : ''}>普通用户</option>
      <option value="1" ${level === 1 ? 'selected' : ''}>一级代理</option>
      <option value="2" ${level === 2 ? 'selected' : ''}>二级代理</option>
      <option value="3" ${level === 3 ? 'selected' : ''}>三级代理</option>
    </select>
    <label>代理名称（可选）</label>
    <input id="agName" value="${esc(aname || '')}" placeholder="例如：杭州联登科技">
    <label>指定渠道供应商（该代理名下调用强制走此渠道）</label>
    <select id="agChannel">
      <option value="0" ${!chId ? 'selected' : ''}>— 不指定（走通用路由：优先级+权重+故障转移）—</option>
      ${chOpts}
    </select>
    <p class="muted" style="font-size:12px">指定后，此代理及其名下所有成员的请求只会走该渠道；若该渠道不支持所请求的模型或已熔断，将直接报错（不会回退到其他渠道）。</p>
    <div class="modal-actions">
      <button class="btn-ghost" onclick="closeModal()">取消</button>
      <button class="btn-primary" onclick="saveAgent(${id})">保存</button>
    </div>`);
}
async function saveAgent(id) {
  const b = {
    user_id: id,
    inviter_id: parseInt($('agUp').value || '0', 10),
    agent_level: parseInt($('agLevel').value, 10),
    agent_name: $('agName').value.trim(),
    agent_channel_id: parseInt(($('agChannel') && $('agChannel').value) || '0', 10),
  };
  const j = await api('/api/admin/agent/set', { method: 'POST', body: JSON.stringify(b) });
  if (!j.success) return toast(j.message, 'err');
  toast('已保存');
  closeModal();
  loadAgentTree();
}

// ---------- Modal / copy ----------
function openModal(html) { $('modalBox').innerHTML = html; $('modal').classList.remove('hidden'); }
function closeModal() { $('modal').classList.add('hidden'); }
$('modal').onclick = e => { if (e.target.id === 'modal') closeModal(); };
function copyText(t) {
  const done = () => toast('已复制');
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(t).then(done).catch(() => fallbackCopy(t, done));
  } else fallbackCopy(t, done);
}
// 复制某个代码块（<pre class="code" id=...>）的纯文本内容
function copyBlock(id) {
  const el = document.getElementById(id);
  if (!el) return;
  copyText(el.innerText.trim());
}
function fallbackCopy(t, done) {
  try {
    const ta = document.createElement('textarea');
    ta.value = t; ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select(); document.execCommand('copy');
    document.body.removeChild(ta); done();
  } catch { toast('复制失败，请手动选择', 'err'); }
}

// 暴露给 inline onclick
Object.assign(window, {
  showKey, delToken, editToken, saveToken, createToken,
  testChannel, toggleChannel, delChannel, createChannel: saveChannel,
  editChannel, syncChannelModels, probeIntoModal, saveChannel,
  editPrice, savePrice, delPrice, showAllPrices,
  editUser, saveUser, genRedeem, toggleRedeem, delRedeem,
  closeModal, copyText,
});

bootstrap();
