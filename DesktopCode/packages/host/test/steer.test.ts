/**
 * 多轮 steer 的 Host 端到端验收（`28-多轮steer行为契约` §7 第 4/5/6/7/8/10/11/12 行）。
 *
 * 这里走的是真实链路：真实 WebSocket + 真实 Host + 真实内核 + 本地可控 provider。
 * provider 的**第一段流由测试闸门控制**，因此可以在"模型正在输出"这个精确时刻提交
 * steer，而不是靠 sleep 撞运气。
 *
 * 断言重点（契约语义，不得放宽）：
 *  - ACK 的 `queued: true` 只表示"已接受排队"；终态只能从事件流读。
 *  - 过期 expectedExecutionId → noop，不排入当前也不排入下一轮。
 *  - 同 commandId 同内容 → duplicate（无第二次注入）；同 id 不同内容 → conflict。
 *  - queued 后 stop → not_consumed（aborted），且之后不自动重放。
 *  - Host 重启 → 不重放、不假装已消费，补 not_consumed（host_restarted）。
 *  - 归档 / 关闭会话不再接受 steer，排队项有明确终态。
 *  - steer 历史至多一次（恢复 / fork 不重复）。
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { createServer, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import {
  DHP_VERSION,
  FeatureMethod,
  Method,
  Notification,
  WorkbenchMethod as W,
  type AckResult,
  type SessionSnapshot,
  type SteerRow,
  type TurnSteerResult,
} from '@liwencode/dhp';
import { createHost, type RunningHost } from '../src/host.ts';

let home: string;
let root: string;
let host: RunningHost | undefined;
const clients: WebSocket[] = [];
const cleanups: (() => Promise<void>)[] = [];
const gates: (() => void)[] = [];

beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), 'steer-home-'));
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'steer-root-'));
  await fs.writeFile(path.join(root, 'README.md'), '# steer test\n');
});

async function closeHost(): Promise<void> {
  const running = host;
  host = undefined;
  await running?.close();
}

afterEach(async () => {
  for (const release of gates.splice(0)) release();
  for (const ws of clients.splice(0)) ws.close();
  await closeHost();
  for (const fn of cleanups.splice(0)) await fn();
  for (const dir of [home, root]) await fs.rm(dir, { recursive: true, force: true });
});

// ── 测试脚手架 ──────────────────────────────────────────────────────────

function deferred(): { promise: Promise<void>; release: () => void } {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

async function localProvider(handler: (body: any, res: ServerResponse, index: number) => void | Promise<void>) {
  let count = 0;
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (b) => {
      body += String(b);
    });
    req.on('end', () => {
      count += 1;
      void handler(JSON.parse(body), res, count);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanups.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no port');
  return `http://127.0.0.1:${address.port}/v1`;
}

function answer(res: ServerResponse, text: string): void {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: text }, finish_reason: null }] })}\n\n`);
  res.write(
    `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5 } })}\n\n`,
  );
  res.end('data: [DONE]\n\n');
}

/** 开始一段"可暂停"的流式回复：先吐一个 delta，等闸门放行后再收尾。 */
function hold(res: ServerResponse, gate: Promise<void>, text = '正在处理…'): Promise<void> {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: text }, finish_reason: null }] })}\n\n`);
  return gate
    .then(() => {
      try {
        res.write(
          `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5 } })}\n\n`,
        );
        res.end('data: [DONE]\n\n');
      } catch {
        // 客户端已 abort（stop 场景）：写失败是预期行为。
      }
    })
    .catch(() => undefined);
}

const channel = (baseUrl: string) => ({
  id: 'local',
  name: 'Local steer test',
  protocol: 'openai-compatible',
  baseUrl,
  apiKeyEnv: 'LOCAL_KEY',
  models: [{ id: 'a', name: 'A', contextWindow: 4096 }],
});

interface Client {
  request<T = any>(method: string, params?: unknown): Promise<T>;
  notifications: { method: string; params: any }[];
  ws: WebSocket;
}

async function connect(): Promise<Client> {
  if (host === undefined) throw new Error('host not started');
  const ws = new WebSocket(host.server.url, { headers: { authorization: `Bearer ${host.server.token}` } });
  clients.push(ws);
  const notifications: { method: string; params: any }[] = [];
  const pending = new Map<number, { resolve(v: any): void; reject(e: Error): void; timer: ReturnType<typeof setTimeout> }>();
  let seq = 0;
  ws.on('message', (raw) => {
    const f = JSON.parse(raw.toString());
    if (f.method) {
      notifications.push(f);
      return;
    }
    const p = pending.get(f.id);
    if (!p) return;
    clearTimeout(p.timer);
    pending.delete(f.id);
    if (f.error) p.reject(Object.assign(new Error(f.error.message), f.error.data));
    else p.resolve(f.result);
  });
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', reject);
  });
  const request = <T = any>(method: string, params?: unknown): Promise<T> =>
    new Promise((resolve, reject) => {
      const id = ++seq;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`Timeout: ${method}`));
      }, 10_000);
      pending.set(id, { resolve, reject, timer });
      ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
    });
  await request(Method.Hello, { clientName: 'steer-test', dhpVersion: DHP_VERSION });
  return { request, notifications, ws };
}

async function boot(env: Record<string, string> = {}): Promise<Client> {
  host = await createHost({ workspaceRoot: root, env: { LIWENCODE_HOME: home, ...env }, logger: () => {} });
  return connect();
}

async function session(c: Client, params: Record<string, unknown> = {}): Promise<string> {
  const created = await c.request<{ snapshot: SessionSnapshot }>(Method.SessionCreate, params);
  return created.snapshot.meta.sessionId;
}

async function snapshot(c: Client, sessionId: string): Promise<SessionSnapshot> {
  return c.request<SessionSnapshot>(Method.SessionSnapshot, { sessionId });
}

async function steer(
  c: Client,
  sessionId: string,
  expectedExecutionId: string,
  text: string,
  commandId: string = randomUUID(),
): Promise<AckResult & { data?: TurnSteerResult }> {
  const snap = await snapshot(c, sessionId);
  return c.request(Method.TurnSteer, {
    commandId,
    baseRevision: snap.revision,
    sessionId,
    expectedExecutionId,
    text,
  });
}

async function sendTurn(c: Client, sessionId: string, text: string): Promise<{ executionId: string }> {
  const snap = await snapshot(c, sessionId);
  const ack = await c.request<AckResult>(Method.TurnSend, {
    commandId: randomUUID(),
    baseRevision: snap.revision,
    sessionId,
    text,
  });
  expect(ack.status).toBe('accepted');
  return ack.data as { executionId: string };
}

async function waitSnapshot(c: Client, sessionId: string, predicate: (s: SessionSnapshot) => boolean): Promise<SessionSnapshot> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const snap = await snapshot(c, sessionId);
    if (predicate(snap)) return snap;
    if (Date.now() > deadline) throw new Error('snapshot condition timed out');
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
}

async function idle(c: Client, sessionId: string): Promise<SessionSnapshot> {
  return waitSnapshot(c, sessionId, (s) => s.runState === 'idle');
}

function steerRows(snap: SessionSnapshot): SteerRow[] {
  return snap.rows.filter((r): r is SteerRow => r.kind === 'steer');
}

/** 取一条 provider 请求里的纯文本 user 消息（保持顺序）。 */
function userTexts(request: any): string[] {
  const messages = (request?.messages ?? []) as { role?: string; content?: unknown }[];
  return messages
    .filter((m) => m.role === 'user')
    .map((m) => {
      const content = m.content;
      if (typeof content === 'string') return content;
      if (Array.isArray(content)) {
        return content
          .map((b: any) => (typeof b === 'string' ? b : b?.type === 'text' ? String(b.text ?? '') : ''))
          .join('');
      }
      return '';
    });
}

function stateFile(): string {
  return path.join(home, 'desktop', 'state-v2.json');
}

async function readState(): Promise<any> {
  return JSON.parse(await fs.readFile(stateFile(), 'utf8'));
}

// ── §7 #1/#2/#5：运行中连续 steer → FIFO 注入、投影 queued→consumed ────

describe('steer：接受、排队与消费（§7 #1/#2/#5）', () => {
  it('流式输出中连续两条 steer：FIFO 注入、投影 queued→consumed、每条只出现一次', async () => {
    const requests: any[] = [];
    const gate = deferred();
    gates.push(gate.release);
    const url = await localProvider(async (body, res, index) => {
      requests.push(body);
      if (index === 1) await hold(res, gate.promise);
      else answer(res, `回复#${index}`);
    });

    const c = await boot({ LOCAL_KEY: 'k' });
    await c.request(W.ChannelSave, channel(url));
    const id = await session(c, { model: 'local:a' });
    await c.request(Method.SessionSubscribe, { sessionId: id });

    const { executionId } = await sendTurn(c, id, '开始工作');
    expect(executionId.startsWith('exe_')).toBe(true);

    const a = await steer(c, id, executionId, '补充指令 A');
    expect(a.status).toBe('accepted');
    expect((a.data as TurnSteerResult).queued).toBe(true);
    expect((a.data as TurnSteerResult).executionId).toBe(executionId);
    expect((a.data as TurnSteerResult).steerId.startsWith('steer_')).toBe(true);

    const b = await steer(c, id, executionId, '补充指令 B');
    expect(b.status).toBe('accepted');

    // 排队态：两条都是 queued，且 ACK 不改变运行态（仍是 streaming）。
    const queued = await snapshot(c, id);
    expect(steerRows(queued).map((r) => r.state)).toEqual(['queued', 'queued']);
    expect(queued.runState).toBe('streaming');

    gate.release();
    const done = await idle(c, id);
    const rows = steerRows(done);
    expect(rows.map((r) => r.state)).toEqual(['consumed', 'consumed']);
    expect(rows.every((r) => r.turn === 2)).toBe(true);
    expect(rows[0]?.text).toBe('补充指令 A');
    expect(rows[1]?.text).toBe('补充指令 B');

    // 第二次模型请求必须包含两条 steer，且 FIFO、各一次。
    expect(requests).toHaveLength(2);
    const texts = userTexts(requests[1]);
    const ia = texts.findIndex((t) => t.includes('补充指令 A'));
    const ib = texts.findIndex((t) => t.includes('补充指令 B'));
    expect(ia).toBeGreaterThanOrEqual(0);
    expect(ib).toBeGreaterThan(ia);
    expect(texts.filter((t) => t.includes('补充指令 A'))).toHaveLength(1);
    expect(texts.filter((t) => t.includes('补充指令 B'))).toHaveLength(1);

    // Host 侧记账清空（持久化的 pendingSteers 不残留）。
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    const state = await readState();
    const saved = state.sessions.find((s: any) => s.snapshot.meta.sessionId === id);
    expect(saved.pendingSteers ?? []).toEqual([]);
  }, 30_000);

  it('等待审批时 steer：排队不回答审批、权限模式不变（§7 #4）', async () => {
    await fs.mkdir(home, { recursive: true });
    await fs.writeFile(
      path.join(home, 'config.json'),
      JSON.stringify({ model: 'mock:default', permissionMode: 'strict' }),
    );

    const c = await boot();
    const id = await session(c);
    await c.request(Method.SessionSubscribe, { sessionId: id });

    // mock 剧本：step0 纯文本；step1 触发 read 工具（strict 下必须审批）。
    await sendTurn(c, id, '先说一句');
    await idle(c, id);

    const { executionId } = await sendTurn(c, id, '读一下 README');
    const interaction = await waitForNotification(c, Notification.InteractionRequest, () => true);
    expect(interaction.interaction.options.length).toBeGreaterThan(0);

    const before = await snapshot(c, id);
    expect(before.runState).toBe('awaiting-approval');
    const permissionMode = before.meta.permissionMode;

    const ack = await steer(c, id, executionId, '审批期间补充');
    expect(ack.status).toBe('accepted');
    expect(steerRows(await snapshot(c, id)).map((r) => r.state)).toEqual(['queued']);

    // 审批仍然是未决的：没有被 steer 自动回答，也没有被改写权限模式。
    const during = await snapshot(c, id);
    expect(during.pendingInteractions).toHaveLength(1);
    expect(during.meta.permissionMode).toBe(permissionMode);

    // 结算为拒绝 → 执行结束；排队项必须有终态（consumed 或 notConsumed），不得停留 queued。
    const current = await snapshot(c, id);
    await c.request(Method.InteractionResolve, {
      commandId: randomUUID(),
      baseRevision: current.revision,
      sessionId: id,
      interactionId: interaction.interaction.id,
      optionId: 'deny',
    });
    const done = await idle(c, id);
    expect(done.runState).toBe('idle');
    const rows = steerRows(done);
    expect(rows).toHaveLength(1);
    expect(['consumed', 'notConsumed']).toContain(rows[0]?.state);
  }, 30_000);
});

