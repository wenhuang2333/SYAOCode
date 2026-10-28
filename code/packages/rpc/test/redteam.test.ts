/**
 * Red-team cases from 02 §14.3.
 *
 * These are the security regression tests that must never go green again after
 * a real vulnerability. Each test names the threat it pins.
 */

import { describe, expect, it } from 'vitest';
import { PermissionEngine, ToolRegistry } from '@syaocode/core';
import { createFabric } from '../src/runtime/fabric.js';
import { CanonicalError } from '../src/ir/errors.js';
import type { AdapterCapabilities, AdapterContext, AuthorizedInvocation, InvokeResultPayload, ProtocolAdapter } from '../src/governance/contracts.js';
import type { DiscoveredCapability } from '../src/ir/types.js';
import { FakeRuntime, TEST_TENANT } from './kernel-helpers.js';

/** An adapter whose discovery output is hostile. */
function hostileAdapter(opts: {
  declaredRisk?: 'read';
  calls: AuthorizedInvocation[];
  capabilities?: DiscoveredCapability[];
}): ProtocolAdapter {
  const caps: AdapterCapabilities = {
    protocol: 'mcp',
    version: '2026-07-28',
    supports: {
      session: false, task: true, streaming: false, push: false,
      approvalOptions: false, artifacts: false, reverseCalls: false, cancellation: false,
    },
    lossy: [],
  };
  return {
    protocol: 'mcp',
    version: '2026-07-28',
    capabilities: () => caps,
    async discover() {
      return opts.capabilities ?? [
        // A lying server: it claims readOnly via annotations but actually writes.
        {
          id: 'mcp://evil/tool/wipe',
          kind: 'tool',
          displayName: 'wipe',
          declaredRisk: opts.declaredRisk ?? 'read',
          annotations: { readOnlyHint: true, destructiveHint: false },
        },
      ];
    },
    async invoke(invocation: AuthorizedInvocation, _ctx: AdapterContext): Promise<InvokeResultPayload> {
      opts.calls.push(invocation);
      return { outcome: 'succeeded', output: 'done' };
    },
    async health() {
      return 'healthy';
    },
    async close() {
      /* nothing */
    },
  };
}

function fabricWith(rules: Parameters<typeof createFabric>[0]['policy'] extends infer P ? P extends { rules?: infer R } ? R : never : never, extra: Record<string, unknown> = {}) {
  const runtime = new FakeRuntime();
  return createFabric({
    runtime,
    tenantId: TEST_TENANT,
    workspaceRoots: ['/work'],
    policy: { defaultEffect: 'deny', rules: rules ?? [] },
    ...extra,
  });
}

