/**
 * T20 · FHIR R4 本地契约校验
 *
 * 写进 LIS 之前先过本地形状检查：必填字段 / 值域 / 引用格式 / contained 内部资源。
 * 不通过就拒绝写入并给出结构化报告（path 精确到字段），绝不静默丢弃。
 *
 * 与 zod 资源构造器的区别：构造器只保证「我们造出来的对象合格」；
 * 本模块保证「任何来源送进来的对象（含人工修订、回放、外部导入）也合格」，
 * 且错误以 path/code/message 形式返回，可直接进面板与校验报告。
 */

import { FhirContractViolationError } from '../shared/errors.js';

export const FHIR_CONTRACT_VIOLATION = 'FHIR_CONTRACT_VIOLATION';

export type FhirResourceType =
  | 'Observation' | 'DiagnosticReport' | 'Specimen' | 'Device' | 'Task' | 'AuditEvent';

export type ViolationCode =
  | 'REQUIRED_MISSING'
  | 'INVALID_VALUE'
  | 'INVALID_REFERENCE'
  | 'INVALID_TYPE'
  | 'UNKNOWN_RESOURCE_TYPE';

export interface ContractViolation {
  /** 精确到字段的路径，如 Observation.subject.reference / AuditEvent.agent[0].who */
  path: string;
  code: ViolationCode | typeof FHIR_CONTRACT_VIOLATION;
  message: string;
}

export interface ValidationReport {
  resourceType: string;
  resourceId: string | null;
  ok: boolean;
  violations: ContractViolation[];
}

export interface BatchValidationReport {
  total: number;
  passed: number;
  failed: number;
  byResourceType: Record<string, { passed: number; failed: number }>;
  /** 按失败原因分布（code@path 维度） */
  byReason: Record<string, number>;
  reports: ValidationReport[];
}

export const FHIR_R4_VALUE_SETS = {
  observationStatus: ['registered', 'preliminary', 'final', 'amended', 'corrected', 'cancelled', 'entered-in-error', 'unknown'],
  diagnosticReportStatus: ['registered', 'partial', 'preliminary', 'final', 'amended', 'corrected', 'appended', 'cancelled', 'entered-in-error', 'unknown'],
  specimenStatus: ['available', 'unavailable', 'unsatisfactory', 'entered-in-error'],
  deviceStatus: ['active', 'inactive', 'entered-in-error', 'unknown'],
  taskStatus: ['draft', 'requested', 'received', 'accepted', 'rejected', 'ready', 'cancelled', 'in-progress', 'on-hold', 'failed', 'completed', 'entered-in-error'],
  taskIntent: ['unknown', 'proposal', 'plan', 'order', 'original-order', 'reflex-order', 'filler-order', 'instance-order', 'option'],
  auditOutcome: ['0', '4', '8', '12', 'success', 'denied', 'partial', 'fallback_rules'],
} as const;

const REFERENCE_RE = /^(?:[A-Z][A-Za-z0-9]*\/[A-Za-z0-9.\-_]{1,64}|https?:\/\/\S+|#[A-Za-z0-9.\-_]{1,64})$/;

/** 取嵌套值；路径用 . 分隔，数组下标用 [n] */
function get(obj: unknown, path: string): unknown {
  const parts = path.replace(/\[(\d+)\]/g, '.$1').split('.').filter(Boolean);
  let cur: unknown = obj;
  for (const p of parts) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[p];
  }
  return cur;
}

function present(v: unknown): boolean {
  if (v === undefined || v === null) return false;
  if (typeof v === 'string') return v.trim().length > 0;
  if (Array.isArray(v)) return v.length > 0;
  return true;
}

interface Rule {
  path: string;
  kind: 'required' | 'enum' | 'reference' | 'array-reference' | 'any';
  values?: readonly string[];
  /** any: 至少满足其中一条路径 */
  paths?: string[];
  message?: string;
}

const OBSERVATION_VALUE_PATHS = ['valueQuantity', 'valueString', 'valueCodeableConcept', 'valueBoolean', 'valueInteger', 'dataAbsentReason'];

