/**
 * `defineAdapterContract` — the 8 universal adapter-contract properties
 * (document/Agent-RPC/03 §7.2).
 *
 * The suite drives a *real* `ProtocolAdapter` through a minimal fake of the
 * kernel's governance pipeline: policy → idempotency → approval → dispatch. That
 * is enough to prove the eight properties without depending on the Lead's full
 * dispatcher, and it keeps every assertion about the adapter's observable
 * behaviour: what reached the peer, what came back, and what the payload says.
 *
 *   1. discovery returns correct capability ids + risk metadata
 *   2. a policy-denied call never reaches the peer (call counter)
 *   3. `ask` → approval must pass before the peer is reached
 *   4. approval denied → the peer is never called
 *   5. timeout → timed_out/indeterminate, no automatic retry
 *   6. idempotency: the same key twice → the peer is called once
 *   7. receipt-relevant fields are complete (capability id, input hash,
 *      outcome, lossy)
 *   8. cancel propagates and the peer state becomes determinable
 */

import { describe, expect, it } from 'vitest';
import { contentHash, MemoryLogger, Redactor, sha256Hex, type Logger, type Runtime } from '@syaocode/core';
import { CanonicalError, createFabric, RulePolicyEngine, withRevision, type Fabric } from '@syaocode/rpc';
import type {
  AdapterContext,
  Protocol,
  ApprovalBroker,
  ApprovalDecision,
  ApprovalOutcome,
  ApprovalRecord,
  ApprovalRequest,
  AuthorizedInvocation,
  CanonicalErrorShape,
  CanonicalEvent,
  Capability,
  DiscoveredCapability,
  Effect,
  InvocationState,
  InvokeResultPayload,
  ProtocolAdapter,
  PolicyRule,
} from '@syaocode/rpc';
import type { FakePeer, FakePeerNotification } from './fake-peer.js';

/**
 * The tenant every contract run is attributed to.
 *
 * It MUST match the tenant the rig's invocation carries (`ten_test`): the
 * dispatcher's I1 check refuses a principal from another tenant, so a
 * mismatch would deny every call and the contract would assert nothing.
 */
const TENANT = 'ten_test';

// ── peer view ─────────────────────────────────────────────────────────────

export interface ContractPeer {
  /** Requests received for `method` (all methods when omitted). */
  calls(method?: string): number;
  /** Requests **plus** notifications received for `method`. */
  observed(method: string): number;
  notifications(): FakePeerNotification[];
}

export function peerView(peer: FakePeer): ContractPeer {
  return {
    calls: (method) => peer.calls(method),
    observed: (method) => peer.calls(method) + peer.notifications().filter((note) => note.method === method).length,
    notifications: () => peer.notifications(),
  };
}

// ── rig ───────────────────────────────────────────────────────────────────

export interface ContractRig {
  adapter: ProtocolAdapter;
  capabilityId: string;
  peer: ContractPeer;
  runtime: Runtime;
  invocation(overrides?: Partial<AuthorizedInvocation>): AuthorizedInvocation;
  ctx(overrides?: { deadlineMs?: number }): AdapterContext;
  /** Protocol-specific discovery assertions (ids + risk metadata). */
  assertDiscovery(capabilities: readonly DiscoveredCapability[]): void;
  /** Make the peer stop answering the invocation method (timeout test). */
  hang(): void;
  /** Set up a cancellation target; returns the task id to cancel. */
  prepareCancel(): Promise<string>;
  /** Read the peer's state for a task, over the wire where possible. */
  observeState(taskId: string): Promise<string>;
  dispose(): Promise<void>;
}

export interface ContractFixture {
  protocol: 'mcp' | 'a2a' | 'acp';
  setup(): Promise<ContractRig>;
  /** Wire method that carries the capability invocation. */
  invocationMethod: string;
  /** Wire method/notification that must be observed when cancel propagates. */
  cancelSignal: string;
  /** The peer's state after a successful cancel. */
  cancelledState: string;
}

// ── fake approval broker ──────────────────────────────────────────────────