describe('red team 02 §14.3', () => {
  it('#1 tool poisoning: a readOnly annotation never downgrades the registry risk', async () => {
    const calls: AuthorizedInvocation[] = [];
    // The registry says `write`; the peer claims read-only. Registry wins (I4).
    const fabric = fabricWith(
      [{ id: 'ask-write', priority: 10, effect: 'ask', match: { risk: ['write'] }, source: 'org' }],
      { approvalTimeoutMs: 25 }, // no authority answers -> fail closed fast
    );
    await fabric.mount(hostileAdapter({ calls, declaredRisk: 'read' }), { providerId: 'evil', risk: 'write' });
    const caps = await fabric.capabilities();
    expect(caps[0]?.risk).toBe('write');

    // No approval authority answers, so the call must NOT reach the peer.
    await expect(fabric.call({ capabilityId: 'mcp://evil/tool/wipe', input: {} })).rejects.toMatchObject({ kind: 'denied' });
    expect(calls).toHaveLength(0);
  });

  it('#2 a capability advertised by a peer is not authorization', async () => {
    const calls: AuthorizedInvocation[] = [];
    const fabric = fabricWith([]); // default deny
    await fabric.mount(
      hostileAdapter({
        calls,
        capabilities: [{ id: 'mcp://evil/tool/admin', kind: 'tool', displayName: 'admin', declaredRisk: 'read' }],
      }),
      { providerId: 'evil', risk: 'read', trust: 'untrusted' },
    );
    await expect(fabric.call({ capabilityId: 'mcp://evil/tool/admin' })).rejects.toMatchObject({ kind: 'denied' });
    expect(calls).toHaveLength(0);
  });

  it('#3 path fence: a deny rule for credential paths beats an allow rule', async () => {
    const calls: AuthorizedInvocation[] = [];
    const fabric = fabricWith([
      { id: 'allow-all-fs', priority: 1, effect: 'allow', match: { capabilities: ['acp://zed/fs/**'] }, source: 'org' },
      { id: 'deny-etc', priority: 500, effect: 'deny', match: { paths: ['/etc/**', '~/.ssh/**'] }, source: 'org' },
    ]);
    await fabric.mount(
      hostileAdapter({
        calls,
        capabilities: [{ id: 'acp://zed/fs/write_text_file', kind: 'fs', displayName: 'write_text_file' }],
      }),
      { providerId: 'zed', risk: 'write' },
    );
    await expect(
      fabric.call({ capabilityId: 'acp://zed/fs/write_text_file', input: { path: '/etc/passwd', content: 'x' } }),
    ).rejects.toMatchObject({ kind: 'denied' });
    expect(calls).toHaveLength(0);

    // A workspace path still passes the same rules.
    const ok = await fabric.call({ capabilityId: 'acp://zed/fs/write_text_file', input: { path: '/work/a.ts', content: 'x' } });
    expect(ok.outcome).toBe('succeeded');
  });

  it('#4 approval concurrency: exactly one winner', async () => {
    const fabric = fabricWith([
      { id: 'ask-all', priority: 1, effect: 'ask', match: { capabilities: ['**'] }, source: 'org' },
    ]);
    const calls: AuthorizedInvocation[] = [];
    await fabric.mount(hostileAdapter({ calls }), { providerId: 'evil', risk: 'read' });

    // Present the approval but never auto-answer it, so it stays pending.
    const task = await fabric.tasks.create({ blocks: [] });
    const record = {
      id: 'apr_race',
      tenantId: TEST_TENANT,
      taskId: task.id,
      subject: { kind: 'tool' as const, summary: 'race' },
      options: [{ id: 'allow_once', label: 'once', kind: 'allow_once' as const }],
      authority: 'local' as const,
      delegationChain: [],
      policyRevision: 'rev',
      revision: 1,
      state: 'pending' as const,
      createdAt: '2026-10-28T00:00:00.000Z',
      expiresAt: '2026-10-28T01:00:00.000Z',
      sensitive: false,
    };
    await fabric.stores.approvals.insert(record);
    const [a, b] = await Promise.all([
      fabric.approvals.decide('apr_race', 'allow_once', 'client-a'),
      fabric.approvals.decide('apr_race', 'allow_once', 'client-b'),
    ]);
    expect([a, b].filter(Boolean)).toHaveLength(1);
  });

  it('#5 a non-idempotent timeout is indeterminate and is not retried', async () => {
    const calls: AuthorizedInvocation[] = [];
    const fabric = fabricWith([
      { id: 'allow-all', priority: 1, effect: 'allow', match: { capabilities: ['**'] }, source: 'org' },
    ]);
    const adapter = hostileAdapter({ calls });
    await fabric.mount(
      {
        ...adapter,
        async invoke(invocation: AuthorizedInvocation): Promise<InvokeResultPayload> {
          calls.push(invocation);
          // The request went out but no result came back.
          return { outcome: 'indeterminate', error: { kind: 'indeterminate', message: 'no response', retryable: false } };
        },
      },
      { providerId: 'evil', risk: 'execute', sideEffect: 'non_idempotent' },
    );
    const result = await fabric.call({ capabilityId: 'mcp://evil/tool/wipe', input: {} });
    expect(result.outcome).toBe('indeterminate');
    expect(calls).toHaveLength(1);
    // The receipt records the honest outcome rather than claiming failure.
    const receipt = await fabric.stores.receipts.get(result.receiptId, TEST_TENANT);
    expect(receipt?.outcome).toBe('indeterminate');
  });

  it('#6 a replay of a completed call does not touch the peer twice', async () => {
    const calls: AuthorizedInvocation[] = [];
    const fabric = fabricWith([
      { id: 'allow-all', priority: 1, effect: 'allow', match: { capabilities: ['**'] }, source: 'org' },
    ]);
    await fabric.mount(hostileAdapter({ calls }), { providerId: 'evil', risk: 'write', sideEffect: 'non_idempotent' });
    const first = await fabric.call({ capabilityId: 'mcp://evil/tool/wipe', input: { n: 1 }, idempotencyKey: 'k' });
    const second = await fabric.call({ capabilityId: 'mcp://evil/tool/wipe', input: { n: 1 }, idempotencyKey: 'k' });
    expect(calls).toHaveLength(1);
    expect(second.replayed).toBe(true);
    expect(second.receiptId).toBe(first.receiptId);
  });

  it('#8 cross-tenant reads do not leak existence', async () => {
    const fabric = fabricWith([]);
    const task = await fabric.tasks.create({ blocks: [] });
    expect(await fabric.stores.tasks.get(task.id, 'attacker-tenant')).toBeUndefined();
    // Same answer for a task that does not exist at all: no existence oracle.
    expect(await fabric.stores.tasks.get('task_does_not_exist', 'attacker-tenant')).toBeUndefined();
  });

  it('#10 a deny in any layer vetoes an org allow', async () => {
    const calls: AuthorizedInvocation[] = [];
    const fabric = fabricWith([
      { id: 'org-allow', priority: 1, effect: 'allow', match: { capabilities: ['mcp://evil/**'] }, source: 'org' },
      { id: 'session-deny', priority: 2, effect: 'deny', match: { capabilities: ['mcp://evil/tool/wipe'] }, source: 'session' },
    ]);
    await fabric.mount(hostileAdapter({ calls }), { providerId: 'evil', risk: 'read' });
    await expect(fabric.call({ capabilityId: 'mcp://evil/tool/wipe' })).rejects.toBeInstanceOf(CanonicalError);
    expect(calls).toHaveLength(0);
  });

  it('#11 an unknown local tool is refused at resolve, never silently executed', async () => {
    const tools = new ToolRegistry();
    const fabric = fabricWith(
      [{ id: 'allow-local', priority: 1, effect: 'allow', match: { capabilities: ['local://tools/**'] }, source: 'org' }],
      { tools },
    );
    // Refused during resolve: the request never reaches an executor.
    await expect(fabric.call({ capabilityId: 'local://tools/does_not_exist', input: {} })).rejects.toMatchObject({
      kind: 'capability_not_found',
    });
  });

  it('#12 an empty capability id is rejected before any side effect', async () => {
    const fabric = fabricWith([]);
    await expect(fabric.call({ capabilityId: '' })).rejects.toMatchObject({ kind: 'invalid_request' });
  });

  it('#13 the redactor scrubs secrets before they reach a receipt or an event', async () => {
    const { RecordingRedactor } = await import('../src/governance/redactor-bridge.js');
    const redactor = new RecordingRedactor('test');
    redactor.register('sk-super-secret-value-123456', 'api-key');
    const fabric = fabricWith(
      [{ id: 'allow-all', priority: 1, effect: 'allow', match: { capabilities: ['**'] }, source: 'org' }],
      { redactor },
    );
    const calls: AuthorizedInvocation[] = [];
    await fabric.mount(hostileAdapter({ calls }), { providerId: 'evil', risk: 'read' });
    // The secret is in the INPUT, so the executor must never see it verbatim.
    await fabric.call({ capabilityId: 'mcp://evil/tool/wipe', input: { token: 'sk-super-secret-value-123456' } });
    const seen = JSON.stringify(calls[0]?.input ?? {});
    expect(seen).not.toContain('sk-super-secret-value-123456');
    expect(seen).toContain('[REDACTED:api-key]');
  });
});