export const RESOURCE_CONTRACTS: Record<FhirResourceType, Rule[]> = {
  Observation: [
    { path: 'resourceType', kind: 'required' },
    { path: 'status', kind: 'required' },
    { path: 'status', kind: 'enum', values: FHIR_R4_VALUE_SETS.observationStatus },
    { path: 'code.coding[0].code', kind: 'required' },
    { path: 'subject', kind: 'required' },
    { path: 'subject.reference', kind: 'reference' },
    { path: 'effectiveDateTime', kind: 'any', paths: ['effectiveDateTime', 'effectivePeriod', 'effectiveInstant'] },
    { path: 'value*', kind: 'any', paths: OBSERVATION_VALUE_PATHS },
    { path: 'device.reference', kind: 'reference' },
    { path: 'specimen.reference', kind: 'reference' },
    { path: 'performer[0].reference', kind: 'reference' },
  ],
  DiagnosticReport: [
    { path: 'resourceType', kind: 'required' },
    { path: 'status', kind: 'required' },
    { path: 'status', kind: 'enum', values: FHIR_R4_VALUE_SETS.diagnosticReportStatus },
    { path: 'code.coding[0].code', kind: 'required' },
    { path: 'subject.reference', kind: 'reference' },
    { path: 'result', kind: 'array-reference' },
  ],
  Specimen: [
    { path: 'resourceType', kind: 'required' },
    { path: 'status', kind: 'required' },
    { path: 'status', kind: 'enum', values: FHIR_R4_VALUE_SETS.specimenStatus },
    { path: 'type.coding[0].code', kind: 'required' },
    { path: 'subject.reference', kind: 'reference' },
  ],
  Device: [
    { path: 'resourceType', kind: 'required' },
    { path: 'deviceName[0].name', kind: 'any', paths: ['deviceName[0].name', 'type.coding[0].code', 'identifier[0].value'] },
    { path: 'status', kind: 'enum', values: FHIR_R4_VALUE_SETS.deviceStatus },
    { path: 'owner.reference', kind: 'reference' },
  ],
  Task: [
    { path: 'resourceType', kind: 'required' },
    { path: 'status', kind: 'required' },
    { path: 'status', kind: 'enum', values: FHIR_R4_VALUE_SETS.taskStatus },
    { path: 'intent', kind: 'required' },
    { path: 'intent', kind: 'enum', values: FHIR_R4_VALUE_SETS.taskIntent },
    { path: 'focus.reference', kind: 'reference' },
    { path: 'for.reference', kind: 'reference' },
    { path: 'owner.reference', kind: 'reference' },
  ],
  AuditEvent: [
    { path: 'resourceType', kind: 'required' },
    { path: 'type.code', kind: 'any', paths: ['type.code', 'type.coding[0].code'] },
    { path: 'recorded', kind: 'required' },
    { path: 'agent', kind: 'required' },
    { path: 'agent[0].who.reference', kind: 'any', paths: ['agent[0].who.reference', 'agent[0].name', 'agent[0].who.display'] },
    { path: 'source', kind: 'required' },
    { path: 'source.observer.reference', kind: 'any', paths: ['source.observer.reference', 'source.observer.display', 'source.site'] },
    { path: 'outcome', kind: 'required' },
    { path: 'outcome', kind: 'enum', values: FHIR_R4_VALUE_SETS.auditOutcome },
  ],
};

/** 校验一个引用字段（不存在则跳过 —— 必填由 required 规则负责） */
function checkReference(resource: unknown, path: string, violations: ContractViolation[], prefix: string): void {
  const value = get(resource, path);
  if (!present(value)) return;
  if (typeof value !== 'string' || !REFERENCE_RE.test(value)) {
    violations.push({
      path: `${prefix}${path}`,
      code: 'INVALID_REFERENCE',
      message: `引用格式非法：应为 {ResourceType}/{id}、绝对 URL 或 #contained-id，实收 ${JSON.stringify(value)}`,
    });
  }
}

