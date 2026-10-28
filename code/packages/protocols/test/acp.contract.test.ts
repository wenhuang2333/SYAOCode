/**
 * ACP adapter contract (document/Agent-RPC/03 §7.2).
 *
 * The peer is an ACP v1 *editor*: it serves the client-owned reverse methods
 * (`fs/*`, `terminal/*`) and answers `session/request_permission`. The edge
 * under test is the agent side (`AcpServer` + `AcpAdapter`), which must never
 * fall back to a local filesystem when the client did not declare a capability
 * (G6).
 */

import { describe, expect, it } from 'vitest';
import {
  AcpAdapter,
  AcpApprovalChannel,
  ACP_LOSSY,
  acpOutcomeFromApproval,
  approvalFromAcpOutcome,
  createAcpEdge,
  type AcpPermissionRequest,
} from '../src/acp/index.js';
import { createLoopbackPair } from '../src/shared/transport.js';
import { JsonRpcConnection } from '../src/shared/jsonrpc.js';
import type { ReverseInvokeGateway } from '../src/shared/gateway.js';
import type { InvokeResultPayload } from '@syaocode/rpc';
import { createFakePeer } from './helpers/fake-peer.js';
import { createFakeRuntime } from './helpers/fake-runtime.js';
import { buildContext, buildInvocation, defineAdapterContract, peerView } from './helpers/contract.js';

const CLIENT_ID = 'editor1';
const SESSION_ID = 'acp-session-1';
const CAPABILITY_ID = `acp://${CLIENT_ID}/fs/read_text_file`;

const CLIENT_CAPABILITIES = {
  fs: { readTextFile: true, writeTextFile: true },
  terminal: { terminal: true },
};

/** A gateway that records what the kernel was asked to authorize. */
function recordingGateway(result: InvokeResultPayload = { outcome: 'succeeded', output: { content: 'file body' } }): ReverseInvokeGateway & {
  calls: { capabilityId: string; input: unknown }[];
} {
  const calls: { capabilityId: string; input: unknown }[] = [];
  return {
    calls,
    async invoke(request) {
      calls.push({ capabilityId: request.capabilityId, input: request.input });
      return result;
    },
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 500): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
    await new Promise<void>((resolve) => setTimeout(resolve, 2));
  }
}

describe('acp · permissions bridge', () => {
  it('maps an allow decision to `selected`', () => {
    const options = [
      { optionId: 'a1', name: 'Allow once', kind: 'allow_once' as const },
      { optionId: 'r1', name: 'Reject', kind: 'reject_once' as const },
    ];
    expect(acpOutcomeFromApproval({ approvalId: 'apr', state: 'allowed', optionId: 'a1' }, options)).toEqual({ outcome: 'selected', optionId: 'a1' });
  });

  it('expresses a rejection as `selected` + reject_* (there is no `denied`)', () => {
    const options = [
      { optionId: 'a1', name: 'Allow once', kind: 'allow_once' as const },
      { optionId: 'r1', name: 'Reject', kind: 'reject_once' as const },
    ];
    expect(acpOutcomeFromApproval({ approvalId: 'apr', state: 'denied' }, options)).toEqual({ outcome: 'selected', optionId: 'r1' });
  });

  it('falls back to `cancelled` when the client offered no reject option', () => {
    const options = [{ optionId: 'a1', name: 'Allow once', kind: 'allow_once' as const }];
    expect(acpOutcomeFromApproval({ approvalId: 'apr', state: 'denied' }, options)).toEqual({ outcome: 'cancelled' });
  });

  it('treats a dismissed request as cancelled (fail closed)', () => {
    const options = [{ optionId: 'a1', name: 'Allow once', kind: 'allow_once' as const }];
    const outcome = approvalFromAcpOutcome({ outcome: 'cancelled' }, options);
    expect(outcome.state).toBe('cancelled');
  });

  it('asks the editor over the wire and fails closed on a malformed answer', async () => {
    const pair = createLoopbackPair({ labels: ['agent', 'editor'] });
    const editor = createFakePeer(pair.b);
    editor.on('session/request_permission', () => ({ outcome: 'selected', optionId: 'nope' }));
    const connection = new JsonRpcConnection({ channel: pair.a });
    connection.start();

    const channel = new AcpApprovalChannel((method, params, opts) => connection.request(method, params, opts), SESSION_ID);
    const request: AcpPermissionRequest = {
      sessionId: SESSION_ID,
      toolCall: { toolCallId: 'tc1', title: 'write a file' },
      options: [{ optionId: 'a1', name: 'Allow once', kind: 'allow_once' }],
    };
    const outcome = await channel.decide(request);
    await connection.close();
    await editor.close();

    expect(outcome.state).toBe('cancelled');
  });
});

