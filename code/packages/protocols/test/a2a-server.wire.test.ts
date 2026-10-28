/**
 * A2A server wire conformance (P-H2/H3/H4).
 *
 * The point of this suite: every error path must put the **exact numeric code**
 * on the wire. Before the fix, `toShape()` carried no code and the JSON-RPC
 * layer answered `-32603` for everything, so a peer could not tell
 * `TaskNotFoundError` from an internal crash.
 *
 * Streaming is asserted against the spec's SSE binding
 * (`text/event-stream`), never the private `notifications/stream` frame.
 */

import { describe, expect, it } from 'vitest';
import { A2aClient, A2A_VERSION } from '../src/a2a/client.js';
import { A2aServer, MemoryA2aTaskStore } from '../src/a2a/server.js';
import { buildAgentCard } from '../src/a2a/card.js';
import { a2aError, a2aVersionNotSupported, canonicalToA2aError } from '../src/a2a/errors.js';
import type { A2aMessage, A2aTask } from '../src/a2a/artifacts.js';
import { createLoopbackPair } from '../src/shared/transport.js';
import { JsonRpcConnection, isJsonRpcResponse } from '../src/shared/jsonrpc.js';
import type { DuplexChannel } from '../src/shared/transport.js';
import { createFakeRuntime } from './helpers/fake-runtime.js';

const AGENT_ID = 'agent-1';
const TENANT = 'acme';

const CARD = buildAgentCard({
  name: 'Test Agent',
  description: 'A2A wire test agent',
  version: '1.0.0',
  url: 'http://127.0.0.1:8931',
  skills: [{ id: 'echo', name: 'Echo', description: 'echoes' }],
});

const META = { tenantId: TENANT, 'A2A-Version': A2A_VERSION };

function message(id: string, text = 'hello'): A2aMessage {
  return { messageId: id, role: 'user', parts: [{ text }], kind: 'message' };
}

function task(id: string, state: string, contextId = 'ctx-1'): A2aTask {
  return { id, contextId, kind: 'task', status: { state, timestamp: new Date(0).toISOString() }, artifacts: [] };
}

interface Rig {
  server: A2aServer;
  client: JsonRpcConnection;
  store: MemoryA2aTaskStore;
  /** Send a raw JSON-RPC request and surface the JSON-RPC error object. */
  raw(method: string, params: Record<string, unknown>): Promise<unknown>;
  errors: { code: number; message: string; data?: unknown }[];
  dispose(): Promise<void>;
}

async function rig(options?: {
  onMessage?: (input: { message: A2aMessage }) => Promise<A2aTask | A2aMessage>;
  states?: Record<string, string>;
}): Promise<Rig> {
  const pair = createLoopbackPair({ labels: ['client', 'server'] });
  const runtime = createFakeRuntime();
  const store = new MemoryA2aTaskStore();
  const states = options?.states ?? {};
  const errors: { code: number; message: string; data?: unknown }[] = [];

  const server = new A2aServer({
    runtime,
    channel: pair.b,
    agentId: AGENT_ID,
    card: CARD,
    store,
    pollIntervalMs: 1,
    maxPolls: 3,
    onMessage:
      options?.onMessage ??
      (async (input) => {
        const id = `task-${input.message.messageId}`;
        states[id] = states[id] ?? 'TASK_STATE_WORKING';
        const created = task(id, states[id] ?? 'TASK_STATE_WORKING');
        await store.put(TENANT, created);
        return created;
      }),
  });

  // A raw client so the test can observe the JSON-RPC error object itself.
  const client = new JsonRpcConnection({
    channel: pair.a,
    requestTimeoutMs: 1_000,
    handlers: {},
  });
  client.start();

  const raw = async (method: string, params: Record<string, unknown>): Promise<unknown> => {
    try {
      return await client.request(method, params);
    } catch (error) {
      const remote = error as { code?: number; message?: string; data?: unknown };
      errors.push({ code: remote.code ?? 0, message: remote.message ?? '', ...(remote.data !== undefined ? { data: remote.data } : {}) });
      throw error;
    }
  };

  return {
    server,
    client,
    store,
    raw,
    errors,
    dispose: async () => {
      await client.close();
      await server.close();
      await pair.close();
    },
  };
}

