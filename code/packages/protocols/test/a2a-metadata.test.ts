/**
 * A2A reserved metadata keys (WP-6 / 06 §13).
 *
 * `metadata` carries transport-level facts — the acting tenant and the spoken
 * protocol version. They are **reserved**: a caller must not be able to
 * override them by accident, and a peer must not accept a body that
 * contradicts what the transport already established.
 *
 * The bug this locks down: the client used to build its metadata as
 * `{ tenantId, 'A2A-Version', ...extra }` — the spread came *after* the
 * reserved keys, so an `extra` silently overrode both, and the server read
 * whatever arrived without a conflict check.
 */

import { describe, expect, it } from 'vitest';
import { A2aClient } from '../src/a2a/client.js';
import { A2aServer, DEFAULT_A2A_VERSION, MemoryA2aTaskStore } from '../src/a2a/server.js';
import {
  A2A_METADATA_TENANT_KEY,
  A2A_METADATA_VERSION_KEY,
  A2A_RESERVED_METADATA_KEYS,
  findReservedMetadataConflict,
  readReservedMetadata,
} from '../src/a2a/metadata.js';
import { A2A_INVALID_PARAMS, a2aReservedMetadataError } from '../src/a2a/errors.js';
import { buildAgentCard } from '../src/a2a/card.js';
import type { A2aMessage, A2aTask } from '../src/a2a/artifacts.js';
import { createLoopbackPair } from '../src/shared/transport.js';
import { JsonRpcConnection } from '../src/shared/jsonrpc.js';
import { createFakeRuntime } from './helpers/fake-runtime.js';

const TENANT = 'acme';
const VERSION = '1.0';

const CARD = buildAgentCard({
  name: 'Test Agent',
  description: 'reserved-metadata test agent',
  version: '1.0.0',
  url: 'http://127.0.0.1:8931',
  skills: [{ id: 'echo', name: 'Echo' }],
});

function message(id: string): A2aMessage {
  return { messageId: id, role: 'user', parts: [{ text: 'hello' }], kind: 'message' };
}

function task(id: string, state = 'TASK_STATE_WORKING'): A2aTask {
  return { id, contextId: 'ctx-1', kind: 'task', status: { state, timestamp: new Date(0).toISOString() }, artifacts: [] };
}

describe('a2a · reserved metadata keys', () => {
  it('registers the transport-owned keys', () => {
    expect([...A2A_RESERVED_METADATA_KEYS].sort()).toEqual(['A2A-Version', 'tenantId']);
    expect(A2A_RESERVED_METADATA_KEYS.has(A2A_METADATA_TENANT_KEY)).toBe(true);
    expect(A2A_RESERVED_METADATA_KEYS.has(A2A_METADATA_VERSION_KEY)).toBe(true);
  });

  it('reads the reserved keys out of a metadata record', () => {
    expect(readReservedMetadata({ tenantId: 'acme', 'A2A-Version': '1.0', other: 1 })).toEqual({ tenantId: 'acme', version: '1.0' });
    expect(readReservedMetadata(undefined)).toEqual({});
  });

  it('reports a conflict only when the value differs', () => {
    const authoritative = { tenantId: 'acme', version: '1.0' };
    expect(findReservedMetadataConflict({ tenantId: 'acme' }, authoritative)).toBeUndefined();
    expect(findReservedMetadataConflict({ 'A2A-Version': '1.0' }, authoritative)).toBeUndefined();
    expect(findReservedMetadataConflict({ tenantId: 'other' }, authoritative)).toEqual({
      key: 'tenantId',
      expected: 'acme',
      received: 'other',
    });
    expect(findReservedMetadataConflict({ 'A2A-Version': '0.3' }, authoritative)).toEqual({
      key: 'A2A-Version',
      expected: '1.0',
      received: '0.3',
    });
  });
});