describe('acp · reverse fs is governed', () => {
  it('routes fs/read_text_file through the gateway and fences the path', async () => {
    const pair = createLoopbackPair({ labels: ['agent', 'editor'] });
    const editor = createFakePeer(pair.b);
    const runtime = createFakeRuntime();
    const gateway = recordingGateway();
    const edge = createAcpEdge({
      runtime,
      channel: pair.a,
      clientId: CLIENT_ID,
      gateway,
      agentInfo: { name: 'syaocode', version: '0.3.0-dev' },
    });
    await editor.send('initialize', { protocolVersion: 1, clientCapabilities: CLIENT_CAPABILITIES });
    const { sessionId } = (await editor.send('session/new', { cwd: '/repo' })) as { sessionId: string };

    const fs = edge.server.fsBridge(sessionId);
    const read = await fs.readTextFile('/repo/a.txt');
    expect(read.content).toBe('file body');
    expect(gateway.calls).toHaveLength(1);
    expect(gateway.calls[0]?.capabilityId).toBe(CAPABILITY_ID);

    await expect(fs.readTextFile('/etc/passwd')).rejects.toMatchObject({ kind: 'denied' });
    expect(gateway.calls).toHaveLength(1);

    await edge.server.close();
    await editor.close();
  });

  it('answers unsupported_capability and never touches a local fs (G6)', async () => {
    const pair = createLoopbackPair({ labels: ['agent', 'editor'] });
    const editor = createFakePeer(pair.b);
    const runtime = createFakeRuntime();
    const gateway = recordingGateway();
    const edge = createAcpEdge({
      runtime,
      channel: pair.a,
      clientId: CLIENT_ID,
      gateway,
      agentInfo: { name: 'syaocode', version: '0.3.0-dev' },
    });
    await editor.send('initialize', { protocolVersion: 1, clientCapabilities: {} });
    const { sessionId } = (await editor.send('session/new', { cwd: '/repo' })) as { sessionId: string };

    const fs = edge.server.fsBridge(sessionId);
    await expect(fs.readTextFile('/repo/a.txt')).rejects.toMatchObject({ kind: 'unsupported_capability' });
    await expect(fs.writeTextFile('/repo/a.txt', 'x')).rejects.toMatchObject({ kind: 'unsupported_capability' });

    expect(gateway.calls).toHaveLength(0);
    expect(runtime.fsReads).toHaveLength(0);
    expect(runtime.fsWrites).toHaveLength(0);
    expect(runtime.spawns).toHaveLength(0);

    await edge.server.close();
    await editor.close();
  });

  it('gates terminal/* on the client capability', async () => {
    const pair = createLoopbackPair({ labels: ['agent', 'editor'] });
    const editor = createFakePeer(pair.b);
    const runtime = createFakeRuntime();
    const gateway = recordingGateway({ outcome: 'succeeded', output: { terminalId: 'term-1' } });
    const edge = createAcpEdge({
      runtime,
      channel: pair.a,
      clientId: CLIENT_ID,
      gateway,
      agentInfo: { name: 'syaocode', version: '0.3.0-dev' },
    });
    await editor.send('initialize', { protocolVersion: 1, clientCapabilities: CLIENT_CAPABILITIES });
    const { sessionId } = (await editor.send('session/new', { cwd: '/repo' })) as { sessionId: string };

    const terminal = edge.server.terminalBridge(sessionId);
    const created = await terminal.create({ command: 'ls', args: ['-la'] });
    expect(created.terminalId).toBe('term-1');
    expect(gateway.calls[0]?.capabilityId).toBe(`acp://${CLIENT_ID}/terminal/create`);

    await edge.server.close();
    await editor.close();
  });
});