export function createApprovalBroker(handler: (request: ApprovalRequest) => Promise<ApprovalOutcome> | ApprovalOutcome): ApprovalBroker {
  const records = new Map<string, ApprovalRecord>();
  return {
    async request(request: ApprovalRequest): Promise<ApprovalOutcome> {
      return handler(request);
    },
    async decide(): Promise<boolean> {
      return false;
    },
    async get(approvalId: string): Promise<ApprovalRecord | undefined> {
      return records.get(approvalId);
    },
    async listPending(): Promise<ApprovalRecord[]> {
      return [];
    },
    async cancelForTask(): Promise<number> {
      return 0;
    },
    async recheck(): Promise<number> {
      return 0;
    },
  };
}

// ── governed run (the fake dispatcher) ────────────────────────────────────

export interface ContractReceipt {
  protocol: string;
  capabilityId: string;
  inputHash: string;
  outcome: string;
  lossy: string[];
  invocationId: string;
  taskId: string;
  policyEffect: Effect;
  approvals: number;
}

export interface ContractRun {
  /** The kernel's invocation state; `denied` is a real outcome here. */
  outcome: InvocationState;
  error?: CanonicalErrorShape;
  lossy: string[];
  receipt: ContractReceipt;
  /** True when the result came from the fake idempotency store. */
  replayed: boolean;
  /** Peer invocation calls observed DURING the run. */
  peerCalls: number;
  /** Every peer call observed during the run (any method). */
  peerCallsTotal: number;
}

export interface GovernedOptions {
  policy: Effect;
  approval?: ApprovalOutcome['state'];
  idempotencyKey?: string;
  deadlineMs?: number;
  input?: unknown;
  capabilityId?: string;
  /** Hold the approval open so a test can assert the peer is untouched. */
  deferApproval?: boolean;
}

/** Map a canonical failure kind onto the kernel's invocation outcome. */
function outcomeOf(kind: CanonicalErrorShape['kind']): InvocationState {
  switch (kind) {
    case 'denied':
    case 'unauthorized':
    case 'unauthenticated':
      return 'denied';
    case 'timed_out':
      return 'timed_out';
    case 'cancelled':
      return 'cancelled';
    case 'indeterminate':
      return 'indeterminate';
    default:
      return 'failed';
  }
}

export class GovernedHarness {
  readonly idempotency = new Map<string, ContractRun>();
  approvalsRequested = 0;

  private issuedPromise: Promise<void> = Promise.resolve();
  private issued: (() => void) | undefined;
  /** Set by the deferred-approval presenter; answers the kernel's approval. */
  private release: ((state: ApprovalOutcome['state']) => void) | undefined;
  /** The kernel, built once: the rig's adapter is single-use. */
  private fabric: Fabric | undefined;
  /** Options of the run in flight, read by the approval presenter. */
  private current: GovernedOptions | undefined;

  constructor(
    private readonly rig: ContractRig,
    private readonly invocationMethod: string,
  ) {}

  /** Resolves as soon as the kernel actually asks for an approval. */
  waitForApproval(): Promise<void> {
    return this.issuedPromise;
  }

  /** Answer a deferred approval. */
  releaseApproval(state: ApprovalOutcome['state']): void {
    this.release?.(state);
    this.release = undefined;
  }

  /** Wake `waitForApproval()` once the kernel asks. */
  private signalApprovalRequested(): void {
    this.issued?.();
  }

