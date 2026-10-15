/* 算力商城前端逻辑 */
'use strict';

const $ = id => document.getElementById(id);
const TOKEN_KEY = 'market_token';
let token = localStorage.getItem(TOKEN_KEY) || null;
let currentTab = 'login';
let nodes = [];
let selectedNode = null;
let lastQuote = null;
let orders = {};
let totalTokens = 0;

// ============ Toast ============
function toast(msg, type) {
  const t = $('toast');
  t.textContent = msg;
  t.className = 'toast ' + (type || 'ok');
  t.classList.remove('hidden');
  clearTimeout(t._h);
  t._h = setTimeout(() => t.classList.add('hidden'), 3000);
}

// ============ 登录/注册 ============
document.querySelectorAll('.tab').forEach(tab => {
  tab.onclick = () => {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    currentTab = tab.dataset.tab;
    $('authSubmit').textContent = currentTab === 'login' ? '登录' : '注册';
    $('authMsg').textContent = '';
  };
});

$('authForm').onsubmit = async e => {
  e.preventDefault();
  const username = $('authUser').value.trim();
  const password = $('authPass').value;
  const endpoint = currentTab === 'login' ? '/api/login' : '/api/register';
  $('authSubmit').disabled = true;
  $('authMsg').textContent = '处理中…';
  try {
    const r = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password })
    });
    const j = await r.json();
    if (j.ok) {
      if (currentTab === 'login') {
        token = j.token;
        localStorage.setItem(TOKEN_KEY, token);
        toast('✅ 登录成功，欢迎 ' + j.username, 'ok');
        enterMain(j.username);
      } else {
        toast('✅ 注册成功，请登录', 'ok');
        // 切到登录 tab
        document.querySelector('[data-tab="login"]').click();
        $('authPass').value = '';
      }
    } else {
      $('authMsg').className = 'auth-msg err';
      $('authMsg').textContent = j.error || '操作失败';
    }
  } catch (err) {
    $('authMsg').className = 'auth-msg err';
    $('authMsg').textContent = '请求失败: ' + err.message;
  }
  $('authSubmit').disabled = false;
};

$('btnLogout').onclick = async () => {
  if (token) {
    try {
      await fetch('/api/logout', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + token }
      });
    } catch {}
  }
  token = null;
  localStorage.removeItem(TOKEN_KEY);
  location.reload();
};

// ============ 主界面 ============
function enterMain(username) {
  $('authView').classList.add('hidden');
  $('mainView').classList.remove('hidden');
  $('welcomeUser').textContent = '👤 ' + username;
  loadNodes();
  setInterval(loadNodes, 15000);
}

async function checkAuth() {
  if (!token) return showAuth();
  try {
    const r = await fetch('/api/me', { headers: { 'Authorization': 'Bearer ' + token } });
    const j = await r.json();
    if (j.ok) return enterMain(j.username);
  } catch {}
  token = null;
  localStorage.removeItem(TOKEN_KEY);
  showAuth();
}
function showAuth() {
  $('mainView').classList.add('hidden');
  $('authView').classList.remove('hidden');
}

// ============ 节点 ============
async function loadNodes() {
  try {
    const r = await fetch('/api/v1/nodes/list');
    const j = await r.json();
    if (j.success && j.data) {
      nodes = j.data.filter(n => n.status === 'online');
      renderNodes();
      $('stNodes').textContent = nodes.length;
      $('nodeCount').textContent = nodes.length + ' 在线';
    }
  } catch {}
}

function renderNodes() {
  const el = $('nodeList');
  if (!nodes.length) { el.innerHTML = '<div class="empty">无在线节点</div>'; return; }
  el.innerHTML = nodes.map(n => {
    const isGPU = (n.gpu_type || '').length > 0;
    const type = isGPU ? 'gpu' : 'cpu';
    const sel = selectedNode && selectedNode.node_id === n.node_id ? 'sel' : '';
    return `<div class="node ${sel}" data-id="${n.node_id}">
      <div><div class="n-id"><span class="dot"></span>${n.node_id}</div>
      <div class="n-meta">${n.platform || '?'} · CPU ${(n.cpu_utilization || 0).toFixed(0)}% · 任务 ${n.active_tasks || 0}</div></div>
      <span class="n-type ${type}">${type.toUpperCase()}</span>
    </div>`;
  }).join('');
  el.querySelectorAll('.node').forEach(div => {
    div.onclick = () => {
      selectedNode = nodes.find(n => n.node_id === div.dataset.id);
      renderNodes();
    };
  });
}

$('cmdType').onchange = () => {
  $('gpuRow').style.display = $('cmdType').value === 'gpu' ? 'flex' : 'none';
};

