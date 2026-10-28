/**
 * ACP server wire conformance (P-H5/H7).
 *
 * Drives the REAL `AcpServer` over a loopback channel:
 *   - `initialize` negotiates the integer MAJOR version and records the client's
 *     capabilities;
 *   - `session/new` / `session/prompt` / `session/cancel`;
 *   - `session/cancel` MUST answer `stopReason: 'cancelled'` (never 'refusal'),
 *     and every pending permission request must be answered 'cancelled';
 *   - `session/request_permission`: approve → `selected` + the allow option,
 *     reject → `selected` + a `reject_*` option (ACP has no `denied` outcome);
 *   - reverse `fs/*` goes through the governance gateway, and a missing client
 *     capability answers `unsupported_capability` with ZERO local fs calls;
 *   - the reverse path fence uses realpaths, not lexical prefixes, and the
 *     session must belong to this connection.
 */

import { describe, expect, it } from 'vitest';
import { AcpAdapter } from '../src/acp/index.js';
import { AcpServer } from '../src/acp/server.js';
import { ACP_LOSSY, ACP_PROTOCOL_VERSION } from '../src/acp/index.js';
import type { AcpPermissionOutcome, AcpPermissionRequest } from '../src/acp/permissions.js';
import type { InvokeResultPayload } from '@syaocode/rpc';
import { createLoopbackPair } from '../src/shared/transport.js';
import { JsonRpcConnection } from '../src/shared/jsonrpc.js';
import { createFakeRuntime } from './helpers/fake-runtime.js';
import { buildContext } from './helpers/contract.js';

const CLIENT_ID = 'editor1';
const CLIENT_CAPABILITIES = { fs: { readTextFile: true, writeTextFile: true }, terminal: { terminal: true } };

interface Gateway {
  invoke(request: { capabilityId: string; input: unknown }): Promise<InvokeResultPayload>;
  calls: { capabilityId: string; input: unknown }[];
}

function gateway(result: InvokeResultPayload = { outcome: 'succeeded', output: { content: 'editor body' } }): Gateway {
  const calls: { capabilityId: string; input: unknown }[] = [];
  return {
    calls,
    async invoke(request) {
      calls.push({ capabilityId: request.capabilityId, input: request.input });
      return result;
    },
  };
}

interface EditorPeer {
  /** Answer for the next `session/request_permission`. */
  permissionAnswer: AcpPermissionOutcome;
  /** Requests the agent sent to the editor. */
  received: { method: string; params: unknown }[];
  fsReads: number;
  /** When true, `session/request_permission` stays unanswered until released. */
  holdPermission: boolean;
  releasePermission(): void;
}

interface Rig {
  server: AcpServer;
  client: JsonRpcConnection;
  gateway: Gateway;
  runtime: ReturnType<typeof createFakeRuntime>;
  editor: EditorPeer;
  dispose(): Promise<void>;
}

type TurnRunner = NonNullable<import('../src/acp/server.js').AcpServerOptions['runTurn']>;

async function rig(options?: {
  runTurn?: TurnRunner;
  clientCapabilities?: Record<string, unknown>;
}): Promise<Rig> {
  const pair = createLoopbackPair({ labels: ['editor', 'agent'] });
  const runtime = createFakeRuntime();
  const gw = gateway();
  const server = new AcpServer({
    runtime,
    channel: pair.b,
    clientId: CLIENT_ID,
    gateway: gw,
    agentInfo: { name: 'syaocode', version: '0.3.0-dev' },
    ...(options?.runTurn !== undefined ? { runTurn: options.runTurn } : {}),
  });
  // The editor side: it OWNS fs/terminal and answers permission requests.
  let release: (() => void) | undefined;
  const editor: EditorPeer = {
    permissionAnswer: { outcome: 'selected', optionId: 'allow' },
    received: [],
    fsReads: 0,
    holdPermission: false,
    releasePermission: () => {
      const fn = release;
      release = undefined;
      fn?.();
    },
  };
  const client = new JsonRpcConnection({
    channel: pair.a,
    requestTimeoutMs: 2_000,
    handlers: {
      request: (method, params) => {
        editor.received.push({ method, params });
        switch (method) {
          case 'session/request_permission':
            if (editor.holdPermission) {
              return new Promise<AcpPermissionOutcome>((resolve) => {
                release = () => resolve(editor.permissionAnswer);
              });
            }
            return editor.permissionAnswer;
          case 'fs/read_text_file':
            editor.fsReads += 1;
            return { content: 'editor body' };
          case 'fs/write_text_file':
            return {};
          case 'terminal/create':
            return { terminalId: 'term-1' };
          default:
            return {};
        }
      },
    },
  });
  client.start();
  return {
    server,
    client,
    gateway: gw,
    runtime,
    editor,
    dispose: async () => {
      await client.close();
      await server.close();
      await pair.close();
    },
  };
}