// ── C-1 (third-round audit): the local safety floor is protocol-independent ──
//
// The policy engine consulted core's PermissionEngine — the BR-006 dangerous
// command library, the BR-003 workspace path fence and the sensitive-path rule
// — ONLY for `local://` capabilities. A single ordinary `mcp://**` allow rule
// therefore disabled all of it on every protocol edge: `rm -rf /`,
// `/etc/passwd` and `~/.ssh/id_rsa` all went through ungoverned. This is a
// regression of the v0.2 security work, so it is pinned here for every edge.

describe('red team C-1: the local safety floor applies to protocol edges', () => {
  it('a plain mcp allow cannot bypass dangerous commands, the path fence or sensitive paths', async () => {
    const calls: AuthorizedInvocation[] = [];
    const runtime = new FakeRuntime();
    const engine = new PermissionEngine({ mode: 'default', rules: [], workspaceRoots: ['/work'], runtime });
    const fabric = createFabric({
      runtime,
      tenantId: TEST_TENANT,
      workspaceRoots: ['/work'],
      approvalTimeoutMs: 25, // no authority answers -> fail closed
      policy: {
        defaultEffect: 'deny',
        // The most permissive rule a customer would plausibly write.
        rules: [{ id: 'allow-mcp', priority: 1, effect: 'allow', match: { capabilities: ['mcp://**'] }, source: 'org' }],
        permissionEngine: engine,
      },
    });
    await fabric.mount(hostileAdapter({ calls }), { providerId: 'evil', risk: 'execute' });

    const dangerous = [
      { command: 'rm -rf /' },        // BR-006 dangerous command library
      { path: '/etc/passwd' },        // outside every workspace root
      { path: '~/.ssh/id_rsa' },      // sensitive credential path
    ];
    for (const input of dangerous) {
      await expect(
        fabric.call({ capabilityId: 'mcp://evil/tool/wipe', input }),
        `input ${JSON.stringify(input)} must not be allowed through an edge`,
      ).rejects.toBeDefined();
    }
    // Nothing may have reached the peer.
    expect(calls).toHaveLength(0);
  });

  it('the safety floor also applies to the ACP reverse direction', async () => {
    const calls: AuthorizedInvocation[] = [];
    const runtime = new FakeRuntime();
    const engine = new PermissionEngine({ mode: 'default', rules: [], workspaceRoots: ['/work'], runtime });
    const fabric = createFabric({
      runtime,
      tenantId: TEST_TENANT,
      workspaceRoots: ['/work'],
      approvalTimeoutMs: 25,
      policy: {
        defaultEffect: 'deny',
        rules: [{ id: 'allow-acp', priority: 1, effect: 'allow', match: { capabilities: ['acp://**'] }, source: 'org' }],
        permissionEngine: engine,
      },
    });
    await fabric.mount(
      hostileAdapter({
        calls,
        capabilities: [{ id: 'acp://zed/fs/write_text_file', kind: 'fs', displayName: 'write_text_file' }],
      }),
      { providerId: 'zed', risk: 'write' },
    );
    await expect(
      fabric.call({ capabilityId: 'acp://zed/fs/write_text_file', input: { path: '/etc/passwd', content: 'x' }, direction: 'reverse' }),
    ).rejects.toBeDefined();
    expect(calls).toHaveLength(0);
  });
});
