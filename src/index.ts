/**
 * lab-ops-console 启动装配 —— 一条常驻主路径
 *
 * 仪器字节 → HL7/ASTM/串口通道 → 解析 → FHIR R4 写回 → 危急值检测 → Task 状态机 →
 * 多通道派发 → Express + ws 面板。所有凭据从 env 读，缺失时降级但不静默改数据。
 *
 * 本模块同时是 `node dist/index.js` 的入口；`createLabOpsApp()` 可被测试直接调用，
 * 注入临时端口与本地 FHIR 替身，跑真实 TCP / 真实 HTTP 的端到端路径。
 */

import 'dotenv/config';
import { Buffer } from 'node:buffer';
import iconv from 'iconv-lite';
import type { Server as HttpServer } from 'node:http';
import { Hl7Server } from './channels/Hl7Server.js';
import { parseHl7Message, type Hl7Message } from './channels/Hl7Connection.js';
import { DLQ } from './channels/DLQ.js';
import { ChannelSupervisor, type ManagedChannel } from './channels/supervisor.js';
import { parseOruR01 } from './parser/oru-r01.js';
import { detect, resolvePatientId } from './critical/detector.js';
import { hashPatientId } from './critical/NotificationDispatcher.js';
import { CriticalStore } from './critical/store.js';
import { TaskStateMachine } from './critical/Task-state-machine.js';
import { NotificationDispatcher } from './critical/NotificationDispatcher.js';
import { getCriticalTools, toFhirId, type CriticalToolRegistry } from './critical/tools/index.js';
import { publishParserResult } from './fhir/result-publisher.js';
import { createFhirWriter, createFhirWriterWithToken, type FhirWriter } from './fhir/FhirWriter.js';
import { validateResource } from './fhir/validate.js';
import { createGatewayServer, type GatewayHandle } from './gateway/server.js';
import { ModelGateway } from './ai/ModelGateway.js';
import { createModelCallAuditor } from './ai/audit.js';
import type { ModelConfig } from './ai/config.js';
import type { Candidate, FallbackProvider } from './ai/types.js';
import { OncallRoster } from './critical/oncall.js';
import { RedeliveryWorker } from './critical/redelivery.js';
import { CandidateAdoption } from './critical/CandidateAdoption.js';
import { getSqlite } from './shared/sqlite.js';
import { RunSummary } from './shared/run-summary.js';
import { createLogger } from './shared/logger.js';

const log = createLogger('app');

export interface LabOpsAppOptions {
  env?: NodeJS.ProcessEnv;
  dataDir?: string;
  channelsDir?: string;
  /** 仪器 TCP 端口；0 = 由 OS 分配（测试用） */
  devicePort?: number;
  /** HTTP / WS 端口；0 = 由 OS 分配（测试用） */
  httpPort?: number;
  startChannels?: boolean;
  encoding?: 'utf-8' | 'gbk' | 'gb18030';
  deviceId?: string;
  wallboardToken?: string;
  auditDir?: string;
  now?: () => string;
  /** 直接注入已构造的 FHIR 写出器（e2e 指向本地替身） */
  fhirWriter?: FhirWriter;
  fhirBaseUrl?: string;
  fhirToken?: string;
  fhirTokenUrl?: string;
  fhirClientId?: string;
  fhirClientSecret?: string;
  modelConfig?: ModelConfig;
  modelFetch?: typeof fetch;
  notifyWebhookUrl?: string;
  /** T20 · 出站前做 FHIR R4 契约校验（默认开启；显式 false 可关） */
  validateFhirContracts?: boolean;
  /** T25 · 注入值班表兜底提供者（默认加载 channels/oncall-sample.yaml） */
  oncallRoster?: FallbackProvider;
  oncallRosterPath?: string;
}

export interface IngestResult {
  ok: boolean;
  controlId: string;
  observations: number;
  reportId: string;
  criticalTasks: string[];
  dlqEnqueued: number;
  error?: string;
}

export interface LabOpsApp {
  httpPort: number;
  devicePort: number;
  store: CriticalStore;
  stateMachine: TaskStateMachine;
  tools: CriticalToolRegistry;
  dispatcher: NotificationDispatcher;
  gateway: GatewayHandle;
  supervisor: ChannelSupervisor;
  summary: RunSummary;
  redelivery: RedeliveryWorker;
  modelGateway: ModelGateway;
  writer: FhirWriter | null;
  dlq: DLQ;
  candidates: Map<string, Candidate[]>;
  pendingModelCalls: Promise<unknown>[];
  ingestFrame(raw: string | Buffer, opts?: { controlId?: string }): Promise<IngestResult>;
  start(): Promise<void>;
  stop(): Promise<void>;
}

