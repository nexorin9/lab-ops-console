/* T31/T32 · 护士站大屏逻辑（原生 JS）
 * 大屏只需一个视觉目标：未处置的危急值红框醒目；已处置转入已办列表。
 * 三态（加载/空/错误）齐备；ack/resolve 乐观更新 + 失败回滚；WS 断线挂横幅，恢复后补拉快照。
 */

import { skeletonHtml, emptyHtml, errorHtml, criticalCardHtml } from './render.js';

const $ = (sel) => document.querySelector(sel);
const region = (name) => document.querySelector(`[data-region="${name}"]`);

const state = { tasks: [], socket: null, retry: 0, loading: true };

function setBanner(connected) {
  const banner = $('#ws-banner');
  $('#ws-state').textContent = connected ? '已连接' : '重连中';
  if (banner) banner.classList.toggle('show', !connected);
}

function renderWallboard() {
  const el = region('wallboard');
  if (!el) return;
  if (state.loading) { el.innerHTML = skeletonHtml('危急值'); return; }
  const open = state.tasks.filter((t) => (t.status || 'requested') !== 'completed');
  el.innerHTML = open.length ? open.map((t) => criticalCardHtml(t)).join('') : emptyHtml('本班暂无危急值');
  const done = region('wallboard-done');
  const closed = state.tasks.filter((t) => (t.status || 'requested') === 'completed');
  done.innerHTML = closed.length ? closed.map((t) => criticalCardHtml(t)).join('') : emptyHtml('暂无已办');
}

function upsert(list, task) {
  const idx = list.findIndex((t) => t.id === task.id);
  if (idx >= 0) { const copy = list.slice(); copy[idx] = { ...copy[idx], ...task }; return copy; }
  return [task, ...list];
}

function handleEvent(msg) {
  if (msg.type === 'critical.snapshot') { state.loading = false; state.tasks = msg.tasks || []; }
  else if (['critical.detected', 'critical.updated', 'critical.resolved'].includes(msg.type)) {
    if (msg.task) state.tasks = upsert(state.tasks, msg.task);
  }
  renderWallboard();
}

async function load() {
  try {
    const r = await fetch('/api/critical').then((x) => x.json());
    handleEvent({ type: 'critical.snapshot', tasks: r.tasks || [] });
  } catch (err) {
    state.loading = false;
    const el = region('wallboard');
    if (el) el.innerHTML = errorHtml('危急值加载失败', 'FETCH_FAILED');
  }
}

async function optimistic(action, taskId, payload, applyLocal) {
  const prev = JSON.stringify(state.tasks);
  applyLocal();
  renderWallboard();
  try {
    const res = await fetch(`/api/critical/${encodeURIComponent(taskId)}/${action}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (data && data.task) state.tasks = upsert(state.tasks, data.task);
  } catch (err) {
    state.tasks = JSON.parse(prev);
    renderWallboard();
    alert(`操作失败：${err.message}（已回滚）`);
  }
}

function connect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/ws`);
  state.socket = ws;
  ws.onopen = () => { state.retry = 0; setBanner(true); load(); };
  ws.onmessage = (evt) => { let m; try { m = JSON.parse(evt.data); } catch { return; } handleEvent(m); };
  ws.onclose = () => { setBanner(false); state.retry = Math.min(state.retry + 1, 5); setTimeout(connect, 1000 * state.retry); };
}

document.addEventListener('click', (e) => {
  const t = e.target.closest('[data-action]');
  if (!t) return;
  const action = t.getAttribute('data-action');
  const taskId = t.getAttribute('data-task');
  if (action === 'ack') optimistic('ack', taskId, { practitioner_id: 'nurse-wall', role: 'nurse' }, () => {
    state.tasks = state.tasks.map((x) => (x.id === taskId ? { ...x, status: 'received' } : x));
  });
  else if (action === 'resolve') optimistic('resolve', taskId, { practitioner_id: 'doc-wall', resolution_note: '大屏已处置' }, () => {
    state.tasks = state.tasks.map((x) => (x.id === taskId ? { ...x, status: 'completed' } : x));
  });
  else if (action === 'retry') load();
});

renderWallboard();
connect();
setInterval(() => { if (state.socket && state.socket.readyState === 1) load(); }, 10000);