async function initialize(client: JsonRpcConnection, capabilities: Record<string, unknown> = CLIENT_CAPABILITIES): Promise<Record<string, unknown>> {
  return (await client.request('initialize', {
    protocolVersion: ACP_PROTOCOL_VERSION,
    clientCapabilities: capabilities,
    clientInfo: { name: 'editor', version: '1' },
  })) as Record<string, unknown>;
}

/** A minimal authorized reverse invocation for the ACP edge. */
function authorizedInvocation(capabilityId: string, input: Record<string, unknown>): import('@syaocode/rpc').AuthorizedInvocation {
  return {
    invocationId: 'inv_1',
    taskId: 'task_1',
    sessionId: 'ses_1',
    tenantId: 'ten_1',
    capability: {
      id: capabilityId,
      kind: capabilityId.includes('/fs/') ? 'fs' : 'terminal',
      protocol: 'acp',
      displayName: capabilityId,
      risk: 'read',
      sideEffect: 'none',
      dataClass: 'internal',
      visibility: 'full',
      reversible: true,
      provider: { id: CLIENT_ID, protocol: 'acp', endpoint: `acp://${CLIENT_ID}`, trust: 'verified', health: 'healthy', ttlMs: 1_000, lastSeenAt: 'now' },
    },
    endpoint: `acp://${CLIENT_ID}`,
    input,
    inputHash: 'h',
    principal: { id: 'user:test', kind: 'user', tenantId: 'ten_1', scopes: [], trustTier: 'first_party' },
    protocol: 'acp',
    direction: 'reverse',
    obligations: [],
    visibility: 'full',
  };
}

describe('acp server · initialize and sessions', () => {
  it('negotiates the integer MAJOR version and declares its capabilities', async () => {
    const r = await rig();
    const result = await initialize(r.client);
    expect(result['protocolVersion']).toBe(ACP_PROTOCOL_VERSION);
    expect(result['agentInfo']).toMatchObject({ name: 'syaocode' });
    expect((result['agentCapabilities'] as { loadSession: boolean }).loadSession).toBe(true);
    await r.dispose();
  });

  it('rejects an unsupported MAJOR version with -32022', async () => {
    const r = await rig();
    await expect(r.client.request('initialize', { protocolVersion: 2 })).rejects.toMatchObject({ code: -32022 });
    await r.dispose();
  });

  it('records the client capabilities it negotiated', async () => {
    const r = await rig();
    await initialize(r.client);
    expect(r.server.clientCapabilities.fs?.readTextFile).toBe(true);
    await r.dispose();
  });

  it('session/new requires an absolute cwd (-32602 otherwise)', async () => {
    const r = await rig();
    await initialize(r.client);
    await expect(r.client.request('session/new', { cwd: 'relative' })).rejects.toMatchObject({ code: -32602 });
    const created = (await r.client.request('session/new', { cwd: '/repo' })) as { sessionId: string };
    expect(created.sessionId).toBeTruthy();
    await r.dispose();
  });

  it('session/prompt returns the agent stopReason', async () => {
    const r = await rig({
      runTurn: (async (input: { update: (u: unknown) => void }) => {
        input.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'done' } });
        return { stopReason: 'end_turn' };
      }) as never,
    });
    await initialize(r.client);
    const { sessionId } = (await r.client.request('session/new', { cwd: '/repo' })) as { sessionId: string };
    const result = (await r.client.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'go' }] })) as { stopReason: string };
    expect(result.stopReason).toBe('end_turn');
    await r.dispose();
  });
});

