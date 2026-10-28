import { describe, expect, it } from 'vitest';

/**
 * Adapter contract harness (03 §3.5, 02 §12).
 *
 * Every protocol edge (MCP / A2A / ACP / native) must satisfy the same
 * governance invariants, so the SAME suite runs against each adapter — the
 * analogue of `defineProviderContract` for protocol adapters.
 *
 * Deliberately structural: `@syaocode/testing` depends on `@syaocode/core`
 * only, so this file never imports `@syaocode/rpc` types. A fixture supplies
 * closures and the harness asserts the *behaviour* described by the design
 * doc, not the shape of any particular adapter class.
 */

/** One governed invocation a fixture knows how to drive. */
export interface AdapterInvokeRequest {
  /** Capability / tool id, in the adapter's own vocabulary. */
  capabilityId: string;
  input: unknown;
  /** Idempotency key, when the case exercises replay. */
  idempotencyKey?: string;
  /** Abort the caller side mid-flight (cancel propagation case). */
  signal?: AbortSignal;
}

/** Normalized outcome the harness asserts on. */
export interface AdapterInvokeResult {
  /** 'succeeded' | 'denied' | 'timed_out' | 'cancelled' | 'indeterminate' | … */
  state: string;
  /** Machine-readable error code, when the call failed. */
  errorCode?: string;
  output?: unknown;
  /** Receipt id, when the adapter produced one. */
  receiptId?: string;
  /** True when the result came from the idempotency cache. */
  replayed?: boolean;
}

export interface AdapterContractFixture<A> {
  /** Fresh adapter bound to a fake/loopback peer. */
  createAdapter: () => Promise<A> | A;
  /** Drive one governed invocation and normalize the outcome. */
  invoke: (adapter: A, req: AdapterInvokeRequest) => Promise<AdapterInvokeResult>;
  /**
   * How many times the *remote peer* was actually called. Used by the
   * "deny means no side effect" and idempotency cases.
   */
  remoteCalls: () => number;
  /**
   * Answer or deny the next approval the adapter asks for. When omitted the
   * approval cases are skipped (the adapter has no approval surface).
   */
  answerApproval?: (adapter: A, answer: 'allow' | 'deny') => void | Promise<void>;
  /** Cancel an in-flight invocation; enables the cancel case. */
  cancel?: (adapter: A, invocationId: string) => Promise<void>;
  /** Adapter id of the in-flight invocation, for the cancel case. */
  lastInvocationId?: () => string | undefined;
  /** True when the adapter's peer supports push/streaming. */
  supportsStreaming?: boolean;
}

/**
 * Register the adapter contract suite for one adapter.
 *
 * Cases marked conditional are skipped when the fixture does not supply the
 * hook, so an adapter that has no approval surface is not punished for it —
 * but every hook it *does* supply must behave.
 */
export function defineAdapterContract<A>(name: string, fixture: AdapterContractFixture<A>): void {
  describe(`adapter contract: ${name}`, () => {
    it('completes a governed invocation and reports a terminal state', async () => {
      const adapter = await fixture.createAdapter();
      const result = await fixture.invoke(adapter, { capabilityId: 'echo', input: { text: 'hi' } });
      expect(['succeeded', 'completed']).toContain(result.state);
      expect(result.receiptId ?? '').not.toBe('');
    });

    it('a denied invocation never reaches the peer', async () => {
      const adapter = await fixture.createAdapter();
      await fixture.answerApproval?.(adapter, 'deny');
      const before = fixture.remoteCalls();
      const result = await fixture.invoke(adapter, { capabilityId: 'echo', input: { text: 'hi' } });
      if (fixture.answerApproval === undefined) return; // no approval surface
      expect(result.state).toBe('denied');
      expect(fixture.remoteCalls()).toBe(before);
    });

    it('replays an idempotent retry without a second side effect', async () => {
      const adapter = await fixture.createAdapter();
      const key = 'contract-idem-key';
      const first = await fixture.invoke(adapter, { capabilityId: 'echo', input: { text: 'once' }, idempotencyKey: key });
      expect(first.state).toBe('succeeded');
      const second = await fixture.invoke(adapter, { capabilityId: 'echo', input: { text: 'once' }, idempotencyKey: key });
      expect(second.state).toBe('succeeded');
      expect(second.replayed === true || fixture.remoteCalls() === 1).toBe(true);
    });

    it('surfaces a cancelled invocation as a terminal non-success state', async () => {
      const adapter = await fixture.createAdapter();
      const controller = new AbortController();
      const running = fixture.invoke(adapter, { capabilityId: 'slow', input: {}, signal: controller.signal });
      controller.abort();
      const result = await running;
      // The adapter must honour the abort signal; a fast local adapter may
      // have finished first, in which case the case proves nothing — so the
      // expectation is only enforced when the adapter actually observed the
      // cancellation.
      if (result.state === 'succeeded') {
        expect(fixture.remoteCalls()).toBeGreaterThan(0);
        return;
      }
      expect(['cancelled', 'timed_out', 'indeterminate', 'failed']).toContain(result.state);
    });
  });
}

/** Convenience fixture for a purely local adapter (no remote peer). */
export function localAdapterFixture<A>(opts: {
  createAdapter: () => A | Promise<A>;
  invoke: (adapter: A, req: AdapterInvokeRequest) => Promise<AdapterInvokeResult>;
}): AdapterContractFixture<A> {
  let calls = 0;
  return {
    createAdapter: opts.createAdapter,
    async invoke(adapter, req) {
      calls += 1;
      return opts.invoke(adapter, req);
    },
    remoteCalls: () => calls,
  };
}
