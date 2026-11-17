/* T31/T32/T33 · 面板渲染纯函数（浏览器 panel.js 与 Node 单测共用）
 * 不依赖任何浏览器全局；纯字符串模板，便于断言。
 */

export function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** T32 · 加载骨架 */
export function skeletonHtml(label = '加载中') {
  return `<div class="state-skeleton" data-state="loading"><span class="shimmer"></span><span class="sr-only">${escapeHtml(label)}，正在加载</span></div>`;
}

/** T32 · 空态 */
export function emptyHtml(label = '暂无数据') {
  return `<div class="state-empty" data-state="empty">${escapeHtml(label)}</div>`;
}

/** T32 · 错误态（带错误码与重试按钮） */
export function errorHtml(label = '加载失败', code = '') {
  const codeHtml = code ? ` <code data-error-code="${escapeHtml(code)}">${escapeHtml(code)}</code>` : '';
  return `<div class="state-error" data-state="error">${escapeHtml(label)}：${codeHtml}<br><button class="secondary" data-action="retry">重试</button></div>`;
}

/** T31 · 设备/通道行 */
export function deviceRowHtml(d) {
  const statusClass = d.status === 'running' ? 'tag-ok' : 'tag-critical';
  return `<tr>
    <td>${escapeHtml(d.id)}</td>
    <td><span class="${statusClass}">${escapeHtml(d.status)}</span></td>
    <td>${escapeHtml(d.lastHeartbeatAt ?? '—')}</td>
    <td>${escapeHtml(d.frameCount ?? 0)}</td>
  </tr>`;
}

export function deviceTableHtml(devices) {
  if (!devices || devices.length === 0) return emptyHtml('暂无通道');
  const rows = devices.map(deviceRowHtml).join('');
  return `<table><thead><tr><th>通道</th><th>状态</th><th>最近心跳</th><th>累计帧数</th></tr></thead><tbody>${rows}</tbody></table>`;
}

/** T31/T33 · 候选接收人列表（来源 + 置信度 + 采纳/忽略） */
export function candidateListHtml(taskId, candidates) {
  if (!candidates || candidates.length === 0) {
    return `<div class="candidates state-empty">暂无可采纳的接收人建议</div>`;
  }
  const items = candidates.map((c, i) => {
    const srcLabel = c.source === 'model' ? '模型建议' : '规则兜底';
    const conf = Number(c.confidence).toFixed(2);
    const low = c.lowConfidence ? '（低置信度）' : '';
    return `<li class="candidate" data-index="${i}">
      <span class="c-role">${escapeHtml(c.role)}</span>
      <span class="c-meta">${escapeHtml(srcLabel)} · 置信 ${conf}${low}</span>
      <span class="c-reason">${escapeHtml(c.reason ?? '')}</span>
      <span class="c-actions">
        <button class="secondary" data-action="candidate-accept" data-task="${escapeHtml(taskId)}" data-index="${i}">采纳</button>
        <button class="secondary" data-action="candidate-ignore" data-task="${escapeHtml(taskId)}" data-index="${i}">忽略</button>
      </span>
    </li>`;
  }).join('');
  return `<ul class="candidates">${items}</ul>`;
}

/** T31/T32/T33 · 危急值卡片（三态 + 候选采纳） */
export function criticalCardHtml(task, opts = {}) {
  const status = task.status || 'requested';
  const severity = task.severity === 'critical' ? 'critical' : '';
  const isRequested = status === 'requested';
  const isCompleted = status === 'completed';
  const cardClass = isRequested ? 'critical-card critical' : 'critical-card';
  const stateTag = isCompleted
    ? '<span class="tag-ok">已处置</span>'
    : isRequested
      ? '<span class="tag-critical">危急</span>'
      : '<span class="tag-critical" style="background:var(--c-warn)">已接收</span>';
  const patient = escapeHtml(task.patientHash || task.patientId || '');
  const test = escapeHtml(task.testDisplay || task.testCode || '');
  const value = escapeHtml(task.value || '');
  const unit = escapeHtml(task.unit || '');
  const detectedAt = escapeHtml(task.detectedAt || '');
  const candidates = opts.candidates || task.candidates || [];
  const candidateHtml = candidateListHtml(task.id, candidates);
  const ackBtn = isRequested
    ? `<button data-action="ack" data-task="${escapeHtml(task.id)}">已接收</button>` : '';
  const resolveBtn = !isCompleted
    ? `<button class="secondary" data-action="resolve" data-task="${escapeHtml(task.id)}">已处置</button>` : '';

  return `<div class="${cardClass}" data-task="${escapeHtml(task.id)}" data-status="${escapeHtml(status)}">
    <div class="card-head">${stateTag}<span class="sr-only">${isRequested ? '危急值待处理' : isCompleted ? '已处置' : '已接收待处置'}</span></div>
    <div class="value">${value} <span class="unit">${unit}</span></div>
    <div class="meta">患者 <code>${patient}</code> · ${test} · 检出 ${detectedAt}</div>
    <div class="candidates-block">${candidateHtml}</div>
    <div class="actions">${ackBtn}${resolveBtn}</div>
  </div>`;
}

export function criticalListHtml(tasks, opts = {}) {
  if (!tasks || tasks.length === 0) return emptyHtml('暂无危急值');
  return tasks.map((t) => criticalCardHtml(t, opts)).join('');
}