// ── §7 #7：过期 expectedExecutionId 不影响当前或下一执行 ────────────────

describe('steer：迟到 / 过期执行（§7 #7）', () => {
  it('过期 expectedExecutionId → noop；不排入当前轮也不排入下一轮', async () => {
    const requests: any[] = [];
    const gate = deferred();
    gates.push(gate.release);
    const url = await localProvider(async (body, res, index) => {
      requests.push(body);
      if (index === 1) await hold(res, gate.promise);
      else answer(res, `回复#${index}`);
    });

    const c = await boot({ LOCAL_KEY: 'k' });
    await c.request(W.ChannelSave, channel(url));
    const id = await session(c, { model: 'local:a' });

    const { executionId } = await sendTurn(c, id, '开始');
    const stale = await steer(c, id, 'exe_stale_execution', '迟到的补充');
    expect(stale.status).toBe('noop');
    expect(stale.reason).toBe('execution already changed');
    // 迟到 steer 不产生任何投影行（既没排队，也没注入）。
    expect(steerRows(await snapshot(c, id))).toHaveLength(0);

    const ok = await steer(c, id, executionId, '本轮的补充');
    expect(ok.status).toBe('accepted');

    gate.release();
    await idle(c, id);
    expect(steerRows(await snapshot(c, id)).map((r) => r.state)).toEqual(['consumed']);

    // 下一轮执行绝不能看到迟到的那条。
    await sendTurn(c, id, '第二轮');
    await idle(c, id);
    for (const request of requests) {
      expect(userTexts(request).some((t) => t.includes('迟到的补充'))).toBe(false);
    }
    expect(requests).toHaveLength(3);
  }, 30_000);
});

