/* T31/T32/T33 · 信息科面板逻辑（原生 JS，不引框架）
 * 经 /ws 收实时事件；用 render.js 纯函数渲染；三态（加载/空/错误）齐备；
 * ack/resolve/候选采纳/忽略采用乐观更新，失败回滚并提示；WS 断线挂横幅，恢复后补拉快照。
 */

import {
  skeletonHtml, emptyHtml, errorHtml, deviceTableHtml, criticalListHtml,
} from './render.js';

const $ = (sel) => document.querySelector(sel);
const region = (name) => document.querySelector(`[data-region="${name}"]`);

const state = {
  tasks: [],
  devices: [],
  candidates: {},
  filter: 'requested',
  socket: null,
  retry: 0,
  loading: { devices: true, sample: true, criticals: true, fhir: true },
};

function setBanner(connected) {
  const banner = $('#ws-banner');
  $('#ws-state').textContent = connected ? '已连接' : '重连中';
  if (banner) banner.classList.toggle('show', !connected);
}

function applyFilter(tasks) {
  if (!state.filter) return tasks;
  return tasks.filter((t) => (t.status || 'requested') === state.filter);
}

function renderDevices() {
  const el = region('devices');
  if (!el) return;
  if (state.loading.devices) { el.innerHTML = skeletonHtml('设备'); return; }
  el.innerHTML = deviceTableHtml(state.devices);
}

function renderCriticals() {
  const el = region('criticals');
  if (!el) return;
  if (state.loading.criticals) { el.innerHTML = skeletonHtml('危急值'); return; }
  const tasks = state.tasks.map((t) => ({ ...t, candidates: state.candidates?.[t.id] || t.candidates || [] }));
  el.innerHTML = criticalListHtml(applyFilter(tasks));
}

function renderSample(msg) {
  const el = region('sample');
  if (!el) return;
  if (state.loading.sample) { el.innerHTML = skeletonHtml('样本'); return; }
  el.innerHTML = msg && msg.summary ? `<div>${msg.summary}</div>` : emptyHtml('等待仪器推送');
}

function renderFhir(msg) {
  const el = region('fhir');
  if (!el) return;
  if (state.loading.fhir) { el.innerHTML = skeletonHtml('FHIR 回读'); return; }
  const r = msg && msg.resource;
  el.innerHTML = r ? `<pre>${JSON.stringify(r, null, 2)}</pre>` : emptyHtml('用 /api/fhir-debug 回读资源');
}

