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
  topup: '充值兑换', invite: '邀请返利', profile: '个人设置', channels: '渠道管理',
  users: '用户管理', settings: '系统设置', docs: '接入文档',
};
document.querySelectorAll('.side-nav a').forEach(a => { a.onclick = () => goto(a.dataset.page); });
function goto(page) {
  document.querySelectorAll('.side-nav a').forEach(a => a.classList.toggle('active', a.dataset.page === page));
  document.querySelectorAll('.page').forEach(p => p.classList.toggle('hidden', p.id !== 'page-' + page));
  $('pageTitle').textContent = TITLES[page] || page;
  const fn = {
    dashboard: loadDashboard, tokens: loadTokens, models: loadModels, logs: () => loadLogs(1),
    topup: loadTopup, invite: loadInvite, profile: loadProfile, channels: loadChannels,
    users: loadUsers, settings: loadSettings, docs: () => {},
  }[page];
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
  renderModels(allModels);
}
function renderModels(list) {
  $('modelBody').innerHTML = list.length ? list.map(x => `
    <tr><td class="mono">${esc(x.name)}</td><td>${x.channels || 1}</td>
    <td>$${(x.input ?? 0).toFixed(4)}</td><td>$${(x.output ?? 0).toFixed(4)}</td></tr>`).join('')
    : '<tr><td colspan="4" class="empty">无匹配模型</td></tr>';
}
$('modelSearch').oninput = e => {
  const q = e.target.value.toLowerCase();
  renderModels(allModels.filter(x => x.name.toLowerCase().includes(q)));
};

// ---------- 日志 ----------
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
      <td>${esc(l.channel_name)}</td>
      <td>${fmtTok(l.prompt_tokens)}</td>
      <td>${fmtTok(l.completion_tokens)}</td>
      <td>${(l.use_time || 0).toFixed(1)}s</td>
      <td>${l.quota < 0 ? '+' + fmtUsd(-l.quota) : fmtUsd(l.quota)}</td>
      <td><span class="tag ${l.status === 'success' ? 'on' : 'off'}">${l.status === 'success' ? '成功' : '失败'}</span></td>
    </tr>`).join('') : '<tr><td colspan="9" class="empty">暂无日志</td></tr>';
  lastLogs = d.items;
}
let lastLogs = [];
$('logPrev').onclick = () => loadLogs(Math.max(1, logPage - 1));
$('logNext').onclick = () => loadLogs(logPage + 1);
$('btnExportLogs').onclick = () => {
  if (!lastLogs.length) return toast('当前页无数据', 'err');
  const head = ['时间', '模型', '令牌', '渠道', '输入tok', '输出tok', '总tok', '耗时s', 'quota', '状态'];
  const rows = lastLogs.map(l => [
    new Date(l.created_at).toISOString(), l.model_name, l.token_name, l.channel_name,
    l.prompt_tokens, l.completion_tokens, l.total_tokens, l.use_time, l.quota, l.status,
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
  const url = `/api/log/export${all ? '?all=1' : ''}`;
  const a = document.createElement('a');
  a.href = url;
  a.download = '';
  document.body.appendChild(a); a.click(); a.remove();
  toast(all ? '正在导出全站用量…' : '正在导出使用日志…');
}
$('btnExportXlsx').onclick = () => downloadXlsx(false);
if ($('btnExportAll')) $('btnExportAll').onclick = () => downloadXlsx(true);

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
async function loadChannels() {
  const j = await api('/api/channel/');
  if (!j.success) { $('channelBody').innerHTML = `<tr><td colspan="9" class="empty">${esc(j.message)}</td></tr>`; return; }
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
$('btnNewChannel').onclick = () => {
  openModal(`
    <h3>新建渠道</h3>
    <label>名称</label><input id="chName" placeholder="例如 某某中转站">
    <label>上游地址（OpenAI 兼容 /v1）</label><input id="chUrl" placeholder="https://api.example.com/v1">
    <label>API Key</label><input id="chKey" placeholder="sk-...">
    <label>模型列表（逗号分隔）</label><input id="chModels" placeholder="deepseek-v4-flash,gpt-oss:20b">
    <label>优先级（越大越优先）</label><input id="chPrio" type="number" value="50">
    <label>权重（同优先级分流）</label><input id="chWeight" type="number" value="1">
    <label>模型映射（可选，JSON 如 {"对外名":"上游名"}）</label><input id="chMap" placeholder="">
    <div class="modal-actions">
      <button class="btn-ghost" onclick="closeModal()">取消</button>
      <button class="btn-primary" onclick="createChannel()">创建</button>
    </div>`);
};
async function createChannel() {
  const maps = $('chMap').value.trim();
  const b = {
    name: $('chName').value.trim(), base_url: $('chUrl').value.trim(), api_key: $('chKey').value.trim(),
    models: $('chModels').value.split(',').map(s => s.trim()).filter(Boolean),
    priority: parseInt($('chPrio').value, 10) || 0, weight: parseInt($('chWeight').value, 10) || 1,
  };
  if (maps) { try { b.model_mapping = JSON.parse(maps); } catch { return toast('模型映射不是合法 JSON', 'err'); } }
  if (!b.base_url) return toast('请填写上游地址', 'err');
  const j = await api('/api/channel/', { method: 'POST', body: JSON.stringify(b) });
  if (!j.success) return toast(j.message, 'err');
  closeModal(); toast('✅ 渠道已创建'); loadChannels();
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
        <button class="btn-ghost sm" onclick="editUser(${u.id},'${esc(u.username)}',${u.status},${u.role})">管理</button>
      </td>
    </tr>`).join('');
  loadRedemptions();
}
$('btnReloadUsers').onclick = loadUsers;
function editUser(id, name, status, role) {
  openModal(`
    <h3>管理用户「${esc(name)}」(ID ${id})</h3>
    <label>充值（美元，正数加、负数扣）</label><input id="euAdd" type="number" value="1" step="0.5">
    <label>状态</label>
    <select id="euStatus"><option value="1" ${status === 1 ? 'selected' : ''}>正常</option><option value="2" ${status === 2 ? 'selected' : ''}>禁用</option></select>
    <label>角色</label>
    <select id="euRole"><option value="1" ${role < 100 ? 'selected' : ''}>普通用户</option><option value="100" ${role >= 100 ? 'selected' : ''}>管理员</option></select>
    <label>备注</label><input id="euRemark" placeholder="可选">
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
}
$('btnSaveSettings').onclick = async () => {
  const b = {
    site_name: $('sSiteName').value.trim(),
    signup_quota: $('sSignup').value, checkin_quota: $('sCheckin').value,
    rate_limit_per_min: $('sRate').value, invite_reward_rate: $('sInvite').value,
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
  $('pwOld').value = ''; $('pwNew').value = ''; $('pwNew2').value = '';
  $('pwMsg').textContent = '';
}

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
  testChannel, toggleChannel, delChannel, createChannel,
  editUser, saveUser, genRedeem, toggleRedeem, delRedeem,
  closeModal, copyText,
});

bootstrap();
