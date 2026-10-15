/* 算力商城 API 平台 · 控制台逻辑 */
'use strict';

const $ = id => document.getElementById(id);
const SKEY = 'cmk_console_token';
let SESSION = localStorage.getItem(SKEY) || null;
let ME = null;
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
      ...(SESSION ? { Authorization: 'Bearer ' + SESSION } : {}),
      ...(opts.headers || {}),
    },
  });
  const j = await r.json().catch(() => ({ success: false, message: 'invalid JSON' }));
  return j;
}
function fmtUsd(quota) { return '$' + (quota / 500000).toFixed(4); }
function fmtTok(n) { return (n || 0).toLocaleString('en-US'); }
function fmtTime(ms) {
  if (!ms) return '—';
  const d = new Date(ms);
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

// ---------- 登录 / 注册 ----------
let authTab = 'login';
document.querySelectorAll('.tab').forEach(tab => {
  tab.onclick = () => {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    authTab = tab.dataset.tab;
    $('authSubmit').textContent = authTab === 'login' ? '登录' : '注册';
    $('authMsg').textContent = '';
  };
});

$('authForm').onsubmit = async e => {
  e.preventDefault();
  const username = $('authUser').value.trim();
  const password = $('authPass').value;
  const ep = authTab === 'login' ? '/api/user/login' : '/api/user/register';
  $('authSubmit').disabled = true;
  $('authMsg').textContent = '处理中…';
  try {
    const j = await api(ep, { method: 'POST', body: JSON.stringify({ username, password }) });
    if (j.success) {
      if (authTab === 'login') {
        SESSION = j.data.token;
        localStorage.setItem(SKEY, SESSION);
        toast('✅ 登录成功，欢迎 ' + (j.data.display_name || j.data.username));
        enterApp();
      } else {
        toast('✅ 注册成功，请登录');
        document.querySelector('[data-tab="login"]').click();
        $('authPass').value = '';
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
  SESSION = null;
  localStorage.removeItem(SKEY);
  location.reload();
};

// ---------- 进入控制台 ----------
async function bootstrap() {
  if (!SESSION) return showAuth();
  const j = await api('/api/user/self');
  if (j.success) { ME = j.data; return enterApp(); }
  SESSION = null;
  localStorage.removeItem(SKEY);
  showAuth();
}
function showAuth() { $('appView').classList.add('hidden'); $('authView').classList.remove('hidden'); }

function enterApp() {
  $('authView').classList.add('hidden');
  $('appView').classList.remove('hidden');
  $('sideUser').innerHTML = `<b>${ME.display_name || ME.username}</b>ID: ${ME.id} · ${ME.group}`;
  const base = location.origin;
  $('docBase').textContent = base;
  document.querySelectorAll('.docBaseInline').forEach(e => e.textContent = base);
  refreshBalance();
  goto('dashboard');
}

function refreshBalance() {
  $('balancePill').textContent = '余额 ' + fmtUsd(ME.quota);
  $('dBalance').textContent = fmtUsd(ME.quota);
  $('dUsed').textContent = fmtUsd(ME.used_quota);
  $('dReqs').textContent = fmtMe(ME.request_count);
}
const fmtMe = n => (n >= 10000 ? (n / 10000).toFixed(2) + ' 万' : fmtTok(n));

// ---------- 导航 ----------
document.querySelectorAll('.side-nav a').forEach(a => {
  a.onclick = () => goto(a.dataset.page);
});
const TITLES = { dashboard: '仪表盘', tokens: '令牌管理', models: '模型目录', logs: '使用日志', channels: '渠道管理', docs: '接入文档' };
function goto(page) {
  document.querySelectorAll('.side-nav a').forEach(a => a.classList.toggle('active', a.dataset.page === page));
  document.querySelectorAll('.page').forEach(p => p.classList.toggle('hidden', p.id !== 'page-' + page));
  $('pageTitle').textContent = TITLES[page] || page;
  if (page === 'dashboard') loadDashboard();
  if (page === 'tokens') loadTokens();
  if (page === 'models') loadModels();
  if (page === 'logs') loadLogs(1);
  if (page === 'channels') loadChannels();
}

// ---------- 仪表盘 ----------
async function loadDashboard() {
  const j = await api('/api/user/dashboard');
  if (!j.success) return;
  const d = j.data;
  $('dBalance').textContent = fmtUsd(d.quota);
  $('dUsed').textContent = fmtUsd(d.used_quota);
  $('dReqs').textContent = fmtMe(d.request_count);
  $('dToday').textContent = fmtMe(d.today.requests);
  $('tReq').textContent = fmtTok(d.today.requests);
  $('tTok').textContent = fmtTok(d.today.tokens);
  $('tCost').textContent = fmtUsd(d.today.quota);
  $('balancePill').textContent = '余额 ' + fmtUsd(d.quota);
  ME.quota = d.quota; ME.used_quota = d.used_quota; ME.request_count = d.request_count;

  const s = await api('/api/log/model');
  const rows = (s.success ? s.data : []).slice(0, 10);
  $('dModelStats').innerHTML = rows.length ? rows.map(r => `
    <tr><td class="mono">${r.model_name}</td><td>${fmtTok(r.count)}</td>
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
      <td>${t.name}</td>
      <td><span class="tag ${t.status === 1 ? 'on' : 'off'}">${t.status === 1 ? '启用' : '禁用'}</span></td>
      <td>${t.unlimited_quota ? '无限' : fmtUsd(t.remain_quota)}</td>
      <td>${fmtUsd(t.used_quota)}</td>
      <td class="mono">${t.model_limits || '不限'}</td>
      <td class="mono">${t.key}</td>
      <td>${fmtTime(t.accessed_time)}</td>
      <td>
        <button class="btn-ghost sm" onclick="showKey(${t.id})">查看</button>
        <button class="btn-ghost sm" onclick="delToken(${t.id},'${t.name}')">删除</button>
      </td>
    </tr>`).join('') : '<tr><td colspan="8" class="empty">还没有令牌，点右上角新建</td></tr>';
}

$('btnNewToken').onclick = () => {
  openModal(`
    <h3>新建令牌</h3>
    <label>名称</label><input id="tkName" placeholder="例如 computehub" value="default">
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
  closeModal();
  toast('✅ 令牌已创建');
  const key = 'sk-' + j.data.key_plain;
  openModal(`
    <h3>令牌创建成功</h3>
    <p class="muted">这是唯一一次显示完整 Key，请立即复制保存。</p>
    <pre class="code" style="margin-top:12px">${key}</pre>
    <div class="modal-actions"><button class="btn-primary" onclick="copyText('${key}');closeModal()">复制并关闭</button></div>`);
  loadTokens();
}

async function showKey(id) {
  const j = await api('/api/token/key?id=' + id);
  if (!j.success) return toast(j.message, 'err');
  openModal(`
    <h3>令牌 Key</h3>
    <pre class="code">${j.data.key}</pre>
    <div class="modal-actions"><button class="btn-primary" onclick="copyText('${j.data.key}');closeModal()">复制并关闭</button></div>`);
}

async function delToken(id, name) {
  if (!confirm('确认删除令牌「' + name + '」？')) return;
  const j = await api('/api/token/delete', { method: 'POST', body: JSON.stringify({ id }) });
  if (!j.success) return toast(j.message, 'err');
  toast('已删除');
  loadTokens();
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
    <tr><td class="mono">${x.name}</td><td>${x.channels || 1}</td>
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
      <td class="mono">${l.model_name}</td>
      <td>${l.token_name}</td>
      <td>${l.channel_name}</td>
      <td>${fmtTok(l.prompt_tokens)}</td>
      <td>${fmtTok(l.completion_tokens)}</td>
      <td>${(l.use_time || 0).toFixed(1)}s</td>
      <td>${fmtUsd(l.quota)}</td>
    </tr>`).join('') : '<tr><td colspan="8" class="empty">暂无日志</td></tr>';
}
$('logPrev').onclick = () => loadLogs(Math.max(1, logPage - 1));
$('logNext').onclick = () => loadLogs(logPage + 1);

// ---------- 渠道 ----------
async function loadChannels() {
  const j = await api('/api/channel/');
  if (!j.success) {
    $('channelBody').innerHTML = `<tr><td colspan="7" class="empty">${j.message}</td></tr>`;
    return;
  }
  $('channelBody').innerHTML = j.data.length ? j.data.map(c => `
    <tr>
      <td>${c.id}</td><td>${c.name}</td><td class="mono">${c.base_url}</td>
      <td class="mono">${c.api_key}</td>
      <td>${(c.models || '').split(',').filter(Boolean).length}</td>
      <td>${c.priority}</td>
      <td><span class="tag ${c.status === 1 ? 'on' : 'off'}">${c.status === 1 ? '启用' : '禁用'}</span></td>
    </tr>`).join('') : '<tr><td colspan="7" class="empty">无渠道</td></tr>';
}
$('btnProbe').onclick = () => $('probeBox').classList.toggle('hidden');
$('btnProbeGo').onclick = async () => {
  const base_url = $('probeUrl').value.trim();
  if (!base_url) return toast('请输入上游地址', 'err');
  $('probeResult').textContent = '探测中…';
  const j = await api('/api/channel/models', { method: 'POST', body: JSON.stringify({ base_url, api_key: $('probeKey').value.trim() }) });
  $('probeResult').textContent = j.success
    ? `✅ 共 ${j.data.count} 个模型：${j.data.models.slice(0, 25).join(', ')}${j.data.count > 25 ? ' …' : ''}`
    : '❌ ' + j.message;
};

// ---------- Modal / copy ----------
function openModal(html) { $('modalBox').innerHTML = html; $('modal').classList.remove('hidden'); }
function closeModal() { $('modal').classList.add('hidden'); }
$('modal').onclick = e => { if (e.target.id === 'modal') closeModal(); };
function copyText(t) {
  navigator.clipboard?.writeText(t).then(() => toast('已复制')).catch(() => toast('复制失败，请手动选择', 'err'));
}
window.showKey = showKey; window.delToken = delToken;
window.createToken = createToken; window.closeModal = closeModal; window.copyText = copyText;

bootstrap();
