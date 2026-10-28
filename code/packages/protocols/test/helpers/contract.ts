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
import { contentHash, MemoryLogger, Redactor, type Logger, type Runtime } from '@syaocode/core';
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
  InvokeResultPayload,
  ProtocolAdapter,
} from '@syaocode/rpc';
import type { FakePeer, FakePeerNotification } from './fake-peer.js';

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
  outcome: InvokeResultPayload['outcome'];
  error?: CanonicalErrorShape;
  lossy: string[];
  receipt: ContractReceipt;
  /** True when the result came from the fake idempotency store. */
  replayed: boolean;
  /** Peer invocation calls observed after the run. */
  peerCalls: number;
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

export class GovernedHarness {
  readonly idempotency = new Map<string, ContractRun>();
  approvalsRequested = 0;

  private pendingApproval: ((state: ApprovalOutcome['state']) => void) | undefined;
  private issued: (() => void) | undefined;
  private issuedPromise: Promise<void> = Promise.resolve();

  constructor(
    private readonly rig: ContractRig,
    private readonly invocationMethod: string,
  ) {}

  /** Resolves as soon as the harness asks for an approval. */
  waitForApproval(): Promise<void> {
    return this.issuedPromise;
  }

  /** Answer a deferred approval. */
  releaseApproval(state: ApprovalOutcome['state']): void {
    const resolve = this.pendingApproval;
    this.pendingApproval = undefined;
    resolve?.(state);
  }

  async run(options: GovernedOptions): Promise<ContractRun> {
    const rig = this.rig;
    const invocation = rig.invocation({
      ...(options.capabilityId !== undefined ? { capabilityId: options.capabilityId } : {}),
      ...(options.input !== undefined ? { input: options.input } : {}),
      ...(options.idempotencyKey !== undefined ? { idempotencyKey: options.idempotencyKey } : {}),
    });
    const inputHash = hashInput(invocation.input);
    const base = {
      protocol: rig.adapter.protocol,
      capabilityId: invocation.capability.id,
      inputHash,
      invocationId: invocation.invocationId,
      taskId: invocation.taskId,
      policyEffect: options.policy,
      approvals: 0,
    };

    // ── step: authorize ────────────────────────────────────────────────────
    if (options.policy === 'deny') {
      return {
        outcome: 'failed',
        error: { kind: 'denied', message: 'policy denied', retryable: false },
        lossy: [],
        receipt: { ...base, outcome: 'denied', lossy: [] },
        replayed: false,
        peerCalls: rig.peer.calls(this.invocationMethod),
      };
    }

    // ── step: idempotency (before authorize, per 02 §4) ───────────────────
    const key = options.idempotencyKey;
    if (key !== undefined) {
      const prior = this.idempotency.get(key);
      if (prior !== undefined && prior.receipt.inputHash === inputHash) return { ...prior, replayed: true };
    }

    // ── step: approve ─────────────────────────────────────────────────────
    let approvals = 0;
    if (options.policy === 'ask') {
      approvals = 1;
      this.approvalsRequested += 1;
      const state = options.deferApproval === true ? await this.defer() : (options.approval ?? 'allowed');
      if (state !== 'allowed') {
        const run: ContractRun = {
          outcome: 'failed',
          error: { kind: 'denied', message: `approval ${state}`, retryable: false },
          lossy: [],
          receipt: { ...base, outcome: 'denied', lossy: [], approvals },
          replayed: false,
          peerCalls: rig.peer.calls(this.invocationMethod),
        };
        if (key !== undefined) this.idempotency.set(key, run);
        return run;
      }
    }

    // ── step: dispatch ────────────────────────────────────────────────────
    const payload = await rig.adapter.invoke(invocation, rig.ctx({ ...(options.deadlineMs !== undefined ? { deadlineMs: options.deadlineMs } : {}) }));
    const lossy = payload.lossy ?? [];
    const run: ContractRun = {
      outcome: payload.outcome,
      ...(payload.error !== undefined ? { error: payload.error } : {}),
      lossy,
      receipt: { ...base, outcome: payload.outcome, lossy, approvals },
      replayed: false,
      peerCalls: rig.peer.calls(this.invocationMethod),
    };
    if (key !== undefined) this.idempotency.set(key, run);
    return run;
  }

  private defer(): Promise<ApprovalOutcome['state']> {
    let signal: () => void = () => undefined;
    this.issuedPromise = new Promise<void>((resolve) => {
      signal = resolve;
    });
    const promise = new Promise<ApprovalOutcome['state']>((resolve) => {
      this.pendingApproval = resolve;
      signal();
    });
    return promise;
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
        expect(run.outcome).toBe('failed');
        expect(run.error?.kind).toBe('denied');
        expect(rig.peer.calls(fixture.invocationMethod)).toBe(0);
        expect(rig.peer.calls()).toBe(0);
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
        expect(rig.peer.calls(fixture.invocationMethod)).toBe(0);
        expect(rig.peer.calls()).toBe(0);
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