  /**
   * Build the kernel once and mount the adapter.
   *
   * One fabric per harness mirrors reality (one kernel per process) and is
   * required here because an adapter's channel cannot be mounted twice.
   */
  private async kernel(): Promise<Fabric> {
    if (this.fabric !== undefined) return this.fabric;
    const rig = this.rig;
    const fabric = createFabric({
      runtime: rig.runtime,
      tenantId: TENANT,
      workspaceRoots: ['/work'],
      // The bundle is re-stamped per run; this default denies.
      policy: { defaultEffect: 'deny', rules: [] },
      // Nothing answers within this window unless a presenter decides, which is
      // exactly the fail-closed behaviour the contract pins.
      approvalTimeoutMs: 300,
      presentApproval: (record: ApprovalRecord) => {
        this.approvalsRequested += 1;
        const options = this.current;
        if (options?.deferApproval === true) {
          this.signalApprovalRequested();
          this.release = (state) => {
            void fabric.approvals.decide(record.id, state === 'allowed' ? 'allow_once' : 'deny_once', 'contract');
          };
          return;
        }
        const state = options?.approval ?? 'allowed';
        void fabric.approvals.decide(record.id, state === 'allowed' ? 'allow_once' : 'deny_once', 'contract');
      },
    });
    await fabric.mount(rig.adapter, { providerId: 'contract', risk: 'read' });
    this.fabric = fabric;
    return fabric;
  }

  /** Point the kernel's policy at the effect this run asks for. */
  private applyPolicy(fabric: Fabric, capabilityId: string, effect: Effect): void {
    const engine = fabric.policy;
    if (!(engine instanceof RulePolicyEngine)) return;
    engine.setBundle(
      withRevision(
        { sha256: (text: string) => sha256Hex(text) },
        {
          schemaVersion: 1,
          tenantId: TENANT,
          defaultEffect: effect === 'allow' ? 'allow' : 'deny',
          rules: [
            { id: 'contract-rule', priority: 10, effect, match: { capabilities: [capabilityId] }, source: 'org' },
          ],
        },
      ),
    );
  }

  /**
   * Run ONE invocation through the REAL governance kernel.
   *
   * The previous implementation reimplemented policy, idempotency and approval
   * inside this helper, so the "universal contract properties" passed even if
   * the kernel were deleted (05 §10.1 C-6). This drives the real
   * `createFabric` + `dispatcher.invoke` with the real adapter mounted, so a
   * kernel regression fails here.
   */
  async run(options: GovernedOptions): Promise<ContractRun> {
    const rig = this.rig;
    const invocation = rig.invocation({
      ...(options.capabilityId !== undefined ? { capabilityId: options.capabilityId } : {}),
      ...(options.input !== undefined ? { input: options.input } : {}),
      ...(options.idempotencyKey !== undefined ? { idempotencyKey: options.idempotencyKey } : {}),
    });
    const capabilityId = invocation.capability.id;
    this.current = options;
    // Arm the approval latch BEFORE the call: `waitForApproval()` must not
    // resolve until the kernel actually asks, or a test's release would race
    // ahead of the presenter and the approval would time out to `denied`.
    this.issuedPromise = new Promise<void>((resolve) => {
      this.issued = resolve;
    });

    const fabric = await this.kernel();
    this.applyPolicy(fabric, capabilityId, options.policy);
    // Mounting itself calls `discover()` (server/discover + tools/list), so the
    // baselines are taken AFTER it: an absolute zero would measure discovery,
    // not the denied invocation.
    const before = rig.peer.calls(this.invocationMethod);
    const beforeTotal = rig.peer.calls();

    const base = {
      protocol: rig.adapter.protocol,
      capabilityId,
      inputHash: hashInput(invocation.input),
      invocationId: invocation.invocationId,
      taskId: invocation.taskId,
      policyEffect: options.policy,
      approvals: 0,
    };

    // The kernel creates its OWN task; on the error path there is no result to
    // read it from, so capture the task set before the call and diff it.
    const tasksBefore = new Set((await fabric.tasks.list({})).map((t) => t.id));
    let outcome: InvocationState = 'failed';
    let error: CanonicalErrorShape | undefined;
    let lossy: string[] = [];
    let replayed = false;
    let approvals = 0;
    let taskId = invocation.taskId;
    try {
      const result = await fabric.call({
        capabilityId,
        input: invocation.input,
        ...(options.idempotencyKey !== undefined ? { idempotencyKey: options.idempotencyKey } : {}),
        // The deadline is the ADAPTER's to honour: the kernel only forwards it.
        ...(options.deadlineMs !== undefined
          ? { deadlineAt: new Date(rig.runtime.clock.now() + options.deadlineMs).toISOString() }
          : {}),
      });
      outcome = result.outcome;
      replayed = result.replayed === true;
      approvals = result.approvalIds.length;
      lossy = result.lossy ?? [];
      taskId = result.taskId;
      if (result.error !== undefined) error = result.error;
    } catch (e) {
      const canonical = CanonicalError.from(e);
      error = canonical.toShape();
      outcome = outcomeOf(canonical.kind);
    }
    this.current = undefined;
    const peerCalls = rig.peer.calls(this.invocationMethod) - before;
    const peerCallsTotal = rig.peer.calls() - beforeTotal;
    if (taskId === invocation.taskId) {
      const created = (await fabric.tasks.list({})).find((t) => !tasksBefore.has(t.id));
      if (created !== undefined) taskId = created.id;
    }
    // The receipt is the kernel's own, read back from its store.
    const receipt = await fabric.stores.receipts
      .listByTask(taskId, TENANT)
      .then((rows) => rows.at(-1))
      .catch(() => undefined);
    // The approval count comes from the kernel's receipt: a denial throws, so
    // there is no InvokeResult to read it from.
    if (receipt !== undefined) approvals = receipt.approvals.length;

    return {
      outcome,
      ...(error !== undefined ? { error } : {}),
      lossy,
      replayed,
      peerCalls,
      peerCallsTotal,
      receipt: {
        ...base,
        taskId,
        approvals,
        outcome: (receipt?.outcome ?? outcome) as ContractReceipt['outcome'],
        lossy,
        ...(receipt !== undefined ? { kernelReceiptId: receipt.id } : {}),
      },
    };
  }