describe('acp server · cancellation is not a refusal (P-H5)', () => {
  it('session/cancel answers stopReason "cancelled", never "refusal"', async () => {
    const r = await rig({
      runTurn: (async (input: { signal?: AbortSignal }) => {
        // Wait until the session is cancelled.
        await new Promise<void>((resolve) => {
          input.signal?.addEventListener('abort', () => resolve(), { once: true });
        });
        throw { kind: 'cancelled', message: 'the session was cancelled' };
      }) as never,
    });
    await initialize(r.client);
    const { sessionId } = (await r.client.request('session/new', { cwd: '/repo' })) as { sessionId: string };
    const pending = r.client.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'go' }] });
    // Give the turn a moment to register, then cancel it.
    await new Promise((resolve) => setTimeout(resolve, 10));
    await r.client.request('session/cancel', { sessionId });

    const result = (await pending) as { stopReason: string };
    expect(result.stopReason).toBe('cancelled');
    expect(result.stopReason).not.toBe('refusal');
    expect(r.server.wasCancelled(sessionId)).toBe(true);
    await r.dispose();
  });

  it('a genuine failure still answers "refusal"', async () => {
    const r = await rig({
      runTurn: (async () => {
        throw new Error('the agent exploded');
      }) as never,
    });
    await initialize(r.client);
    const { sessionId } = (await r.client.request('session/new', { cwd: '/repo' })) as { sessionId: string };
    const result = (await r.client.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'go' }] })) as { stopReason: string };
    expect(result.stopReason).toBe('refusal');
    expect(r.server.wasCancelled(sessionId)).toBe(false);
    await r.dispose();
  });

  it('answers a pending permission request with "cancelled" when the session is cancelled', async () => {
    let permissionAnswered: AcpPermissionOutcome | undefined;
    const r = await rig({
      runTurn: (async (input: { requestPermission: (req: AcpPermissionRequest) => Promise<AcpPermissionOutcome> }) => {
        permissionAnswered = await input.requestPermission({
          sessionId: 'acp-session-1',
          toolCall: { toolCallId: 'tc1', title: 'write a file' },
          options: [
            { optionId: 'allow', name: 'Allow once', kind: 'allow_once' },
            { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
          ],
        });
        return { stopReason: permissionAnswered.outcome === 'selected' ? 'end_turn' : 'refusal' };
      }) as never,
    });
    r.editor.holdPermission = true;
    await initialize(r.client);
    const { sessionId } = (await r.client.request('session/new', { cwd: '/repo' })) as { sessionId: string };
    const pending = r.client.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'go' }] });
    // Wait until the agent has actually asked the editor.
    for (let i = 0; i < 100 && !r.editor.received.some((entry) => entry.method === 'session/request_permission'); i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    await r.client.request('session/cancel', { sessionId });

    const result = (await pending) as { stopReason: string };
    expect(permissionAnswered).toEqual({ outcome: 'cancelled' });
    expect(result.stopReason).toBe('cancelled');
    await r.dispose();
  });
});

