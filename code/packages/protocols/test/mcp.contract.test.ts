/**
 * MCP adapter contract (document/Agent-RPC/03 §7.2).
 *
 * The peer is a modern-era (2026-07-28) MCP server:
 *   - `server/discover` → `supportedVersions` / `capabilities` / `ttlMs` /
 *     `cacheScope`;
 *   - `tools/list` → one tool with untrusted annotations;
 *   - `tools/call` → `resultType: "complete"` (and `input_required` for the
 *     MRTR round-trip test below).
 *
 * Every request carries the per-request `_meta` envelope, which the peer
 * asserts on.
 */

import { describe, expect, it } from 'vitest';
import { McpAdapter, McpClient } from '../src/mcp/index.js';
import { createLoopbackPair } from '../src/shared/transport.js';
import { createFakePeer } from './helpers/fake-peer.js';
import { createFakeRuntime } from './helpers/fake-runtime.js';
import { buildContext, buildInvocation, defineAdapterContract, peerView } from './helpers/contract.js';

const SERVER_ID = 'github';
const CAPABILITY_ID = `mcp://${SERVER_ID}/tool/create_issue`;

function wireMeta(params: unknown): Record<string, unknown> {
  const meta = (params as { _meta?: unknown } | null)?._meta;
  return meta !== null && typeof meta === 'object' ? (meta as Record<string, unknown>) : {};
}

describe('mcp · modern era wire', () => {
  it('sends the per-request _meta envelope on every request', async () => {
    const pair = createLoopbackPair({ labels: ['client', 'server'] });
    const peer = createFakePeer(pair.b);
    const runtime = createFakeRuntime();
    const seen: Record<string, unknown>[] = [];

    peer.on('server/discover', (params) => {
      seen.push(wireMeta(params));
      return { supportedVersions: ['2026-07-28'], capabilities: { tools: {} }, ttlMs: 60_000, cacheScope: 'private' };
    });
    peer.on('tools/list', () => ({
      tools: [
        {
          name: 'create_issue',
          title: 'Create issue',
          description: 'Opens a GitHub issue',
          inputSchema: { type: 'object', properties: { title: { type: 'string' } } },
          annotations: { readOnlyHint: false, destructiveHint: true },
        },
      ],
    }));

    const client = new McpClient({ runtime, channel: pair.a, serverId: SERVER_ID });
    const capabilities = await client.discover();
    await client.close();
    await peer.close();

    expect(seen.length).toBeGreaterThan(0);
    for (const meta of seen) {
      expect(meta['io.modelcontextprotocol/protocolVersion']).toBe('2026-07-28');
      expect(meta['io.modelcontextprotocol/clientCapabilities']).toEqual({});
      expect(meta['io.modelcontextprotocol/clientInfo']).toBeTruthy();
    }
    expect(capabilities[0]?.id).toBe(CAPABILITY_ID);
  });

  it('falls back to the legacy initialize handshake and records the loss', async () => {
    const pair = createLoopbackPair({ labels: ['client', 'server'] });
    const peer = createFakePeer(pair.b);
    const runtime = createFakeRuntime();

    peer.on('initialize', () => ({ protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: 'legacy', version: '1' } }));

    const client = new McpClient({ runtime, channel: pair.a, serverId: SERVER_ID, allowLegacyFallback: true });
    await client.connect();
    const lossy = client.lossy;
    await client.close();
    await peer.close();

    expect(client.era).toBe('legacy');
    expect(lossy).toContain('mcp-legacy');
    expect(peer.calls('initialize')).toBe(1);
    expect(peer.notifications().some((note) => note.method === 'notifications/initialized')).toBe(true);
  });

  it('rejects a tampered MRTR requestState (fail closed, -32021)', async () => {
    const pair = createLoopbackPair({ labels: ['client', 'server'] });
    const peer = createFakePeer(pair.b);
    const runtime = createFakeRuntime();

    peer.on('server/discover', () => ({ supportedVersions: ['2026-07-28'], capabilities: {}, ttlMs: 1, cacheScope: 'private' }));
    peer.on('tools/list', () => ({ tools: [{ name: 'create_issue' }] }));
    peer.on('tools/call', (params) => {
      const record = params as { requestState?: unknown };
      if (record.requestState === undefined) {
        return { resultType: 'input_required', requestState: 'state-1', inputRequests: [{ id: 'q1', method: 'elicitation', message: 'need title' }] };
      }
      if (record.requestState !== 'state-1') throw { code: -32021, message: 'requestState was tampered with' };
      return { resultType: 'complete', content: [{ type: 'text', text: 'ok' }] };
    });

    const client = new McpClient({ runtime, channel: pair.a, serverId: SERVER_ID });
    await client.connect();
    const first = await client.callTool('create_issue', { title: 'x' });
    expect(first.result.resultType).toBe('input_required');

    // A tampered token must fail closed, never be forwarded.
    await expect(client.callTool('create_issue', { title: 'x' }, { requestState: 'tampered', inputResponses: { q1: 'y' } })).rejects.toMatchObject({
      code: -32021,
    });

    await client.close();
    await peer.close();
  });

  it('never reaches the peer when the requestState was never issued', async () => {
    const pair = createLoopbackPair({ labels: ['client', 'server'] });
    const peer = createFakePeer(pair.b);
    const runtime = createFakeRuntime();
    peer.on('server/discover', () => ({ supportedVersions: ['2026-07-28'], capabilities: {}, ttlMs: 1, cacheScope: 'private' }));
    peer.on('tools/list', () => ({ tools: [{ name: 'create_issue' }] }));
    const client = new McpClient({ runtime, channel: pair.a, serverId: SERVER_ID });
    await client.connect();
    await expect(async () => client.retryPayload('create_issue', { title: 'x' }, 'unknown-state', {})).rejects.toMatchObject({
      kind: 'unsupported_capability',
    });
    await client.close();
    await peer.close();
  });
});