  /** Release the kernel (one per harness). */
  async dispose(): Promise<void> {
    await this.fabric?.close();
    this.fabric = undefined;
  }
}
// ── context / invocation builders ─────────────────────────────────────────

export interface BuildContextOptions {
  runtime: Runtime;
  deadlineMs?: number;
  approval?: (request: ApprovalRequest) => Promise<ApprovalOutcome> | ApprovalOutcome;
  logger?: Logger;
}

export interface ContractContext extends AdapterContext {
  /** Canonical events the adapter handed to the log (stamped by the fake log). */
  readonly appended: CanonicalEvent[];
}

export function buildContext(options: BuildContextOptions): ContractContext {
  const deadlineMs = options.deadlineMs ?? 5_000;
  const appended: CanonicalEvent[] = [];
  const context: ContractContext = {
    runtime: options.runtime,
    signal: new AbortController().signal,
    deadlineAt: new Date(options.runtime.clock.now() + deadlineMs).toISOString(),
    // The real EventLog stamps seq/eventId/ts; the fake does the same so an
    // adapter can never observe (or forge) a gap-free sequence.
    append: async (draft) => {
      const event: CanonicalEvent = {
        ...draft,
        schemaVersion: 1,
        eventId: `evt_test_${appended.length + 1}`,
        seq: appended.length + 1,
        ts: draft.ts ?? new Date(options.runtime.clock.now()).toISOString(),
      };
      appended.push(event);
      return event;
    },
    approval: createApprovalBroker(options.approval ?? (() => ({ approvalId: 'apr_test', state: 'allowed', decidedBy: 'test' }))),
    redactor: new Redactor(),
    logger: options.logger ?? new MemoryLogger(),
    appended,
  };
  return context;
}

export interface BuildInvocationOptions {
  capabilityId: string;
  protocol: Protocol;
  runtime: Runtime;
  input?: unknown;
  taskId?: string;
  idempotencyKey?: string;
}

