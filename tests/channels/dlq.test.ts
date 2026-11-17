/**
 * tests/channels/dlq.test.ts —— 死信队列（入队 / 过滤 / 顺序回放 / 保留期清理）
 *
 * 覆盖（任务书 T4）：
 * 1. 入队保留原始字节（字节精确 + Base64 镜像，可导出核对）
 * 2. 按错误码过滤（也能按通道过滤）
 * 3. 顺序回放且不重复（同一条不会被回放两次）
 * 4. 30 天清理（保留期到期清掉，未到期的留下）
 * 5. 重放后标记已回放（replay_status + 回放游标）
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import net from 'node:net';
import { DLQ, type DlqEntry } from '../../src/channels/DLQ.js';
import { Hl7Server } from '../../src/channels/Hl7Server.js';
import { createTestSqlite } from '../../src/shared/sqlite.js';
import type { Database as DB } from 'better-sqlite3';

let db: DB;
let dlq: DLQ;

beforeEach(() => {
  const t = createTestSqlite();
  db = t.db;
  dlq = new DLQ(db);
});

afterEach(() => {
  db.close();
});

/** 造一条脱敏的坏帧字节（非真实标识） */
function badFrame(tag: string): Buffer {
  return Buffer.from(`MSH|^~\\&|LAB|A|B|LAB|C|20260101120000||ORU^R01|${tag}|P|2.5\r`, 'utf-8');
}

describe('DLQ · 入队保留原始字节', () => {
  it('入队后原始字节逐字节可还原（不丢不篡改），并带 Base64 镜像', () => {
    const raw = badFrame('MSG-BAD-1');
    const entry = dlq.enqueue({
      channelName: 'chemo-hl7',
      errorCode: 'HL7_FRAME_INVALID',
      errorMessage: '帧含非法控制字符',
      rawBytes: raw,
    });

    expect(entry.id).toBeGreaterThan(0);
    expect(entry.channel_name).toBe('chemo-hl7');
    expect(entry.error_code).toBe('HL7_FRAME_INVALID');
    expect(Buffer.from(entry.raw_bytes).equals(raw)).toBe(true);
    expect(entry.raw_bytes_base64).toBe(raw.toString('base64'));

    // 从库里读回来仍然是同一串字节
    const [stored] = dlq.list({ channelName: 'chemo-hl7' });
    expect(Buffer.from(stored.raw_bytes).equals(raw)).toBe(true);
    expect(Buffer.from(stored.raw_bytes_base64, 'base64').equals(raw)).toBe(true);
  });

  it('入队后默认是待回放状态（pending），不是"已处理"', () => {
    const entry = dlq.enqueue({
      channelName: 'chemo-hl7',
      errorCode: 'HL7_PARSE_FAIL',
      rawBytes: badFrame('MSG-BAD-2'),
    });
    expect(entry.replay_status).toBe('pending');
    expect(entry.replay_count).toBe(0);
    expect(dlq.stats().pending).toBe(1);
  });
});

describe('DLQ · 按错误码 / 通道过滤', () => {
  it('按错误码过滤只返回该码的条目', () => {
    dlq.enqueue({ channelName: 'ch-a', errorCode: 'HL7_FRAME_INVALID', rawBytes: badFrame('A') });
    dlq.enqueue({ channelName: 'ch-a', errorCode: 'HL7_FRAME_INVALID', rawBytes: badFrame('B') });
    dlq.enqueue({ channelName: 'ch-a', errorCode: 'ASTM_PARSE_FAIL', rawBytes: badFrame('C') });
    dlq.enqueue({ channelName: 'ch-b', errorCode: 'HL7_FRAME_INVALID', rawBytes: badFrame('D') });

    const invalid = dlq.list({ errorCode: 'HL7_FRAME_INVALID' });
    expect(invalid).toHaveLength(3);
    expect(invalid.every((e) => e.error_code === 'HL7_FRAME_INVALID')).toBe(true);

    const astm = dlq.list({ errorCode: 'ASTM_PARSE_FAIL' });
    expect(astm).toHaveLength(1);

    // 通道 + 错误码组合过滤
    const combo = dlq.list({ channelName: 'ch-a', errorCode: 'HL7_FRAME_INVALID' });
    expect(combo).toHaveLength(2);
    expect(combo.every((e) => e.channel_name === 'ch-a')).toBe(true);
  });

  it('按通道统计条数', () => {
    dlq.enqueue({ channelName: 'ch-a', errorCode: 'X', rawBytes: badFrame('A') });
    dlq.enqueue({ channelName: 'ch-a', errorCode: 'X', rawBytes: badFrame('B') });
    dlq.enqueue({ channelName: 'ch-b', errorCode: 'X', rawBytes: badFrame('C') });
    const counts = dlq.countByChannel();
    const a = counts.find((c) => c.channel_name === 'ch-a');
    const b = counts.find((c) => c.channel_name === 'ch-b');
    expect(a?.count).toBe(2);
    expect(b?.count).toBe(1);
  });
});

