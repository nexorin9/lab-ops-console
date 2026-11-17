/**
 * oru-r01 —— HL7 v2 ORU^R01 解析器
 *
 * 输入：Hl7Message（已由 Hl7Connection.parseMessages 切帧并解析）
 * 输出：ParserResult（Observation[] + DiagnosticReport + Specimen + Device + fieldAttribution + criticalFlags）
 *
 * 字段映射规则：
 * - MSH.3 (sending app) → Device.manufacturer
 * - MSH.4 (sending facility) → Specimen.accessionIdentifier system
 * - MSH.7 (timestamp) → DiagnosticReport.effectiveDateTime + issued
 * - MSH.10 (control id) → DiagnosticReport.identifier
 * - PID.3 (patient id) → DiagnosticReport.subject + Observation.subject
 * - PID.5 (patient name) → DiagnosticReport.subject.display
 * - OBR.4 (universal service id) → DiagnosticReport.code（panel 名）
 * - OBR.7 (observation datetime) → DiagnosticReport.effectiveDateTime 优先
 * - OBX.2 (value type) → Observation.valueQuantity / valueString
 * - OBX.3 (observation identifier) → Observation.code（code^name^codingSystem）
 * - OBX.5 (observation value) → Observation.valueQuantity.value
 * - OBX.6 (units) → Observation.valueQuantity.unit
 * - OBX.7 (reference range) → Observation.referenceRange[0].text
 * - OBX.8 (abnormal flags) → Observation.interpretation + criticalFlag 候选
 * - OBX.11 (result status) → Observation.status
 */

import type { Hl7Message } from '../channels/Hl7Connection.js';
import { parseHl7Message } from '../channels/Hl7Connection.js';
import { Hl7ParseFailError, DeviceNotAllowedError } from '../shared/errors.js';
import type {
  ParserResult,
  FhirObservation,
  FhirDiagnosticReport,
  FhirSpecimen,
  FhirDevice,
  FhirCodeableConcept,
  FhirIdentifier,
  FhirReference,
} from './fhir-types.js';
import { FieldMapper, checkCriticalThreshold, type ModelGatewayLike } from './field-mapper.js';

export interface ParseOruR01Options {
  /** 设备 ID（来自 channel yaml 的 deviceId 字段，优先于 MSH.3 推断） */
  deviceId?: string;
  /** 设备厂家 */
  deviceManufacturer?: string;
  /** 设备型号 */
  deviceModel?: string;
  /** 设备序列号 */
  deviceSerialNumber?: string;
  /**
   * 授权设备白名单（留空 = 不限制）。
   * 院内一台仪器报废 / 换机后，旧仪器可能还在往端口推报文；
   * 白名单外的设备报文直接拒收，不进解析主路径。
   */
  allowedDeviceIds?: string[];
  /** 依赖注入：FieldMapper（缺省时只走同步字典查表，模型兜底不可用） */
  fieldMapper?: FieldMapper;
}

/**
 * ORU^R01 段视图 —— 「字节 → 结构化样本」的最短路径输出。
 * msh / pid / pv1 / obr 为单段字段数组（缺段为 undefined），obx 为多段数组。
 */
export interface OruR01SegmentView {
  /** MSH 段字段数组 */
  msh: string[];
  /** PID 段（患者标识） */
  pid?: string[];
  /** PV1 段（就诊 / 病区） */
  pv1?: string[];
  /** OBR 段（检验申请 / 组合） */
  obr?: string[];
  /** OBX 段列表（每项检验结果） */
  obx: string[][];
}

/**
 * 从已解析的 Hl7Message 取 ORU^R01 段视图。
 */
export function parseOruR01Segments(msg: Hl7Message): OruR01SegmentView {
  const find = (name: string): string[] | undefined =>
    msg.segments.find((s) => s[0] === name);
  return {
    msh: msg.msh,
    pid: find('PID'),
    pv1: find('PV1'),
    obr: find('OBR'),
    obx: msg.segments.filter((s) => s[0] === 'OBX'),
  };
}

/**
 * 段级入口：从一帧原始 HL7 文本（含或不含 VT/FS/CR 帧边界）直接得到段视图。
 *
 * 与 parseOruR01（产出 FHIR 资源）的分工：
 * - 本函数只做「帧 → 段」，不查字典、不调模型，是主干第 1 段的最短可核对路径；
 * - parseOruR01 在其上补齐 FHIR 资源与字段归因。
 */
