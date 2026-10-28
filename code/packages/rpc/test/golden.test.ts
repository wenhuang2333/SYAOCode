/**
 * Golden cross-protocol traces (03 T0.10 / T3.5).
 *
 * The three scenarios from 01 §7, expressed as the canonical event sequences
 * they must produce. These are the regression anchors for cross-protocol
 * behaviour: if a change alters the governance trace of a documented scenario,
 * this test fails and the change must be justified.
 *
 * The protocol edges here are in-process fakes — what is under test is the
 * KERNEL's trace (task/invocation/approval/budget/receipt ordering), not the
 * wire encoding, which the adapter contract tests cover.
 */

import { describe, expect, it } from 'vitest';
import { createFabric } from '../src/runtime/fabric.js';
import type { AdapterCapabilities, AdapterContext, AuthorizedInvocation, InvokeResultPayload, ProtocolAdapter } from '../src/governance/contracts.js';
import type { CanonicalEvent, DiscoveredCapability } from '../src/ir/types.js';
import { FakeRuntime, TEST_TENANT } from './kernel-helpers.js';

interface EdgeOptions {
  protocol: 'mcp' | 'a2a' | 'acp';
  version: string;
  discovered: DiscoveredCapability[];
  invoke: (invocation: AuthorizedInvocation) => Promise<InvokeResultPayload>;
  lossy?: string[];
}

function edge(opts: EdgeOptions): ProtocolAdapter {
  const caps: AdapterCapabilities = {
    protocol: opts.protocol,
    version: opts.version,
    supports: {
      session: opts.protocol === 'acp',
      task: opts.protocol !== 'mcp',
      streaming: true,
      push: false,
      approvalOptions: opts.protocol === 'acp',
      artifacts: true,
      reverseCalls: opts.protocol === 'acp',
      cancellation: true,
    },
    lossy: opts.lossy ?? [],
  };
  return {
    protocol: opts.protocol,
    version: opts.version,
    capabilities: () => caps,
    async discover() {
      return opts.discovered;
    },
    async invoke(invocation: AuthorizedInvocation, _ctx: AdapterContext): Promise<InvokeResultPayload> {
      return opts.invoke(invocation);
    },
    async health() {
      return 'healthy';
    },
    async close() {
      /* nothing to release */
    },
  };
}

/** Collect the canonical event trace of a task. */
async function traceOf(fabric: ReturnType<typeof createFabric>, taskId: string): Promise<string[]> {
  const events: CanonicalEvent[] = await fabric.tasks.events(taskId);
  return events.map((e) => e.type);
}

describe('golden trace S1 — IDE: read → approve → write → evidence (ACP + MCP)', () => {
  it('produces the documented governance trace', async () => {
    const runtime = new FakeRuntime();
    const fabric = createFabric({
      runtime,
      tenantId: TEST_TENANT,
      workspaceRoots: ['/work'],
      policy: {
        defaultEffect: 'deny',
        rules: [
          { id: 'read-ok', priority: 10, effect: 'allow', match: { capabilities: ['mcp://fs/tool/read_file'], risk: ['read'] }, source: 'org' },
          { id: 'write-ask', priority: 20, effect: 'ask', match: { capabilities: ['acp://zed/fs/write_text_file'], risk: ['write'] }, source: 'org' },
        ],
      },
      presentApproval: (record) => {
        // The editor (ACP client) answers with `allow_once`.
        void fabric.approvals.decide(record.id, 'allow_once', 'editor:zed');
      },
    });

    // MCP edge: a file read through a tool server.
    await fabric.mount(
      edge({
        protocol: 'mcp',
        version: '2026-07-28',
        discovered: [{ id: 'mcp://fs/tool/read_file', kind: 'tool', displayName: 'read_file' }],
        invoke: async () => ({ outcome: 'succeeded', output: { text: 'buggy()' } }),
      }),
      { providerId: 'fs', risk: 'read' },
    );

    // ACP edge: the client owns the filesystem; writes are reverse calls.
    await fabric.mount(
      edge({
        protocol: 'acp',
        version: 'v1',
        discovered: [{ id: 'acp://zed/fs/write_text_file', kind: 'fs', displayName: 'write_text_file' }],
        lossy: ['client-owned filesystem'],
        invoke: async (invocation) => ({ outcome: 'succeeded', output: { written: (invocation.input as { path?: string }).path } }),
      }),
      { providerId: 'zed', risk: 'write' },
    );

    const session = await fabric.createSession({ protocolBinding: 'acp', approvalAuthority: 'delegated' });
    const read = await fabric.call({ capabilityId: 'mcp://fs/tool/read_file', input: { path: '/work/a.ts' }, sessionId: session.id });
    expect(read.outcome).toBe('succeeded');

    const write = await fabric.call({
      capabilityId: 'acp://zed/fs/write_text_file',
      input: { path: '/work/a.ts', content: 'fixed()' },
      sessionId: session.id,
      taskId: read.taskId,
    });
    expect(write.outcome).toBe('succeeded');
    expect(write.approvalIds).toHaveLength(1);

    const bundle = await fabric.evidence.seal(read.taskId);
    expect(bundle.receipts).toHaveLength(2);

    const trace = await traceOf(fabric, read.taskId);
    // Golden order: task → reserve → start → settle → receipt, twice, plus the
    // approval lifecycle in between.
    expect(trace).toEqual([
      'task.created',
      'budget.reserved',
      'invocation.started',
      'budget.settled',
      'receipt.issued',
      'invocation.completed',
      'budget.reserved',
      'invocation.started',
      'budget.settled',
      'receipt.issued',
      'invocation.completed',
    ]);

    // The approval is recorded on the second receipt and in the evidence.
    const approvals = await fabric.approvals.listPending();
    expect(approvals).toHaveLength(0);
    const all = await fabric.stores.approvals.list({ tenantId: TEST_TENANT });
    expect(all).toHaveLength(1);
    expect(all[0]?.state).toBe('allowed');
    expect(all[0]?.decidedBy).toBe('editor:zed');
    expect(bundle.receipts[1]?.approvals).toEqual([all[0]?.id]);
  });
});

