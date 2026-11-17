/**
 * observability.test.ts —— T35 结构化日志 + 错误码表 + 运行摘要（含脱敏）
 *
 * 覆盖：
 * 1. 结构化日志为合法 JSON，固定字段齐全（time/level/msg/component）
 * 2. 日志级别过滤：info 级下 debug 不输出
 * 3. 脱敏 redactContext 递归遮罩敏感字段（姓名/证件/电话/地址）
 * 4. 脱敏 redactValue 遮罩身份证/手机号/银行卡模式
 * 5. 错误码表完整：每个 ErrorCode 都有元数据，且表键都在 ErrorCode 内
 * 6. RunSummary 记录事件并累计 totals，字典命中率计算正确
 * 7. RunSummary 窗口到期 flush 归零窗口但保留 totals
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Writable } from 'node:stream';
import pino, { type LoggerOptions } from 'pino';
import { createLogger, _resetRootLogger, _setRootLogger } from '../../src/shared/logger.js';
import { redactContext, redactValue, REDACTED } from '../../src/shared/redact.js';
import {
  ErrorCode, ERROR_CODE_TABLE, ALL_ERROR_CODES, getErrorCodeMeta, BaseError,
} from '../../src/shared/errors.js';
import { RunSummary } from '../../src/shared/run-summary.js';

class StringSink extends Writable {
  lines: string[] = [];
  override _write(chunk: Buffer, _enc: BufferEncoding, cb: (err?: Error | null) => void): void {
    this.lines.push(chunk.toString('utf8'));
    cb();
  }
  parsed(): Array<Record<string, unknown>> {
    return this.lines
      .flatMap((l) => l.split('\n').filter(Boolean))
      .map((l) => JSON.parse(l));
  }
}

const TEST_OPTIONS: LoggerOptions = {
  level: 'info',
  formatters: { level: (label) => ({ level: label }) },
  timestamp: pino.stdTimeFunctions.isoTime,
  base: { pid: process.pid },
};

describe('T35 · 结构化日志', () => {
  let sink: StringSink;
  let saved: string | undefined;

  beforeEach(() => {
    saved = process.env.LOG_LEVEL;
    sink = new StringSink();
    _resetRootLogger();
    _setRootLogger(pino(TEST_OPTIONS, sink));
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.LOG_LEVEL;
    else process.env.LOG_LEVEL = saved;
    _resetRootLogger();
  });

  it('输出为合法 JSON 且固定字段齐全（time/level/msg/component）', () => {
    const log = createLogger('fhir.FhirWriter');
    log.info({ fhirResourceType: 'DiagnosticReport', fhirResourceId: 'dr-1' }, '写回成功');
    const lines = sink.parsed();
    expect(lines.length).toBe(1);
    const rec = lines[0]!;
    expect(typeof rec.time).toBe('string');
    expect(rec.level).toBe('info');
    expect(rec.msg).toBe('写回成功');
    expect(rec.component).toBe('fhir.FhirWriter');
    expect(rec.fhirResourceType).toBe('DiagnosticReport');
  });

  it('日志级别过滤：info 级下 debug 不输出', () => {
    const log = createLogger('app');
    log.debug('这条不该出现');
    log.info('这条该出现');
    const lines = sink.parsed();
    expect(lines.length).toBe(1);
    expect(lines[0]!.msg).toBe('这条该出现');
  });

  it('敏感字段在日志边界被脱敏（姓名/证件不落明文）', () => {
    const log = createLogger('critical.dispatcher');
    log.warn({ patientId: 'PAT-001', name: '张三', mrn: 'MRN-998', controlId: 'C1' }, '脱敏验证');
    const rec = sink.parsed()[0]!;
    expect(rec.name).toBe(REDACTED);
    expect(rec.mrn).toBe(REDACTED);
    // patientId 命中敏感 key（patientid）同样被遮罩
    expect(rec.patientId).toBe(REDACTED);
    // 非敏感字段保留
    expect(rec.controlId).toBe('C1');
  });
});

describe('T35 · 脱敏工具', () => {
  it('redactContext 递归遮罩敏感字段，非敏感字段原样保留', () => {
    const input = {
      name: '李四',
      controlId: 'ORD-1',
      nested: { phone: '13800001111', note: 'ok' },
      list: [{ idCard: '110101199001011234' }, { keep: 'x' }],
    };
    const out = redactContext(input);
    expect(out.name).toBe(REDACTED);
    expect(out.controlId).toBe('ORD-1');
    expect((out.nested as Record<string, unknown>).phone).toBe(REDACTED);
    expect((out.nested as Record<string, unknown>).note).toBe('ok');
    expect((out.list as Array<Record<string, unknown>>)[0]!.idCard).toBe(REDACTED);
    expect((out.list as Array<Record<string, unknown>>)[1]!.keep).toBe('x');
  });

  it('redactValue 遮罩身份证/手机号/银行卡模式', () => {
    expect(redactValue('110101199001011234')).toContain(REDACTED);
    expect(redactValue('13800001111')).toContain(REDACTED);
    expect(redactValue('6222021234567890123')).toContain(REDACTED);
    // 普通值不遮罩
    expect(redactValue('ORD-123')).toBe('ORD-123');
  });

  it('redactContext 不修改入参（纯函数）', () => {
    const input = { name: '王五', id: 'ORD-9' };
    redactContext(input);
    expect(input.name).toBe('王五'); // 原对象未被改动
  });
});

describe('T35 · 错误码表', () => {
  it('每个 ErrorCode 都有元数据条目', () => {
    for (const code of ALL_ERROR_CODES) {
      expect(ERROR_CODE_TABLE[code], `错误码 ${code} 缺元数据`).toBeDefined();
      expect(ERROR_CODE_TABLE[code]!.category).toBeTruthy();
      expect(['fatal', 'error', 'warn', 'info']).toContain(ERROR_CODE_TABLE[code]!.severity);
    }
  });

  it('错误码表的键全部是合法 ErrorCode（无孤儿条目）', () => {
    const valid = new Set(ALL_ERROR_CODES);
    for (const key of Object.keys(ERROR_CODE_TABLE)) {
      expect(valid.has(key as never), `表键 ${key} 不在 ErrorCode 枚举内`).toBe(true);
    }
  });

  it('getErrorCodeMeta 返回已知 code 的元数据，未知 code 不抛错', () => {
    expect(getErrorCodeMeta(ErrorCode.FHIR_WRITE_FAIL).category).toBe('fhir');
    const meta = getErrorCodeMeta('NOT_A_REAL_CODE');
    expect(meta.category).toBe('unknown');
    expect(meta.severity).toBe('warn');
  });

  it('BaseError 序列化携带稳定 code/context 字段供日志与审计消费', () => {
    const err = new BaseError(ErrorCode.DLQ_ENQUEUE, '落盘失败', { channelName: 'hl7' });
    const json = err.toJSON();
    expect(json.code).toBe(ErrorCode.DLQ_ENQUEUE);
    expect(json.context).toMatchObject({ channelName: 'hl7' });
    expect(json.name).toBe('BaseError');
  });
});

describe('T35 · 运行摘要', () => {
  it('记录事件累计到 totals，窗口内计数随事件增长', () => {
    const s = new RunSummary({ windowMs: 60_000, now: () => 1000 });
    s.record('inbound_frame', 3);
    s.record('critical', 2);
    const snap = s.snapshot();
    expect(snap.totals.inbound_frame).toBe(3);
    expect(snap.totals.critical).toBe(2);
    expect(snap.window.inbound_frame).toBe(3);
  });

  it('字典命中率按窗口计算（命中/(命中+未命中)）', () => {
    const s = new RunSummary({ windowMs: 60_000, now: () => 1000 });
    s.record('dictionary_hit', 4);
    s.record('dictionary_miss', 1);
    const snap = s.snapshot();
    expect(snap.dictionaryHitRate).toBe(80);
  });

  it('窗口到期 flush 归零窗口但保留 totals', () => {
    let now = 1000;
    const s = new RunSummary({ windowMs: 1000, now: () => now });
    s.record('inbound_frame', 5);
    now = 2500; // 跨过窗口
    const flush = s.maybeFlush();
    expect(flush).not.toBeNull();
    const snap = s.snapshot();
    expect(snap.window.inbound_frame).toBe(0); // 窗口已归零
    expect(snap.totals.inbound_frame).toBe(5); // totals 保留
    expect(snap.flushes).toBe(1);
  });

  it('快照暴露运维抓手所需的固定字段', () => {
    const s = new RunSummary({ windowMs: 60_000, now: () => 1000 });
    const snap = s.snapshot();
    expect(snap).toHaveProperty('startedAt');
    expect(snap).toHaveProperty('windowMs');
    expect(snap).toHaveProperty('window');
    expect(snap).toHaveProperty('totals');
    expect(snap).toHaveProperty('dictionaryHitRate');
  });
});