// ── the 8 universal properties ────────────────────────────────────────────

defineAdapterContract({
  protocol: 'mcp',
  invocationMethod: 'tools/call',
  cancelSignal: 'tasks/cancel',
  cancelledState: 'cancelled',
  setup: async () => {
    const pair = createLoopbackPair({ labels: ['client', 'server'] });
    const peer = createFakePeer(pair.b);
    const runtime = createFakeRuntime();
    let lastCall = 0;

    peer.on('server/discover', () => ({
      supportedVersions: ['2026-07-28'],
      capabilities: { tools: { listChanged: false } },
      ttlMs: 60_000,
      cacheScope: 'private',
    }));
    peer.on('tools/list', () => ({
      tools: [
        {
          name: 'create_issue',
          title: 'Create issue',
          description: 'Opens a GitHub issue',
          inputSchema: { type: 'object', properties: { title: { type: 'string' } } },
          annotations: { readOnlyHint: false, destructiveHint: true, title: 'Create issue' },
        },
      ],
    }));
    peer.on('tools/call', () => {
      lastCall += 1;
      return { resultType: 'complete', content: [{ type: 'text', text: `issue-${lastCall}` }], structuredContent: { ok: true } };
    });
    const taskStates = new Map<string, string>();
    peer.on('tasks/cancel', (params) => {
      const taskId = (params as { taskId?: string }).taskId ?? 'task-1';
      taskStates.set(taskId, 'cancelled');
      return { taskId, status: 'cancelled' };
    });
    peer.on('tasks/get', (params) => {
      const taskId = (params as { taskId?: string }).taskId ?? 'task-1';
      return { taskId, status: taskStates.get(taskId) ?? 'working' };
    });

    const adapter = new McpAdapter({ runtime, channel: pair.a, serverId: SERVER_ID, requestTimeoutMs: 1_000 });
    const peerView_ = peerView(peer);

    return {
      adapter,
      capabilityId: CAPABILITY_ID,
      peer: peerView_,
      runtime,
      invocation: (overrides) =>
        buildInvocation({
          capabilityId: CAPABILITY_ID,
          protocol: 'mcp',
          runtime,
          input: { title: 'bug' },
          ...overrides,
        }),
      ctx: (overrides) => buildContext({ runtime, ...(overrides?.deadlineMs !== undefined ? { deadlineMs: overrides.deadlineMs } : {}) }),
      assertDiscovery: (capabilities) => {
        const tool = capabilities.find((capability) => capability.id === CAPABILITY_ID);
        expect(tool).toBeDefined();
        expect(tool?.kind).toBe('tool');
        // G8: annotations are untrusted, so risk is advisory only.
        expect(tool?.annotations?.['trust']).toBe('untrusted');
        expect(tool?.declaredRisk).toBe('write');
      },
      hang: () => {
        peer.drop('tools/call');
      },
      prepareCancel: async () => 'task-1',
      observeState: async (taskId) => {
        // Read the state back over the wire: the peer is the authority.
        const state = await adapter.client.getTask(taskId);
        return state.status;
      },
      dispose: async () => {
        await adapter.close();
        await peer.close();
        await pair.close();
      },
    };
  },
});