describe('acp server · session/request_permission', () => {
  it('an approval is answered with `selected` + the allow option', async () => {
    const r = await rig({
      runTurn: (async (input: { requestPermission: (req: AcpPermissionRequest) => Promise<AcpPermissionOutcome> }) => {
        const outcome = await input.requestPermission({
          sessionId: 'acp-session-1',
          toolCall: { toolCallId: 'tc1', title: 'write a file' },
          options: [
            { optionId: 'allow', name: 'Allow once', kind: 'allow_once' },
            { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
          ],
        });
        return { stopReason: outcome.outcome === 'selected' && outcome.optionId === 'allow' ? 'end_turn' : 'refusal' };
      }) as never,
    });
    // The editor approves.
    r.editor.permissionAnswer = { outcome: 'selected', optionId: 'allow' };
    await initialize(r.client);
    const { sessionId } = (await r.client.request('session/new', { cwd: '/repo' })) as { sessionId: string };

    const result = (await r.client.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'go' }] })) as { stopReason: string };
    expect(result.stopReason).toBe('end_turn');
    // The agent asked the editor, over the wire.
    expect(r.editor.received.some((entry) => entry.method === 'session/request_permission')).toBe(true);
    await r.dispose();
  });

  it('a rejection is answered with `selected` + a reject_* option (never a "denied" outcome)', async () => {
    let seen: AcpPermissionOutcome | undefined;
    const r = await rig({
      runTurn: (async (input: { requestPermission: (req: AcpPermissionRequest) => Promise<AcpPermissionOutcome> }) => {
        seen = await input.requestPermission({
          sessionId: 'acp-session-1',
          toolCall: { toolCallId: 'tc1', title: 'write a file' },
          options: [
            { optionId: 'allow', name: 'Allow once', kind: 'allow_once' },
            { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
          ],
        });
        return { stopReason: seen.outcome === 'selected' && seen.optionId === 'reject' ? 'refusal' : 'end_turn' };
      }) as never,
    });
    // The editor rejects: `selected` + the reject_* option, never a `denied`.
    r.editor.permissionAnswer = { outcome: 'selected', optionId: 'reject' };
    await initialize(r.client);
    const { sessionId } = (await r.client.request('session/new', { cwd: '/repo' })) as { sessionId: string };

    const result = (await r.client.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'go' }] })) as { stopReason: string };
    expect(seen).toEqual({ outcome: 'selected', optionId: 'reject' });
    expect(result.stopReason).toBe('refusal');
    await r.dispose();
  });

  it('a dismissed request is answered `cancelled` (fail closed)', async () => {
    let seen: AcpPermissionOutcome | undefined;
    const r = await rig({
      runTurn: (async (input: { requestPermission: (req: AcpPermissionRequest) => Promise<AcpPermissionOutcome> }) => {
        seen = await input.requestPermission({
          sessionId: 'acp-session-1',
          toolCall: { toolCallId: 'tc1', title: 'write a file' },
          options: [{ optionId: 'allow', name: 'Allow once', kind: 'allow_once' }],
        });
        return { stopReason: 'refusal' };
      }) as never,
    });
    r.editor.permissionAnswer = { outcome: 'cancelled' };
    await initialize(r.client);
    const { sessionId } = (await r.client.request('session/new', { cwd: '/repo' })) as { sessionId: string };
    await r.client.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'go' }] });
    expect(seen).toEqual({ outcome: 'cancelled' });
    await r.dispose();
  });
});