// ============ 报价 ============
$('btnEstimate').onclick = async () => {
  const ct = $('cmdType').value;
  const cmd = $('cmd').value.trim();
  const body = {
    command_type: ct,
    command: cmd,
    resources: {
      cpu_cores: parseInt($('cpuCores').value) || 1,
      mem_gb: parseFloat($('memGB').value) || 0,
      est_duration: parseInt($('estDur').value) || 60,
      gpu: { count: parseInt($('gpuCount').value) || 0, vram_gb: parseFloat($('gpuVram').value) || 0 },
      data_mb: 0
    }
  };
  try {
    const r = await fetch('/api/v1/tasks/estimate', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
    });
    const j = await r.json();
    if (j.success) {
      const e = j.data.estimate;
      lastQuote = { command_type: j.data.command_type, resources: body.resources, estimate: e };
      $('quoteBox').classList.remove('hidden');
      $('qTokens').textContent = Math.round(e.mid) + ' token';
      $('qRange').textContent = `区间 ${Math.round(e.min)} ~ ${Math.round(e.max)} · 类型 ${j.data.command_type.toUpperCase()}`;
    } else toast(j.error || '报价失败', 'err');
  } catch (e) { toast('请求失败: ' + e.message, 'err'); }
};

// ============ 下单 ============
$('btnOrder').onclick = async () => {
  if (!lastQuote) return;
  if (!selectedNode) { toast('请先选择一个算力节点', 'err'); return; }
  const cmd = $('cmd').value.trim();
  if (!cmd) { toast('请输入命令', 'err'); return; }

  const taskId = 'mk-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6);
  const body = {
    task_id: taskId, command: cmd,
    assigned_node: selectedNode.node_id,
    priority: parseInt($('priority').value) || 5,
    timeout: 900, source_type: 'market',
    submitted_by: 'market-web:' + ($('welcomeUser').textContent.replace('👤 ', '')),
    command_type: lastQuote.command_type,
    resources: lastQuote.resources
  };
  try {
    const r = await fetch('/api/v1/tasks/submit', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
    });
    const j = await r.json();
    if (j.success) {
      toast('✅ 下单成功：' + taskId, 'ok');
      orders[taskId] = { info: { task_id: taskId, command: cmd, node: selectedNode.node_id, est: lastQuote.estimate.mid, timestamp: Date.now() } };
      $('quoteBox').classList.add('hidden');
      $('cmd').value = '';
      renderOrders();
      pollOrder(taskId);
    } else toast('下单失败：' + (j.error || 'unknown'), 'err');
  } catch (e) { toast('请求失败: ' + e.message, 'err'); }
};

// ============ 订单轮询 ============
async function pollOrder(taskId) {
  if (orders[taskId].pollTimer) return;
  orders[taskId].pollTimer = setInterval(async () => {
    try {
      const r = await fetch('/api/v1/tasks/detail?task_id=' + taskId);
      const j = await r.json();
      if (j.success && j.data) {
        const d = j.data;
        orders[taskId].info.status = d.status;
        if (d.settlement) {
          orders[taskId].info.final = d.settlement.tokens_final;
          totalTokens += d.settlement.tokens_final;
          $('stTokens').textContent = Math.round(totalTokens);
        }
        renderOrders();
        if (d.status === 'completed' || d.status === 'failed') {
          clearInterval(orders[taskId].pollTimer);
          orders[taskId].pollTimer = null;
        }
      }
    } catch {}
  }, 2000);
}

function renderOrders() {
  const el = $('orderList');
  const keys = Object.keys(orders).sort((a, b) =>
    (orders[b].info.timestamp || 0) - (orders[a].info.timestamp || 0));
  $('orderCount').textContent = keys.length;
  if (!keys.length) { el.innerHTML = '<div class="empty">暂无订单</div>'; return; }
  el.innerHTML = keys.map(tid => {
    const o = orders[tid].info;
    const status = o.status || 'queued';
    const stMap = { queued: 'queued', running: 'running', completed: 'completed', failed: 'failed' };
    const cls = stMap[status] || 'queued';
    const tk = o.final ? `结算 <b>${Math.round(o.final)}</b> token` : `预估 <b>${Math.round(o.est || 0)}</b> token`;
    return `<div class="order">
      <div class="o-top"><span class="o-id">${tid}</span><span class="o-status ${cls}">${status}</span></div>
      <div class="o-cmd">${o.command}</div>
      <div class="o-tokens">${o.node} · ${tk}</div>
    </div>`;
  }).join('');
}

// ============ 启动 ============
checkAuth();