describe('acp · server handshake', () => {
  it('negotiates the version, records client capabilities and runs a turn', async () => {
    const pair = createLoopbackPair({ labels: ['agent', 'editor'] });
    const editor = createFakePeer(pair.b);
    const runtime = createFakeRuntime();
    editor.on('session/request_permission', () => ({ outcome: 'selected', optionId: 'allow' }));

    const edge = createAcpEdge({
      runtime,
      channel: pair.a,
      clientId: CLIENT_ID,
      gateway: recordingGateway(),
      agentInfo: { name: 'syaocode', version: '0.3.0-dev' },
      runTurn: async (input) => {
        input.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hi' } });
        const decision = await input.requestPermission({
          sessionId: input.sessionId,
          toolCall: { toolCallId: 'tc1', title: 'write a file' },
          options: [
            { optionId: 'allow', name: 'Allow once', kind: 'allow_once' },
            { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
          ],
        });
        return { stopReason: decision.outcome === 'selected' && decision.optionId === 'allow' ? 'end_turn' : 'refusal' };
      },
    });

    const init = (await editor.send('initialize', {
      protocolVersion: 1,
      clientCapabilities: CLIENT_CAPABILITIES,
      clientInfo: { name: 'editor', version: '1' },
    })) as { protocolVersion: number; agentCapabilities: { loadSession: boolean } };
    expect(init.protocolVersion).toBe(1);
    expect(init.agentCapabilities.loadSession).toBe(true);

    const { sessionId } = (await editor.send('session/new', { cwd: '/repo' })) as { sessionId: string };
    const result = (await editor.send('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'do it' }] })) as { stopReason: string };
    expect(result.stopReason).toBe('end_turn');
    expect(editor.notifications().some((note) => note.method === 'session/update')).toBe(true);
    expect(editor.calls('session/request_permission')).toBe(1);

    // Discovery reflects whatever `initialize` negotiated.
    const capabilities = await edge.adapter.discover(buildContext({ runtime }));
    expect(capabilities.map((capability) => capability.id)).toContain(CAPABILITY_ID);

    await edge.server.close();
    await editor.close();
  });

  it('rejects an unsupported MAJOR version', async () => {
    const pair = createLoopbackPair({ labels: ['agent', 'editor'] });
    const editor = createFakePeer(pair.b);
    const runtime = createFakeRuntime();
    const edge = createAcpEdge({
      runtime,
      channel: pair.a,
      clientId: CLIENT_ID,
      gateway: recordingGateway(),
      agentInfo: { name: 'syaocode', version: '0.3.0-dev' },
    });
    await expect(editor.send('initialize', { protocolVersion: 2 })).rejects.toMatchObject({ code: -32022 });
    await edge.server.close();
    await editor.close();
  });

  it('requires an absolute cwd for session/new', async () => {
    const pair = createLoopbackPair({ labels: ['agent', 'editor'] });
    const editor = createFakePeer(pair.b);
    const runtime = createFakeRuntime();
    const edge = createAcpEdge({
      runtime,
      channel: pair.a,
      clientId: CLIENT_ID,
      gateway: recordingGateway(),
      agentInfo: { name: 'syaocode', version: '0.3.0-dev' },
    });
    await expect(editor.send('session/new', { cwd: 'relative/path' })).rejects.toMatchObject({ code: -32602 });
    await edge.server.close();
    await editor.close();
  });
});

// ── the 8 universal properties ────────────────────────────────────────────

defineAdapterContract({
  protocol: 'acp',
  invocationMethod: 'fs/read_text_file',
  cancelSignal: '$/cancel_request',
  cancelledState: 'cancelled',
  setup: async () => {
    const pair = createLoopbackPair({ labels: ['agent', 'editor'] });
    const peer = createFakePeer(pair.b);
    const runtime = createFakeRuntime();
    peer.on('fs/read_text_file', () => ({ content: 'file body' }));
    peer.on('fs/write_text_file', () => ({}));
    peer.on('terminal/create', () => ({ terminalId: 'term-1' }));

    const connection = new JsonRpcConnection({ channel: pair.a });
    connection.start();
    const adapter = new AcpAdapter({
      runtime,
      connection,
      clientId: CLIENT_ID,
      sessionId: SESSION_ID,
      clientCapabilities: CLIENT_CAPABILITIES,
      requestTimeoutMs: 1_000,
    });

    let pendingCancel: Promise<unknown> | undefined;
    let cancelTaskId = '';

    return {
      adapter,
      capabilityId: CAPABILITY_ID,
      peer: peerView(peer),
      runtime,
      invocation: (overrides) =>
        buildInvocation({
          capabilityId: CAPABILITY_ID,
          protocol: 'acp',
          runtime,
          input: { path: '/repo/a.txt' },
          ...overrides,
        }),
      ctx: (overrides) => buildContext({ runtime, ...(overrides?.deadlineMs !== undefined ? { deadlineMs: overrides.deadlineMs } : {}) }),
      assertDiscovery: (capabilities) => {
        const read = capabilities.find((capability) => capability.id === CAPABILITY_ID);
        const write = capabilities.find((capability) => capability.id === `acp://${CLIENT_ID}/fs/write_text_file`);
        const terminal = capabilities.find((capability) => capability.id === `acp://${CLIENT_ID}/terminal/create`);
        expect(read?.kind).toBe('fs');
        expect(read?.declaredRisk).toBe('read');
        expect(write?.declaredRisk).toBe('write');
        expect(terminal?.declaredRisk).toBe('execute');
      },
      hang: () => {
        peer.drop('fs/read_text_file');
      },
      prepareCancel: async () => {
        cancelTaskId = 'task-acp-1';
        peer.drop('fs/read_text_file');
        pendingCancel = adapter
          .invoke(
            buildInvocation({ capabilityId: CAPABILITY_ID, protocol: 'acp', runtime, input: { path: '/repo/a.txt' }, taskId: cancelTaskId }),
            buildContext({ runtime, deadlineMs: 30_000 }),
          )
          .catch(() => undefined);
        await waitFor(() => peer.calls('fs/read_text_file') > 0);
        return cancelTaskId;
      },
      observeState: async () => {
        await pendingCancel;
        return peer.notifications().some((note) => note.method === '$/cancel_request') ? 'cancelled' : 'unknown';
      },
      dispose: async () => {
        await adapter.close();
        await connection.close();
        await peer.close();
        await pair.close();
      },
    };
  },
});

describe('acp · capability gate', () => {
  it('answers unsupported_capability, emits a notice, and never touches a local fs', async () => {
    const pair = createLoopbackPair({ labels: ['agent', 'editor'] });
    const peer = createFakePeer(pair.b);
    const runtime = createFakeRuntime();
    const connection = new JsonRpcConnection({ channel: pair.a });
    connection.start();
    const adapter = new AcpAdapter({ runtime, connection, clientId: CLIENT_ID, clientCapabilities: {} });
    const ctx = buildContext({ runtime });

    const payload = await adapter.invoke(
      buildInvocation({ capabilityId: CAPABILITY_ID, protocol: 'acp', runtime, input: { path: '/repo/a.txt' } }),
      ctx,
    );

    expect(payload.outcome).toBe('failed');
    expect(payload.error?.kind).toBe('unsupported_capability');
    expect(payload.lossy).toContain(ACP_LOSSY.clientCapabilityMissing);
    expect(peer.calls()).toBe(0);
    expect(runtime.fsReads).toHaveLength(0);
    expect(runtime.fsWrites).toHaveLength(0);
    expect(runtime.spawns).toHaveLength(0);

    const notice = ctx.appended.find((event) => event.type === 'capability.unavailable');
    expect(notice).toBeDefined();
    expect(notice?.payload).toMatchObject({ acp: 'client-capability-missing' });

    await adapter.close();
    await peer.close();
    await pair.close();
  });
});

describe('acp · degradation is surfaced', () => {
  it('reports the ACP-specific semantic gaps', async () => {
    const pair = createLoopbackPair({ labels: ['agent', 'editor'] });
    const runtime = createFakeRuntime();
    const connection = new JsonRpcConnection({ channel: pair.a });
    const adapter = new AcpAdapter({
      runtime,
      connection,
      clientId: CLIENT_ID,
      clientCapabilities: {},
    });
    const lossy = adapter.capabilities().lossy;
    await adapter.close();
    await pair.close();

    expect(lossy).toContain(ACP_LOSSY.noTaskState);
    expect(lossy).toContain(ACP_LOSSY.clientOwnedFs);
    expect(lossy).toContain(ACP_LOSSY.noDeniedOutcome);
  });
});