describe('a2a server · task lifecycle', () => {
  it('SendMessage creates a task and GetTask reads it back', async () => {
    const r = await rig();
    const created = (await r.raw('SendMessage', { message: message('m1'), metadata: META })) as A2aTask;
    expect(created.id).toBe('task-m1');
    expect(created.status.state).toBe('TASK_STATE_WORKING');

    const fetched = (await r.raw('GetTask', { id: created.id, metadata: META })) as A2aTask;
    expect(fetched.id).toBe(created.id);
    expect(fetched.contextId).toBe('ctx-1');
    await r.dispose();
  });

  it('SendMessage is idempotent on messageId', async () => {
    const r = await rig();
    const first = (await r.raw('SendMessage', { message: message('m1'), metadata: META })) as A2aTask;
    const second = (await r.raw('SendMessage', { message: message('m1'), metadata: META })) as A2aTask;
    expect(second.id).toBe(first.id);
    await r.dispose();
  });

  it('GetExtendedAgentCard returns the card', async () => {
    const r = await rig();
    const card = (await r.raw('GetExtendedAgentCard', { metadata: META })) as { name: string; skills: unknown[] };
    expect(card.name).toBe('Test Agent');
    expect(card.skills).toHaveLength(1);
    await r.dispose();
  });

  it('ListTasks paginates newest-first and returns a cursor', async () => {
    const r = await rig();
    for (const id of ['a', 'b', 'c']) {
      await r.raw('SendMessage', { message: message(id), metadata: META });
      await r.server.publish(task(`task-${id}`, 'TASK_STATE_WORKING'), TENANT);
    }
    const page1 = (await r.raw('ListTasks', { pageSize: 2, metadata: META })) as { tasks: A2aTask[]; nextPageToken?: string };
    expect(page1.tasks).toHaveLength(2);
    expect(page1.nextPageToken).toBeTruthy();
    const page2 = (await r.raw('ListTasks', { pageSize: 2, pageToken: page1.nextPageToken, metadata: META })) as { tasks: A2aTask[] };
    expect(page2.tasks).toHaveLength(1);
    const ids = [...page1.tasks, ...page2.tasks].map((entry) => entry.id);
    expect(new Set(ids).size).toBe(3);
    await r.dispose();
  });

  it('CancelTask is idempotent on an already-cancelled task', async () => {
    const r = await rig();
    await r.raw('SendMessage', { message: message('m1'), metadata: META });
    const first = (await r.raw('CancelTask', { id: 'task-m1', metadata: META })) as A2aTask;
    expect(first.status.state).toBe('TASK_STATE_CANCELED');
    const second = (await r.raw('CancelTask', { id: 'task-m1', metadata: META })) as A2aTask;
    expect(second.status.state).toBe('TASK_STATE_CANCELED');
    expect(r.errors).toHaveLength(0);
    await r.dispose();
  });
});

describe('a2a server · tenant filtering', () => {
  it('a cross-tenant GetTask answers TaskNotFound (-32001), never a 403', async () => {
    const r = await rig();
    await r.raw('SendMessage', { message: message('m1'), metadata: META });

    await expect(r.raw('GetTask', { id: 'task-m1', metadata: { tenantId: 'other', 'A2A-Version': A2A_VERSION } })).rejects.toMatchObject({
      code: -32001,
    });
    // The same answer as a genuinely missing task: existence never leaks.
    await expect(r.raw('GetTask', { id: 'does-not-exist', metadata: META })).rejects.toMatchObject({ code: -32001 });
    expect(r.errors.map((entry) => entry.code)).toEqual([-32001, -32001]);
    await r.dispose();
  });

  it('ListTasks never returns another tenant\'s tasks', async () => {
    const r = await rig();
    await r.raw('SendMessage', { message: message('m1'), metadata: META });
    const other = (await r.raw('ListTasks', { metadata: { tenantId: 'other', 'A2A-Version': A2A_VERSION } })) as { tasks: A2aTask[] };
    expect(other.tasks).toHaveLength(0);
    await r.dispose();
  });

  it('a cross-tenant CancelTask answers -32001 and does not mutate the task', async () => {
    const r = await rig();
    await r.raw('SendMessage', { message: message('m1'), metadata: META });
    await expect(r.raw('CancelTask', { id: 'task-m1', metadata: { tenantId: 'other', 'A2A-Version': A2A_VERSION } })).rejects.toMatchObject({
      code: -32001,
    });
    const task = (await r.raw('GetTask', { id: 'task-m1', metadata: META })) as A2aTask;
    expect(task.status.state).toBe('TASK_STATE_WORKING');
    await r.dispose();
  });
});