// ── MRTR round-trip through the kernel's approval broker ──────────────────

describe('mcp · MRTR', () => {
  it('asks for approval and retries with the verbatim requestState', async () => {
    const pair = createLoopbackPair({ labels: ['client', 'server'] });
    const peer = createFakePeer(pair.b);
    const runtime = createFakeRuntime();
    const seenStates: unknown[] = [];

    peer.on('server/discover', () => ({ supportedVersions: ['2026-07-28'], capabilities: {}, ttlMs: 1, cacheScope: 'private' }));
    peer.on('tools/list', () => ({ tools: [{ name: 'create_issue' }] }));
    peer.on('tools/call', (params) => {
      const record = params as { requestState?: unknown; inputResponses?: unknown };
      seenStates.push(record.requestState);
      if (record.requestState === undefined) {
        return {
          resultType: 'input_required',
          requestState: 'state-1',
          inputRequests: [{ id: 'q1', method: 'elicitation', message: 'need a title', schema: { enum: ['yes', 'no'] } }],
        };
      }
      if (record.requestState !== 'state-1') throw { code: -32021, message: 'tampered requestState' };
      return { resultType: 'complete', content: [{ type: 'text', text: 'done' }] };
    });

    const adapter = new McpAdapter({ runtime, channel: pair.a, serverId: SERVER_ID, requestTimeoutMs: 1_000 });
    const ctx = buildContext({
      runtime,
      approval: () => ({ approvalId: 'apr_1', state: 'allowed', optionId: 'option_0', decidedBy: 'test' }),
    });
    const invocation = buildInvocation({ capabilityId: CAPABILITY_ID, protocol: 'mcp', runtime, input: { title: 'x' } });
    const payload = await adapter.invoke(invocation, ctx);
    await adapter.close();
    await peer.close();

    expect(payload.outcome).toBe('succeeded');
    // First round has no state, the retry echoes it verbatim.
    expect(seenStates).toEqual([undefined, 'state-1']);
    expect(peer.calls('tools/call')).toBe(2);

    // The adapter reported the round-trip through the new `append` seam; the
    // log (not the adapter) owns seq/eventId/ts.
    const notice = ctx.appended.find((event) => (event.payload as { mcp?: string }).mcp === 'mrtr-round-trip');
    expect(notice).toBeDefined();
    expect(notice?.type).toBe('notice');
    expect(notice?.taskId).toBe(invocation.taskId);
    expect(notice?.protocol).toBe('mcp');
    expect(notice?.seq).toBe(1);
    expect(notice?.eventId).toBe('evt_test_1');
  });

  it('fails closed when the approval is denied', async () => {
    const pair = createLoopbackPair({ labels: ['client', 'server'] });
    const peer = createFakePeer(pair.b);
    const runtime = createFakeRuntime();

    peer.on('server/discover', () => ({ supportedVersions: ['2026-07-28'], capabilities: {}, ttlMs: 1, cacheScope: 'private' }));
    peer.on('tools/list', () => ({ tools: [{ name: 'create_issue' }] }));
    peer.on('tools/call', () => ({
      resultType: 'input_required',
      requestState: 'state-1',
      inputRequests: [{ id: 'q1', method: 'elicitation', message: 'need a title' }],
    }));

    const adapter = new McpAdapter({ runtime, channel: pair.a, serverId: SERVER_ID, requestTimeoutMs: 1_000 });
    const ctx = buildContext({ runtime, approval: () => ({ approvalId: 'apr_1', state: 'denied', decidedBy: 'test' }) });
    const invocation = buildInvocation({ capabilityId: CAPABILITY_ID, protocol: 'mcp', runtime, input: { title: 'x' } });
    const payload = await adapter.invoke(invocation, ctx);
    await adapter.close();
    await peer.close();

    expect(payload.outcome).toBe('failed');
    expect(payload.error?.kind).toBe('denied');
    // The peer was reached once (the elicitation) but never retried.
    expect(peer.calls('tools/call')).toBe(1);
  });
});