// ── §7 #6：幂等与冲突 ───────────────────────────────────────────────────

describe('steer：幂等（§7 #6）', () => {
  it('同 commandId 同内容 → duplicate（无第二次注入）；同 id 不同内容 → conflict', async () => {
    const requests: any[] = [];
    const gate = deferred();
    gates.push(gate.release);
    const url = await localProvider(async (body, res, index) => {
      requests.push(body);
      if (index === 1) await hold(res, gate.promise);
      else answer(res, `回复#${index}`);
    });

    const c = await boot({ LOCAL_KEY: 'k' });
    await c.request(W.ChannelSave, channel(url));
    const id = await session(c, { model: 'local:a' });

    const { executionId } = await sendTurn(c, id, '开始');
    const commandId = randomUUID();
    const first = await steer(c, id, executionId, '幂等补充', commandId);
    expect(first.status).toBe('accepted');
    const steerId = (first.data as TurnSteerResult).steerId;

    // 同 commandId + 同内容 → duplicate，且返回第一次的业务数据（同一个 steerId）。
    const dup = await steer(c, id, executionId, '幂等补充', commandId);
    expect(dup.status).toBe('duplicate');
    expect((dup.data as TurnSteerResult).steerId).toBe(steerId);
    expect(steerRows(await snapshot(c, id))).toHaveLength(1);

    // 同 commandId + 不同内容 → idempotency_conflict。
    await expect(steer(c, id, executionId, '换了内容', commandId)).rejects.toMatchObject({
      kind: 'idempotency_conflict',
    });
    expect(steerRows(await snapshot(c, id))).toHaveLength(1);

    gate.release();
    await idle(c, id);
    const texts = userTexts(requests[1]);
    expect(texts.filter((t) => t.includes('幂等补充'))).toHaveLength(1);
    expect(texts.some((t) => t.includes('换了内容'))).toBe(false);
  }, 30_000);
});

