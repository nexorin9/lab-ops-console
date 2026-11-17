/**
 * tests/channels/channel-loader.test.ts —— 通道配置化 + 多通道并存
 *
 * 覆盖（任务书 T4）：
 * 1. 合法 yaml 载入（hl7 / bytestream / private 三类）
 * 2. 缺必填项拒绝，且报错含具体字段名
 * 3. 非法 type 拒绝
 * 4. 多通道并存互不影响（两条 HL7 通道各收各的帧）
 * 5. 单条非法配置不阻塞其余通道
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import net from 'node:net';

import {
  loadChannelYaml,
  loadAllChannels,
  loadAllChannelsWithReport,
  type ChannelLoadError,
} from '../../src/channels/channel-loader.js';
import { ChannelRegistry } from '../../src/channels/registry.js';
import { DLQ } from '../../src/channels/DLQ.js';
import { createTestSqlite } from '../../src/shared/sqlite.js';
import { ChannelConfigError } from '../../src/shared/errors.js';

const HL7_YAML = `
name: chemo-hl7
description: 生化仪 HL7 v2 通道
type: hl7
deviceListenPort: 0
encoding: utf-8
`;

const BYTESTREAM_YAML = `
name: astm-stream
type: bytestream
encoding: utf-8
host: 127.0.0.1
listenPort: 0
startCharHex: '0x05'
endCharHex: '0x04'
bodyEncoding: utf-8
`;

const PRIVATE_YAML = `
name: private-biochem
type: private
encoding: utf-8
deviceId: DEV-001
startTriggerHex: '0x02'
endTriggerHex: '0x03'
fields:
  - name: patientId
    offset: 0
    length: 8
    encoding: utf-8
`;

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'lab-channels-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('channel-loader · yaml schema 校验', () => {
  it('合法 yaml → loadChannelYaml 返回结构化配置（三类协议各一）', () => {
    const hl7 = loadChannelYaml({ rawYaml: HL7_YAML, fileName: 'chemo-hl7.yaml' });
    expect(hl7.type).toBe('hl7');
    expect(hl7.name).toBe('chemo-hl7');
    expect(hl7.deviceListenPort).toBe(0);

    const bs = loadChannelYaml({ rawYaml: BYTESTREAM_YAML, fileName: 'astm-stream.yaml' });
    expect(bs.type).toBe('bytestream');
    expect(bs.startCharHex).toBe('0x05');

    const pv = loadChannelYaml({ rawYaml: PRIVATE_YAML, fileName: 'private.yaml' });
    expect(pv.type).toBe('private');
    expect(pv.deviceId).toBe('DEV-001');
    expect(pv.fields).toHaveLength(1);
  });

  it('缺必填项 → 拒绝，且错误信息含具体字段名', () => {
    // hl7 通道缺 deviceListenPort
    const bad = `
name: broken-hl7
type: hl7
`;
    expect(() => loadChannelYaml({ rawYaml: bad, fileName: 'broken-hl7.yaml' })).toThrow(
      ChannelConfigError,
    );
    let caught: ChannelConfigError | null = null;
    try {
      loadChannelYaml({ rawYaml: bad, fileName: 'broken-hl7.yaml' });
    } catch (err) {
      caught = err as ChannelConfigError;
    }
    expect(caught).toBeInstanceOf(ChannelConfigError);
    // 报错点名缺失字段
    const issues = caught!.context.issues as Array<{ path: string; message: string }>;
    expect(issues.some((i) => i.path === 'deviceListenPort')).toBe(true);
    expect(caught!.message).toContain('deviceListenPort');
  });

  it('非法 type → 拒绝（不是悄悄降级成别的协议）', () => {
    const bad = `
name: mystery
type: http-push
deviceListenPort: 2575
`;
    expect(() => loadChannelYaml({ rawYaml: bad, fileName: 'mystery.yaml' })).toThrow(
      ChannelConfigError,
    );
    let caught: ChannelConfigError | null = null;
    try {
      loadChannelYaml({ rawYaml: bad, fileName: 'mystery.yaml' });
    } catch (err) {
      caught = err as ChannelConfigError;
    }
    const issues = caught!.context.issues as Array<{ path: string }>;
    expect(issues.some((i) => i.path === 'type')).toBe(true);
  });

  it('yaml 语法错误 → 拒绝且不抛裸 SyntaxError', () => {
    const broken = 'name: [unclosed\n  type: hl7';
    expect(() => loadChannelYaml({ rawYaml: broken, fileName: 'broken.yaml' })).toThrow(
      ChannelConfigError,
    );
  });
});

describe('channel-loader · 单条非法不阻塞其余通道', () => {
  it('目录里 1 条坏 yaml + 2 条好 yaml → 返回 2 条通道，错误逐条列出字段名', async () => {
    writeFileSync(join(dir, 'a-good.yaml'), HL7_YAML);
    writeFileSync(join(dir, 'b-bad.yaml'), 'name: broken\ntype: hl7\n'); // 缺 deviceListenPort
    writeFileSync(join(dir, 'c-good.yaml'), PRIVATE_YAML);

    const reported: ChannelLoadError[] = [];
    const result = await loadAllChannelsWithReport(dir, {
      onError: (e) => reported.push(e),
    });

    // 好通道照常装配
    expect(result.channels).toHaveLength(2);
    expect(result.channels.map((c) => c.yaml.name).sort()).toEqual([
      'chemo-hl7',
      'private-biochem',
    ]);

    // 坏配置逐条报错，且点名字段
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].file).toBe('b-bad.yaml');
    expect(result.errors[0].fields).toContain('deviceListenPort');
    expect(result.errors[0].code).toBe('CHANNEL_CONFIG_ERROR');
    // onError 回调也被调用（现场要能第一时间知道哪台配错了）
    expect(reported).toHaveLength(1);
    expect(reported[0].file).toBe('b-bad.yaml');
  });

  it('严格模式（strict:true）→ 任一失败即抛汇总错误，其余通道仍已装配', async () => {
    writeFileSync(join(dir, 'a-good.yaml'), HL7_YAML);
    writeFileSync(join(dir, 'b-bad.yaml'), 'name: broken\ntype: hl7\n');

    await expect(loadAllChannelsWithReport(dir, { strict: true })).rejects.toThrow(
      ChannelConfigError,
    );
  });

  it('loadAllChannels 便捷入口返回已装配通道（不抛）', async () => {
    writeFileSync(join(dir, 'a-good.yaml'), HL7_YAML);
    writeFileSync(join(dir, 'b-bad.yaml'), 'name: broken\ntype: hl7\n');
    const channels = await loadAllChannels(dir);
    expect(channels).toHaveLength(1);
    expect(channels[0].yaml.name).toBe('chemo-hl7');
  });
});

describe('多通道并存 · 互不影响', () => {
  it('两条 HL7 通道各起各的端口，各收各的帧', async () => {
    writeFileSync(join(dir, 'ch1.yaml'), HL7_YAML);
    writeFileSync(join(dir, 'ch2.yaml'), HL7_YAML.replace('chemo-hl7', 'hema-hl7'));

    const registry = new ChannelRegistry();
    const loadErrors = await registry.load(dir);
    expect(loadErrors).toHaveLength(0);
    expect(registry.channelIds().sort()).toEqual(['chemo-hl7', 'hema-hl7']);

    const statuses = await registry.startAll();
    expect(statuses).toHaveLength(2);
    for (const s of statuses) {
      expect(s.status).toBe('connected');
      expect(s.port).toBeGreaterThan(0);
    }
    // 两条通道端口不同
    const ports = statuses.map((s) => s.port);
    expect(new Set(ports).size).toBe(2);

    // 往通道 1 推一帧，只有通道 1 收到
    const received: Array<{ channelId: string; controlId: string }> = [];
    registry.on('channel:message', (e: { channelId: string; message: { controlId: string } }) => {
      received.push({ channelId: e.channelId, controlId: e.message.controlId });
    });

    const port1 = statuses.find((s) => s.id === 'chemo-hl7')!.port!;
    const frame = Buffer.concat([
      Buffer.from([0x0b]),
      Buffer.from('MSH|^~\\&|LAB|A|B|LAB|20260101120000||ORU^R01|MSG-CH1|P|2.5\rOBR|1||X\r', 'utf-8'),
      Buffer.from([0x1c, 0x0d]),
    ]);
    await sendFrame(port1, frame);
    await wait(120);

    expect(received).toHaveLength(1);
    expect(received[0].channelId).toBe('chemo-hl7');
    expect(received[0].controlId).toBe('MSG-CH1');

    // 状态上报：通道 1 有心跳，通道 2 没有
    const finalStatus = registry.status();
    const ch1 = finalStatus.find((s) => s.id === 'chemo-hl7')!;
    const ch2 = finalStatus.find((s) => s.id === 'hema-hl7')!;
    expect(ch1.framesReceived).toBeGreaterThan(0);
    expect(ch1.lastHeartbeatAt).not.toBeNull();
    expect(ch2.framesReceived).toBe(0);
    expect(ch2.lastHeartbeatAt).toBeNull();

    await registry.stopAll();
    const stopped = registry.status();
    for (const s of stopped) {
      expect(s.status).toBe('stopped');
    }
  });

  it('通道解析失败 → 共享 DLQ 落盘原始字节，通道转 degraded', async () => {
    const t = createTestSqlite();
    const dlq = new DLQ(t.db);

    writeFileSync(join(dir, 'ch1.yaml'), HL7_YAML);
    const registry = new ChannelRegistry({ dlq });
    await registry.load(dir);
    const statuses = await registry.startAll();
    const port = statuses[0].port!;

    // 推一个含非法控制字符的坏帧 → 应落 DLQ
    const bad = Buffer.concat([
      Buffer.from([0x0b]),
      Buffer.from(
        'MSH|^~\\&|LAB|A|B|LAB|20260101120000||ORU^R01|MSG-BAD|P|2.5\rOBX|1|NM|K\x07|1|6.8|mmol/L\r',
        'utf-8',
      ),
      Buffer.from([0x1c, 0x0d]),
    ]);
    await sendFrame(port, bad);
    await wait(150);

    const rows = dlq.list({ channelName: 'chemo-hl7' });
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows[0].error_code).toBe('HL7_FRAME_INVALID');
    expect(rows[0].raw_bytes.length).toBeGreaterThan(0);
    expect(rows[0].replay_status).toBe('pending');

    // 通道状态：连着但有错 → degraded（不是静默正常）
    const st = registry.status()[0];
    expect(st.status).toBe('degraded');
    expect(st.lastErrorCode).toBe('HL7_FRAME_INVALID');

    await registry.stopAll();
    t.db.close();
  });
});

/** 发一帧并等待对端关闭（服务端 ACK 后我们直接断） */
async function sendFrame(port: number, payload: Buffer): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const sock = net.createConnection({ port, host: '127.0.0.1' }, () => {
      sock.write(payload);
    });
    sock.on('data', () => {
      sock.destroy();
      resolve();
    });
    sock.on('error', reject);
    setTimeout(() => {
      sock.destroy();
      resolve();
    }, 800);
  });
}

function wait(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
