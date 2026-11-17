/**
 * FHIR R4 资源类型精简定义 —— 解析层只用到的最小子集
 *
 * 设计原则：
 * - 不引入 fhir.js / fhir-kit-client 等依赖（避免包体积膨胀 + 满足「真生产最小子集」要求）
 * - 字段命名严格对齐 FHIR R4 spec（cardinality 0..1/0..* 体现在字段是否可为 undefined / 是否为数组）
 * - 时间字段统一用 ISO 8601 字符串
 *
 * 与 FhirWriter（T6 阶段）保持一致：本文件只描述数据结构，构造逻辑在 resources/。
 */

export interface FhirCoding {
  system?: string;
  code: string;
  display?: string;
}

export interface FhirCodeableConcept {
  coding: FhirCoding[];
  text?: string;
}

export interface FhirReference {
  reference: string;
  display?: string;
  type?: string;
}

export interface FhirIdentifier {
  system?: string;
  value: string;
  use?: 'usual' | 'official' | 'temp' | 'secondary';
}

export interface FhirQuantity {
  value: number;
  unit?: string;
  system?: string;
  code?: string;
}

/** FHIR R4 Observation —— 单项检验结果 */
export interface FhirObservation {
  resourceType: 'Observation';
  id?: string;
  status: 'registered' | 'preliminary' | 'final' | 'amended' | 'corrected' | 'cancelled';
  category?: FhirCodeableConcept[];
  code: FhirCodeableConcept;
  subject?: FhirReference;
  effectiveDateTime?: string;
  issued?: string;
  valueQuantity?: FhirQuantity;
  valueString?: string;
  interpretation?: FhirCodeableConcept[];
  referenceRange?: Array<{
    low?: FhirQuantity;
    high?: FhirQuantity;
    text?: string;
  }>;
  device?: FhirReference;
  specimen?: FhirReference;
}

/** FHIR R4 DiagnosticReport —— 一份完整报告（多 OBX 关联） */
export interface FhirDiagnosticReport {
  resourceType: 'DiagnosticReport';
  id?: string;
  identifier?: FhirIdentifier[];
  status: 'registered' | 'partial' | 'preliminary' | 'final' | 'amended' | 'corrected' | 'appended' | 'cancelled' | 'entered-in-error';
  category?: FhirCodeableConcept[];
  code: FhirCodeableConcept;
  subject?: FhirReference;
  effectiveDateTime?: string;
  issued?: string;
  specimen?: FhirReference[];
  result?: FhirReference[];
  conclusion?: string;
  note?: Array<{ text: string; time?: string; authorReference?: FhirReference }>;
}

/** FHIR R4 Specimen —— 标本 */
export interface FhirSpecimen {
  resourceType: 'Specimen';
  id?: string;
  identifier?: FhirIdentifier[];
  status?: 'available' | 'unavailable' | 'unsatisfactory' | 'entered-in-error';
  type?: FhirCodeableConcept;
  subject?: FhirReference;
  receivedTime?: string;
  accessionIdentifier?: FhirIdentifier;
}

/** FHIR R4 Device —— 仪器 */
export interface FhirDevice {
  resourceType: 'Device';
  id: string;
  identifier?: FhirIdentifier[];
  manufacturer?: string;
  modelNumber?: string;
  serialNumber?: string;
  type?: FhirCodeableConcept;
}

/** 解析层统一输出结构 */
export interface ParserResult {
  observations: FhirObservation[];
  diagnosticReport: FhirDiagnosticReport;
  /** 首份标本（多标本场景下为第一份；完整列表见 specimens） */
  specimen: FhirSpecimen;
  /**
   * 本次消息涉及的全部标本。
   * 一条 ORU^R01 可携带多个 OBR（每 OBR 一份标本），OBX 按所属 OBR 归属到对应标本。
   */
  specimens: FhirSpecimen[];
  device: FhirDevice;
  /** 仪器原始码 → LOINC 归因明细（用于审计 + 字段归因观测） */
  fieldAttribution: Array<{
    deviceCode: string;
    deviceDisplay: string;
    loinc?: string;
    confidence: number;
    source: 'dictionary' | 'model' | 'fallback';
    /** 字典未命中且模型兜底不可用 → true；结果仍可用但需人工确认 */
    lowConfidence?: boolean;
  }>;
  /** 危急值标记（K 6.8 mmol/L 之类） */
  criticalFlags: Array<{
    observationId?: string;
    testCode: string;
    testDisplay: string;
    value: string;
    unit?: string;
    reason: 'abnormal_flag' | 'threshold_exceeded';
    detail: string;
  }>;
  /**
   * 字段级解析错误（单条 OBX 失败不丢整帧）。
   * 出错的那条 OBX 不产出 Observation，其余同批 OBX 照常产出。
   */
  parseErrors?: Array<{
    /** 出错段名（OBX / PID / OBR …） */
    segment: string;
    /** 段内序号（OBX.1） */
    setId?: string;
    /** 错误码（HL7_PARSE_FAIL / HL7_FIELD_INVALID …） */
    code: string;
    /** 人可读原因 */
    message: string;
  }>;
  /**
   * 被跳过的空段（如整行只有 "OBX" 的空值行）。
   * 跳过不是静默丢弃 —— 逐条记账，信息科能查到「这台仪器今天空行有多少」。
   */
  skippedSegments?: Array<{
    segment: string;
    setId?: string;
    reason: string;
  }>;
}
