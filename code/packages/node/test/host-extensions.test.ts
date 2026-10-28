import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { sha256Hex as coreSha256Hex, type AgentEvent } from '@syaocode/core';
import {
  createFileAuditStore,
  createFileBudgetStore,
  createFileEventSink,
  createFileIdempotencyStore,
  createFilePermissionStore,
  createFileTaskStore,
  createHttpServer,
  createNodeHasher,
  createSecretResolver,
  createStdioTransport,
  createVerifiedHasher,
  nodeRuntime,
  parseSecretRef,
  type TaskRecord,
} from '../src/index';

/**
 * Agent RPC host extensions (03 §3.5): hasher, event sink, stdio duplex,
 * HTTP+SSE edge, file-backed stores and secret resolution.
 */

function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function event(partial: Partial<AgentEvent> & { type: AgentEvent['type'] }): AgentEvent {
  return { seq: 1, runId: 'run_1', ts: 123, sessionId: 'ses_1', ...partial } as AgentEvent;
}

describe('node host · hasher adapter (C6)', () => {
  it('agrees with the kernel SHA-256', () => {
    const hasher = createNodeHasher();
    expect(hasher.sha256('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(hasher.sha256('abc')).toBe(coreSha256Hex('abc'));
    expect(createVerifiedHasher().sha256('syaocode')).toBe(coreSha256Hex('syaocode'));
  });

  it('is injected into the node runtime', () => {
    expect(nodeRuntime().hash?.sha256('x')).toBe(coreSha256Hex('x'));
  });
});

describe('node host · FileEventSink (C3)', () => {
  it('persists only governance-relevant events by default', async () => {
    const dir = tempDir('syao-events-');
    const runtime = nodeRuntime();
    try {
      const path = join(dir, 'events.jsonl');
      const sink = createFileEventSink(runtime, path);
      sink.emit(event({ type: 'text.delta', text: 'noise' }));
      sink.emit(event({ type: 'permission.request', id: 'perm_1', request: {} as never, seq: 2 }));
      sink.emit(event({ type: 'tool.receipt', receipt: { callId: 'c1' } as never, seq: 3 }));
      sink.emit(event({ type: 'usage', usage: { inputTokens: 1, outputTokens: 2 }, seq: 4 }));
      sink.emit(event({ type: 'verification.result', result: { command: 'pnpm test' } as never, seq: 5 }));
      await sink.flush?.();
      const lines = (await runtime.fs.readFile(path)).trim().split('\n');
      expect(lines).toHaveLength(4);
      const parsed = lines.map((l) => JSON.parse(l) as { type: string; sessionId: string; data: AgentEvent });
      expect(parsed.map((p) => p.type)).toEqual(['permission', 'checkpoint', 'usage', 'meta']);
      expect(parsed.every((p) => p.sessionId === 'ses_1')).toBe(true);
      expect(parsed[0]?.data.type).toBe('permission.request');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('can persist the full stream and serializes concurrent writes', async () => {
    const dir = tempDir('syao-events-all-');
    const runtime = nodeRuntime();
    try {
      const path = join(dir, 'all.jsonl');
      const sink = createFileEventSink(runtime, path, { all: true });
      for (let i = 1; i <= 25; i += 1) sink.emit(event({ type: 'text.delta', text: `t${i}`, seq: i }));
      await sink.flush?.();
      const lines = (await runtime.fs.readFile(path)).trim().split('\n');
      expect(lines).toHaveLength(25);
      expect(lines.every((l) => (JSON.parse(l) as { v: number }).v === 1)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('node host · file-backed stores', () => {
  it('task store round-trips and finds unterminated work', async () => {
    const dir = tempDir('syao-tasks-');
    const runtime = nodeRuntime();
    try {
      const store = createFileTaskStore<TaskRecord>({ runtime, dir });
      const base = { tenantId: 't1', sessionId: 's1', state: 'working' };
      await store.create({ ...base, id: 'task_1' });
      await store.create({ ...base, id: 'task_2', state: 'completed' });
      await store.create({ ...base, id: 'task_3', tenantId: 't2' });
      expect((await store.get('task_1', 't1'))?.state).toBe('working');
      // Tenant isolation: another tenant never sees the task.
      expect(await store.get('task_1', 't2')).toBeUndefined();
      expect((await store.list({ tenantId: 't1' })).map((t) => t.id)).toEqual(['task_1', 'task_2']);
      expect((await store.list({ tenantId: 't1', state: 'completed' })).map((t) => t.id)).toEqual(['task_2']);
      expect((await store.listUnterminated('t1')).map((t) => t.id)).toEqual(['task_1']);
      await store.put({ ...base, id: 'task_1', state: 'cancelled' });
      expect(await store.listUnterminated('t1')).toEqual([]);
      await store.delete('task_2', 't1');
      expect(await store.get('task_2', 't1')).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('budget store keeps accounts and reservations apart', async () => {
    const dir = tempDir('syao-budget-');
    const runtime = nodeRuntime();
    try {
      const store = createFileBudgetStore<
        { id: string; tenantId: string; reservedUsd: number; spentUsd: number },
        { id: string; accountId: string; state: string }
      >({ runtime, dir });
      await store.put({ id: 'acc_1', tenantId: 't1', reservedUsd: 0, spentUsd: 1 });
      await store.put({ id: 'acc_2', tenantId: 't2', reservedUsd: 0, spentUsd: 0 });
      expect((await store.get('acc_1'))?.spentUsd).toBe(1);
      expect((await store.list('t1')).map((a) => a.id)).toEqual(['acc_1']);
      await store.putReservation({ id: 'res_1', accountId: 'acc_1', state: 'held' });
      await store.putReservation({ id: 'res_2', accountId: 'acc_1', state: 'settled' });
      expect((await store.getReservation('res_1'))?.state).toBe('held');
      expect((await store.listReservations({ state: 'held' })).map((r) => r.id)).toEqual(['res_1']);
      expect((await store.listReservations({ accountId: 'acc_1' })).map((r) => r.id).sort()).toEqual(['res_1', 'res_2']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('idempotency store replays, refuses conflicts and allows retry after failure', async () => {
    const dir = tempDir('syao-idem-');
    const runtime = nodeRuntime();
    try {
      const store = createFileIdempotencyStore<{
        key: string;
        requestHash: string;
        state: string;
        createdAt: string;
        expiresAt: string;
      }>({ runtime, dir });
      const first = await store.begin('k1', 'hash-a');
      expect(first.kind).toBe('new');
      expect((await store.begin('k1', 'hash-a')).kind).toBe('in_flight');
      expect((await store.begin('k1', 'hash-b')).kind).toBe('conflict');
      await store.complete('k1', { ok: true }, 'ref://1');
      const replay = await store.begin('k1', 'hash-a');
      expect(replay.kind).toBe('replay');
      expect(replay.record.state).toBe('completed');

      await store.begin('k2', 'hash-c');
      await store.fail('k2', { code: 'SY-SRV-004' });
      expect((await store.begin('k2', 'hash-c')).kind).toBe('new');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('audit store appends a verifiable SHA-256 chain per tenant', async () => {
    const dir = tempDir('syao-audit-');
    const runtime = nodeRuntime();
    try {
      const store = createFileAuditStore<{
        id: string;
        ts: string;
        tenantId: string;
        action: string;
        outcome: string;
        prevHash: string;
        hash: string;
      }>({ runtime, dir });
      const a = await store.append({ id: 'a1', ts: '2026-10-28T00:00:00Z', tenantId: 't1', action: 'invoke', outcome: 'success' });
      const b = await store.append({ id: 'a2', ts: '2026-10-28T00:00:01Z', tenantId: 't1', action: 'invoke', outcome: 'denied' });
      expect(a.prevHash).toBe('');
      expect(b.prevHash).toBe(a.hash);
      expect(a.hash).toHaveLength(64);
      expect((await store.list({ tenantId: 't1' })).map((e) => e.id)).toEqual(['a1', 'a2']);
      // Chains are per tenant.
      expect((await store.list({ tenantId: 't2' }))).toEqual([]);
      expect(await store.verify('t1')).toEqual({ ok: true, checked: 2 });

      // Tampering with a stored line must break verification.
      const file = join(dir, 't1.jsonl');
      const raw = await runtime.fs.readFile(file);
      await runtime.fs.writeFile(file, raw.replace('"action":"invoke"', '"action":"tampered"'));
      const verdict = await store.verify('t1');
      expect(verdict.ok).toBe(false);
      expect(verdict.brokenAt).toBe('a1');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('node host · secret references (BR-023)', () => {
  it('parses env and file references but not literals', () => {
    expect(parseSecretRef('env:TOKEN')).toEqual({ kind: 'env', name: 'TOKEN' });
    expect(parseSecretRef('${TOKEN}')).toEqual({ kind: 'env', name: 'TOKEN' });
    expect(parseSecretRef('file:/tmp/token')).toEqual({ kind: 'file', path: '/tmp/token' });
    expect(parseSecretRef('sk-live-abcdef')).toBeUndefined();
  });

  it('resolves from the environment and from a file', async () => {
    const dir = tempDir('syao-secret-');
    const runtime = nodeRuntime();
    try {
      const path = join(dir, 'token');
      await runtime.fs.writeFile(path, 'file-secret\n');
      const envRuntime = { ...runtime, env: { get: (n: string) => (n === 'SYAO_TOKEN' ? 'env-secret' : undefined) } };
      const resolver = createSecretResolver({ runtime: envRuntime });
      expect(await resolver.resolve('env:SYAO_TOKEN')).toBe('env-secret');
      expect(await resolver.resolve(`file:${path}`)).toBe('file-secret');
      expect(resolver.canResolve('literal-value')).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fails closed with SY-CFG-002 for a literal, a missing variable or a missing file', async () => {
    const runtime = nodeRuntime();
    const resolver = createSecretResolver({ runtime, env: { get: () => undefined } });
    await expect(resolver.resolve('sk-live-abcdef')).rejects.toMatchObject({ code: 'SY-CFG-002' });
    await expect(resolver.resolve('env:MISSING')).rejects.toMatchObject({ code: 'SY-CFG-002' });
    await expect(resolver.resolve('file:/definitely/not/here')).rejects.toMatchObject({ code: 'SY-CFG-002' });
  });
});

describe('node host · file permission store (C5)', () => {
  it('round-trips remembered project rules and tolerates a corrupt file', async () => {
    const dir = tempDir('syao-perm-');
    const runtime = nodeRuntime();
    try {
      const path = join(dir, '.syaocode', 'permissions.json');
      const store = createFilePermissionStore(runtime, path);
      expect(await store.load()).toEqual([]);
      const rule = { effect: 'allow' as const, tool: 'write', source: 'user' as const, match: { path: 'a.ts' } };
      await store.save([rule]);
      expect(await store.load()).toEqual([rule]);
      await runtime.fs.writeFile(path, '{ not json');
      expect(await store.load()).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('node host · stdio duplex transport', () => {
  it('round-trips a newline-delimited JSON frame through a child process', async () => {
    const runtime = nodeRuntime();
    const transport = createStdioTransport({ runtime, command: 'cat', args: [], framing: 'json-lines' });
    const frames = await transport.open();
    transport.send({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    const iterator = frames[Symbol.asyncIterator]();
    const first = await iterator.next();
    expect(first.done).toBe(false);
    expect(first.value?.json).toEqual({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    await transport.close();
  });
});

describe('node host · HTTP + SSE edge', () => {
  it('serves JSON-RPC and an SSE stream on an ephemeral loopback port', async () => {
    const runtime = nodeRuntime();
    const server = createHttpServer({
      runtime,
      handler: (req) => ({ status: 200, body: JSON.stringify({ echo: req.body, method: req.method }) }),
      onSse: (channel) => {
        channel.send({ hello: 'world' }, { event: 'ready', id: '1' });
      },
    });
    await server.listen();
    try {
      expect(server.port).toBeGreaterThan(0);
      const res = await fetch(`${server.url}/rpc`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1 }),
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ echo: '{"jsonrpc":"2.0","id":1}', method: 'POST' });

      const sse = await fetch(`${server.url}/events`);
      expect(sse.headers.get('content-type')).toContain('text/event-stream');
      // The SSE stream stays open by design: read the first frame only.
      const reader = sse.body?.getReader();
      expect(reader).toBeDefined();
      const chunk = await reader!.read();
      const text = new TextDecoder().decode(chunk.value);
      expect(text).toContain('event: ready');
      expect(text).toContain('data: {"hello":"world"}');
      await reader!.cancel();
    } finally {
      await server.close();
    }
  });

  it('rejects a request without the bearer token (BR-041)', async () => {
    const runtime = nodeRuntime();
    const server = createHttpServer({
      runtime,
      token: 'expected',
      handler: () => ({ status: 200, body: '{}' }),
    });
    await server.listen();
    try {
      const unauthorized = await fetch(`${server.url}/rpc`, { method: 'POST', body: '{}' });
      expect(unauthorized.status).toBe(401);
      const ok = await fetch(`${server.url}/rpc`, {
        method: 'POST',
        body: '{}',
        headers: { authorization: 'Bearer expected' },
      });
      expect(ok.status).toBe(200);
    } finally {
      await server.close();
    }
  });
});