export function parseOruR01Frame(frame: string | Buffer): OruR01SegmentView {
  const text = typeof frame === 'string' ? frame : frame.toString('utf-8');
  // 去掉帧边界（VT 0x0B / FS 0x1C / CR 0x0D）—— CR 兼作段分隔符，故只去首尾 VT/FS
  const stripped = text.replace(/^﻿/, '').replace(/^\x0b/, '').replace(/\x1c\x0d$/, '');
  const msg = parseHl7Message(stripped);
  return parseOruR01Segments(msg);
}

function fieldAt(segment: string[], idx: number, isMsh: boolean = false): string {
  // HL7 段字段 1-indexed
  // - MSH.N 在 msh[N-1]（MSH.1 是字段分隔符，被 split 吃掉）
  // - 其他段：PID.1 在 seg[1]、PID.3 在 seg[3]（段名在 seg[0]），所以 SEG.N 在 seg[N]
  return isMsh ? (segment[idx - 1] ?? '') : (segment[idx] ?? '');
}

function isoFromHl7Timestamp(hl7Ts: string): string {
  // HL7 v2 时间戳：YYYYMMDDHHMMSS 或 YYYYMMDDHHMMSS.SSS
  if (hl7Ts.length < 8) return new Date().toISOString();
  const y = hl7Ts.slice(0, 4);
  const m = hl7Ts.slice(4, 6);
  const d = hl7Ts.slice(6, 8);
  const hh = hl7Ts.slice(8, 10) || '00';
  const mm = hl7Ts.slice(10, 12) || '00';
  const ss = hl7Ts.slice(12, 14) || '00';
  return `${y}-${m}-${d}T${hh}:${mm}:${ss}Z`;
}

function parseCodeableConcept(raw: string, system?: string): FhirCodeableConcept {
  // 形如 K^钾^L 或 2823-3^Potassium^LN
  const parts = raw.split('^');
  const code = parts[0] ?? '';
  const display = parts[1] ?? '';
  const codingSystem = parts[2] ?? '';
  return {
    coding: [
      {
        system: system ?? (codingSystem ? `urn:hl7:${codingSystem.toLowerCase()}` : undefined),
        code,
        display: display || undefined,
      },
    ],
    text: display || code,
  };
}

function parseAbnormalFlag(flag: string): FhirCodeableConcept[] | undefined {
  if (!flag) return undefined;
  const map: Record<string, string> = {
    H: 'High',
    L: 'Low',
    HH: 'Critical high',
    LL: 'Critical low',
    A: 'Abnormal',
    AA: 'Critical abnormal',
    N: 'Normal',
  };
  return [
    {
      coding: [
        {
          system: 'http://terminology.hl7.org/CodeSystem/v3-ObservationInterpretation',
          code: flag,
          display: map[flag] ?? flag,
        },
      ],
      text: map[flag] ?? flag,
    },
  ];
}

function observationStatusFromObx11(s: string): FhirObservation['status'] {
  const v = s.toUpperCase();
  if (v === 'F') return 'final';
  if (v === 'P') return 'preliminary';
  if (v === 'C') return 'corrected';
  if (v === 'X') return 'cancelled';
  return 'registered';
}

/** 按医嘱（OBR）分组的 OBX 集合 —— 一份 OBR 对应一份标本 */
interface ObxGroup {
  /** 该组的 OBR 段（无 OBR 时为 undefined） */
  obr?: string[];
  /** 该组的 SPM 段（标本段，可选） */
  spm?: string[];
  /** 归属该组的 OBX 段 */
  obx: string[][];
}

/**
 * 按 OBR 把 OBX 分组。
 *
 * 现场真实报文里一条 ORU^R01 可能带多个 OBR（同一份血样分送生化 + 免疫，
 * 或一次采血多管），每个 OBR 下的 OBX 归属各自的标本。
 * 没有 OBR 时全部 OBX 归为一组（退化行为与单标本一致）。
 */