function checkRules(resource: Record<string, unknown>, type: FhirResourceType, prefix: string): ContractViolation[] {
  const violations: ContractViolation[] = [];
  for (const rule of RESOURCE_CONTRACTS[type]) {
    switch (rule.kind) {
      case 'required': {
        if (!present(get(resource, rule.path))) {
          violations.push({
            path: `${prefix}${rule.path}`,
            code: 'REQUIRED_MISSING',
            message: rule.message ?? `必填字段 ${rule.path} 缺失`,
          });
        }
        break;
      }
      case 'any': {
        const paths = rule.paths ?? [];
        if (!paths.some((p) => present(get(resource, p)))) {
          violations.push({
            path: `${prefix}${rule.path}`,
            code: 'REQUIRED_MISSING',
            message: `至少需要 ${paths.join(' / ')} 之一`,
          });
        }
        break;
      }
      case 'enum': {
        const value = get(resource, rule.path);
        if (!present(value)) break; // 缺失由 required 报，不重复计数
        if (typeof value !== 'string' || !(rule.values ?? []).includes(value)) {
          violations.push({
            path: `${prefix}${rule.path}`,
            code: 'INVALID_VALUE',
            message: `值 ${JSON.stringify(value)} 不在 FHIR R4 值域 [${(rule.values ?? []).join(', ')}]`,
          });
        }
        break;
      }
      case 'reference': {
        checkReference(resource, rule.path, violations, prefix);
        break;
      }
      case 'array-reference': {
        const arr = get(resource, rule.path);
        if (!present(arr)) break;
        if (!Array.isArray(arr)) {
          violations.push({ path: `${prefix}${rule.path}`, code: 'INVALID_TYPE', message: `${rule.path} 应为数组` });
          break;
        }
        arr.forEach((item, i) => {
          const ref = (item as Record<string, unknown>)?.reference;
          if (!present(ref) || typeof ref !== 'string' || !REFERENCE_RE.test(ref)) {
            violations.push({
              path: `${prefix}${rule.path}[${i}].reference`,
              code: 'INVALID_REFERENCE',
              message: `数组引用第 ${i} 项格式非法：${JSON.stringify(ref)}`,
            });
          }
        });
        break;
      }
    }
  }
  return violations;
}

/** 单资源校验（contained 内部资源一并递归校验，路径带 contained[i] 前缀） */
export function validateResource(resource: unknown, opts: { prefix?: string } = {}): ValidationReport {
  const prefix = opts.prefix ?? '';
  if (!resource || typeof resource !== 'object' || Array.isArray(resource)) {
    return {
      resourceType: '?', resourceId: null, ok: false,
      violations: [{ path: `${prefix}resource`, code: 'INVALID_TYPE', message: '资源必须是对象' }],
    };
  }
  const obj = resource as Record<string, unknown>;
  const type = String(obj.resourceType ?? '');
  const id = typeof obj.id === 'string' ? obj.id : null;
  if (!(type in RESOURCE_CONTRACTS)) {
    return {
      resourceType: type || '?', resourceId: id, ok: false,
      violations: [{ path: `${prefix}resourceType`, code: 'UNKNOWN_RESOURCE_TYPE', message: `未定义契约的资源类型：${type}` }],
    };
  }

  const violations = checkRules(obj, type as FhirResourceType, prefix);
  const contained = obj.contained;
  if (Array.isArray(contained)) {
    contained.forEach((inner, i) => {
      const innerReport = validateResource(inner, { prefix: `${prefix}contained[${i}].` });
      if (!innerReport.ok) violations.push(...innerReport.violations);
    });
  }

  return { resourceType: type, resourceId: id, ok: violations.length === 0, violations };
}

/** 批量校验 → 通过数 / 失败数 / 每类失败原因分布 */
export function validateBatch(resources: unknown[]): BatchValidationReport {
  const reports = resources.map((r) => validateResource(r));
  const byResourceType: Record<string, { passed: number; failed: number }> = {};
  const byReason: Record<string, number> = {};
  let passed = 0;
  let failed = 0;
  for (const report of reports) {
    const bucket = byResourceType[report.resourceType] ?? { passed: 0, failed: 0 };
    if (report.ok) { passed += 1; bucket.passed += 1; }
    else {
      failed += 1;
      bucket.failed += 1;
      for (const v of report.violations) {
        const key = `${v.code}@${v.path.replace(/\[\d+\]/g, '[]')}`;
        byReason[key] = (byReason[key] ?? 0) + 1;
      }
    }
    byResourceType[report.resourceType] = bucket;
  }
  return { total: reports.length, passed, failed, byResourceType, byReason, reports };
}

/** 校验失败即抛结构化错误（供 FhirWriter 前置调用，错误对象带完整报告） */
export function assertValidResource(resource: unknown): ValidationReport {
  const report = validateResource(resource);
  if (!report.ok) {
    throw new FhirContractViolationError(
      `FHIR 契约校验失败：${report.violations.map((v) => `${v.path} ${v.code}`).join('; ')}`,
      {
        errorCode: FHIR_CONTRACT_VIOLATION,
        resourceType: report.resourceType,
        resourceId: report.resourceId ?? undefined,
        violations: report.violations,
      },
    );
  }
  return report;
}

/** FhirWriter 可注入的最小校验面 */
export interface ContractValidatorLike {
  validate(resource: Record<string, unknown>): ValidationReport;
}