describe('a2a · client rejects a conflicting reserved key', () => {
  it('rejects an extra with a conflicting tenantId and never reaches the peer', async () => {
    const pair = createLoopbackPair({ labels: ['client', 'agent'] });
    const runtime = createFakeRuntime();
    let peerCalls = 0;
    const peer = new JsonRpcConnection({
      channel: pair.b,
      requestTimeoutMs: 1_000,
      handlers: {
        request: () => {
          peerCalls += 1;
          return task('t1');
        },
      },
    });
    peer.start();

    const client = new A2aClient({ runtime, channel: pair.a, agentId: 'agent-1', tenantId: TENANT, version: VERSION });

    await expect(
      client.sendMessage({ message: message('m1'), metadata: { tenantId: 'someone-else' } }),
    ).rejects.toMatchObject({ kind: 'invalid_request' });

    // The request never left the client.
    expect(peerCalls).toBe(0);

    await client.close();
    await peer.close();
    await pair.close();
  });

  it('rejects an extra with a conflicting A2A-Version and never reaches the peer', async () => {
    const pair = createLoopbackPair({ labels: ['client', 'agent'] });
    const runtime = createFakeRuntime();
    let peerCalls = 0;
    const peer = new JsonRpcConnection({
      channel: pair.b,
      requestTimeoutMs: 1_000,
      handlers: {
        request: () => {
          peerCalls += 1;
          return task('t1');
        },
      },
    });
    peer.start();

    const client = new A2aClient({ runtime, channel: pair.a, agentId: 'agent-1', tenantId: TENANT, version: VERSION });

    await expect(
      client.sendMessage({ message: message('m1'), metadata: { 'A2A-Version': '0.3' } }),
    ).rejects.toMatchObject({ kind: 'invalid_request' });
    expect(peerCalls).toBe(0);

    await client.close();
    await peer.close();
    await pair.close();
  });

  it('rejects on every metadata-carrying method, not just SendMessage', async () => {
    const pair = createLoopbackPair({ labels: ['client', 'agent'] });
    const runtime = createFakeRuntime();
    const peer = new JsonRpcConnection({ channel: pair.b, requestTimeoutMs: 1_000, handlers: { request: () => task('t1') } });
    peer.start();
    const client = new A2aClient({ runtime, channel: pair.a, agentId: 'agent-1', tenantId: TENANT, version: VERSION });

    await expect(client.sendMessage({ message: message('m1'), metadata: { tenantId: 'someone-else' } })).rejects.toMatchObject({
      kind: 'invalid_request',
    });
    // A call without `extra` is unaffected.
    await expect(client.getTask('t1')).resolves.toBeTruthy();

    await client.close();
    await peer.close();
    await pair.close();
  });

  it('allows an extra that repeats the same reserved value', async () => {
    const pair = createLoopbackPair({ labels: ['client', 'agent'] });
    const runtime = createFakeRuntime();
    const seen: unknown[] = [];
    const peer = new JsonRpcConnection({
      channel: pair.b,
      requestTimeoutMs: 1_000,
      handlers: {
        request: (method, params) => {
          seen.push(params);
          return task('t1');
        },
      },
    });
    peer.start();

    const client = new A2aClient({ runtime, channel: pair.a, agentId: 'agent-1', tenantId: TENANT, version: VERSION });
    const result = await client.sendMessage({
      message: message('m1'),
      metadata: { tenantId: TENANT, 'A2A-Version': VERSION, traceId: 'abc' },
    });
    expect(result.task?.id).toBe('t1');

    // The non-reserved key survived; the reserved ones carry the authoritative value.
    const metadata = (seen[0] as { metadata: Record<string, unknown> }).metadata;
    expect(metadata['traceId']).toBe('abc');
    expect(metadata['tenantId']).toBe(TENANT);
    expect(metadata['A2A-Version']).toBe(VERSION);

    await client.close();
    await peer.close();
    await pair.close();
  });

  it('keeps the reserved keys authoritative even when extra is spread last', async () => {
    const pair = createLoopbackPair({ labels: ['client', 'agent'] });
    const runtime = createFakeRuntime();
    const seen: Record<string, unknown>[] = [];
    const peer = new JsonRpcConnection({
      channel: pair.b,
      requestTimeoutMs: 1_000,
      handlers: {
        request: (_method, params) => {
          seen.push((params as { metadata: Record<string, unknown> }).metadata);
          return task('t1');
        },
      },
    });
    peer.start();

    const client = new A2aClient({ runtime, channel: pair.a, agentId: 'agent-1', tenantId: TENANT, version: VERSION });
    await client.sendMessage({ message: message('m1'), metadata: { tenantId: TENANT, 'A2A-Version': VERSION } });

    expect(seen[0]?.['tenantId']).toBe(TENANT);
    expect(seen[0]?.['A2A-Version']).toBe(VERSION);

    await client.close();
    await peer.close();
    await pair.close();
  });
});

