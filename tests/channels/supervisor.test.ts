/**
 * T15 · ChannelSupervisor 生命周期 / 单通道热重载 / 指数退避重连
 */

import { describe, it, expect, vi } from 'vitest';
import { ChannelSupervisor, DEFAULT_BACKOFF_MS, type ManagedChannel } from '../../src/channels/supervisor.js';

interface FakeChannel extends ManagedChannel {
  starts: number;
  stops: number;
  port: number;
  disconnect?: (err?: Error) => void;
}

function fakeFactory(id: string, opts: { failStart?: boolean; port?: number } = {}) {
  const created: FakeChannel[] = [];
  const factory = {
    id,
    type: 'hl7',
    create: (): ManagedChannel => {
      const ch: FakeChannel = {
        id,
        type: 'hl7',
        starts: 0,
        stops: 0,
        port: opts.port ?? 0,
        async start() {
          ch.starts += 1;
          if (opts.failStart && created.length > 1) throw new Error(`port ${ch.port} unreachable`);
          return ch.port;
        },
        async stop() { ch.stops += 1; },
        onDisconnect(cb) { ch.disconnect = cb; },
      };
      created.push(ch);
      return ch;
    },
  };
  return { factory, created };
}

const instantSleep = () => async (_ms: number) => { await Promise.resolve(); };

describe('T15 · 生命周期与热重载', () => {
  it('reload 目标通道后，另一通道连接仍可用（stop 未被调用）', async () => {
    const a = fakeFactory('hl7-a', { port: 10001 });
    const b = fakeFactory('hl7-b', { port: 10002 });
    const sup = new ChannelSupervisor({ factories: [a.factory, b.factory], autoReconnect: false });
    await sup.startAll();
    const bFirst = b.created[0]!;
    await sup.reload('hl7-a');
    expect(bFirst.stops).toBe(0);
    expect(bFirst.starts).toBe(1);
    expect(a.created).toHaveLength(2);
    expect(sup.status().find((s) => s.id === 'hl7-b')?.status).toBe('running');
    expect(sup.status().find((s) => s.id === 'hl7-a')?.port).toBe(10001);
  });

  it('重复 reload 幂等（并发两次只重建一次）', async () => {
    const a = fakeFactory('hl7-a');
    const sup = new ChannelSupervisor({ factories: [a.factory], autoReconnect: false });
    await sup.startAll();
    await Promise.all([sup.reload('hl7-a'), sup.reload('hl7-a')]);
    expect(a.created).toHaveLength(2);
  });

  it('stopAll 释放所有通道（每条都调用 stop）', async () => {
    const a = fakeFactory('hl7-a');
    const b = fakeFactory('hl7-b');
    const sup = new ChannelSupervisor({ factories: [a.factory, b.factory], autoReconnect: false });
    await sup.startAll();
    await sup.stopAll();
    expect(a.created[0]!.stops).toBe(1);
    expect(b.created[0]!.stops).toBe(1);
    expect(sup.status().every((s) => s.status === 'stopped' && s.port === 0)).toBe(true);
  });

  it('status 字段齐全且 markFrame 累计帧数 / 刷新心跳', async () => {
    const a = fakeFactory('hl7-a', { port: 12345 });
    const sup = new ChannelSupervisor({ factories: [a.factory], autoReconnect: false, now: () => 1_700_000_000_000 });
    await sup.startAll();
    sup.markFrame('hl7-a', 3);
    sup.markError('hl7-a', 'E-FRAME-PARSE');
    const s = sup.status()[0]!;
    expect(s).toMatchObject({ id: 'hl7-a', type: 'hl7', status: 'running', port: 12345, frameCount: 3 });
    expect(s.lastHeartbeatAt).toBeTruthy();
    expect(s.lastErrorCode).toBe('E-FRAME-PARSE');
    expect(s.retryCount).toBe(0);
  });
});

describe('T15 · 断线退避与降级', () => {
  it('断线置 degraded，退避序列为 10s / 30s / 90s（之后沿用 90s）', async () => {
    const waits: number[] = [];
    const a = fakeFactory('hl7-a', { failStart: true });
    const sup = new ChannelSupervisor({
      factories: [a.factory],
      backoffMs: DEFAULT_BACKOFF_MS,
      maxRetries: 5,
      sleep: async (ms) => { waits.push(ms); },
    });
    await sup.startAll();
    const afterStart = sup.status()[0]!;
    expect(afterStart.status).toBe('running');
    await sup.handleDisconnect('hl7-a', new Error('ECONNRESET'));
    expect(sup.status()[0]!.status).toBe('down');
    expect(waits).toEqual([10_000, 30_000, 90_000, 90_000, 90_000]);
    expect(sup.backoffSchedule()).toHaveLength(5);
  });

  it('重试 5 次失败后置 down 并发告警', async () => {
    const alert = vi.fn();
    const a = fakeFactory('hl7-a', { failStart: true });
    const sup = new ChannelSupervisor({
      factories: [a.factory], maxRetries: 5, sleep: instantSleep(), onAlert: alert,
    });
    await sup.startAll();
    await sup.handleDisconnect('hl7-a');
    expect(sup.status()[0]!.status).toBe('down');
    expect(alert).toHaveBeenCalledOnce();
    expect(alert.mock.calls[0]![0]).toMatchObject({ channelId: 'hl7-a', level: 'critical' });
  });

  it('断线后重连成功 → 回到 running 并清零重试计数', async () => {
    let attempt = 0;
    const factory = {
      id: 'hl7-a', type: 'hl7',
      create: (): ManagedChannel => {
        const n = ++attempt;
        return {
          id: 'hl7-a', type: 'hl7',
          async start() { if (n === 2) throw new Error('still down'); return 10001; },
          async stop() {},
        };
      },
    };
    const sup = new ChannelSupervisor({ factories: [factory], sleep: async () => {} });
    await sup.startAll();
    await sup.handleDisconnect('hl7-a');
    expect(sup.status()[0]!.status).toBe('running');
    expect(sup.status()[0]!.retryCount).toBe(0);
  });

  it('degraded 期间收到一帧 → 自动回到 running（不静默消失）', async () => {
    const a = fakeFactory('hl7-a');
    const sup = new ChannelSupervisor({ factories: [a.factory], autoReconnect: false });
    await sup.startAll();
    await sup.handleDisconnect('hl7-a', new Error('link down'));
    expect(sup.status()[0]!.status).toBe('degraded');
    sup.markFrame('hl7-a');
    expect(sup.status()[0]!.status).toBe('running');
  });
});