export function buildInvocation(options: BuildInvocationOptions): AuthorizedInvocation {
  const binding: Capability['protocol'] = options.protocol === 'native' ? 'local' : options.protocol;
  const capability: Capability = {
    id: options.capabilityId,
    kind: kindOf(options.capabilityId),
    protocol: binding,
    displayName: options.capabilityId,
    risk: 'read',
    sideEffect: 'idempotent',
    dataClass: 'internal',
    visibility: 'full',
    reversible: true,
    provider: {
      id: `${options.protocol}-peer`,
      protocol: binding,
      endpoint: `${options.protocol}://peer`,
      trust: 'verified',
      health: 'healthy',
      ttlMs: 60_000,
      lastSeenAt: new Date(options.runtime.clock.now()).toISOString(),
    },
  };
  const invocation: AuthorizedInvocation = {
    invocationId: options.runtime.ids.next('inv'),
    taskId: options.taskId ?? options.runtime.ids.next('task'),
    sessionId: options.runtime.ids.next('ses'),
    tenantId: 'ten_test',
    capability,
    endpoint: capability.provider.endpoint,
    input: options.input ?? { text: 'hello' },
    inputHash: hashInput(options.input ?? { text: 'hello' }),
    principal: { id: 'user:test', kind: 'user', tenantId: 'ten_test', scopes: ['repo:read'], trustTier: 'first_party' },
    protocol: options.protocol,
    direction: 'outbound',
    obligations: [],
    visibility: 'full',
  };
  if (options.idempotencyKey !== undefined) invocation.idempotencyKey = options.idempotencyKey;
  return invocation;
}

function kindOf(capabilityId: string): Capability['kind'] {
  if (capabilityId.includes('/fs/')) return 'fs';
  if (capabilityId.includes('/terminal/')) return 'terminal';
  if (capabilityId.includes('/resource/')) return 'resource';
  if (capabilityId.includes('/prompt/')) return 'prompt';
  if (capabilityId.includes('/skill/')) return 'agent_skill';
  return 'tool';
}

export function hashInput(input: unknown): string {
  return contentHash(stableStringify(input));
}

export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`).join(',')}}`;
}

/** Risk metadata is present when the adapter declared it or annotated it. */
export function hasRiskMetadata(capability: DiscoveredCapability): boolean {
  return capability.declaredRisk !== undefined || capability.annotations !== undefined;
}

// ── the suite ─────────────────────────────────────────────────────────────