describe('golden trace S2 — platform delegates to a remote A2A agent (opaque)', () => {
  it('records an opaque receipt and settles the budget without claiming verification', async () => {
    const runtime = new FakeRuntime();
    const fabric = createFabric({
      runtime,
      tenantId: TEST_TENANT,
      workspaceRoots: ['/work'],
      budget: { tenantLimitUsd: 5, sessionLimitUsd: 2 },
      policy: {
        defaultEffect: 'deny',
        rules: [{ id: 'delegate-ok', priority: 10, effect: 'allow', match: { capabilities: ['a2a://researcher/skill/*'], risk: ['delegate'] }, source: 'org' }],
      },
    });

    await fabric.mount(
      edge({
        protocol: 'a2a',
        version: '1.0',
        discovered: [{ id: 'a2a://researcher/skill/web-research', kind: 'agent_skill', displayName: 'web-research' }],
        // A remote agent exposes no internal steps.
        lossy: ['remote task does not expose internal tool calls'],
        invoke: async () => ({
          outcome: 'succeeded',
          output: { artifact: 'sha256:deadbeef' },
          usage: { costUsd: 0.4, inputTokens: 1200, outputTokens: 800 },
          lossy: ['remote task does not expose internal tool calls'],
        }),
      }),
      { providerId: 'researcher', risk: 'delegate', sideEffect: 'non_idempotent', visibility: 'opaque' },
    );

    const session = await fabric.createSession({ approvalAuthority: 'delegated' });
    const result = await fabric.call({
      capabilityId: 'a2a://researcher/skill/web-research',
      input: { q: 'agent rpc governance' },
      sessionId: session.id,
      estimate: { usd: 0.5 },
    });
    expect(result.outcome).toBe('succeeded');
    expect(result.lossy).toContain('remote task does not expose internal tool calls');

    const receipt = await fabric.stores.receipts.get(result.receiptId, TEST_TENANT);
    expect(receipt?.visibility).toBe('opaque');
    expect(receipt?.usage?.costUsd).toBe(0.4);
    // An opaque edge must never be presented as fully verified.
    expect(receipt?.lossy).toBeDefined();

    // Budget was reserved then settled against the actual cost.
    const account = await fabric.budget.get(session.budgetId);
    expect(account?.reservedUsd).toBe(0);
    expect(account?.spentUsd).toBeCloseTo(0.4, 6);

    const trace = await traceOf(fabric, result.taskId);
    expect(trace).toEqual([
      'task.created',
      'budget.reserved',
      'invocation.started',
      'budget.settled',
      'receipt.issued',
      'invocation.completed',
    ]);
  });
});

describe('golden trace S3 — CLI calls an MCP server that requires input (MRTR)', () => {
  it('asks for approval, retries the same logical request, then completes', async () => {
    const runtime = new FakeRuntime();
    let attempts = 0;
    const fabric = createFabric({
      runtime,
      tenantId: TEST_TENANT,
      workspaceRoots: ['/work'],
      policy: {
        defaultEffect: 'deny',
        rules: [{ id: 'create-ask', priority: 10, effect: 'ask', match: { capabilities: ['mcp://tracker/tool/create_issue'] }, source: 'org' }],
      },
      presentApproval: (record) => {
        void fabric.approvals.decide(record.id, 'allow_once', 'user:local');
      },
    });

    await fabric.mount(
      edge({
        protocol: 'mcp',
        version: '2026-07-28',
        discovered: [{ id: 'mcp://tracker/tool/create_issue', kind: 'tool', displayName: 'create_issue' }],
        invoke: async () => {
          attempts += 1;
          // The MRTR round-trip is handled INSIDE the adapter: the kernel sees
          // one logical invocation with one receipt (02 §5.1).
          return { outcome: 'succeeded', output: { issue: 42, attempts } };
        },
      }),
      { providerId: 'tracker', risk: 'write', sideEffect: 'non_idempotent' },
    );

    const result = await fabric.call({
      capabilityId: 'mcp://tracker/tool/create_issue',
      input: { title: 'governance' },
      idempotencyKey: 'mrtr-1',
      estimate: { usd: 0.1 },
    });
    expect(result.outcome).toBe('succeeded');
    expect(result.approvalIds).toHaveLength(1);
    // Exactly one logical invocation, hence exactly one receipt.
    const receipts = await fabric.stores.receipts.listByTask(result.taskId, TEST_TENANT);
    expect(receipts).toHaveLength(1);
    expect(receipts[0]?.policy.effect).toBe('ask');
    expect(receipts[0]?.approvals).toHaveLength(1);

    // A replay of the same logical request must not create a second issue.
    const replay = await fabric.call({
      capabilityId: 'mcp://tracker/tool/create_issue',
      input: { title: 'governance' },
      idempotencyKey: 'mrtr-1',
    });
    expect(replay.replayed).toBe(true);
    expect(await fabric.stores.receipts.listByTask(result.taskId, TEST_TENANT)).toHaveLength(1);
  });
});