// ── §2：参数校验与队列容量 fail-closed ──────────────────────────────────

describe('steer：参数与容量（§2 fail-closed）', () => {
  it('非法 text / 缺失 expectedExecutionId → invalid_request；第 33 条 → rejected 队列满', async () => {
    const gate = deferred();
    gates.push(gate.release);
    const url = await localProvider(async (body, res, index) => {
      if (index === 1) await hold(res, gate.promise);
      else answer(res, `回复#${index}`);
    });

    const c = await boot({ LOCAL_KEY: 'k' });
    await c.request(W.ChannelSave, channel(url));
    const id = await session(c, { model: 'local:a' });
    const { executionId } = await sendTurn(c, id, '开始');

    const base = await snapshot(c, id);
    await expect(
      c.request(Method.TurnSteer, {
        commandId: randomUUID(),
        baseRevision: base.revision,
        sessionId: id,
        expectedExecutionId: executionId,
        text: '',
      }),
    ).rejects.toMatchObject({ kind: 'invalid_request' });
    await expect(
      c.request(Method.TurnSteer, {
        commandId: randomUUID(),
        baseRevision: base.revision,
        sessionId: id,
        expectedExecutionId: executionId,
        text: 'x'.repeat(10_001),
      }),
    ).rejects.toMatchObject({ kind: 'invalid_request' });
    // expectedExecutionId 必填：缺失 → invalid_request（不得被当成"无活动执行"）。
    await expect(
      c.request(Method.TurnSteer, {
        commandId: randomUUID(),
        baseRevision: base.revision,
        sessionId: id,
        text: '缺少执行 id',
      }),
    ).rejects.toMatchObject({ kind: 'invalid_request' });

    // 容量 32：前 32 条 accepted，第 33 条 fail-closed 并给可操作原因。
    for (let i = 0; i < 32; i += 1) {
      const ack = await steer(c, id, executionId, `排队 ${i}`);
      expect(ack.status).toBe('accepted');
    }
    const overflow = await steer(c, id, executionId, '第 33 条');
    expect(overflow.status).toBe('rejected');
    expect(overflow.reason).toBe('steer queue is full (max 32 pending)');
    // 被拒的条目不得留下 queued 行（不静默丢弃，也不假装排队）。
    expect(steerRows(await snapshot(c, id))).toHaveLength(32);

    gate.release();
    const done = await idle(c, id);
    expect(steerRows(done).filter((r) => r.state === 'consumed')).toHaveLength(32);

    // 执行已结束后再 steer → rejected 'no active execution'（不排入下一轮）。
    const afterRun = await steer(c, id, executionId, '结束后再补充');
    expect(afterRun.status).toBe('rejected');
    expect(afterRun.reason).toBe('no active execution');
  }, 40_000);
});