function groupObxByOrder(segments: string[][]): ObxGroup[] {
  const groups: ObxGroup[] = [];
  let pending: string[][] = [];
  let current: ObxGroup | undefined;

  for (const seg of segments) {
    const name = seg[0];
    if (name === 'OBR') {
      current = { obr: seg, obx: [...pending] };
      pending = [];
      groups.push(current);
      continue;
    }
    if (name === 'SPM') {
      if (!current) {
        current = { obx: [] };
        groups.push(current);
      }
      current.spm = seg;
      continue;
    }
    if (name === 'OBX') {
      if (current) {
        current.obx.push(seg);
      } else {
        pending.push(seg);
      }
    }
  }

  if (groups.length === 0) {
    // 完全没有 OBR：全部 OBX 归为一组（无 OBR 上下文）
    groups.push({ obx: pending });
  } else if (pending.length > 0) {
    // OBX 出现在首个 OBR 之前 → 并入首组
    groups[0]!.obx.unshift(...pending);
  }
  return groups;
}

/**
 * 解析标本标识 —— 优先 SPM.2，其次 OBR.3（申请号），再次 OBR.2。
 * 都没有时退化为组序号，保证 accession 仍可区分。
 */
function resolveSpecimenKey(group: ObxGroup, index: number): string {
  const spmId = group.spm ? fieldAt(group.spm, 2) : '';
  if (spmId) return spmId;
  const obr3 = group.obr ? fieldAt(group.obr, 3) : '';
  if (obr3) return obr3;
  const obr2 = group.obr ? fieldAt(group.obr, 2) : '';
  if (obr2) return obr2;
  return `g${index + 1}`;
}

/**
 * 解析 ORU^R01 消息为 FHIR R4 资源 + 字段归因 + 危急值标记。
 * 抛 Hl7ParseFailError 时含具体字段位置（消息控制 ID + 段名 + 字段号）。
 */
