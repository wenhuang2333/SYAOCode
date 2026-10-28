/**
 * A2A adapter contract (document/Agent-RPC/03 §7.2).
 *
 * The peer is an A2A 1.0.0 agent: `GetExtendedAgentCard` for discovery and
 * `SendMessage` / `GetTask` / `CancelTask` for the task lifecycle. States use
 * the ProtoJSON enum names from the frozen `TASK_TO_A2A` table.
 */

import { describe, expect, it } from 'vitest';
import { A2aAdapter, buildAgentCard } from '../src/a2a/index.js';
import { createLoopbackPair } from '../src/shared/transport.js';
import { createFakePeer } from './helpers/fake-peer.js';
import { createFakeRuntime } from './helpers/fake-runtime.js';
import { buildContext, buildInvocation, defineAdapterContract, peerView } from './helpers/contract.js';
import type { A2aTask } from '../src/a2a/index.js';

const AGENT_ID = 'remote-agent';
const CAPABILITY_ID = `a2a://${AGENT_ID}/skill/echo`;

const CARD = buildAgentCard({
  name: 'Remote Agent',
  description: 'Echoes messages',
  version: '1.0.0',
  url: 'http://127.0.0.1:8931',
  skills: [{ id: 'echo', name: 'Echo', description: 'Echoes the input', tags: ['utility'] }],
});

function task(id: string, state: string, contextId = 'ctx-1'): A2aTask {
  return { id, contextId, kind: 'task', status: { state, timestamp: new Date(0).toISOString() }, artifacts: [] };
}

describe('a2a · wire details', () => {
  it('sends the tenant and the A2A-Version pin on every request', async () => {
    const pair = createLoopbackPair({ labels: ['client', 'agent'] });
    const peer = createFakePeer(pair.b);
    const runtime = createFakeRuntime();
    const metadatas: unknown[] = [];

    peer.on('GetExtendedAgentCard', (params) => {
      metadatas.push((params as { metadata?: unknown }).metadata);
      return CARD;
    });
    peer.on('SendMessage', (params) => {
      metadatas.push((params as { metadata?: unknown }).metadata);
      return task('t1', 'TASK_STATE_COMPLETED');
    });

    const adapter = new A2aAdapter({ runtime, channel: pair.a, agentId: AGENT_ID, tenantId: 'ten-1' });
    await adapter.discover(buildContext({ runtime }));
    const payload = await adapter.invoke(
      buildInvocation({ capabilityId: CAPABILITY_ID, protocol: 'a2a', runtime, input: 'hello' }),
      buildContext({ runtime }),
    );
    await adapter.close();
    await peer.close();

    expect(payload.outcome).toBe('succeeded');
    for (const metadata of metadatas) {
      expect(metadata).toMatchObject({ tenantId: 'ten-1', 'A2A-Version': '1.0' });
    }
  });

  it('surfaces an opaque-visibility loss for every remote task (G3)', async () => {
    const pair = createLoopbackPair({ labels: ['client', 'agent'] });
    const peer = createFakePeer(pair.b);
    const runtime = createFakeRuntime();
    peer.on('GetExtendedAgentCard', () => CARD);
    peer.on('SendMessage', () => task('t1', 'TASK_STATE_COMPLETED'));

    const adapter = new A2aAdapter({ runtime, channel: pair.a, agentId: AGENT_ID, tenantId: 'ten-1' });
    const payload = await adapter.invoke(
      buildInvocation({ capabilityId: CAPABILITY_ID, protocol: 'a2a', runtime, input: 'hello' }),
      buildContext({ runtime }),
    );
    await adapter.close();
    await peer.close();

    expect(payload.lossy).toContain('a2a-remote-task-opaque');
    expect(adapter.capabilities().lossy).toContain('a2a-no-approval-options');
  });

  it('maps a rejected remote task to a denied error', async () => {
    const pair = createLoopbackPair({ labels: ['client', 'agent'] });
    const peer = createFakePeer(pair.b);
    const runtime = createFakeRuntime();
    peer.on('GetExtendedAgentCard', () => CARD);
    peer.on('SendMessage', () => task('t1', 'TASK_STATE_REJECTED'));

    const adapter = new A2aAdapter({ runtime, channel: pair.a, agentId: AGENT_ID, tenantId: 'ten-1' });
    const payload = await adapter.invoke(
      buildInvocation({ capabilityId: CAPABILITY_ID, protocol: 'a2a', runtime, input: 'hello' }),
      buildContext({ runtime }),
    );
    await adapter.close();
    await peer.close();

    expect(payload.outcome).toBe('failed');
    expect(payload.error?.kind).toBe('denied');
  });

  it('rejects a malformed AgentCard as invalid_request', async () => {
    const pair = createLoopbackPair({ labels: ['client', 'agent'] });
    const peer = createFakePeer(pair.b);
    const runtime = createFakeRuntime();
    peer.on('GetExtendedAgentCard', () => ({ name: 'broken' }));

    const adapter = new A2aAdapter({ runtime, channel: pair.a, agentId: AGENT_ID, tenantId: 'ten-1' });
    await expect(adapter.discover(buildContext({ runtime }))).rejects.toMatchObject({ kind: 'invalid_request' });
    await adapter.close();
    await peer.close();
  });
});