function connect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/ws`);
  state.socket = ws;
  ws.onopen = () => { state.retry = 0; setBanner(true); refreshSnapshot(); };
  ws.onmessage = (evt) => {
    let msg; try { msg = JSON.parse(evt.data); } catch { return; }
    handleEvent(msg);
  };
  ws.onclose = () => {
    setBanner(false);
    state.retry = Math.min(state.retry + 1, 5);
    setTimeout(connect, 1000 * state.retry);
  };
}

function handleEvent(msg) {
  switch (msg.type) {
    case 'channels.snapshot':
      state.loading.devices = false;
      state.devices = msg.channels || [];
      renderDevices();
      break;
    case 'critical.snapshot':
      state.loading.criticals = false;
      state.tasks = msg.tasks || [];
      renderCriticals();
      break;
    case 'critical.detected':
    case 'critical.updated':
    case 'critical.resolved':
      if (msg.task) state.tasks = upsert(state.tasks, msg.task);
      if (msg.task && (msg.task.status || 'requested') === 'requested') fetchCandidates(msg.task.id);
      renderCriticals();
      break;
    case 'sample.recent':
      state.loading.sample = false;
      renderSample(msg);
      break;
    case 'fhir.debug':
      state.loading.fhir = false;
      renderFhir(msg);
      break;
    default:
      break;
  }
}

function upsert(list, task) {
  const idx = list.findIndex((t) => t.id === task.id);
  if (idx >= 0) { const copy = list.slice(); copy[idx] = { ...copy[idx], ...task }; return copy; }
  return [task, ...list];
}

async function refreshSnapshot() {
  try {
    const ch = await fetch('/api/channels').then((r) => r.json());
    handleEvent({ type: 'channels.snapshot', channels: ch.channels || [] });
    const cr = await fetch('/api/critical').then((r) => r.json());
    handleEvent({ type: 'critical.snapshot', tasks: cr.tasks || [] });
    // T33 · 并行拉取各未完成危急值的候选接收人
    await Promise.all((cr.tasks || []).filter((t) => (t.status || 'requested') === 'requested').map(fetchCandidates));
    renderCriticals();
  } catch (err) {
    state.loading.criticals = false;
    const el = region('criticals');
    if (el) el.innerHTML = errorHtml('危急值加载失败', 'FETCH_FAILED');
  }
}

async function fetchCandidates(task) {
  const taskId = typeof task === 'string' ? task : task.id;
  try {
    const r = await fetch(`/api/candidates/${encodeURIComponent(taskId)}`).then((x) => x.json());
    state.candidates[taskId] = r.candidates || [];
  } catch { /* 候选缺失不阻塞主列表 */ }
}

/** 乐观更新 + 失败回滚 */
async function optimistic(action, taskId, payload, applyLocal) {
  const prev = JSON.stringify(state.tasks);
  applyLocal();
  renderCriticals();
  try {
    const res = await fetch(`/api/critical/${encodeURIComponent(taskId)}/${action}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (data && data.task) state.tasks = upsert(state.tasks, data.task);
  } catch (err) {
    state.tasks = JSON.parse(prev); // 回滚
    renderCriticals();
    alert(`操作失败：${err.message}（已回滚）`);
  }
}

/** 候选采纳：写 AuditEvent + Task.owner 回写 FHIR（乐观） */
async function adoptCandidate(taskId, index) {
  const prev = JSON.stringify(state.candidates);
  try {
    const res = await fetch(`/api/candidates/${encodeURIComponent(taskId)}/accept`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ index }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  } catch (err) {
    state.candidates = JSON.parse(prev);
    alert(`采纳失败：${err.message}`);
  }
}

async function ignoreCandidate(taskId, index) {
  try {
    await fetch(`/api/candidates/${encodeURIComponent(taskId)}/ignore`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ index }),
    });
  } catch (err) {
    alert(`忽略失败：${err.message}`);
  }
}

document.addEventListener('click', (e) => {
  const t = e.target.closest('[data-action]');
  if (!t) return;
  const action = t.getAttribute('data-action');
  const taskId = t.getAttribute('data-task');
  const index = t.getAttribute('data-index');
  if (action === 'ack') optimistic('ack', taskId, { practitioner_id: 'nurse-01', role: 'nurse' }, () => {
    state.tasks = state.tasks.map((x) => (x.id === taskId ? { ...x, status: 'received' } : x));
  });
  else if (action === 'resolve') optimistic('resolve', taskId, { practitioner_id: 'doc-01', resolution_note: '已处置' }, () => {
    state.tasks = state.tasks.map((x) => (x.id === taskId ? { ...x, status: 'completed' } : x));
  });
  else if (action === 'candidate-accept') adoptCandidate(taskId, Number(index));
  else if (action === 'candidate-ignore') ignoreCandidate(taskId, Number(index));
  else if (action === 'retry') refreshSnapshot();
});

document.querySelectorAll('.filters button').forEach((b) => {
  b.addEventListener('click', () => {
    document.querySelectorAll('.filters button').forEach((x) => x.classList.remove('active'));
    b.classList.add('active');
    state.filter = b.getAttribute('data-filter') || '';
    renderCriticals();
  });
});

// 初始渲染三态骨架，随后连接
renderDevices(); renderCriticals(); renderSample(); renderFhir();
connect();
setInterval(() => { if (state.socket && state.socket.readyState === 1) refreshSnapshot(); }, 15000);
