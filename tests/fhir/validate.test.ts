/**
 * T20 · FHIR R4 资源契约校验（≥8 条）
 */

import { describe, it, expect } from 'vitest';
import {
  validateResource,
  validateBatch,
  assertValidResource,
  FHIR_CONTRACT_VIOLATION,
  RESOURCE_CONTRACTS,
} from '../../src/fhir/validate.js';
import { FhirWriter } from '../../src/fhir/FhirWriter.js';
import { FhirContractViolationError } from '../../src/shared/errors.js';

type R = Record<string, unknown>;

const validObservation = (): R => ({
  resourceType: 'Observation', id: 'obs-1', status: 'final',
  code: { coding: [{ system: 'http://loinc.org', code: '2823-3' }] },
  subject: { reference: 'Patient/p-001' },
  effectiveDateTime: '2026-11-08T10:00:00Z',
  valueQuantity: { value: 6.8, unit: 'mmol/L' },
});
const validReport = (): R => ({
  resourceType: 'DiagnosticReport', id: 'dr-1', status: 'final',
  code: { coding: [{ system: 'http://loinc.org', code: '24357-6' }] },
  subject: { reference: 'Patient/p-001' },
  result: [{ reference: 'Observation/obs-1' }],
});
const validSpecimen = (): R => ({
  resourceType: 'Specimen', id: 'sp-1', status: 'available',
  type: { coding: [{ code: '122554006' }] }, subject: { reference: 'Patient/p-001' },
});
const validDevice = (): R => ({ resourceType: 'Device', id: 'dev-1', deviceName: [{ name: '生化分析仪 A' }], status: 'active' });
const validTask = (): R => ({
  resourceType: 'Task', id: 'task-1', status: 'requested', intent: 'order',
  focus: { reference: 'Observation/obs-1' },
});
const validAudit = (): R => ({
  resourceType: 'AuditEvent', id: 'audit-1', type: { code: '110112' },
  recorded: '2026-11-08T10:00:01Z',
  agent: [{ name: '值班护士', who: { reference: 'Practitioner/pr-1' } }],
  source: { observer: { reference: 'Device/dev-1' } },
  outcome: 'success',
});

describe('T20 · 六类资源契约', () => {
  it('六类合法资源全部通过', () => {
    const all = [validObservation(), validReport(), validSpecimen(), validDevice(), validTask(), validAudit()];
    expect(Object.keys(RESOURCE_CONTRACTS)).toHaveLength(6);
    for (const r of all) {
      const report = validateResource(r);
      expect(report.ok, `${r.resourceType}: ${JSON.stringify(report.violations)}`).toBe(true);
    }
  });

  it('缺 code 的 Observation 被拒，错误 path 精确到字段', () => {
    const r = validObservation(); delete r.code;
    const report = validateResource(r);
    expect(report.ok).toBe(false);
    expect(report.violations.some((v) => v.path === 'code.coding[0].code' && v.code === 'REQUIRED_MISSING')).toBe(true);
  });

  it('缺 agent 的 AuditEvent 被拒，且 recorded / source / outcome 也逐项检查', () => {
    const r = validAudit(); delete r.agent;
    const report = validateResource(r);
    expect(report.violations.some((v) => v.path === 'agent' && v.code === 'REQUIRED_MISSING')).toBe(true);
    const r2 = validAudit(); delete r2.outcome;
    expect(validateResource(r2).violations.some((v) => v.path === 'outcome')).toBe(true);
  });

  it('Task.status 非法值被拒（值域校验）', () => {
    const r = validTask(); r.status = 'done-but-not-fhir';
    const report = validateResource(r);
    expect(report.violations.some((v) => v.path === 'status' && v.code === 'INVALID_VALUE')).toBe(true);
  });

  it('引用格式非法被拒（subject / result[] / contained 引用）', () => {
    const r = validObservation(); r.subject = { reference: 'p-001' };
    expect(validateResource(r).violations.some((v) => v.path === 'subject.reference' && v.code === 'INVALID_REFERENCE')).toBe(true);
    const dr = validReport(); dr.result = [{ reference: 'obs-1' }];
    expect(validateResource(dr).violations.some((v) => v.path === 'result[0].reference')).toBe(true);
    // 合法绝对 URL / contained 引用应放行
    const ok = validObservation(); ok.subject = { reference: 'https://lis.example.com/fhir/R4/Patient/p-001' };
    expect(validateResource(ok).ok).toBe(true);
  });

  it('contained 内部资源一并校验，错误 path 带 contained[i] 前缀', () => {
    const dr = validReport();
    const broken = validObservation(); delete broken.code;
    dr.contained = [broken];
    const report = validateResource(dr);
    expect(report.ok).toBe(false);
    expect(report.violations.some((v) => v.path === 'contained[0].code.coding[0].code')).toBe(true);
  });

  it('未定义契约的资源类型与数组 / 空对象均被拒', () => {
    expect(validateResource({ resourceType: 'Patient' }).violations[0]!.code).toBe('UNKNOWN_RESOURCE_TYPE');
    expect(validateResource([]).violations[0]!.code).toBe('INVALID_TYPE');
    expect(validateResource(null).ok).toBe(false);
  });

  it('批量聚合报告：通过数 / 失败数 / 每类失败原因分布计数正确', () => {
    const badObs = validObservation(); delete badObs.code;
    const badTask = validTask(); badTask.status = 'bad';
    const report = validateBatch([validObservation(), validTask(), badObs, badTask, validAudit()]);
    expect(report.total).toBe(5);
    expect(report.passed).toBe(3);
    expect(report.failed).toBe(2);
    expect(report.byResourceType.Observation).toEqual({ passed: 1, failed: 1 });
    expect(report.byResourceType.Task).toEqual({ passed: 1, failed: 1 });
    expect(report.byReason['REQUIRED_MISSING@code.coding[].code']).toBe(1);
    expect(report.byReason['INVALID_VALUE@status']).toBe(1);
  });

  it('assertValidResource 抛 FhirContractViolationError 且错误码为 FHIR_CONTRACT_VIOLATION', () => {
    const r = validObservation(); delete r.subject;
    let caught: unknown;
    try { assertValidResource(r); } catch (err) { caught = err; }
    expect(caught).toBeInstanceOf(FhirContractViolationError);
    expect((caught as FhirContractViolationError).code).toBe(FHIR_CONTRACT_VIOLATION);
    expect((caught as FhirContractViolationError).context.violations).toBeTruthy();
  });
});