describe('DLQ · 顺序回放且不重复', () => {
  it('按 id 升序回放，顺序与入队一致', async () => {
    const tags = ['MSG-1', 'MSG-2', 'MSG-3'];
    for (const tag of tags) {
      dlq.enqueue({ channelName: 'ch-a', errorCode: 'HL7_PARSE_FAIL', rawBytes: badFrame(tag) });
    }

    const seen: string[] = [];
    const result = await dlq.replay(10, (entry: DlqEntry) => {
      seen.push(entry.id.toString());
    });

    expect(result.replayed).toHaveLength(3);
    expect(result.failed).toHaveLength(0);
    // 严格按 id 升序
    expect(seen).toEqual([...seen].sort((a, b) => Number(a) - Number(b)));
    expect(result.replayed.map((e) => e.id)).toEqual([1, 2, 3]);
  });

  it('同一条不会被回放两次（第二次 replay 不再交付给 handler）', async () => {
    dlq.enqueue({ channelName: 'ch-a', errorCode: 'HL7_PARSE_FAIL', rawBytes: badFrame('MSG-1') });
    dlq.enqueue({ channelName: 'ch-a', errorCode: 'HL7_PARSE_FAIL', rawBytes: badFrame('MSG-2') });

    let calls = 0;
    await dlq.replay(10, () => {
      calls += 1;
    });
    expect(calls).toBe(2);

    // 再回放一次：已回放的条目不再交付
    const second = await dlq.replay(10, () => {
      calls += 1;
    });
    expect(calls).toBe(2);
    expect(second.replayed).toHaveLength(0);
    expect(second.scanned).toBe(0);
  });

  it('replay(limit) 限流：只取 limit 条，剩余留待下次', async () => {
    for (let i = 0; i < 5; i++) {
      dlq.enqueue({ channelName: 'ch-a', errorCode: 'HL7_PARSE_FAIL', rawBytes: badFrame(`M${i}`) });
    }
    const first = await dlq.replay(2, () => undefined);
    expect(first.replayed).toHaveLength(2);
    expect(dlq.stats().pending).toBe(3);

    const second = await dlq.replay(2, () => undefined);
    expect(second.replayed).toHaveLength(2);
    expect(dlq.stats().pending).toBe(1);
  });

  it('回放失败不丢条目：状态保持 pending + 记 last_error，下次还能回放', async () => {
    dlq.enqueue({ channelName: 'ch-a', errorCode: 'HL7_PARSE_FAIL', rawBytes: badFrame('MSG-1') });

    const failed = await dlq.replay(10, () => {
      throw new Error('下游仍不可用');
    });
    expect(failed.failed).toHaveLength(1);
    expect(failed.failed[0].error).toContain('下游仍不可用');
    expect(failed.replayed).toHaveLength(0);

    const [row] = dlq.list({ channelName: 'ch-a' });
    expect(row.replay_status).toBe('pending');
    expect(row.replay_count).toBe(1);
    expect(row.last_error).toContain('下游仍不可用');

    // 下游恢复后能补回放
    const ok = await dlq.replay(10, () => undefined);
    expect(ok.replayed).toHaveLength(1);
    expect(dlq.stats().replayed).toBe(1);
  });
});

describe('DLQ · 重放后标记已回放', () => {
  it('成功回放 → replay_status=replayed + last_replayed_at + 回放游标推进', async () => {
    dlq.enqueue({ channelName: 'ch-a', errorCode: 'HL7_PARSE_FAIL', rawBytes: badFrame('MSG-1') });
    dlq.enqueue({ channelName: 'ch-a', errorCode: 'HL7_PARSE_FAIL', rawBytes: badFrame('MSG-2') });

    await dlq.replay(10, () => undefined);

    const rows = dlq.list({ channelName: 'ch-a', order: 'asc' });
    for (const row of rows) {
      expect(row.replay_status).toBe('replayed');
      expect(row.last_replayed_at).not.toBeNull();
      expect(row.replay_count).toBe(1);
      expect(row.last_error).toBeNull();
    }

    // 回放游标记到该通道最后回放到的 id
    const cursor = dlq.getReplayCursor('ch-a');
    expect(cursor).not.toBeNull();
    expect(cursor!.last_replayed_id).toBe(2);
  });
});

