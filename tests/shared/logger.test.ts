import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Writable } from 'node:stream';
import pino, { type LoggerOptions } from 'pino';
import { createLogger, _resetRootLogger, _setRootLogger } from '../../src/shared/logger.js';

/**
 * logger.test.ts —— JSON 格式输出、child 绑定、字段链
 * 通过注入自定义 sink 来捕获日志行（不污染测试 stdout）
 *
 * 复刻 src/shared/logger.ts 中 baseOptions 的 formatters + timestamp，确保测试断言
 * 与生产配置一致。
 */

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
  level: 'trace',
  formatters: { level: (label) => ({ level: label }) },
  timestamp: pino.stdTimeFunctions.isoTime,
  base: { pid: process.pid },
};

describe('shared/logger', () => {
  let sink: StringSink;
  let savedLevel: string | undefined;

  beforeEach(() => {
    savedLevel = process.env.LOG_LEVEL;
    sink = new StringSink();
    _resetRootLogger();
    const root = pino(TEST_OPTIONS, sink);
    _setRootLogger(root);
  });

  afterEach(() => {
    if (savedLevel === undefined) delete process.env.LOG_LEVEL;
    else process.env.LOG_LEVEL = savedLevel;
    _resetRootLogger();
  });

  it('createLogger 返回绑定 component 的 child logger', () => {
    const log = createLogger('Hl7Server');
    log.info('hello');
    const lines = sink.parsed();
    expect(lines.length).toBeGreaterThanOrEqual(1);
    expect(lines[0]).toMatchObject({
      component: 'Hl7Server',
      msg: 'hello',
      level: 'info',
    });
    expect(typeof (lines[0] as any).time).toBe('string');
  });

  it('支持 child 链绑定 requestId / channelId / taskId', () => {
    const log = createLogger('parser').withContext({
      requestId: 'req-1',
      channelId: 'ch-hl7',
      taskId: 't-42',
    });
    log.info({ extra: 1 }, 'parsed');
    const lines = sink.parsed();
    expect(lines[0]).toMatchObject({
      component: 'parser',
      requestId: 'req-1',
      channelId: 'ch-hl7',
      taskId: 't-42',
      extra: 1,
      msg: 'parsed',
    });
  });

  it('输出 JSON 格式（每行一条 JSON）', () => {
    const log = createLogger('test');
    log.info('a');
    log.warn('b');
    log.error('c');
    const parsed = sink.parsed();
    expect(parsed.length).toBe(3);
    for (const p of parsed) {
      expect(typeof p).toBe('object');
      expect(typeof p.time).toBe('string');
      expect(typeof p.level).toBe('string');
      expect(typeof p.msg).toBe('string');
    }
  });

  it('error 字段附加 err_ 前缀', () => {
    const log = createLogger('test');
    log.error({ err_name: 'F', err_code: 'X' }, 'oops');
    const lines = sink.parsed();
    expect(lines[0]).toMatchObject({
      err_name: 'F',
      err_code: 'X',
      level: 'error',
      msg: 'oops',
    });
  });

  it('支持多次 child 链（不丢失父字段）', () => {
    const log = createLogger('critical').withContext({ requestId: 'r1' }).withContext({ taskId: 't1' });
    log.info('msg');
    const lines = sink.parsed();
    expect(lines[0]).toMatchObject({
      component: 'critical',
      requestId: 'r1',
      taskId: 't1',
    });
  });

  it('level 阈值生效（trace 默认输出；info 阈值过滤 debug）', () => {
    _resetRootLogger();
    const silent = new StringSink();
    const root = pino({ ...TEST_OPTIONS, level: 'info' }, silent);
    _setRootLogger(root);
    const log = createLogger('test');
    log.debug('should not appear');
    log.info('should appear');
    const parsed = silent.parsed();
    expect(parsed.length).toBe(1);
    expect(parsed[0].msg).toBe('should appear');
  });
});