describe('a2a server · every error path carries the exact wire code', () => {
  it('TaskNotFound = -32001', async () => {
    const r = await rig();
    await expect(r.raw('GetTask', { id: 'missing', metadata: META })).rejects.toMatchObject({ code: -32001 });
    expect(r.errors[0]?.code).toBe(-32001);
    await r.dispose();
  });

  it('TaskNotCancelable = -32002', async () => {
    const r = await rig();
    await r.raw('SendMessage', { message: message('m1'), metadata: META });
    // Drive the task to a non-cancellable terminal state.
    await r.server.publish(task('task-m1', 'TASK_STATE_COMPLETED'), TENANT);
    await expect(r.raw('CancelTask', { id: 'task-m1', metadata: META })).rejects.toMatchObject({ code: -32002 });
    expect(r.errors[0]?.code).toBe(-32002);
    await r.dispose();
  });

  it('PushNotificationNotSupported = -32003', async () => {
    const r = await rig();
    await expect(r.raw('CreateTaskPushNotificationConfig', { metadata: META })).rejects.toMatchObject({ code: -32003 });
    await expect(r.raw('GetTaskPushNotificationConfig', { metadata: META })).rejects.toMatchObject({ code: -32003 });
    await expect(r.raw('ListTaskPushNotificationConfigs', { metadata: META })).rejects.toMatchObject({ code: -32003 });
    await expect(r.raw('DeleteTaskPushNotificationConfig', { metadata: META })).rejects.toMatchObject({ code: -32003 });
    expect(r.errors.map((entry) => entry.code)).toEqual([-32003, -32003, -32003, -32003]);
    await r.dispose();
  });

  it('UnsupportedOperation = -32004 when the agent has no message handler', async () => {
    const pair = createLoopbackPair();
    const runtime = createFakeRuntime();
    const server = new A2aServer({ runtime, channel: pair.b, agentId: AGENT_ID, card: CARD, store: new MemoryA2aTaskStore() });
    const client = new JsonRpcConnection({ channel: pair.a, requestTimeoutMs: 1_000 });
    client.start();
    await expect(client.request('SendMessage', { message: message('m1'), metadata: META })).rejects.toMatchObject({ code: -32004 });
    await client.close();
    await server.close();
    await pair.close();
  });

  it('VersionNotSupported = -32009 (not MCP\'s -32022)', async () => {
    const r = await rig();
    await expect(r.raw('GetTask', { id: 'x', metadata: { tenantId: TENANT, 'A2A-Version': '9.9' } })).rejects.toMatchObject({ code: -32009 });
    expect(r.errors[0]?.code).toBe(-32009);
    expect(r.errors[0]?.code).not.toBe(-32022);
    await r.dispose();
  });

  it('maps an inbound -32009 back to kind version_mismatch (both directions)', () => {
    const error = a2aError({ code: -32009, message: 'VersionNotSupportedError' });
    expect(error.kind).toBe('version_mismatch');
    // ...and the outbound direction stamps -32009, not MCP's -32022.
    const outbound = a2aVersionNotSupported('9.9', '1.0');
    expect(outbound.wireCode).toBe(-32009);
    expect(canonicalToA2aError(outbound.toShape()).code).toBe(-32009);
  });

  it('unknown method = -32601 and malformed params = -32602', async () => {
    const r = await rig();
    await expect(r.raw('NoSuchMethod', { metadata: META })).rejects.toMatchObject({ code: -32601 });
    await expect(r.raw('GetTask', { metadata: META })).rejects.toMatchObject({ code: -32602 });
    expect(r.errors.map((entry) => entry.code)).toEqual([-32601, -32602]);
    await r.dispose();
  });

  it('a missing caller context = -32602', async () => {
    const r = await rig();
    await expect(r.raw('ListTasks', {})).rejects.toMatchObject({ code: -32602 });
    expect(r.errors[0]?.code).toBe(-32602);
    await r.dispose();
  });

  it('the canonical kind travels in data so the failure stays classifiable', async () => {
    const r = await rig();
    await expect(r.raw('GetTask', { id: 'missing', metadata: META })).rejects.toBeDefined();
    expect((r.errors[0]?.data as { kind?: string }).kind).toBe('capability_not_found');
    await r.dispose();
  });
});

