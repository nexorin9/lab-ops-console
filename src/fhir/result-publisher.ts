/**
 * result-publisher —— 解析结果 → FHIR 写入 + 回读校验（主干第 2 段的胶水层）
 *
 * 职责边界：
 * - 解析层（src/parser）只产出结构化资源，不碰网络；
 * - 写入层（src/fhir/FhirWriter）只管单条资源的 HTTP 语义（幂等 / 重试 / 回读）；
 * - 本模块把两者接起来：一份标本 → Device / Specimen / Observation[] / DiagnosticReport，
 *   并在最后回读报告确认「Observation 引用真的写进去了」。
 *
 * 幂等口径（与 spec.md §4 对齐）：
 * - Observation / Specimen / Device 的 id 由解析层按「设备 + 控制号 + 序号」确定性生成，
 *   走 PUT 按 id upsert —— 同一份标本重推不会产生第二份资源；
 * - DiagnosticReport 额外带 If-None-Exist（accessionIdentifier = <设备ID>:<MSH.10>），
 *   服务端若已存在同 accession 的报告则返回既有资源，不重复建报告。
 */

import type { FhirWriter } from './FhirWriter.js';
import type { ParserResult } from '../parser/fhir-types.js';

export interface PublishOptions {
  /** 覆盖设备 ID（缺省用解析层给出的 Device.id） */
  deviceId?: string;
  /** 是否写 Device（默认 true） */
  writeDevice?: boolean;
  /** 是否写 Specimen（默认 true） */
  writeSpecimen?: boolean;
  /** 是否回读校验报告（默认 true） */
  verify?: boolean;
  /** 错误上下文（写进结构化错误 / DLQ） */
  context?: Record<string, unknown>;
}

export interface PublishResult {
  /** 幂等键：<设备ID>:<MSH.10> */
  accessionIdentifier: string;
  deviceId: string;
  specimenId?: string;
  observationIds: string[];
  diagnosticReportId: string;
  /** 回读校验是否通过（报告可读 + Observation 引用齐全） */
  verified: boolean;
  /** 本次写入的资源条数 */
  written: number;
}

/**
 * publishParserResult —— 把一份标本的解析结果写进院内 FHIR 端点。
 *
 * 写入顺序：Device → Specimen → Observation[] → DiagnosticReport
 * （报告最后写：报告里的 result[] 引用必须先有对应的 Observation 落库）
 */
export async function publishParserResult(
  writer: FhirWriter,
  parsed: ParserResult,
  options: PublishOptions = {},
): Promise<PublishResult> {
  const verify = options.verify !== false;
  const deviceId = options.deviceId ?? parsed.device?.id ?? 'unknown-device';
  const accessionIdentifier =
    parsed.specimen?.accessionIdentifier?.value ??
    `${deviceId}:${parsed.diagnosticReport?.id ?? 'unknown'}`;
  const context = { ...(options.context ?? {}), deviceId, accessionIdentifier };

  let written = 0;

  // ---- Device：每台仪器一条（按 id upsert，重推不新建）----
  if (options.writeDevice !== false && parsed.device?.id) {
    await writer.write('Device', { ...parsed.device, id: deviceId } as unknown as Record<string, unknown>, {
      verify: false,
      context,
    });
    written += 1;
  }

  // ---- Specimen：每份标本一条（补 subject，让标本能追到患者）----
  let specimenId: string | undefined;
  if (options.writeSpecimen !== false && parsed.specimen?.id) {
    const specimen = {
      ...parsed.specimen,
      subject: parsed.specimen.subject ?? parsed.diagnosticReport?.subject,
    };
    await writer.write('Specimen', specimen as unknown as Record<string, unknown>, {
      verify: false,
      context,
    });
    specimenId = specimen.id;
    written += 1;
  }

  // ---- Observation：每条 OBX 一条（id 确定性 → 按 id upsert 天然幂等）----
  const observationIds: string[] = [];
  for (const observation of parsed.observations ?? []) {
    if (!observation.id) continue;
    await writer.write('Observation', observation as unknown as Record<string, unknown>, {
      verify: false,
      context,
    });
    observationIds.push(observation.id);
    written += 1;
  }

  // ---- DiagnosticReport：每份报告一条（contained 关联 Observation + result 引用）----
  const observations = parsed.observations ?? [];
  const report = {
    ...parsed.diagnosticReport,
    contained: observations,
    result:
      parsed.diagnosticReport?.result ??
      observations
        .filter((o) => o.id)
        .map((o) => ({ reference: `Observation/${o.id}`, type: 'Observation' })),
  };
  const reportWrite = await writer.write(
    'DiagnosticReport',
    report as unknown as Record<string, unknown>,
    { idempotencyKey: accessionIdentifier, verify, context },
  );
  written += 1;

  // 回读校验：报告可读 + 每条 Observation 引用都在
  const refs = (reportWrite.resource?.result as Array<{ reference?: string }> | undefined) ?? [];
  const referencesComplete = observationIds.every((id) =>
    refs.some((r) => r.reference === `Observation/${id}`),
  );
  const verified = verify ? reportWrite.verified && referencesComplete : false;

  return {
    accessionIdentifier,
    deviceId,
    specimenId,
    observationIds,
    diagnosticReportId: reportWrite.id,
    verified,
    written,
  };
}