// ── §7 #8：queued 后立即 stop ───────────────────────────────────────────

describe('steer：stop 后未消费（§7 #8）', () => {
  it('queued 后立即 stop → notConsumed(aborted)，以后运行不自动重放', async () => {
    const requests: any[] = [];
    const gate = deferred();
    gates.push(gate.release);
    const url = await localProvider(async (body, res, index) => {
      requests.push(body);
      if (index === 1) await hold(res, gate.promise);
      else answer(res, `回复#${index}`);
    });

    const c = await boot({ LOCAL_KEY: 'k' });
    await c.request(W.ChannelSave, channel(url));
    const id = await session(c, { model: 'local:a' });

    const { executionId } = await sendTurn(c, id, '开始');
    const ack = await steer(c, id, executionId, '停止前的补充');
    expect(ack.status).toBe('accepted');
    expect(steerRows(await snapshot(c, id)).map((r) => r.state)).toEqual(['queued']);

    const beforeStop = await snapshot(c, id);
    const stopped = await c.request<AckResult>(Method.TurnStop, {
      commandId: randomUUID(),
      baseRevision: beforeStop.revision,
      sessionId: id,
      expectedExecutionId: executionId,
    });
    expect(stopped.status).toBe('accepted');

    gate.release();
    const done = await idle(c, id);
    const rows = steerRows(done);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.state).toBe('notConsumed');
    expect(rows[0]?.reason).toBe('aborted');

    // 之后新一轮执行不得自动重放这条未消费的 steer。
    await sendTurn(c, id, '新的开始');
    await idle(c, id);
    for (const request of requests) {
      expect(userTexts(request).some((t) => t.includes('停止前的补充'))).toBe(false);
    }
    expect(steerRows(await snapshot(c, id))[0]?.state).toBe('notConsumed');
  }, 30_000);
});

// ── §7 #10：Host 重启不重放、不假装已消费 ───────────────────────────────

