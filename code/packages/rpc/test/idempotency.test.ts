import { describe, expect, it } from 'vitest';
import { MemoryIdempotencyStore, derivedKey, idempotencyKeyOf, requestHash } from '../src/governance/idempotency.js';
import { TEST_NOW, hasher } from './kernel-helpers.js';

function makeStore() {
  let n = 0;
  return new MemoryIdempotencyStore({
    ids: { next: (p: string) => `${p}_${(n += 1)}` },
    now: () => TEST_NOW,
  });
}

describe('idempotency (02 §9.1)', () => {
  it('computes a stable request hash over the capability and input', () => {
    const a = requestHash(hasher, 'mcp://x/tool/y', { n: 1 });
    const b = requestHash(hasher, 'mcp://x/tool/y', { n: 1 });
    const c = requestHash(hasher, 'mcp://x/tool/y', { n: 2 });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    // Key order must not matter.
    expect(requestHash(hasher, 'c', { x: 1, y: 2 })).toBe(requestHash(hasher, 'c', { y: 2, x: 1 }));
  });

  it('scopes the key by tenant and principal so callers cannot replay each other', () => {
    const a = idempotencyKeyOf({ tenantId: 't1', principalId: 'p1', capabilityId: 'c', clientKey: 'k' });
    const b = idempotencyKeyOf({ tenantId: 't2', principalId: 'p1', capabilityId: 'c', clientKey: 'k' });
    const c = idempotencyKeyOf({ tenantId: 't1', principalId: 'p2', capabilityId: 'c', clientKey: 'k' });
    expect(a).not.toBe(b);
    expect(a).not.toBe(c);
  });

  it('begins as new, then replays the completed result', async () => {
    const store = makeStore();
    const hash = requestHash(hasher, 'c', {});
    expect((await store.begin('k', hash)).kind).toBe('new');
    await store.complete('k', { value: 42 });
    const second = await store.begin('k', hash);
    expect(second.kind).toBe('replay');
    if (second.kind === 'replay') expect(second.record.result).toEqual({ value: 42 });
  });

  it('reports a conflict when the same key carries different input', async () => {
    const store = makeStore();
    await store.begin('k', requestHash(hasher, 'c', { n: 1 }));
    const second = await store.begin('k', requestHash(hasher, 'c', { n: 2 }));
    expect(second.kind).toBe('conflict');
  });

  it('reports in_flight while the first attempt is running', async () => {
    const store = makeStore();
    const hash = requestHash(hasher, 'c', {});
    await store.begin('k', hash);
    expect((await store.begin('k', hash)).kind).toBe('in_flight');
  });

  it('allows a retry after a failure', async () => {
    const store = makeStore();
    const hash = requestHash(hasher, 'c', {});
    await store.begin('k', hash);
    await store.fail('k', { kind: 'remote_error', message: 'boom', retryable: true });
    const next = await store.begin('k', hash);
    expect(next.kind).toBe('new');
  });

  it('derives a per-invocation key when the caller supplies none', () => {
    expect(derivedKey('task_1', 'inv_1')).toBe('task_1#inv_1');
    expect(derivedKey('task_1', 'inv_1')).not.toBe(derivedKey('task_1', 'inv_2'));
  });
});