describe('a2a server · streaming over text/event-stream (P-H4)', () => {
  it('SubscribeToTask streams the snapshot then a final status event', async () => {
    const r = await rig();
    await r.raw('SendMessage', { message: message('m1'), metadata: META });
    await r.server.publish(task('task-m1', 'TASK_STATE_COMPLETED'), TENANT);

    const events: unknown[] = [];
    for await (const frame of r.client.requestStream('SubscribeToTask', { id: 'task-m1', metadata: META })) {
      if (!isJsonRpcResponse(frame) || 'error' in frame) throw new Error('unexpected error frame');
      events.push(frame.result);
    }
    // First event MUST be the current task snapshot (01 §5.3).
    expect((events[0] as A2aTask).id).toBe('task-m1');
    expect((events[0] as A2aTask).status.state).toBe('TASK_STATE_COMPLETED');
    await r.dispose();
  });

  it('writes real SSE `data:` frames and no private notification', async () => {
    const pair = createLoopbackPair({ labels: ['client', 'server'] });
    const runtime = createFakeRuntime();
    const store = new MemoryA2aTaskStore();
    const server = new A2aServer({ runtime, channel: pair.b, agentId: AGENT_ID, card: CARD, store, pollIntervalMs: 1, maxPolls: 1 });
    await store.put(TENANT, task('t1', 'TASK_STATE_COMPLETED'));

    // Tap everything the server writes, then decode it with the shared framer.
    const written: string[] = [];
    const tap: DuplexChannel = {
      send: async (chunk: string) => {
        written.push(chunk);
        await pair.b.send(chunk);
      },
      receive: () => pair.b.receive(),
      close: (reason?: string) => pair.b.close(reason),
      get closed() {
        return pair.b.closed;
      },
      framing: 'json-lines',
      onClose: (handler) => pair.b.onClose(handler),
      describe: () => 'tap',
    };
    const tapping = new A2aServer({ runtime, channel: tap, agentId: AGENT_ID, card: CARD, store, pollIntervalMs: 1, maxPolls: 1 });

    const client = new JsonRpcConnection({ channel: pair.a, requestTimeoutMs: 1_000 });
    client.start();
    const events: unknown[] = [];
    for await (const frame of client.requestStream('SubscribeToTask', { id: 't1', metadata: META })) {
      if (!isJsonRpcResponse(frame) || 'error' in frame) continue;
      events.push(frame.result);
    }

    const raw = written.join('');
    expect(raw).toContain('data: ');
    expect(raw).not.toContain('notifications/stream');
    expect(events.length).toBeGreaterThan(0);
    await client.close();
    await tapping.close();
    void server;
    await pair.close();
  });

  it('the typed client consumes the SSE stream', async () => {
    const pair = createLoopbackPair({ labels: ['client', 'server'] });
    const runtime = createFakeRuntime();
    const store = new MemoryA2aTaskStore();
    const server = new A2aServer({ runtime, channel: pair.b, agentId: AGENT_ID, card: CARD, store, pollIntervalMs: 1, maxPolls: 2 });
    await store.put(TENANT, task('t1', 'TASK_STATE_COMPLETED'));

    const client = new A2aClient({ runtime, channel: pair.a, agentId: AGENT_ID, tenantId: TENANT });
    const events: unknown[] = [];
    for await (const event of client.subscribeToTask('t1')) events.push(event);
    expect(events.length).toBeGreaterThan(0);
    expect((events[0] as A2aTask).id).toBe('t1');
    await client.close();
    await server.close();
    await pair.close();
  });

  it('streams SendStreamingMessage with the task as the first event', async () => {
    const r = await rig();
    const events: unknown[] = [];
    for await (const frame of r.client.requestStream('SendStreamingMessage', { message: message('s1'), metadata: META })) {
      if (!isJsonRpcResponse(frame) || 'error' in frame) throw new Error('unexpected error frame');
      events.push(frame.result);
    }
    expect((events[0] as A2aTask).id).toBe('task-s1');
    await r.dispose();
  });
});