describe('steer：Host 重启（§7 #10）', () => {
  it('排队项不自动重放；补 not_consumed(host_restarted)；二次重启不重复补记', async () => {
    const c1 = await boot();
    const id = await session(c1, { title: 'restart' });
    await c1.request(W.SessionArchive, { sessionId: id, archived: true });
    await closeHost();

    // 模拟"Host 在 steer 排队期间崩溃"：状态文件里留下未消费项。
    const state = await readState();
    const saved = state.sessions.find((s: any) => s.snapshot.meta.sessionId === id);
    expect(saved).toBeDefined();
    saved.pendingSteers = [{ id: 'steer_restart_1', text: '重启前排队的补充' }];
    await fs.writeFile(stateFile(), JSON.stringify(state));

    // 重启：不自动重放，补一条 not_consumed（host_restarted）。
    const c2 = await boot();
    const restored = await snapshot(c2, id);
    expect(restored.runState).toBe('idle');
    const rows = steerRows(restored);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.steerId).toBe('steer_restart_1');
    expect(rows[0]?.state).toBe('notConsumed');
    expect(rows[0]?.reason).toBe('host_restarted');
    // 没有多出任何消息行（内核历史没有被重放/伪造）。
    expect(restored.rows.filter((r) => r.kind === 'message')).toHaveLength(0);

    // 记账已清空并持久化。
    const after = await readState();
    const afterSaved = after.sessions.find((s: any) => s.snapshot.meta.sessionId === id);
    expect(afterSaved.pendingSteers ?? []).toEqual([]);
    const seqAfterFirstRestart = restored.seq;

    // 归档会话仍拒绝 steer（终态已可见，不需要再接受新的）。
    const archivedAck = await steer(c2, id, 'exe_any', '归档后再补充');
    expect(archivedAck.status).toBe('rejected');
    expect(archivedAck.reason).toBe('Restore archived session before steering');

    // 二次重启：不得重复补记（不假装又发生了一次未消费）。
    await closeHost();
    const c3 = await boot();
    const again = await snapshot(c3, id);
    expect(again.seq).toBe(seqAfterFirstRestart);
    expect(steerRows(again)).toHaveLength(1);
    expect(steerRows(again)[0]?.state).toBe('notConsumed');
  }, 40_000);

  it('关闭的会话不再接受 steer（capability_not_found）', async () => {
    const c = await boot();
    const id = await session(c, { title: 'close' });
    await c.request(Method.SessionClose, { sessionId: id });
    await expect(steer(c, id, 'exe_any', '关闭后补充')).rejects.toMatchObject({
      kind: 'capability_not_found',
    });
  }, 20_000);
});

// ── §7 #11：恢复 / fork 不重复、不跨执行串线 ────────────────────────────

describe('steer：恢复与 fork（§7 #11）', () => {
  it('消费过的 steer 在重启后仍是 consumed，且历史里只出现一次；fork 不重复注入', async () => {
    const gate = deferred();
    gates.push(gate.release);
    const url = await localProvider(async (body, res, index) => {
      if (index === 1) await hold(res, gate.promise);
      else answer(res, `回复#${index}`);
    });
    const c1 = await boot({ LOCAL_KEY: 'k' });
    await c1.request(W.ChannelSave, channel(url));
    const id = await session(c1, { model: 'local:a' });
    const { executionId } = await sendTurn(c1, id, '开始');
    await steer(c1, id, executionId, '只应出现一次的补充');
    gate.release();
    await idle(c1, id);
    expect(steerRows(await snapshot(c1, id)).map((r) => r.state)).toEqual(['consumed']);
    await closeHost();

    const c2 = await boot();
    const restored = await snapshot(c2, id);
    expect(steerRows(restored).map((r) => r.state)).toEqual(['consumed']);
    // 内核历史里恰好一条（重启不会重放/重复追加）。
    const state = await readState();
    const saved = state.sessions.find((s: any) => s.snapshot.meta.sessionId === id);
    const steerMessages = (saved.messages as any[]).filter(
      (m) => m.role === 'user' && JSON.stringify(m.content).includes('只应出现一次的补充'),
    );
    expect(steerMessages).toHaveLength(1);

    // fork 之后，分叉历史同样只含一条（不跨执行串线）。
    const forkBase = await snapshot(c2, id);
    const forked = await c2.request<{ sessionId: string }>(FeatureMethod.SessionFork, {
      commandId: randomUUID(),
      baseRevision: forkBase.revision,
      sessionId: id,
    });
    const state2 = await readState();
    const forkedSaved = state2.sessions.find((s: any) => s.snapshot.meta.sessionId === forked.sessionId);
    const forkedMessages = (forkedSaved.messages as any[]).filter(
      (m) => m.role === 'user' && JSON.stringify(m.content).includes('只应出现一次的补充'),
    );
    expect(forkedMessages).toHaveLength(1);
    expect(forkedSaved.pendingSteers ?? []).toEqual([]);
  }, 40_000);
});

// ── 通用：等待某条通知 ──────────────────────────────────────────────────

async function waitForNotification(
  c: Client,
  method: string,
  predicate: (params: any) => boolean,
  timeoutMs = 10_000,
): Promise<any> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const hit = c.notifications.find((n) => n.method === method && predicate(n.params));
    if (hit !== undefined) return hit.params;
    if (Date.now() > deadline) throw new Error(`timeout waiting for ${method}`);
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
}