function stripFrame(text: string): string {
  return text.replace(/^\uFEFF/, '').replace(/^\x0b/, '').replace(/\x1c\x0d$/, '').replace(/\x1c$/, '');
}

/** 构造一个可复用的应用实例（不自动启动） */
export async function createLabOpsApp(opts: LabOpsAppOptions = {}): Promise<LabOpsApp> {
  const env = opts.env ?? process.env;
  const encoding = opts.encoding ?? 'utf-8';
  const deviceId = opts.deviceId ?? 'DEV001';
  const now = opts.now ?? (() => new Date().toISOString());
  const dataDir = opts.dataDir ?? env.DATA_DIR ?? './data';
  const db = getSqlite({ dataDir });
  const dlq = new DLQ(db);
  const store = new CriticalStore(db);
  const stateMachine = new TaskStateMachine(store);
  const tools = getCriticalTools();
  const dispatcher = new NotificationDispatcher({
    db,
    ...(opts.notifyWebhookUrl ? { webhook: { url: opts.notifyWebhookUrl } } : {}),
  });
  const summary = new RunSummary();

  // ---- FHIR 出站：优先注入的写出器，其次按凭据位构造（静态 token 或 OAuth2 client-credentials）----
  let writer: FhirWriter | null = opts.fhirWriter ?? null;
  const contractValidator = opts.validateFhirContracts === false
    ? undefined
    : { validate: (resource: Record<string, unknown>) => validateResource(resource) };
  if (!writer && (opts.fhirBaseUrl ?? env.FHIR_BASE_URL)) {
    const baseUrl = (opts.fhirBaseUrl ?? env.FHIR_BASE_URL)!;
    const urlAllowlist = [new URL(baseUrl).origin];
    const tokenUrl = opts.fhirTokenUrl ?? env.FHIR_OAUTH_TOKEN_URL;
    const token = opts.fhirToken ?? env.FHIR_TOKEN;
    if (tokenUrl) {
      writer = createFhirWriter({
        baseUrl,
        tokenUrl,
        clientId: opts.fhirClientId ?? env.FHIR_OAUTH_CLIENT_ID ?? 'lab-ops-console',
        clientSecret: opts.fhirClientSecret ?? env.FHIR_OAUTH_CLIENT_SECRET ?? '',
        urlAllowlist,
        dlqSink: dlq,
        contractValidator,
      });
    } else if (token) {
      writer = createFhirWriterWithToken({ baseUrl, token, urlAllowlist, dlqSink: dlq, contractValidator });
    }
  }

  // T25 · 值班表是模型不可达时的确定性兜底路径，缺配置也降级到默认角色，绝不返回空候选
  const oncallRoster = opts.oncallRoster ?? (() => {
    const roster = new OncallRoster({ ...(opts.oncallRosterPath ? { path: opts.oncallRosterPath } : {}) });
    roster.load();
    return roster;
  })();
  const modelGateway = new ModelGateway({
    ...(opts.modelConfig ? { config: opts.modelConfig } : { env }),
    ...(opts.modelFetch ? { fetchImpl: opts.modelFetch } : {}),
    auditor: createModelCallAuditor(opts.auditDir ?? 'audit'),
    criticalStore: store,
    fallback: oncallRoster,
  });

  const candidates = new Map<string, Candidate[]>();
  const pendingModelCalls: Promise<unknown>[] = [];
  const redelivery = new RedeliveryWorker({
    dispatcher,
    db,
    now,
    onComplete: (result) => gateway.broadcast('push.redelivered', result as unknown as Record<string, unknown>),
  });
  const gateway = createGatewayServer({
    store, stateMachine, tools, dispatcher,
    ...(writer ? { writer } : {}),
    summary,
    ...(opts.wallboardToken ? { wallboardToken: opts.wallboardToken } : {}),
    now,
  });

  // T33 · 候选采纳闭环：直接复用进程内候选缓存（与 ingest 同引用），接纳/忽略落成审计 + FHIR owner 回写
  const candidateAdoption = new CandidateAdoption({
    candidates,
    store,
    stateMachine,
    ...(writer ? { writer } : {}),
    source: 'lab-ops-console',
    now,
  });

  let currentDevicePort = opts.devicePort ?? Number(env.DEVICE_LISTEN_PORT ?? 2575);
  let currentHttpPort = opts.httpPort ?? Number(env.HTTP_PORT ?? 3000);
  const httpPortRef = { value: 0 };

  const app: LabOpsApp = {
    httpPort: 0,
    devicePort: 0,
    store, stateMachine, tools, dispatcher, gateway, summary, redelivery, modelGateway, writer, dlq,
    candidates, pendingModelCalls,
    supervisor: null as unknown as ChannelSupervisor,
    ingestFrame: async () => { throw new Error('app not initialized'); },
    start: async () => {},
    stop: async () => {},
  };

  /** 单帧入站的完整主路径（真实 TCP 通道也走这里） */
  const ingestFrame = async (raw: string | Buffer, frameOpts: { controlId?: string } = {}): Promise<IngestResult> => {
    const text = Buffer.isBuffer(raw)
      ? (encoding === 'utf-8' ? raw.toString('utf-8') : iconv.decode(raw, encoding))
      : raw;
    summary.record('inbound_frame');
    const result: IngestResult = {
      ok: false, controlId: frameOpts.controlId ?? '', observations: 0,
      reportId: '', criticalTasks: [], dlqEnqueued: 0,
    };
    try {
      const message: Hl7Message = parseHl7Message(stripFrame(text));
      result.controlId = message.controlId;
      const parsed = await parseOruR01(message, { deviceId });
      result.observations = parsed.observations.length;
      const reportId = parsed.diagnosticReport?.id ?? message.controlId;
      result.reportId = reportId;
      summary.record('parsed_ok');

      // 字段级脏数据不丢整帧：标错后继续写，同时把原始字节留 DLQ 供对账
      if (parsed.parseErrors && parsed.parseErrors.length > 0) {
        dlq.enqueue({
          channelName: 'hl7-ingest',
          errorCode: 'FRAME_MALFORMED',
          errorMessage: parsed.parseErrors.map((e) => e.message).join('; '),
          rawBytes: Buffer.from(text),
        });
        result.dlqEnqueued += 1;
        summary.record('dlq');
      }

      if (writer) {
        try {
          await publishParserResult(writer, parsed, { deviceId, verify: false });
        } catch (err) {
          summary.record('fhir_failure');
          dlq.enqueue({
            channelName: 'fhir-write',
            errorCode: 'FHIR_WRITE_FAIL',
            errorMessage: err instanceof Error ? err.message : String(err),
            rawBytes: Buffer.from(text),
          });
          result.dlqEnqueued += 1;
          summary.record('dlq');
        }
      }

      const detection = detect(parsed, { now: Date.now() });
      const patientHash = hashPatientId(resolvePatientId(parsed));
      const focus = `DiagnosticReport/${toFhirId(reportId)}`;
      const ward = (message.segments.find((s) => s[0] === 'PV1')?.[3] ?? '未分诊').split('^')[0] || '未分诊';

      for (const flag of detection.flags) {
        const task = await stateMachine.createTask({
          patientId: patientHash,
          focusDiagnosticId: focus,
          focusObservationCode: flag.testCode,
          priority: flag.severity === 'critical' ? 'stat' : 'urgent',
          reasonText: `${flag.testDisplay || flag.testCode} ${flag.value}${flag.unit ?? ''}`,
          value: flag.value,
          unit: flag.unit ?? null,
          testCode: flag.testCode,
          testDisplay: flag.testDisplay,
          severity: flag.severity,
          agent: { practitionerId: 'system/lab-ops-console', role: 'system' },
        });
        const chain = await store.queryAuditChain(task.id);
        const isNew = chain.length === 1; // 仅 task_created = 本次新建
        result.criticalTasks.push(task.id);
        summary.record('critical');

        // 模型候选（非阻塞）：不可达时降级到规则，绝不挡住护士 ack
        const modelCall = modelGateway.suggestRecipients({
          ward, testCode: flag.testCode, severity: flag.severity, at: now(),
        }).then(async (res) => {
          candidates.set(task.id, res.data);
          if (!res.ok) {
            summary.record('model_fallback');
            await modelGateway.writeFallbackAudit(task.id, res.errorCode ?? 'MODEL_UNAVAILABLE');
          }
        }).catch((err: unknown) => {
          log.warn({ err: err instanceof Error ? err.message : String(err), taskId: task.id }, '模型候选失败，已忽略');
        });
        pendingModelCalls.push(modelCall);

        if (isNew) {
          const dispatched = await dispatcher.dispatch(task, {
            type: 'critical.detected',
            testCode: flag.testCode,
            testDisplay: flag.testDisplay,
            value: flag.value,
            unit: flag.unit,
            severity: flag.severity,
            detectedAt: now(),
            summary: detection.summary,
          });
          if (!dispatched.ok) summary.record('push_failure');
          gateway.broadcast('critical.detected', {
            taskId: task.id, status: task.status, testCode: flag.testCode,
            testDisplay: flag.testDisplay, value: flag.value, unit: flag.unit,
            patientHash, severity: flag.severity, detectedAt: now(),
          });
        }
      }

      app.supervisor.markFrame('hl7-ingest');
      gateway.broadcast('sample.recent', {
        controlId: message.controlId, reportId, observations: result.observations,
        patientHash, at: now(),
        summary: `${result.observations} 项检验 · 报告 ${reportId} · 患者 ${patientHash.slice(0, 10)}`,
      });
      gateway.broadcast('device.heartbeat', {
        channelId: 'hl7-ingest', at: now(), status: 'running',
      });
      result.ok = true;
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn({ err: message, controlId: result.controlId }, '入站帧处理失败，原始字节进 DLQ');
      dlq.enqueue({
        channelName: 'hl7-ingest',
        errorCode: 'HL7_PARSE_FAIL',
        errorMessage: message,
        rawBytes: Buffer.from(text),
      });
      result.dlqEnqueued += 1;
      result.error = message;
      summary.record('dlq');
      return result;
    }
  };

  /** 通道工厂：reload 只重建这台仪器对应的 Hl7Server */
  const makeHl7Channel = (): ManagedChannel => {
    const server = new Hl7Server('hl7-ingest', { encoding, dlq });
    server.on('message', (payload: { message: Hl7Message }) => {
      void ingestFrame(payload.message.raw, { controlId: payload.message.controlId });
    });
    server.on('error', (err: Error) => {
      app.supervisor?.markError('hl7-ingest', err.message);
      summary.record('dlq');
    });
    return {
      id: 'hl7-ingest',
      type: 'hl7',
      async start() {
        const port = await server.start(currentDevicePort);
        currentDevicePort = port;
        return port;
      },
      async stop() {
        try { await server.stop({ forceDrainTimeoutMs: 100 }); } catch { /* 未启动时忽略 */ }
      },
    };
  };

  const supervisor = new ChannelSupervisor({
    factories: [{ id: 'hl7-ingest', type: 'hl7', create: makeHl7Channel }],
    onStatusChange: (status) => gateway.broadcast('channel.status', { ...status }),
    onAlert: (event) => { log.warn(event, '通道告警'); },
  });

  app.supervisor = supervisor;
  app.ingestFrame = ingestFrame;
  // gateway 的 /api/channels 与 reload 走同一个 supervisor（延迟绑定，避免循环依赖）
  gateway.bind({ supervisor, summary, redelivery, candidateAdoption });

  app.start = async () => {
    if (opts.startChannels !== false) {
      const statuses = await supervisor.startAll();
      app.devicePort = statuses[0]?.port ?? currentDevicePort;
    } else {
      app.devicePort = currentDevicePort;
    }
    httpPortRef.value = await gateway.start(currentHttpPort);
    currentHttpPort = httpPortRef.value;
    app.httpPort = httpPortRef.value;
    // T28 · 启动补推循环（网络恢复后自动重派断网期间堆积的 pending 通知）
    redelivery.startLoop();
    log.info({ httpPort: app.httpPort, devicePort: app.devicePort, writer: !!writer }, 'lab-ops-console started');
  };

  app.stop = async () => {
    redelivery.stopLoop();
    await Promise.allSettled(pendingModelCalls);
    await gateway.close();
    await supervisor.stopAll();
  };

  return app;
}

/** 进程入口：node dist/index.js */
export async function main(): Promise<void> {
  const app = await createLabOpsApp();
  await app.start();
  const shutdown = async (): Promise<void> => {
    await app.stop();
    process.exit(0);
  };
  process.on('SIGINT', () => { void shutdown(); });
  process.on('SIGTERM', () => { void shutdown(); });
}

const isDirectRun = process.argv[1] && /(?:^|\/)index\.(?:js|ts)$/.test(process.argv[1]);
if (isDirectRun) {
  main().catch((err: Error) => {
    process.stderr.write(`[lab-ops-console] 启动失败：${err.stack ?? err.message}\n`);
    process.exit(1);
  });
}

export type { HttpServer };