describe('DLQ · 保留期清理', () => {
  it('purgeOlderThan(30) 清掉 30 天前的，30 天内的留下', () => {
    // 造一条 40 天前的老死信
    dlq.enqueue({ channelName: 'ch-a', errorCode: 'HL7_PARSE_FAIL', rawBytes: badFrame('OLD') });
    db.prepare(
      `UPDATE dlq_messages SET received_at = datetime('now', '-40 days') WHERE id = 1`,
    ).run();
    // 一条 10 天内的
    dlq.enqueue({ channelName: 'ch-a', errorCode: 'HL7_PARSE_FAIL', rawBytes: badFrame('NEW') });
    db.prepare(
      `UPDATE dlq_messages SET received_at = datetime('now', '-10 days') WHERE id = 2`,
    ).run();

    const result = dlq.purgeOlderThan(30);
    expect(result.deleted).toBe(1);

    const remaining = dlq.list({ channelName: 'ch-a' });
    expect(remaining).toHaveLength(1);
    expect(remaining[0].id).toBe(2);
  });

  it('默认保留期 30 天 —— 29 天内的不删', () => {
    dlq.enqueue({ channelName: 'ch-a', errorCode: 'HL7_PARSE_FAIL', rawBytes: badFrame('A') });
    db.prepare(
      `UPDATE dlq_messages SET received_at = datetime('now', '-29 days') WHERE id = 1`,
    ).run();
    const result = dlq.purgeOlderThan();
    expect(result.deleted).toBe(0);
    expect(dlq.list({ channelName: 'ch-a' })).toHaveLength(1);
  });
});

/**
 * DLQ · HL7 解析失败接线（任务书 T4「接线：Hl7Connection 解析失败 → enqueue 而非丢帧」）
 *
 * 现场含义：采集进程必须活着把坏帧记进 DLQ —— 一台仪器送了个坏帧就把整个
 * 采集带下去，等于所有仪器的样本一起丢，比丢一帧坏数据严重得多。
 */
describe('DLQ · HL7 解析失败接线', () => {
  /** 组一个含非法控制字符 0x07 的坏帧（MLLP：VT + body + FS + CR） */
  function badFrameWithControlChar(): Buffer {
    const body = Buffer.from(
      'MSH|^~\\&|LAB|A|B|LAB|20260101120000||ORU^R01|MSG-BAD|P|2.5\r' +
        'OBX|1|NM|K\x07|1|6.8|mmol/L\r',
      'utf-8',
    );
    const out = Buffer.alloc(body.length + 3);
    out.writeInt8(0x0b, 0);
    body.copy(out, 1);
    out.writeInt8(0x1c, body.length + 1);
    out.writeInt8(0x0d, body.length + 2);
    return out;
  }

  /** 往通道推一帧坏帧并等它被处理 */
  async function pushBadFrame(port: number): Promise<void> {
    const sock = net.createConnection({ port, host: '127.0.0.1' });
    await new Promise<void>((resolveP, rejectP) => {
      sock.once('connect', () => {
        sock.write(badFrameWithControlChar());
        resolveP();
      });
      sock.once('error', rejectP);
    });
    await new Promise((r) => setTimeout(r, 300));
    sock.destroy();
  }

  it('坏帧进 DLQ 而不是丢帧，且原始字节可还原', async () => {
    const server = new Hl7Server('standalone-hl7', { dlq });
    const port = await server.start(0);
    // 刻意不挂任何 'error' 监听器 —— 采集进程不能因为一台仪器的坏帧就崩
    await pushBadFrame(port);

    const rows = dlq.list({ channelName: 'standalone-hl7' });
    expect(rows).toHaveLength(1);
    expect(rows[0].error_code).toBe('HL7_FRAME_INVALID');
    expect(rows[0].replay_status).toBe('pending');
    // 原始字节逐字节留底（可回放、可导出核对）
    const raw = Buffer.from(rows[0].raw_bytes);
    expect(raw.length).toBeGreaterThan(0);
    expect(raw.includes(0x07)).toBe(true);

    await server.stop({ forceDrainTimeoutMs: 100 });
  });

  it('同一坏帧只落一条死信（上层监听器抛错也不重复入队、不带崩进程）', async () => {
    const server = new Hl7Server('throwing-listener-hl7', { dlq });
    // 上层监听器自己抛错 —— 不能把同一帧重复报给 DLQ，也不能带崩采集进程
    server.on('error', () => {
      throw new Error('上层处理失败');
    });
    const port = await server.start(0);
    await pushBadFrame(port);

    const rows = dlq.list({ channelName: 'throwing-listener-hl7' });
    expect(rows).toHaveLength(1);
    expect(rows[0].error_code).toBe('HL7_FRAME_INVALID');

    await server.stop({ forceDrainTimeoutMs: 100 });
  });
});