export async function parseOruR01(
  msg: Hl7Message,
  options: ParseOruR01Options = {},
): Promise<ParserResult> {
  if (msg.messageType !== 'ORU' || msg.triggerEvent !== 'R01') {
    throw new Hl7ParseFailError(
      `非 ORU^R01 消息：${msg.messageType}^${msg.triggerEvent}`,
      { controlId: msg.controlId, type: msg.messageType, trigger: msg.triggerEvent },
    );
  }

  const fieldMapper = options.fieldMapper ?? new FieldMapper(null);

  // ---- 段定位 ----
  const pidSeg = msg.segments.find((s) => s[0] === 'PID');
  const obxSegs = msg.segments.filter((s) => s[0] === 'OBX');

  if (obxSegs.length === 0) {
    throw new Hl7ParseFailError(
      'ORU^R01 消息缺 OBX 段',
      { controlId: msg.controlId, segmentCount: msg.segments.length },
    );
  }

  // ---- Device ----
  const deviceId = options.deviceId ?? fieldAt(msg.msh, 3, true) ?? 'unknown-device';

  // 白名单外设备直接拒收：报废 / 换机后的旧仪器报文不进解析主路径
  if (options.allowedDeviceIds && options.allowedDeviceIds.length > 0) {
    const allowed = options.allowedDeviceIds.map((d) => d.trim().toLowerCase());
    if (!allowed.includes(deviceId.trim().toLowerCase())) {
      throw new DeviceNotAllowedError(
        `设备 ${deviceId} 不在授权白名单内，拒收该报文`,
        { controlId: msg.controlId, deviceId, allowed: options.allowedDeviceIds },
      );
    }
  }

  const deviceManufacturer =
    options.deviceManufacturer ?? (fieldAt(msg.msh, 3, true) || undefined);
  const device: FhirDevice = {
    resourceType: 'Device',
    id: deviceId,
    manufacturer: deviceManufacturer,
    modelNumber: options.deviceModel,
    serialNumber: options.deviceSerialNumber,
    identifier: [
      {
        system: 'urn:lab-ops-console:device',
        value: deviceId,
      },
    ],
  };

  // ---- 患者引用（一条消息一份患者）----
  const patientId = pidSeg
    ? fieldAt(pidSeg, 3).split('^')[0] || `unknown-${msg.controlId}`
    : `unknown-${msg.controlId}`;
  const subjectRef: FhirReference = {
    reference: `Patient/${patientId}`,
    type: 'Patient',
  };
  const patientDisplay = pidSeg ? fieldAt(pidSeg, 5).split('^')[0] || patientId : patientId;
  subjectRef.display = patientDisplay;

  // ---- 按 OBR 分组：一份 OBR = 一份标本 ----
  const groups = groupObxByOrder(msg.segments);
  const multiSpecimen = groups.length > 1;
  const firstObr = groups[0]?.obr;

  const observations: FhirObservation[] = [];
  const fieldAttribution: ParserResult['fieldAttribution'] = [];
  const criticalFlags: ParserResult['criticalFlags'] = [];
  const parseErrors: NonNullable<ParserResult['parseErrors']> = [];
  const skippedSegments: NonNullable<ParserResult['skippedSegments']> = [];
  const specimens: FhirSpecimen[] = [];

  for (let gi = 0; gi < groups.length; gi++) {
    const group = groups[gi]!;
    const obrSeg = group.obr;
    const specimenKey = resolveSpecimenKey(group, gi);
    const accessionId = multiSpecimen
      ? `${deviceId}:${msg.controlId}:${specimenKey}`
      : `${deviceId}:${msg.controlId}`;
    const specimenId = multiSpecimen ? `spec-${msg.controlId}-g${gi + 1}` : `spec-${msg.controlId}`;

    const specimen: FhirSpecimen = {
      resourceType: 'Specimen',
      id: specimenId,
      status: 'available',
      identifier: [
        {
          system: 'urn:lab-ops-console:accession',
          value: accessionId,
        },
      ],
      accessionIdentifier: {
        system: 'urn:lab-ops-console:accession',
        value: accessionId,
      },
      receivedTime: isoFromHl7Timestamp(fieldAt(msg.msh, 7, true)),
    };
    specimens.push(specimen);

    for (let i = 0; i < group.obx.length; i++) {
      const obx = group.obx[i]!;
      const setId = fieldAt(obx, 1) || String(i + 1);

      // 空值行（整行只有段名 / 全是空字段）→ 跳过并记账，不产出垃圾 Observation
      const fields = obx.slice(1);
      if (fields.length === 0 || fields.every((f) => f.trim() === '')) {
        skippedSegments.push({ segment: 'OBX', setId, reason: '空值行（无有效字段）' });
        continue;
      }

      // 字段级 try-catch：单条 OBX 失败只丢这一条，同批其余 OBX 照常产出 Observation
      try {
        const valueType = fieldAt(obx, 2).toUpperCase();
        const identifierRaw = fieldAt(obx, 3);
        const subId = fieldAt(obx, 4);
        const valueRaw = fieldAt(obx, 5);
        const unit = fieldAt(obx, 6);
        const refRange = fieldAt(obx, 7);
        const abnFlag = fieldAt(obx, 8);
        const resultStatus = fieldAt(obx, 11);

        // 缺 OBX.3（检验项目标识）→ 该条无法归因，记错误并跳过，同批其余项照常
        if (!identifierRaw.trim()) {
          parseErrors.push({
            segment: 'OBX',
            setId,
            code: 'HL7_FIELD_INVALID',
            message: `OBX.${setId} 缺 OBX.3（检验项目标识），该条跳过，同批其余项继续`,
          });
          continue;
        }

        // 提取 code^display^codingSystem
        const idParts = identifierRaw.split('^');
        const deviceCode = idParts[0] ?? '';
        const deviceDisplay = idParts[1] ?? deviceCode;
        const codingSystem = idParts[2] ?? '';

        // 字段归因（异步，可能调 model）
        const attribution = await fieldMapper.mapResultCode({
          deviceCode,
          deviceDisplay,
          deviceId,
          panelCode: obrSeg ? fieldAt(obrSeg, 4).split('^')[0] : undefined,
        });
        fieldAttribution.push({
          deviceCode,
          deviceDisplay,
          loinc: attribution.loinc === 'unknown' ? undefined : attribution.loinc,
          confidence: attribution.confidence,
          source: attribution.source,
          lowConfidence: attribution.lowConfidence,
        });

        // 构造 Observation
        const observation: FhirObservation = {
          resourceType: 'Observation',
          id: multiSpecimen
            ? `obs-${msg.controlId}-g${gi + 1}-${setId}${subId ? `-${subId}` : ''}`
            : `obs-${msg.controlId}-${setId}${subId ? `-${subId}` : ''}`,
          status: observationStatusFromObx11(resultStatus),
          code: {
            coding: [
              {
                system: attribution.loinc && attribution.loinc !== 'unknown'
                  ? 'http://loinc.org'
                  : (codingSystem ? `urn:hl7:${codingSystem.toLowerCase()}` : undefined),
                code: attribution.loinc && attribution.loinc !== 'unknown' ? attribution.loinc : deviceCode,
                display: attribution.display || deviceDisplay,
              },
            ],
            text: deviceDisplay || deviceCode,
          },
          subject: subjectRef,
          effectiveDateTime: isoFromHl7Timestamp(
            obrSeg ? fieldAt(obrSeg, 7) || fieldAt(msg.msh, 7, true) : fieldAt(msg.msh, 7, true),
          ),
          issued: isoFromHl7Timestamp(fieldAt(msg.msh, 7, true)),
          device: { reference: `Device/${deviceId}`, type: 'Device' },
          specimen: { reference: `Specimen/${specimenId}` },
        };

        // 值类型分支：NM/数值 vs ST/字符串
        if (valueType === 'NM' || valueType === 'SN') {
          const num = Number(valueRaw);
          if (!Number.isNaN(num)) {
            observation.valueQuantity = {
              value: num,
              unit: unit || undefined,
              system: 'http://unitsofmeasure.org',
              code: unit || undefined,
            };

            // 危急值检测
            const t = checkCriticalThreshold(deviceCode, num, unit);
            if (t.critical) {
              criticalFlags.push({
                observationId: observation.id,
                testCode: deviceCode,
                testDisplay: deviceDisplay,
                value: valueRaw,
                unit,
                reason: 'threshold_exceeded',
                detail: `${deviceCode}=${num}${unit ? unit : ''} ${t.reason === 'high' ? '>' : '<'} ${t.reason === 'high' ? t.threshold?.high : t.threshold?.low}${t.threshold?.unit ?? ''}`,
              });
            }
          } else {
            // 数值字段非数字 → 走字符串回退
            observation.valueString = valueRaw;
          }
        } else {
          observation.valueString = valueRaw;
        }

        // 参考范围
        if (refRange) {
          observation.referenceRange = [{ text: refRange }];
        }

        // 异常标记（FHIR interpretation）
        const interp = parseAbnormalFlag(abnFlag);
        if (interp) {
          observation.interpretation = interp;

          // OBX.8 包含 HH/LL/AA 视为危急值
          if (['HH', 'LL', 'AA'].includes(abnFlag.toUpperCase())) {
            criticalFlags.push({
              observationId: observation.id,
              testCode: deviceCode,
              testDisplay: deviceDisplay,
              value: valueRaw,
              unit,
              reason: 'abnormal_flag',
              detail: `OBX.8=${abnFlag} 标记为危急（${deviceCode}=${valueRaw}${unit ?? ''}）`,
            });
          }
        }

        observations.push(observation);
      } catch (err) {
        // 单字段失败不丢整帧：记错误、跳这一条、其余继续
        parseErrors.push({
          segment: 'OBX',
          setId,
          code: 'HL7_FIELD_INVALID',
          message: `OBX.${setId} 解析失败：${(err as Error)?.message ?? String(err)}`,
        });
      }
    }
  }

  // ---- DiagnosticReport 主结构 ----
  const effectiveTime = firstObr
    ? fieldAt(firstObr, 7) || fieldAt(msg.msh, 7, true)
    : fieldAt(msg.msh, 7, true);

  const diagnosticReport: FhirDiagnosticReport = {
    resourceType: 'DiagnosticReport',
    id: `dr-${msg.controlId}`,
    identifier: [
      {
        system: 'urn:lab-ops-console:control-id',
        value: msg.controlId,
      },
    ],
    status: 'final',
    code: firstObr
      ? parseCodeableConcept(fieldAt(firstObr, 4))
      : parseCodeableConcept('ORU^R01^ORU_R01'),
    subject: subjectRef,
    effectiveDateTime: isoFromHl7Timestamp(effectiveTime),
    issued: isoFromHl7Timestamp(fieldAt(msg.msh, 7, true)),
    specimen: specimens.map((s) => ({ reference: `Specimen/${s.id}` })),
    result: observations.map((o) => ({ reference: `Observation/${o.id}`, type: 'Observation' })),
  };

  return {
    observations,
    diagnosticReport,
    specimen: specimens[0]!,
    specimens,
    device,
    fieldAttribution,
    criticalFlags,
    parseErrors,
    skippedSegments,
  };
}
