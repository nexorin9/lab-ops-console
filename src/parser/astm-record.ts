/**
 * astm-record —— ASTM E1394 记录解析器
 *
 * ASTM E1394 帧结构（简化）：
 * <STX>1H|\^&|||host^host|||||labs||P|1<CR><ETX>
 * 2P|1||||<CR>patient
 * 3O|1|sampleId||panelCode^panelName|R|20261013090000<CR>order
 * 4R|1|^^^K|4.5|mmol/L|3.5-5.5|N<CR>result
 * ...
 * 5L|1|N<CR>terminator
 *
 * 字段映射规则（与 HL7 ORU^R01 保持同构）：
 * - 1H.5 (sending facility) → Device
 * - 1H.10 (receiving app) → Specimen.accessionIdentifier system
 * - 3O.3 (sample id) → Specimen.id
 * - 3O.5 (universal service id) → DiagnosticReport.code
 * - 3O.7 (order datetime) → DiagnosticReport.effectiveDateTime
 * - 4R.3 (test code^name) → Observation.code
 * - 4R.4 (value) → Observation.valueQuantity.value
 * - 4R.5 (unit) → Observation.valueQuantity.unit
 * - 4R.6 (reference range) → Observation.referenceRange
 * - 4R.7 (abnormal flag) → Observation.interpretation + criticalFlag
 *
 * 帧切分由 ByteStreamChannel 负责；本函数只对一条已切帧的纯字符串（去 <STX>/<CR><ETX> 后）做解析。
 */

import { createHash } from 'node:crypto';
import { AstmParseFailError } from '../shared/errors.js';
import type { ParserResult, FhirObservation, FhirDiagnosticReport, FhirSpecimen, FhirDevice, FhirCodeableConcept, FhirReference } from './fhir-types.js';
import { FieldMapper, checkCriticalThreshold } from './field-mapper.js';

export interface ParseAstmOptions {
  deviceId?: string;
  deviceManufacturer?: string;
  deviceModel?: string;
  fieldMapper?: FieldMapper;
}

/** ASTM 字段解析：行内 | 分隔，N 索引 1-based */
function fieldAt(parts: string[], idx: number): string {
  return parts[idx - 1] ?? '';
}

/** ISO 8601 转换：ASTM 时间形如 YYYYMMDDHHMMSS */
function isoFromAstmTimestamp(s: string): string {
  if (s.length < 8) return new Date().toISOString();
  const y = s.slice(0, 4);
  const mo = s.slice(4, 6);
  const d = s.slice(6, 8);
  const hh = s.slice(8, 10) || '00';
  const mm = s.slice(10, 12) || '00';
  const ss = s.slice(12, 14) || '00';
  return `${y}-${mo}-${d}T${hh}:${mm}:${ss}Z`;
}