describe('a2a · server rejects a conflicting inbound reserved key', () => {
  it('rejects a body whose tenantId contradicts the transport context (-32602 + reason)', async () => {
    const pair = createLoopbackPair({ labels: ['client', 'agent'] });
    const runtime = createFakeRuntime();
    const server = new A2aServer({
      runtime,
      channel: pair.b,
      agentId: 'agent-1',
      card: CARD,
      store: new MemoryA2aTaskStore(),
      // The transport authenticated the caller: `acme` is authoritative.
      transportContext: () => ({ tenantId: TENANT, version: VERSION }),
    });
    const client = new JsonRpcConnection({ channel: pair.a, requestTimeoutMs: 1_000 });
    client.start();

    await expect(
      client.request('ListTasks', { metadata: { tenantId: 'someone-else', 'A2A-Version': VERSION } }),
    ).rejects.toMatchObject({ code: -32602, data: { reason: 'reserved_metadata_key' } });

    await client.close();
    await server.close();
    await pair.close();
  });

  it('rejects a body whose A2A-Version contradicts the transport header (-32602 + reason)', async () => {
    const pair = createLoopbackPair({ labels: ['client', 'agent'] });
    const runtime = createFakeRuntime();
    const server = new A2aServer({
      runtime,
      channel: pair.b,
      agentId: 'agent-1',
      card: CARD,
      store: new MemoryA2aTaskStore(),
      // The transport carried `A2A-Version: 1.0`; the body may only confirm it.
      transportContext: () => ({ version: VERSION }),
    });
    const client = new JsonRpcConnection({ channel: pair.a, requestTimeoutMs: 1_000 });
    client.start();

    await expect(
      client.request('ListTasks', { metadata: { tenantId: TENANT, 'A2A-Version': '0.3' } }),
    ).rejects.toMatchObject({ code: -32602, data: { reason: 'reserved_metadata_key' } });

    await client.close();
    await server.close();
    await pair.close();
  });

  it('accepts a body that only confirms the authoritative values', async () => {
    const pair = createLoopbackPair({ labels: ['client', 'agent'] });
    const runtime = createFakeRuntime();
    const server = new A2aServer({
      runtime,
      channel: pair.b,
      agentId: 'agent-1',
      card: CARD,
      store: new MemoryA2aTaskStore(),
      transportContext: () => ({ tenantId: TENANT, version: VERSION }),
    });
    const client = new JsonRpcConnection({ channel: pair.a, requestTimeoutMs: 1_000 });
    client.start();

    const result = (await client.request('ListTasks', { metadata: { tenantId: TENANT, 'A2A-Version': VERSION } })) as { tasks: unknown[] };
    expect(result.tasks).toEqual([]);

    await client.close();
    await server.close();
    await pair.close();
  });

  it('accepts a body that omits the reserved keys entirely', async () => {
    const pair = createLoopbackPair({ labels: ['client', 'agent'] });
    const runtime = createFakeRuntime();
    const server = new A2aServer({
      runtime,
      channel: pair.b,
      agentId: 'agent-1',
      card: CARD,
      store: new MemoryA2aTaskStore(),
      transportContext: () => ({ tenantId: TENANT, version: VERSION }),
    });
    const client = new JsonRpcConnection({ channel: pair.a, requestTimeoutMs: 1_000 });
    client.start();

    const result = (await client.request('ListTasks', { metadata: {} })) as { tasks: unknown[] };
    expect(result.tasks).toEqual([]);

    await client.close();
    await server.close();
    await pair.close();
  });

  it('rejects a conflicting key against a host-resolved caller too', async () => {
    const pair = createLoopbackPair({ labels: ['client', 'agent'] });
    const runtime = createFakeRuntime();
    const server = new A2aServer({
      runtime,
      channel: pair.b,
      agentId: 'agent-1',
      card: CARD,
      store: new MemoryA2aTaskStore(),
      resolveCaller: () => ({ tenantId: TENANT, version: VERSION }),
    });
    const client = new JsonRpcConnection({ channel: pair.a, requestTimeoutMs: 1_000 });
    client.start();

    await expect(
      client.request('GetTask', { id: 't1', metadata: { tenantId: 'someone-else', 'A2A-Version': VERSION } }),
    ).rejects.toMatchObject({ code: -32602, data: { reason: 'reserved_metadata_key' } });

    await client.close();
    await server.close();
    await pair.close();
  });
});