describe('acp server · reverse fs is governed (P-H7)', () => {
  it('routes a reverse fs read through the gateway', async () => {
    const r = await rig();
    await initialize(r.client);
    const { sessionId } = (await r.client.request('session/new', { cwd: '/repo' })) as { sessionId: string };

    const adapter = new AcpAdapter({
      runtime: r.runtime,
      connection: r.server.connection,
      clientId: CLIENT_ID,
      sessionId,
      ownedSessionIds: [sessionId],
      clientCapabilities: () => r.server.clientCapabilities,
    });
    const payload = await adapter.invoke(
      authorizedInvocation(`acp://${CLIENT_ID}/fs/read_text_file`, { sessionId, path: '/repo/a.txt' }),
      buildContext({ runtime: r.runtime }),
    );

    // The adapter is reached only after the dispatcher authorized it, so it
    // performs the wire call; the *bridge* is the path that consults the
    // gateway first (asserted below).
    expect(payload.outcome).toBe('succeeded');
    expect(r.editor.fsReads).toBe(1);

    // The bridge — the path an agent turn uses — goes through the gateway.
    const bridgePayload = await r.server.fsBridge(sessionId).readTextFile('/repo/a.txt');
    expect(bridgePayload.content).toBe('editor body');
    expect(r.gateway.calls).toHaveLength(1);
    expect(r.gateway.calls[0]?.capabilityId).toBe(`acp://${CLIENT_ID}/fs/read_text_file`);
    expect(r.editor.fsReads).toBe(1); // the gateway answered; the wire was not touched again

    await adapter.close();
    await r.dispose();
  });

  it('a missing client capability answers unsupported_capability with ZERO local fs calls', async () => {
    const r = await rig();
    await initialize(r.client, {});
    const { sessionId } = (await r.client.request('session/new', { cwd: '/repo' })) as { sessionId: string };

    const adapter = new AcpAdapter({
      runtime: r.runtime,
      connection: r.server.connection,
      clientId: CLIENT_ID,
      sessionId,
      ownedSessionIds: [sessionId],
      clientCapabilities: () => r.server.clientCapabilities,
    });
    const payload = await adapter.invoke(
      authorizedInvocation(`acp://${CLIENT_ID}/fs/read_text_file`, { sessionId, path: '/repo/a.txt' }),
      buildContext({ runtime: r.runtime }),
    );

    expect(payload.outcome).toBe('failed');
    expect(payload.error?.kind).toBe('unsupported_capability');
    expect(payload.lossy).toContain(ACP_LOSSY.clientCapabilityMissing);
    expect(r.gateway.calls).toHaveLength(0);
    // Never a local fs fallback.
    expect(r.runtime.fsReads).toHaveLength(0);
    expect(r.runtime.fsWrites).toHaveLength(0);
    expect(r.runtime.spawns).toHaveLength(0);

    await adapter.close();
    await r.dispose();
  });

  it('rejects a reverse call for a session this connection does not own', async () => {
    const r = await rig();
    await initialize(r.client);
    const { sessionId } = (await r.client.request('session/new', { cwd: '/repo' })) as { sessionId: string };

    const adapter = new AcpAdapter({
      runtime: r.runtime,
      connection: r.server.connection,
      clientId: CLIENT_ID,
      sessionId,
      ownedSessionIds: [sessionId],
      clientCapabilities: () => r.server.clientCapabilities,
    });
    const payload = await adapter.invoke(
      authorizedInvocation(`acp://${CLIENT_ID}/fs/read_text_file`, { sessionId: 'someone-elses-session', path: '/repo/a.txt' }),
      buildContext({ runtime: r.runtime }),
    );

    expect(payload.outcome).toBe('failed');
    expect(payload.error?.kind).toBe('denied');
    expect(payload.lossy).toContain(ACP_LOSSY.sessionNotOwned);
    expect(r.gateway.calls).toHaveLength(0);

    await adapter.close();
    await r.dispose();
  });

  it('fences a path that escapes the session roots, comparing realpaths', async () => {
    const pair = createLoopbackPair({ labels: ['editor', 'agent'] });
    const runtime = createFakeRuntime({ seed: { '/repo/a.txt': 'inside', '/repo-evil/secret.txt': 'outside' } });
    const gw = gateway();
    const server = new AcpServer({ runtime, channel: pair.b, clientId: CLIENT_ID, gateway: gw, agentInfo: { name: 'syaocode', version: '1' } });
    const client = new JsonRpcConnection({
      channel: pair.a,
      requestTimeoutMs: 1_000,
      handlers: { request: () => ({ content: 'editor body' }) },
    });
    client.start();
    await client.request('initialize', { protocolVersion: ACP_PROTOCOL_VERSION, clientCapabilities: CLIENT_CAPABILITIES });
    const { sessionId } = (await client.request('session/new', { cwd: '/repo' })) as { sessionId: string };

    const adapter = new AcpAdapter({
      runtime,
      connection: server.connection,
      clientId: CLIENT_ID,
      sessionId,
      ownedSessionIds: [sessionId],
      workspaceRoots: ['/repo'],
      clientCapabilities: () => server.clientCapabilities,
    });
    const invoke = (path: string) =>
      adapter.invoke(authorizedInvocation(`acp://${CLIENT_ID}/fs/read_text_file`, { sessionId, path }), buildContext({ runtime }));

    // Inside the root: allowed.
    expect((await invoke('/repo/a.txt')).outcome).toBe('succeeded');

    // A lexical prefix test would wrongly accept `/repo-evil`; the realpath
    // fence must not.
    const escaped = await invoke('/repo-evil/secret.txt');
    expect(escaped.outcome).toBe('failed');
    expect(escaped.error?.kind).toBe('denied');
    expect(escaped.lossy).toContain(ACP_LOSSY.fenceDenied);

    await adapter.close();
    await client.close();
    await server.close();
    await pair.close();
  });
});
