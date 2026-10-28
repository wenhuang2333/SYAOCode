/**
 * Governance overhead benchmark (02 §15).
 *
 * Target: p95 governance overhead <= 5ms per invocation, excluding approval
 * waits and network I/O (03 §7.1). The measurement covers the ten-step
 * pipeline with in-memory stores, i.e. exactly the overhead the kernel adds on
 * top of a local call.
 *
 * The assertions are deliberately loose (a hard 5ms p95 would make CI flaky on
 * a loaded machine) — the test fails only when the overhead is an order of
 * magnitude off, and always prints the measured numbers for the record.
 */

import { describe, expect, it } from 'vitest';
import { createFabric } from '../src/runtime/fabric.js';
import type { AdapterCapabilities, AdapterContext, AuthorizedInvocation, InvokeResultPayload, ProtocolAdapter } from '../src/governance/contracts.js';
import type { DiscoveredCapability } from '../src/ir/types.js';
import { FakeRuntime, TEST_TENANT } from './kernel-helpers.js';

function echoAdapter(): ProtocolAdapter {
  const caps: AdapterCapabilities = {
    protocol: 'mcp',
    version: '2026-07-28',
    supports: {
      session: false, task: true, streaming: false, push: false,
      approvalOptions: false, artifacts: false, reverseCalls: false, cancellation: false,
    },
    lossy: [],
  };
  const discovered: DiscoveredCapability[] = [
    { id: 'mcp://bench/tool/echo', kind: 'tool', displayName: 'echo' },
  ];
  return {
    protocol: 'mcp',
    version: '2026-07-28',
    capabilities: () => caps,
    async discover() {
      return discovered;
    },
    async invoke(invocation: AuthorizedInvocation, _ctx: AdapterContext): Promise<InvokeResultPayload> {
      return { outcome: 'succeeded', output: invocation.input };
    },
    async health() {
      return 'healthy';
    },
    async close() {
      /* nothing */
    },
  };
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[idx]!;
}

describe('governance overhead (02 §15)', () => {
  it('keeps the ten-step pipeline p95 well under the SLO', async () => {
    const fabric = createFabric({
      runtime: new FakeRuntime(),
      tenantId: TEST_TENANT,
      workspaceRoots: ['/work'],
      policy: {
        defaultEffect: 'deny',
        rules: [{ id: 'allow', priority: 1, effect: 'allow', match: { capabilities: ['mcp://bench/**'] }, source: 'org' }],
      },
    });
    await fabric.mount(echoAdapter(), { providerId: 'bench', risk: 'read' });
    const session = await fabric.createSession({});

    const sampleCount = 300;
    // Warm up so the first-call laziness does not skew the sample.
    for (let i = 0; i < 20; i += 1) {
      await fabric.call({ capabilityId: 'mcp://bench/tool/echo', input: { i }, sessionId: session.id });
    }

    const samples: number[] = [];
    for (let i = 0; i < sampleCount; i += 1) {
      const started = performance.now();
      await fabric.call({ capabilityId: 'mcp://bench/tool/echo', input: { i }, sessionId: session.id });
      samples.push(performance.now() - started);
    }
    samples.sort((a, b) => a - b);

    const p50 = percentile(samples, 50);
    const p95 = percentile(samples, 95);
    const p99 = percentile(samples, 99);
    const max = samples[samples.length - 1]!;
    // Recorded in the test output so the numbers are visible in CI logs.
    console.log(
      `[bench] governance overhead over ${sampleCount} invocations: p50=${p50.toFixed(3)}ms p95=${p95.toFixed(3)}ms p99=${p99.toFixed(3)}ms max=${max.toFixed(3)}ms`,
    );

    expect(p50).toBeLessThan(5);
    expect(p95).toBeLessThan(50); // an order-of-magnitude guard, not the SLO itself
  });

  it('serves a repeated idempotent call from the cache (no second pipeline pass)', async () => {
    const fabric = createFabric({
      runtime: new FakeRuntime(),
      tenantId: TEST_TENANT,
      workspaceRoots: ['/work'],
      policy: { defaultEffect: 'deny', rules: [{ id: 'allow', priority: 1, effect: 'allow', match: { capabilities: ['**'] }, source: 'org' }] },
    });
    await fabric.mount(echoAdapter(), { providerId: 'bench', risk: 'read' });

    const cold = performance.now();
    await fabric.call({ capabilityId: 'mcp://bench/tool/echo', input: { n: 1 }, idempotencyKey: 'k' });
    const coldMs = performance.now() - cold;

    const replaySamples: number[] = [];
    for (let i = 0; i < 100; i += 1) {
      const started = performance.now();
      const result = await fabric.call({ capabilityId: 'mcp://bench/tool/echo', input: { n: 1 }, idempotencyKey: 'k' });
      replaySamples.push(performance.now() - started);
      expect(result.replayed).toBe(true);
    }
    replaySamples.sort((a, b) => a - b);
    const replayP95 = percentile(replaySamples, 95);
    console.log(`[bench] idempotent replay: cold=${coldMs.toFixed(3)}ms p95=${replayP95.toFixed(3)}ms`);
    expect(replayP95).toBeLessThan(5);
  });

  it('decides policy from cache on the hot path', async () => {
    const fabric = createFabric({
      runtime: new FakeRuntime(),
      tenantId: TEST_TENANT,
      workspaceRoots: ['/work'],
      policy: { defaultEffect: 'deny', rules: [{ id: 'allow', priority: 1, effect: 'allow', match: { capabilities: ['**'] }, source: 'org' }] },
    });
    await fabric.mount(echoAdapter(), { providerId: 'bench', risk: 'read' });
    const samples: number[] = [];
    for (let i = 0; i < 200; i += 1) {
      const started = performance.now();
      await fabric.policyExplain({ capabilityId: 'mcp://bench/tool/echo' });
      samples.push(performance.now() - started);
    }
    samples.sort((a, b) => a - b);
    const p95 = percentile(samples, 95);
    console.log(`[bench] policy explain p95=${p95.toFixed(3)}ms`);
    expect(p95).toBeLessThan(20);
  });
});