describe('a2a · version compatibility defaults', () => {
  it('defaults an absent version to 0.3', () => {
    expect(DEFAULT_A2A_VERSION).toBe('0.3');
  });

  it('answers a request without a version with the 0.3 default (compat)', async () => {
    const pair = createLoopbackPair({ labels: ['client', 'agent'] });
    const runtime = createFakeRuntime();
    const seen: string[] = [];
    const server = new A2aServer({
      runtime,
      channel: pair.b,
      agentId: 'agent-1',
      card: CARD,
      store: new MemoryA2aTaskStore(),
      // A peer that also speaks the 0.3 compatibility version.
      supportedVersions: ['1.0', '0.3'],
      resolveCaller: (params) => {
        const metadata = (params as { metadata?: Record<string, unknown> } | null)?.metadata;
        const version = metadata?.['A2A-Version'];
        seen.push(typeof version === 'string' ? version : DEFAULT_A2A_VERSION);
        return { tenantId: TENANT, version: typeof version === 'string' ? version : DEFAULT_A2A_VERSION };
      },
    });
    const client = new JsonRpcConnection({ channel: pair.a, requestTimeoutMs: 1_000 });
    client.start();

    const result = (await client.request('ListTasks', { metadata: { tenantId: TENANT } })) as { tasks: unknown[] };
    expect(result.tasks).toEqual([]);
    // The absent version was resolved as 0.3, not as the agent's own 1.0.
    expect(seen).toEqual(['0.3']);

    await client.close();
    await server.close();
    await pair.close();
  });

  it('treats an absent version as a real 0.3 request (no common version ⇒ -32009)', async () => {
    const pair = createLoopbackPair({ labels: ['client', 'agent'] });
    const runtime = createFakeRuntime();
    const server = new A2aServer({
      runtime,
      channel: pair.b,
      agentId: 'agent-1',
      card: CARD,
      store: new MemoryA2aTaskStore(),
      // This agent only speaks 1.0, so a 0.3 request has no common version.
      supportedVersions: ['1.0'],
    });
    const client = new JsonRpcConnection({ channel: pair.a, requestTimeoutMs: 1_000 });
    client.start();

    await expect(client.request('ListTasks', { metadata: { tenantId: TENANT } })).rejects.toMatchObject({ code: -32009 });

    await client.close();
    await server.close();
    await pair.close();
  });

  it('defaults to 0.3 without any resolver (body is the only source)', async () => {
    const pair = createLoopbackPair({ labels: ['client', 'agent'] });
    const runtime = createFakeRuntime();
    const server = new A2aServer({
      runtime,
      channel: pair.b,
      agentId: 'agent-1',
      card: CARD,
      store: new MemoryA2aTaskStore(),
      supportedVersions: ['1.0', '0.3'],
    });
    const client = new JsonRpcConnection({ channel: pair.a, requestTimeoutMs: 1_000 });
    client.start();

    const result = (await client.request('ListTasks', { metadata: { tenantId: TENANT } })) as { tasks: unknown[] };
    expect(result.tasks).toEqual([]);

    await client.close();
    await server.close();
    await pair.close();
  });
});

describe('a2a · the conflict error shape', () => {
  it('carries the canonical kind, the -32602 wire code and the reason', () => {
    const error = a2aReservedMetadataError({ key: 'tenantId', expected: 'acme', received: 'other' });
    expect(error.kind).toBe('invalid_request');
    expect(error.wireCode).toBe(A2A_INVALID_PARAMS);
    expect(A2A_INVALID_PARAMS).toBe(-32602);
    expect(error.details).toMatchObject({ reason: 'reserved_metadata_key', key: 'tenantId', expected: 'acme', received: 'other' });
    expect(error.toShape().wireCode).toBe(-32602);
  });
});