export function defineAdapterContract(fixture: ContractFixture): void {
  const label = `adapter contract · ${fixture.protocol}`;

  describe(label, () => {
    it('1. discovery returns canonical capability ids with risk metadata', async () => {
      const rig = await fixture.setup();
      try {
        const capabilities = await rig.adapter.discover(rig.ctx());
        expect(capabilities.length).toBeGreaterThan(0);
        for (const capability of capabilities) {
          expect(capability.id).toMatch(/^(mcp|a2a|acp):\/\/[^/]+\/[^/]+\/.+$/);
          expect(capability.kind).toBeTruthy();
          expect(capability.displayName.length).toBeGreaterThan(0);
          expect(hasRiskMetadata(capability)).toBe(true);
        }
        expect(capabilities.some((capability) => capability.id === rig.capabilityId)).toBe(true);
        rig.assertDiscovery(capabilities);
        // The declared adapter capabilities must be honest about their gaps.
        expect(Array.isArray(rig.adapter.capabilities().lossy)).toBe(true);
      } finally {
        await rig.dispose();
      }
    });

    it('2. a policy-denied invocation never reaches the peer', async () => {
      const rig = await fixture.setup();
      try {
        const harness = new GovernedHarness(rig, fixture.invocationMethod);
        const run = await harness.run({ policy: 'deny' });
        // The kernel records a refusal as its own outcome, not as a failure.
        expect(run.outcome).toBe('denied');
        expect(run.error?.kind).toBe('denied');
        expect(run.peerCalls).toBe(0);
        // No traffic of ANY kind during the denied call (discovery happened
        // during mount, before the baseline).
        expect(run.peerCallsTotal).toBe(0);
        expect(run.receipt.policyEffect).toBe('deny');
      } finally {
        await rig.dispose();
      }
    });

    it('3. an ask decision reaches the peer only after approval', async () => {
      const rig = await fixture.setup();
      try {
        const harness = new GovernedHarness(rig, fixture.invocationMethod);
        const pending = harness.run({ policy: 'ask', approval: 'allowed', deferApproval: true });
        await harness.waitForApproval();
        // Approval is still pending: the peer must be untouched.
        expect(rig.peer.calls(fixture.invocationMethod)).toBe(0);
        harness.releaseApproval('allowed');
        const run = await pending;
        expect(run.outcome).toBe('succeeded');
        expect(run.receipt.approvals).toBe(1);
        expect(rig.peer.calls(fixture.invocationMethod)).toBe(1);
      } finally {
        await rig.dispose();
      }
    });

    it('4. a denied approval never reaches the peer', async () => {
      const rig = await fixture.setup();
      try {
        const harness = new GovernedHarness(rig, fixture.invocationMethod);
        const run = await harness.run({ policy: 'ask', approval: 'denied' });
        expect(run.error?.kind).toBe('denied');
        expect(run.receipt.approvals).toBe(1);
        expect(run.peerCalls).toBe(0);
        expect(run.peerCallsTotal).toBe(0);
      } finally {
        await rig.dispose();
      }
    });

    it('5. a timeout yields timed_out/indeterminate and is never retried', async () => {
      const rig = await fixture.setup();
      try {
        rig.hang();
        const harness = new GovernedHarness(rig, fixture.invocationMethod);
        const run = await harness.run({ policy: 'allow', deadlineMs: 40 });
        expect(['timed_out', 'indeterminate']).toContain(run.outcome);
        expect(run.error?.kind === 'timed_out' || run.error?.kind === 'indeterminate').toBe(true);
        // Exactly one attempt: no automatic retry after dispatch (I10).
        expect(rig.peer.calls(fixture.invocationMethod)).toBe(1);
      } finally {
        await rig.dispose();
      }
    });

    it('6. replaying the same idempotency key calls the peer once', async () => {
      const rig = await fixture.setup();
      try {
        const harness = new GovernedHarness(rig, fixture.invocationMethod);
        const first = await harness.run({ policy: 'allow', idempotencyKey: 'key-1' });
        expect(first.outcome).toBe('succeeded');
        const second = await harness.run({ policy: 'allow', idempotencyKey: 'key-1' });
        expect(second.replayed).toBe(true);
        expect(second.outcome).toBe(first.outcome);
        expect(rig.peer.calls(fixture.invocationMethod)).toBe(1);
      } finally {
        await rig.dispose();
      }
    });

    it('7. receipt-relevant fields are complete', async () => {
      const rig = await fixture.setup();
      try {
        const harness = new GovernedHarness(rig, fixture.invocationMethod);
        const run = await harness.run({ policy: 'allow' });
        expect(run.receipt.capabilityId).toBe(rig.capabilityId);
        expect(run.receipt.inputHash.length).toBeGreaterThan(0);
        expect(run.receipt.outcome).toBe(run.outcome);
        expect(Array.isArray(run.receipt.lossy)).toBe(true);
        expect(run.receipt.protocol).toBe(fixture.protocol);
        expect(run.receipt.invocationId.length).toBeGreaterThan(0);
        expect(run.receipt.taskId.length).toBeGreaterThan(0);
        // Every edge documents the semantics it cannot express (01 §6.1).
        expect(rig.adapter.capabilities().lossy.length).toBeGreaterThan(0);
      } finally {
        await rig.dispose();
      }
    });

    it('8. cancel propagates and the peer state becomes determinable', async () => {
      const rig = await fixture.setup();
      try {
        const taskId = await rig.prepareCancel();
        expect(rig.adapter.cancel).toBeTypeOf('function');
        await rig.adapter.cancel?.(taskId, 'contract-test', rig.ctx());
        expect(rig.peer.observed(fixture.cancelSignal)).toBeGreaterThan(0);
        expect(await rig.observeState(taskId)).toBe(fixture.cancelledState);
      } finally {
        await rig.dispose();
      }
    });
  });
}

/** Small helper so fixtures can build a capability-shaped invocation. */
export function makeDecision(optionId: string, by = 'test'): ApprovalDecision {
  return { optionId, by };
}
