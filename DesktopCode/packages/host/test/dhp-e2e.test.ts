/**
 * 端到端：真实 WebSocket + 真实 Host + 真实内核（MockProvider）。
 *
 * 这个测试覆盖的是"最容易在集成时炸"的那条链路：
 *   握手 → 建会话 → 订阅 → 发一轮 → 收流式事件 → 审批 → 结算
 *
 * 用 MockProvider 保证确定性：不联网、不打真实模型。
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { createHost, type RunningHost } from '../src/host.ts';
import { Method, Notification, DHP_VERSION, DHP_CAPABILITIES, type SessionSnapshot } from '@syaocode/dhp';

let host: RunningHost | undefined;
let tmpHome: string;
let tmpWs: string;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'syao-e2e-home-'));
  tmpWs = fs.mkdtempSync(path.join(os.tmpdir(), 'syao-e2e-ws-'));
  fs.writeFileSync(path.join(tmpWs, 'README.md'), '# demo\nhello\n');
});

afterEach(async () => {
  await host?.close();
  host = undefined;
  fs.rmSync(tmpHome, { recursive: true, force: true });
  fs.rmSync(tmpWs, { recursive: true, force: true });
});

interface Client {
  readonly ws: WebSocket;
  request(method: string, params?: unknown): Promise<unknown>;
  notifications: { method: string; params: unknown }[];
  close(): void;
}

async function connect(url: string, token: string): Promise<Client> {
  const ws = new WebSocket(url, { headers: { authorization: `Bearer ${token}` } });
  const notifications: { method: string; params: unknown }[] = [];
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  let idSeq = 0;

  ws.on('message', (raw) => {
    const frame = JSON.parse(raw.toString()) as Record<string, unknown>;
    if (typeof frame['method'] === 'string') {
      notifications.push({ method: frame['method'], params: frame['params'] });
      return;
    }
    const id = frame['id'];
    if (typeof id !== 'number') return;
    const slot = pending.get(id);
    if (slot === undefined) return;
    pending.delete(id);
    if ('error' in frame) {
      const e = frame['error'] as { code: number; message: string; data?: { kind?: string } };
      const err = new Error(e.message) as Error & { code: number; kind?: string };
      err.code = e.code;
      if (e.data?.kind !== undefined) err.kind = e.data.kind;
      slot.reject(err);
    } else {
      slot.resolve(frame['result']);
    }
  });

  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', reject);
  });

  return {
    ws,
    notifications,
    request(method, params) {
      idSeq += 1;
      const id = idSeq;
      return new Promise<unknown>((resolve, reject) => {
        pending.set(id, { resolve, reject });
        ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
        setTimeout(() => {
          if (pending.has(id)) {
            pending.delete(id);
            reject(new Error(`timeout waiting for ${method}`));
          }
        }, 5000);
      });
    },
    close() {
      ws.close();
    },
  };
}

function waitFor<T>(client: Client, method: string, predicate: (p: T) => boolean, timeoutMs = 5000): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const found = client.notifications.find(
      (n) => n.method === method && predicate(n.params as T),
    );
    if (found !== undefined) {
      resolve(found.params as T);
      return;
    }
    const started = Date.now();
    const tick = setInterval(() => {
      const hit = client.notifications.find((n) => n.method === method && predicate(n.params as T));
      if (hit !== undefined) {
        clearInterval(tick);
        resolve(hit.params as T);
      } else if (Date.now() - started > timeoutMs) {
        clearInterval(tick);
        reject(new Error(`timeout waiting for ${method}`));
      }
    }, 10);
  });
}

describe('DHP 端到端', () => {
  it('握手 → 建会话 → 订阅 → 发一轮 → 收到流式事件', async () => {
    host = await createHost({
      workspaceRoot: tmpWs,
      env: { SYAOCODE_HOME: tmpHome },
      exitOnShutdown: false,
    });
    const client = await connect(host.server.url, host.server.token);

    const ack = (await client.request(Method.Hello, {
      clientName: 'e2e',
      clientVersion: '0.0.0',
      dhpVersion: DHP_VERSION,
      capabilities: DHP_CAPABILITIES,
    })) as { capabilities: string[]; workspaceRoot: string };

    expect(ack.capabilities).toContain('session');
    expect(ack.workspaceRoot).toBe(path.resolve(tmpWs));

    const created = (await client.request(Method.SessionCreate, { title: 'e2e' })) as {
      snapshot: SessionSnapshot;
    };
    const sessionId = created.snapshot.meta.sessionId;

    const sub = (await client.request(Method.SessionSubscribe, { sessionId })) as {
      subscribed: boolean;
      snapshotIncluded: boolean;
    };
    expect(sub.subscribed).toBe(true);
    expect(sub.snapshotIncluded).toBe(true);

    // 发一轮（mock 剧本第一轮是纯文本）。
    const sendAck = (await client.request(Method.TurnSend, {
      commandId: 'cmd_test_1',
      baseRevision: created.snapshot.revision,
      sessionId,
      text: '你好',
    })) as { status: string };

    // ACK ≠ 终态：这里只断言"被接受"，终态由事件流确认。
    expect(sendAck.status).toBe('accepted');

    const delta = await waitFor<{ delta: { events: { type: string }[] } }>(
      client,
      Notification.SessionEvent,
      (p) => p.delta.events.some((e) => e.type === 'text.delta'),
    );
    expect(delta.delta.events.some((e) => e.type === 'text.delta')).toBe(true);

    client.close();
  }, 20000);

  it('错误令牌 → 握手被拒（不回业务错误）', async () => {
    host = await createHost({
      workspaceRoot: tmpWs,
      env: { SYAOCODE_HOME: tmpHome },
      exitOnShutdown: false,
    });
    await expect(connect(host.server.url, 'wrong-token')).rejects.toBeTruthy();
  }, 15000);

  it('未握手直接调业务方法 → not_ready', async () => {
    host = await createHost({
      workspaceRoot: tmpWs,
      env: { SYAOCODE_HOME: tmpHome },
      exitOnShutdown: false,
    });
    const client = await connect(host.server.url, host.server.token);
    await expect(client.request(Method.SessionList, {})).rejects.toMatchObject({ kind: 'not_ready' });
    client.close();
  }, 15000);

  it('同 commandId 重复提交 → duplicate，只执行一次', async () => {
    host = await createHost({
      workspaceRoot: tmpWs,
      env: { SYAOCODE_HOME: tmpHome },
      exitOnShutdown: false,
    });
    const client = await connect(host.server.url, host.server.token);
    await client.request(Method.Hello, {
      clientName: 'e2e',
      clientVersion: '0.0.0',
      dhpVersion: DHP_VERSION,
      capabilities: DHP_CAPABILITIES,
    });
    const created = (await client.request(Method.SessionCreate, { title: 'dup' })) as {
      snapshot: SessionSnapshot;
    };
    const sessionId = created.snapshot.meta.sessionId;
    await client.request(Method.SessionSubscribe, { sessionId });

    const cmd = {
      commandId: 'cmd_dup_1',
      baseRevision: created.snapshot.revision,
      sessionId,
      text: 'hello',
    };
    const first = (await client.request(Method.TurnSend, cmd)) as { status: string };
    expect(first.status).toBe('accepted');

    // 等这一轮结束再发重复命令（避免 conflict_in_flight 干扰）。
    await waitFor(client, Notification.SessionEvent, (p) => {
      const d = p as { delta: { events: { type: string }[] } };
      return d.delta.events.some((e) => e.type === 'turn.end');
    });

    const second = (await client.request(Method.TurnSend, cmd)) as { status: string };
    expect(second.status).toBe('duplicate');

    client.close();
  }, 25000);

  it('baseRevision 过期 → stale，且无副作用', async () => {
    host = await createHost({
      workspaceRoot: tmpWs,
      env: { SYAOCODE_HOME: tmpHome },
      exitOnShutdown: false,
    });
    const client = await connect(host.server.url, host.server.token);
    await client.request(Method.Hello, {
      clientName: 'e2e',
      clientVersion: '0.0.0',
      dhpVersion: DHP_VERSION,
      capabilities: DHP_CAPABILITIES,
    });
    const created = (await client.request(Method.SessionCreate, { title: 'stale' })) as {
      snapshot: SessionSnapshot;
    };
    const sessionId = created.snapshot.meta.sessionId;

    const before = (await client.request(Method.SessionSnapshot, { sessionId })) as SessionSnapshot;

    const res = (await client.request(Method.TurnSend, {
      commandId: 'cmd_stale_1',
      baseRevision: 999, // 过期
      sessionId,
      text: 'x',
    })) as { status: string; revision: number };

    expect(res.status).toBe('stale');
    expect(res.revision).toBe(before.revision);

    // 无副作用：投影没变。
    const after = (await client.request(Method.SessionSnapshot, { sessionId })) as SessionSnapshot;
    expect(after.seq).toBe(before.seq);

    client.close();
  }, 20000);

  it('read 工具触发审批 → 允许后继续执行', async () => {
    // 用 strict 模式让读操作也需要审批（默认档位读是免确认的）。
    fs.mkdirSync(path.join(tmpHome), { recursive: true });
    fs.writeFileSync(
      path.join(tmpHome, 'config.json'),
      JSON.stringify({ model: 'mock:default', permissionMode: 'strict' }),
    );

    host = await createHost({
      workspaceRoot: tmpWs,
      env: { SYAOCODE_HOME: tmpHome },
      exitOnShutdown: false,
    });
    const client = await connect(host.server.url, host.server.token);
    await client.request(Method.Hello, {
      clientName: 'e2e',
      clientVersion: '0.0.0',
      dhpVersion: DHP_VERSION,
      capabilities: DHP_CAPABILITIES,
    });

    const created = (await client.request(Method.SessionCreate, { title: 'approval' })) as {
      snapshot: SessionSnapshot;
    };
    const sessionId = created.snapshot.meta.sessionId;
    await client.request(Method.SessionSubscribe, { sessionId });

    // 第一轮：mock 剧本 step0 是纯文本 → 无工具调用，run 自然结束。
    await client.request(Method.TurnSend, {
      commandId: 'cmd_appr_0',
      baseRevision: created.snapshot.revision,
      sessionId,
      text: '先说一句',
    });
    await waitFor(client, Notification.SessionEvent, (p) => {
      const d = p as { delta: { events: { type: string }[] } };
      return d.delta.events.some((e) => e.type === 'turn.end');
    });

    // 第二轮：mock 剧本 step1 调用 read → strict 模式下必须产生审批。
    const beforeTurn2 = (await client.request(Method.SessionSnapshot, { sessionId })) as SessionSnapshot;
    await client.request(Method.TurnSend, {
      commandId: 'cmd_appr_1',
      baseRevision: beforeTurn2.revision,
      sessionId,
      text: '读一下 README',
    });

    const interaction = await waitFor<{ interaction: { id: string; options: { id: string }[] } }>(
      client,
      Notification.InteractionRequest,
      () => true,
    );
    expect(interaction.interaction.options.length).toBeGreaterThan(0);

    const snap = (await client.request(Method.SessionSnapshot, { sessionId })) as SessionSnapshot;
    const resolved = (await client.request(Method.InteractionResolve, {
      commandId: 'cmd_resolve_1',
      baseRevision: snap.revision,
      sessionId,
      interactionId: interaction.interaction.id,
      optionId: 'once',
    })) as { status: string };
    expect(resolved.status).toBe('accepted');

    client.close();
  }, 30000);

  it('订阅时可补洞（baseSeq 落后但仍在环内）', async () => {
    host = await createHost({
      workspaceRoot: tmpWs,
      env: { SYAOCODE_HOME: tmpHome },
      exitOnShutdown: false,
    });
    const client = await connect(host.server.url, host.server.token);
    await client.request(Method.Hello, {
      clientName: 'e2e',
      clientVersion: '0.0.0',
      dhpVersion: DHP_VERSION,
      capabilities: DHP_CAPABILITIES,
    });
    const created = (await client.request(Method.SessionCreate, { title: 'gap' })) as {
      snapshot: SessionSnapshot;
    };
    const sessionId = created.snapshot.meta.sessionId;

    // 先跑一轮产生事件。
    await client.request(Method.SessionSubscribe, { sessionId });
    await client.request(Method.TurnSend, {
      commandId: 'cmd_gap_1',
      baseRevision: created.snapshot.revision,
      sessionId,
      text: 'hi',
    });
    await waitFor(client, Notification.SessionEvent, (p) => {
      const d = p as { delta: { events: { type: string }[] } };
      return d.delta.events.some((e) => e.type === 'turn.end');
    });

    const snap = (await client.request(Method.SessionSnapshot, { sessionId })) as SessionSnapshot;
    expect(snap.seq).toBeGreaterThan(0);

    // 新客户端从 baseSeq=1 订阅：应能补洞（不需要回快照）。
    const client2 = await connect(host.server.url, host.server.token);
    await client2.request(Method.Hello, {
      clientName: 'e2e-2',
      clientVersion: '0.0.0',
      dhpVersion: DHP_VERSION,
      capabilities: DHP_CAPABILITIES,
    });
    const sub2 = (await client2.request(Method.SessionSubscribe, {
      sessionId,
      baseSeq: 1,
      epoch: snap.epoch,
    })) as { snapshotIncluded: boolean };
    // baseSeq=1 意味着"我已有第 1 条"，需要 2..seq 的补洞。
    expect(sub2.snapshotIncluded).toBe(false);

    client.close();
    client2.close();
  }, 30000);

  it('app/info 与 doctor/run 可用', async () => {
    host = await createHost({
      workspaceRoot: tmpWs,
      env: { SYAOCODE_HOME: tmpHome },
      exitOnShutdown: false,
    });
    const client = await connect(host.server.url, host.server.token);
    await client.request(Method.Hello, {
      clientName: 'e2e',
      clientVersion: '0.0.0',
      dhpVersion: DHP_VERSION,
      capabilities: DHP_CAPABILITIES,
    });

    const info = (await client.request(Method.AppInfo)) as { dhpVersion: { major: number } };
    expect(info.dhpVersion.major).toBe(1);

    const doc = (await client.request(Method.DoctorRun)) as { checks: { name: string }[] };
    expect(doc.checks.some((c) => c.name === 'syaoHome')).toBe(true);

    client.close();
  }, 15000);
});