function parseCodeableConcept(raw: string): FhirCodeableConcept {
  const parts = raw.split('^');
  const code = parts[0] ?? '';
  const display = parts[1] ?? '';
  return {
    coding: [{ code, display: display || undefined }],
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

/**
 * ASTM E1394 控制字符 —— 会话层与帧层的字节真值。
 *
 * 现场仪器与 ASTM 会话的真实差异点就在这几个字节上：
 * 仪器推一条记录前先发 ENQ 问「能收吗」，我方回 ACK；
 * 一条记录结束发 EOT 关会话；帧错回 NAK 要求重传。
 */
export const ASTM_CONTROL = {
  /** 帧开始（记录内容起始） */
  STX: 0x02,
  /** 帧结束（记录内容终止） */
  ETX: 0x03,
  /** 会话结束 */
  EOT: 0x04,
  /** 询问「可以发送吗」 */
  ENQ: 0x05,
  /** 肯定应答 */
  ACK: 0x06,
  /** 否定应答（要求重传） */
  NAK: 0x15,
  /** 记录行结束 */
  CR: 0x0d,
  /** 字段分隔 */
  FS: 0x1c,
} as const;

/** ASTM 会话控制帧类型 */
export type AstmControlFrameType = 'ENQ' | 'ACK' | 'NAK' | 'EOT';

export interface AstmControlFrame {
  type: AstmControlFrameType;
  /** 原始字节（十六进制） */
  rawHex: string;
}

export interface AstmSplitResult {
  /** 切分出的记录（每条含 1H…5L 多行） */
  records: string[];
  /** 切分出的会话控制帧（ENQ / ACK / NAK / EOT） */
  controlFrames: AstmControlFrame[];
}

const ASTM_CONTROL_TYPE_BY_BYTE: Record<number, AstmControlFrameType> = {
  [ASTM_CONTROL.EOT]: 'EOT',
  [ASTM_CONTROL.ENQ]: 'ENQ',
  [ASTM_CONTROL.ACK]: 'ACK',
  [ASTM_CONTROL.NAK]: 'NAK',
};

/**
 * 解码 ASTM 转义序列 %XX。
 *
 * ASTM 用 `%` + 两位十六进制表示一个控制字节（如 %0D = CR、%1C = FS、
 * %05 = ENQ、%25 = 字面量 %）。仪器只发 ASCII 时，字段分隔符与控制字节
 * 会被编码成 %XX 直接出现在报文里；不解码就会把一整条记录粘成一个字段。
 */
export function decodeAstmControlChars(text: string): string {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (ch !== '%') {
      out += ch;
      continue;
    }
    const hex = text.slice(i + 1, i + 3);
    if (hex.length === 2 && /^[0-9A-Fa-f]{2}$/.test(hex)) {
      out += String.fromCharCode(parseInt(hex, 16));
      i += 2;
    } else {
      // 不是合法转义 → 按字面量 '%' 处理
      out += ch;
    }
  }
  return out;
}

/**
 * ASTM 记录切分 —— 从一段原始字节流里切出「记录」与「会话控制帧」。
 *
 * 现场两种 framing 都要认：
 * - STX…ETX 包裹的记录（多数生化仪）
 * - 纯 CR 分隔的记录行（部分血球仪）
 *
 * 控制帧（ENQ / ACK / NAK / EOT）不是记录内容，切出来单独返回，
 * 供会话层（T17）决定何时应答、是否重传。控制帧既可能是裸字节，也可能是 %XX 转义。
 *
 * 返回的 records 保留 %XX 转义原文（只把转义的行结束符消费掉），
 * 由 parseAstmRecord 统一解码一次 —— 若这里先解码一遍、解析时再解码一遍，
 * 形如 %2541（字面量 "%41"）的内容会被解两次变成 "A"，数据被悄悄改掉。
 */
export function splitAstmRecords(raw: string | Buffer): AstmSplitResult {
  const text = typeof raw === 'string' ? raw : raw.toString('latin1');

  const controlFrames: AstmControlFrame[] = [];
  const lines: string[] = [];
  let lineBuffer = '';

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    const code = ch.charCodeAt(0);

    // 转义序列 %XX：识别控制字节，但原文保留给解析层统一解码
    if (ch === '%') {
      const hex = text.slice(i + 1, i + 3);
      if (hex.length === 2 && /^[0-9A-Fa-f]{2}$/.test(hex)) {
        const byte = parseInt(hex, 16);
        const escapedType = ASTM_CONTROL_TYPE_BY_BYTE[byte];
        if (escapedType) {
          controlFrames.push({ type: escapedType, rawHex: hex.toUpperCase() });
          i += 2;
          continue;
        }
        if (byte === ASTM_CONTROL.CR || byte === 0x0a) {
          // 转义的行结束符 → 断行，不进记录内容
          i += 2;
          if (lineBuffer.length > 0) {
            lines.push(lineBuffer);
            lineBuffer = '';
          }
          continue;
        }
        if (byte === ASTM_CONTROL.STX || byte === ASTM_CONTROL.ETX) {
          // 帧边界剥离
          i += 2;
          continue;
        }
        lineBuffer += ch + hex;
        i += 2;
        continue;
      }
      // 不是合法转义 → 按字面量 '%' 处理
      lineBuffer += ch;
      continue;
    }

    if (code === ASTM_CONTROL.STX || code === ASTM_CONTROL.ETX) {
      // 帧边界：记录内容由行结构决定，这里只做边界剥离
      continue;
    }
    const controlType = ASTM_CONTROL_TYPE_BY_BYTE[code];
    if (controlType) {
      controlFrames.push({ type: controlType, rawHex: code.toString(16).toUpperCase().padStart(2, '0') });
      continue;
    }
    if (code === ASTM_CONTROL.CR || ch === '\n') {
      if (lineBuffer.length > 0) {
        lines.push(lineBuffer);
        lineBuffer = '';
      }
      continue;
    }
    lineBuffer += ch;
  }
  if (lineBuffer.length > 0) {
    lines.push(lineBuffer);
  }

  // 按 ASTM 记录结构分组：1H 起、5L 止
  const records: string[] = [];
  let current: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    if (/^\d?H\|/.test(trimmed)) {
      if (current.length > 0) {
        records.push(current.join('\r'));
        current = [];
      }
      current.push(trimmed);
      continue;
    }
    current.push(trimmed);
    if (/^\d?L\|/.test(trimmed)) {
      records.push(current.join('\r'));
      current = [];
    }
  }
  if (current.length > 0) {
    // 没有 5L 收尾（截断 / 缺终止行）→ 仍然作为一条记录交给解析器报错，不静默丢弃
    records.push(current.join('\r'));
  }

  return { records, controlFrames };
}