// ── the 8 universal properties ────────────────────────────────────────────

defineAdapterContract({
  protocol: 'a2a',
  invocationMethod: 'SendMessage',
  cancelSignal: 'CancelTask',
  cancelledState: 'TASK_STATE_CANCELED',
  setup: async () => {
    const pair = createLoopbackPair({ labels: ['client', 'agent'] });
    const peer = createFakePeer(pair.b);
    const runtime = createFakeRuntime();
    const states = new Map<string, string>([['a2a-task-1', 'TASK_STATE_WORKING']]);

    peer.on('GetExtendedAgentCard', () => CARD);
    peer.on('SendMessage', (params) => {
      const messageId = (params as { message?: { messageId?: string } }).message?.messageId ?? 'msg-1';
      const id = `a2a-task-${messageId}`;
      states.set(id, 'TASK_STATE_COMPLETED');
      return task(id, 'TASK_STATE_COMPLETED');
    });
    peer.on('GetTask', (params) => {
      const id = (params as { id?: string }).id ?? '';
      return task(id, states.get(id) ?? 'TASK_STATE_WORKING');
    });
    peer.on('CancelTask', (params) => {
      const id = (params as { id?: string }).id ?? '';
      states.set(id, 'TASK_STATE_CANCELED');
      return task(id, 'TASK_STATE_CANCELED');
    });

    const adapter = new A2aAdapter({
      runtime,
      channel: pair.a,
      agentId: AGENT_ID,
      tenantId: 'ten-1',
      requestTimeoutMs: 1_000,
      maxPolls: 2,
      pollIntervalMs: 1,
    });

    return {
      adapter,
      capabilityId: CAPABILITY_ID,
      peer: peerView(peer),
      runtime,
      invocation: (overrides) =>
        buildInvocation({
          capabilityId: CAPABILITY_ID,
          protocol: 'a2a',
          runtime,
          input: 'echo this',
          ...overrides,
        }),
      ctx: (overrides) => buildContext({ runtime, ...(overrides?.deadlineMs !== undefined ? { deadlineMs: overrides.deadlineMs } : {}) }),
      assertDiscovery: (capabilities) => {
        const skill = capabilities.find((capability) => capability.id === CAPABILITY_ID);
        expect(skill).toBeDefined();
        expect(skill?.kind).toBe('agent_skill');
        // G7: the AgentCard is self-description; the registry owns trust.
        expect(skill?.annotations?.['trust']).toBe('untrusted');
        expect(skill?.declaredRisk).toBe('delegate');
      },
      hang: () => {
        peer.drop('SendMessage');
      },
      prepareCancel: async () => {
        // A task that exists and is still working.
        const id = 'a2a-task-1';
        states.set(id, 'TASK_STATE_WORKING');
        return id;
      },
      observeState: async (taskId) => {
        // Read the state back over the wire, through the adapter's own client.
        const current = await adapter.client.getTask(taskId);
        return current.status.state;
      },
      dispose: async () => {
        await adapter.close();
        await peer.close();
        await pair.close();
      },
    };
  },
});
