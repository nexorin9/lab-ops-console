import { describe, it, expect } from 'vitest';
import {
  skeletonHtml, emptyHtml, errorHtml, deviceTableHtml,
  candidateListHtml, criticalCardHtml, criticalListHtml,
} from '../../src/gateway/static/render.js';

const TASK = {
  id: 'task-1', status: 'requested', patientHash: 'pid:abc123', testDisplay: '血钾', testCode: 'K',
  value: '6.8', unit: 'mmol/L', detectedAt: '2026-11-08T09:30:00Z', severity: 'critical',
};

describe('T30/T31 · 面板渲染（结构）', () => {
  it('危急值卡：危急态带 critical 类 + 红框标签 + 值/单位/患者标识，且不使用真名', () => {
    const html = criticalCardHtml(TASK);
    expect(html).toContain('class="critical-card critical"');
    expect(html).toContain('tag-critical');
    expect(html).toContain('6.8');
    expect(html).toContain('mmol/L');
    expect(html).toContain('pid:abc123');
    expect(html).not.toContain('张三'); // 不落真名
    expect(html).toContain('data-action="ack"'); // 未接收有「已接收」
  });

  it('已处置卡转入已办态（tag-ok，无红框类）', () => {
    const html = criticalCardHtml({ ...TASK, status: 'completed' });
    expect(html).toContain('tag-ok');
    expect(html).not.toContain('class="critical-card critical"');
    expect(html).not.toContain('data-action="resolve"');
  });

  it('已接收卡不致命红框，但仍有处置按钮', () => {
    const html = criticalCardHtml({ ...TASK, status: 'received' });
    expect(html).not.toContain('class="critical-card critical"');
    expect(html).toContain('data-action="resolve"');
  });

  it('设备表含四列与通道状态', () => {
    const html = deviceTableHtml([{ id: 'hl7-1', status: 'running', frameCount: 42, lastHeartbeatAt: '2026-11-08T09:30:00Z' }]);
    expect(html).toContain('<th>通道</th>');
    expect(html).toContain('tag-ok');
    expect(html).toContain('42');
  });
});

describe('T32 · 面板三态（加载 / 空 / 错误）', () => {
  it('加载骨架含 shimmer 与无障碍文案', () => {
    const html = skeletonHtml('设备');
    expect(html).toContain('shimmer');
    expect(html).toContain('data-state="loading"');
    expect(html).toContain('正在加载');
  });
  it('空态文案', () => {
    const html = emptyHtml('暂无危急值');
    expect(html).toContain('data-state="empty"');
    expect(html).toContain('暂无危急值');
  });
  it('错误态含错误码与重试按钮', () => {
    const html = errorHtml('加载失败', 'FHIR_WRITE_FAIL');
    expect(html).toContain('data-state="error"');
    expect(html).toContain('FHIR_WRITE_FAIL');
    expect(html).toContain('data-action="retry"');
  });
  it('列表在无数据时回退到空态', () => {
    expect(criticalListHtml([])).toContain('data-state="empty"');
    expect(deviceTableHtml([])).toContain('data-state="empty"');
  });
});

describe('T33 · 候选接收人渲染（采纳/忽略入口）', () => {
  const candidates = [{
    role: 'ICU 护士', practitionerId: 'ICU-1', confidence: 0.9, reason: '血钾危急送 ICU',
    source: 'model', lowConfidence: false,
  }];
  it('卡片渲染候选列表，含采纳/忽略按钮与来源标注', () => {
    const html = criticalCardHtml({ ...TASK, candidates });
    expect(html).toContain('模型建议');
    expect(html).toContain('data-action="candidate-accept"');
    expect(html).toContain('data-action="candidate-ignore"');
  });
  it('无候选时给出空态而不是缺按钮', () => {
    const html = candidateListHtml('task-1', []);
    expect(html).toContain('暂无可采纳的接收人建议');
    expect(html).not.toContain('candidate-accept');
  });
  it('低置信度候选标注（低置信度）', () => {
    const html = candidateListHtml('task-1', [{ ...candidates[0], confidence: 0.2, lowConfidence: true, source: 'rule' }]);
    expect(html).toContain('规则兜底');
    expect(html).toContain('低置信度');
  });
});