describe('T20 · FhirWriter 写入前置校验', () => {
  it('契约不通过时不发 HTTP 请求、抛结构化错误、原始资源进 DLQ', async () => {
    let fetchCalls = 0;
    const fakeFetch = (async () => {
      fetchCalls += 1;
      return { status: 201, ok: true, headers: { get: () => null }, text: async () => '{}', json: async () => ({}) };
    }) as unknown as typeof fetch;
    const dlqBuffer: Array<Record<string, unknown>> = [];
    const writer = new FhirWriter({
      baseUrl: 'http://127.0.0.1:9999/fhir/R4',
      staticToken: 'test-token',
      urlAllowlist: ['http://127.0.0.1:9999'],
      fetchImpl: fakeFetch,
      dlq: dlqBuffer as never,
      contractValidator: { validate: (r) => validateResource(r) },
    });
    const bad = validObservation(); delete bad.code;

    await expect(writer.writeResource({ resourceType: 'Observation', body: bad }))
      .rejects.toBeInstanceOf(FhirContractViolationError);
    expect(fetchCalls).toBe(0);
    expect(dlqBuffer).toHaveLength(1);
    expect(dlqBuffer[0]!.error_code).toBe('FHIR_CONTRACT_VIOLATION');
    expect(Buffer.isBuffer(dlqBuffer[0]!.raw_bytes)).toBe(true);
  });

  it('合法资源前置校验通过后正常发出写入请求', async () => {
    let fetchCalls = 0;
    const fakeFetch = (async () => {
      fetchCalls += 1;
      return { status: 201, ok: true, headers: { get: () => null }, text: async () => '{}', json: async () => ({}) };
    }) as unknown as typeof fetch;
    const writer = new FhirWriter({
      baseUrl: 'http://127.0.0.1:9999/fhir/R4',
      staticToken: 'test-token',
      urlAllowlist: ['http://127.0.0.1:9999'],
      fetchImpl: fakeFetch,
      contractValidator: { validate: (r) => validateResource(r) },
    });
    const result = await writer.writeResource({ resourceType: 'Observation', body: validObservation() });
    expect(result.status).toBe(201);
    expect(fetchCalls).toBe(1);
  });
});