/**
 * 记录指纹 —— 同一条 ASTM 记录反复解析必须得到同一个指纹。
 *
 * 资源 id 与 accessionIdentifier 是 FHIR 写回侧的幂等锚（If-None-Exist）：
 * 用「当前时间」当锚，重放同一帧时就会生成重复的 Specimen / Observation，
 * 幂等失效、台账出现同一标本的多条记录。指纹取自记录内容，与时间无关。
 */
function recordFingerprint(lines: string[]): string {
  return createHash('sha256').update(lines.join('\r'), 'utf-8').digest('hex').slice(0, 12);
}

/**
 * 解析一条 ASTM 记录字符串（多行 1H/2P/3O/4R/5L）。
 * 返回与 oru-r01 解析同构的 ParserResult。
 */
export async function parseAstmRecord(
  rawRecord: string,
  options: ParseAstmOptions = {},
): Promise<ParserResult> {
  const fieldMapper = options.fieldMapper ?? new FieldMapper(null);

  // 拆行（ASTM 用 \r 分隔；兼容 \r\n / \n）；先解 %XX 转义
  const lines = decodeAstmControlChars(rawRecord)
    .split(/\r\n|\r|\n/)
    .filter((l) => l.trim().length > 0);
  if (lines.length === 0) {
    throw new AstmParseFailError('ASTM 记录为空', { length: 0 });
  }
  const fingerprint = recordFingerprint(lines);

  // header 行（1H 开头；可能是 "1H|..." 或裸 "H|..."）
  const headerLine = lines.find((l) => /^[1]?H\|/.test(l));
  const patientLine = lines.find((l) => /^[2]?P\|/.test(l));
  const orderLine = lines.find((l) => /^[3]?O\|/.test(l));
  const resultLines = lines.filter((l) => /^[4]?R\|/.test(l));

  if (!headerLine) {
    throw new AstmParseFailError('ASTM 记录缺 header (1H) 行', { lines: lines.length });
  }
  if (resultLines.length === 0) {
    throw new AstmParseFailError('ASTM 记录无 4R 结果行', { lines: lines.length });
  }

  const headerParts = headerLine.split('|');
  // ASTM 1H 字段：1H|fieldDelim|repeatDelim|escape|encoding|sender|address|...|receiver|...
  const sendingFacility = fieldAt(headerParts, 5).split('^')[0] || 'unknown-astm';
  const device: FhirDevice = {
    resourceType: 'Device',
    id: options.deviceId ?? sendingFacility,
    manufacturer: options.deviceManufacturer ?? sendingFacility,
    modelNumber: options.deviceModel,
    identifier: [
      {
        system: 'urn:lab-ops-console:device',
        value: options.deviceId ?? sendingFacility,
      },
    ],
  };

  // 病人
  let patientId = `unknown-${fingerprint}`;
  if (patientLine) {
    const p = patientLine.split('|');
    patientId = fieldAt(p, 4).split('^')[0] || patientId; // 2P.4 = practice assigned patient id
  }
  const subjectRef: FhirReference = {
    reference: `Patient/${patientId}`,
    type: 'Patient',
    display: patientId,
  };

  // 医嘱（3O）
  let panelCode = 'UNKNOWN';
  let effectiveTime = new Date().toISOString();
  // 缺 3O 行的退化场景：用记录内容指纹当锚，不用时间戳 —— 保证重放同一帧 id 不变
  let accessionId = `${device.id}:${fingerprint}`;
  if (orderLine) {
    const o = orderLine.split('|');
    accessionId = `${device.id}:${fieldAt(o, 3)}`; // 3O.3 = sample id
    panelCode = fieldAt(o, 5).split('^')[0] || panelCode;
    effectiveTime = isoFromAstmTimestamp(fieldAt(o, 7));
  }

  const specimen: FhirSpecimen = {
    resourceType: 'Specimen',
    id: `spec-${accessionId.replace(/[^A-Za-z0-9]/g, '_')}`,
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
    receivedTime: effectiveTime,
  };

  const diagnosticReport: FhirDiagnosticReport = {
    resourceType: 'DiagnosticReport',
    id: `dr-${accessionId.replace(/[^A-Za-z0-9]/g, '_')}`,
    identifier: [
      {
        system: 'urn:lab-ops-console:accession',
        value: accessionId,
      },
    ],
    status: 'final',
    code: { coding: [{ code: panelCode }], text: panelCode },
    subject: subjectRef,
    effectiveDateTime: effectiveTime,
    issued: new Date().toISOString(),
    specimen: [{ reference: `Specimen/${specimen.id}` }],
    result: [],
  };

  const observations: FhirObservation[] = [];
  const fieldAttribution: ParserResult['fieldAttribution'] = [];
  const criticalFlags: ParserResult['criticalFlags'] = [];

  for (let i = 0; i < resultLines.length; i++) {
    const r = resultLines[i].split('|');
    const setId = fieldAt(r, 1) || String(i + 1);
    const identifierRaw = fieldAt(r, 3); // 4R.3 = test code^name
    const valueRaw = fieldAt(r, 4); // 4R.4 = value
    const unit = fieldAt(r, 5); // 4R.5 = unit
    const refRange = fieldAt(r, 6); // 4R.6 = reference range
    const abnFlag = fieldAt(r, 7); // 4R.7 = abnormal flag

    const idParts = identifierRaw.split('^');
    // ASTM E1394 4R.3 = 项目标识字段，子成分依次是「项目码^项目名^项目类型^样本类型^…」：
    //   ^^^K                          → 码 K
    //   ^^^K^钾                       → 码 K，名 钾
    //   ^^^ALT^丙氨酸氨基转移酶^E      → 码 ALT，名 丙氨酸氨基转移酶（末位的 E 是项目类型）
    // 取「前两个非空子成分」：码在前、名在后。
    // 不能取末位非空 —— 那会把项目类型当成项目码（^^^ALT^丙氨酸氨基转移酶^E → 码 "E"），
    // 结果危急值阈值表按项目码查不到，K=6.8 mmol/L 这类危急值会被漏判。
    const nonEmpty = idParts.map((s) => s.trim()).filter((s) => s.length > 0);
    const deviceCode = nonEmpty[0] ?? '';
    const deviceDisplay = nonEmpty[1] ?? deviceCode;

    const attribution = await fieldMapper.mapResultCode({
      deviceCode,
      deviceDisplay,
      deviceId: device.id,
      panelCode,
    });
    fieldAttribution.push({
      deviceCode,
      deviceDisplay,
      loinc: attribution.loinc === 'unknown' ? undefined : attribution.loinc,
      confidence: attribution.confidence,
      source: attribution.source,
      lowConfidence: attribution.lowConfidence,
    });

    const observation: FhirObservation = {
      resourceType: 'Observation',
      id: `obs-${accessionId.replace(/[^A-Za-z0-9]/g, '_')}-${setId}`,
      status: 'final',
      code: {
        coding: [
          {
            system: attribution.loinc && attribution.loinc !== 'unknown'
              ? 'http://loinc.org'
              : undefined,
            code: attribution.loinc && attribution.loinc !== 'unknown' ? attribution.loinc : deviceCode,
            display: attribution.display || deviceDisplay,
          },
        ],
        text: deviceDisplay || deviceCode,
      },
      subject: subjectRef,
      effectiveDateTime: diagnosticReport.effectiveDateTime,
      issued: diagnosticReport.issued,
      device: { reference: `Device/${device.id}` },
      specimen: { reference: `Specimen/${specimen.id}` },
    };

    const num = Number(valueRaw);
    if (!Number.isNaN(num)) {
      observation.valueQuantity = {
        value: num,
        unit: unit || undefined,
        system: 'http://unitsofmeasure.org',
        code: unit || undefined,
      };
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
      observation.valueString = valueRaw;
    }

    if (refRange) {
      observation.referenceRange = [{ text: refRange }];
    }
    const interp = parseAbnormalFlag(abnFlag);
    if (interp) {
      observation.interpretation = interp;
      if (['HH', 'LL', 'AA'].includes(abnFlag.toUpperCase())) {
        criticalFlags.push({
          observationId: observation.id,
          testCode: deviceCode,
          testDisplay: deviceDisplay,
          value: valueRaw,
          unit,
          reason: 'abnormal_flag',
          detail: `ASTM 4R.7=${abnFlag} 标记为危急（${deviceCode}=${valueRaw}${unit ?? ''}）`,
        });
      }
    }

    observations.push(observation);
    diagnosticReport.result!.push({
      reference: `Observation/${observation.id}`,
      type: 'Observation',
    });
  }

  return {
    observations,
    diagnosticReport,
    specimen,
    specimens: [specimen],
    device,
    fieldAttribution,
    criticalFlags,
  };
}

/**
 * 解析一段 ASTM 原始字节流 —— 先切帧再逐条解析。
 *
 * 与 parseAstmRecord 的分工：
 * - parseAstmRecord 只吃「一条已经切好的记录」
 * - parseAstmStream 吃「一段原始字节流」，内部完成 %XX 解码 + ENQ/ACK/EOT 切分
 *
 * 单条记录解析失败不丢整批：失败项进 errors，其余照常产出。
 */
export async function parseAstmStream(
  raw: string | Buffer,
  options: ParseAstmOptions = {},
): Promise<{
  results: ParserResult[];
  errors: Array<{ record: string; error: AstmParseFailError }>;
  controlFrames: AstmControlFrame[];
}> {
  const { records, controlFrames } = splitAstmRecords(raw);
  const results: ParserResult[] = [];
  const errors: Array<{ record: string; error: AstmParseFailError }> = [];

  for (const record of records) {
    try {
      results.push(await parseAstmRecord(record, options));
    } catch (err) {
      errors.push({
        record,
        error:
          err instanceof AstmParseFailError
            ? err
            : new AstmParseFailError('ASTM 记录解析失败', { record: record.slice(0, 120) }, err),
      });
    }
  }

  return { results, errors, controlFrames };
}
