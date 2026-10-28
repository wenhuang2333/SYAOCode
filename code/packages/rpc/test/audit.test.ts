/**
 * Audit log tests: per-tenant SHA-256 chain, tamper detection, checkpoints.
 */

import { describe, expect, it } from 'vitest';
import { sha256Hex } from '@syaocode/core';
import { buildTestStores, fixedClock, sha256Hasher, T0 } from './helpers.js';
import { MemoryAuditStore, checkpointHashOf, recomputeAuditHash } from '../src/governance/audit.js';
import { canonicalJson } from '../src/ir/schemas.js';
import { deterministicIds } from '../src/ir/ids.js';
import type { AuditEvent } from '../src/ir/types.js';

const TENANT = 'ten_a';

function baseEvent(overrides: Partial<Omit<AuditEvent, 'prevHash' | 'hash'>> = {}): Omit<AuditEvent, 'prevHash' | 'hash'> {
  return {
    id: '',
    ts: T0,
    tenantId: TENANT,
    actor: { type: 'agent', id: 'prn_syao' },
    action: 'invocation.allowed',
    subject: { type: 'capability', id: 'mcp://github/tool/create_issue' },
    outcome: 'success',
    ...overrides,
  };
}

function newAudit(checkpointEvery?: number): MemoryAuditStore {
  const clock = fixedClock();
  return new MemoryAuditStore({
    hash: sha256Hasher(),
    ids: deterministicIds(),
    now: clock.now,
    ...(checkpointEvery !== undefined ? { checkpointEvery } : {}),
  });
}

describe('MemoryAuditStore', () => {
  it('chains events per tenant with a real SHA-256 digest', async () => {
    const audit = newAudit();
    const first = await audit.append(baseEvent());
    const second = await audit.append(baseEvent({ action: 'invocation.completed' }));
    expect(first.prevHash).toBe('');
    expect(second.prevHash).toBe(first.hash);
    expect(first.hash).toMatch(/^[0-9a-f]{64}$/);
    // Real SHA-256 over the canonical body — not core's FNV `contentHash`.
    const { hash: _hash, ...body } = first;
    expect(first.hash).toBe(sha256Hex(`${''}\u0000${canonicalJson({ ...body, prevHash: '' })}`));
    expect(first.hash).not.toBe(contentHashOf(first));
    expect(recomputeAuditHash(sha256Hasher(), second, first.hash)).toBe(second.hash);
  });

  it('generates an id when the caller leaves it empty, keeps an explicit one', async () => {
    const audit = newAudit();
    const generated = await audit.append(baseEvent());
    expect(generated.id).toMatch(/^aud_/);
    const explicit = await audit.append(baseEvent({ id: 'aud_fixed' }));
    expect(explicit.id).toBe('aud_fixed');
  });

  it('keeps independent chains per tenant (I8)', async () => {
    const audit = newAudit();
    const a = await audit.append(baseEvent());
    const b = await audit.append(baseEvent({ tenantId: 'ten_b' }));
    expect(b.prevHash).toBe('');
    expect((await audit.list({ tenantId: 'ten_b' })).map((e) => e.id)).toEqual([b.id]);
    expect((await audit.list({ tenantId: TENANT })).map((e) => e.id)).toEqual([a.id]);
    expect((await audit.verify('ten_b')).ok).toBe(true);
  });

  it('verifies an untouched chain', async () => {
    const audit = newAudit();
    for (let i = 0; i < 5; i += 1) await audit.append(baseEvent());
    const result = await audit.verify(TENANT);
    expect(result).toMatchObject({ ok: true, checked: 5 });
  });

  it('detects a modified link', async () => {
    const audit = newAudit();
    for (let i = 0; i < 4; i += 1) await audit.append(baseEvent());
    const events = await audit.list({ tenantId: TENANT });
    // Tamper with the stored row itself (the store hands out copies, so reach
    // in through the internal map the same way a corrupt database would).
    const internals = audit as unknown as { byTenant: Map<string, AuditEvent[]> };
    internals.byTenant.get(TENANT)![2] = { ...events[2]!, action: 'invocation.denied' };
    const result = await audit.verify(TENANT);
    expect(result.ok).toBe(false);
    expect(result.brokenAt).toBe(events[2]!.id);
    expect(result.reason).toMatch(/hash mismatch/);
  });

  it('detects a prevHash edit', async () => {
    const audit = newAudit();
    for (let i = 0; i < 3; i += 1) await audit.append(baseEvent());
    const events = await audit.list({ tenantId: TENANT });
    const internals = audit as unknown as { byTenant: Map<string, AuditEvent[]> };
    internals.byTenant.get(TENANT)![1] = { ...events[1]!, prevHash: 'forged' };
    const result = await audit.verify(TENANT);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/prevHash mismatch/);
  });

  it('detects a link deleted from the middle', async () => {
    const audit = newAudit();
    for (let i = 0; i < 4; i += 1) await audit.append(baseEvent());
    audit.dropForTest(TENANT, 1);
    const result = await audit.verify(TENANT);
    expect(result.ok).toBe(false);
    expect(result.brokenAt).toBeDefined();
  });

  it('detects a link deleted from the tail via the checkpoint anchor', async () => {
    const audit = newAudit();
    for (let i = 0; i < 3; i += 1) await audit.append(baseEvent());
    const checkpoint = await audit.checkpoint(TENANT);
    expect(checkpoint.count).toBe(3);
    audit.dropForTest(TENANT, 2);
    // Hashing alone cannot see a tail deletion — the checkpoint must.
    const result = await audit.verify(TENANT);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/events missing since checkpoint/);
  });

  it('auto-checkpoints every N events', async () => {
    const audit = newAudit(2);
    for (let i = 0; i < 6; i += 1) await audit.append(baseEvent());
    const checkpoints = await audit.listCheckpoints(TENANT);
    expect(checkpoints.map((c) => c.count)).toEqual([2, 4, 6]);
    expect(checkpoints[2]!.checkpointHash).toBe(checkpointHashOf(sha256Hasher(), TENANT, 6, checkpoints[2]!.lastHash));
    expect((await audit.verify(TENANT)).ok).toBe(true);
  });

  it('is idempotent when re-checkpointing an unchanged head', async () => {
    const audit = newAudit();
    await audit.append(baseEvent());
    const first = await audit.checkpoint(TENANT);
    const second = await audit.checkpoint(TENANT);
    expect(second).toEqual(first);
    expect(await audit.listCheckpoints(TENANT)).toHaveLength(1);
  });

  it('verifies from a checkpoint and rejects a corrupt anchor', async () => {
    const audit = newAudit(2);
    for (let i = 0; i < 4; i += 1) await audit.append(baseEvent());
    const anchor = await audit.checkpoint(TENANT);
    const resumed = await audit.verify(TENANT, anchor.checkpointHash);
    expect(resumed.ok).toBe(true);
    expect(resumed.checked).toBe(0);
    expect(resumed.reason).toMatch(/resumed from checkpoint/);

    const unknown = await audit.verify(TENANT, 'not-a-checkpoint');
    expect(unknown.ok).toBe(false);
    expect(unknown.reason).toMatch(/unknown checkpoint/);

    const tampered = { ...anchor, count: 3 };
    const internals = audit as unknown as { checkpoints: Map<string, AuditCheckpointRow[]> };
    internals.checkpoints.get(TENANT)![0] = tampered;
    const corrupt = await audit.verify(TENANT, anchor.checkpointHash);
    expect(corrupt.ok).toBe(false);
    expect(corrupt.reason).toMatch(/corrupt/);
  });

  it('filters list by from and limit', async () => {
    const clock = fixedClock();
    const audit = new MemoryAuditStore({ hash: sha256Hasher(), ids: deterministicIds(), now: clock.now });
    await audit.append(baseEvent({ ts: '2026-01-01T00:00:00.000Z' }));
    clock.advance(1000);
    await audit.append(baseEvent({ ts: '2026-01-01T00:00:01.000Z' }));
    clock.advance(1000);
    await audit.append(baseEvent({ ts: '2026-01-01T00:00:02.000Z' }));

    const from = await audit.list({ tenantId: TENANT, from: '2026-01-01T00:00:01.000Z' });
    expect(from).toHaveLength(2);
    expect(await audit.list({ tenantId: TENANT, limit: 1 })).toHaveLength(1);
    expect(await audit.list()).toHaveLength(3);
  });

  it('verifies an empty tenant trivially', async () => {
    const audit = newAudit();
    expect(await audit.verify('ten_none')).toMatchObject({ ok: true, checked: 0 });
  });

  it('reports the newest checkpoint', async () => {
    const audit = newAudit(2);
    for (let i = 0; i < 4; i += 1) await audit.append(baseEvent());
    const last = await audit.lastCheckpoint(TENANT);
    expect(last?.count).toBe(4);
    expect(await audit.lastCheckpoint('ten_none')).toBeUndefined();
  });
});

describe('audit in the store bundle', () => {
  it('shares the injected hasher and detects tampering', async () => {
    const stores = buildTestStores({ checkpointEvery: 2 });
    await stores.audit.append(baseEvent());
    await stores.audit.append(baseEvent());
    const checkpoint = await stores.audit.checkpoint(TENANT);
    expect(checkpoint.count).toBe(2);
    expect((await stores.audit.verify(TENANT)).ok).toBe(true);
  });
});

// ── helpers ───────────────────────────────────────────────────────────────

type AuditCheckpointRow = { count: number; lastHash: string; checkpointHash: string; tenantId?: string };

/** core's non-cryptographic digest, used only to prove it is NOT what we store. */
function contentHashOf(event: AuditEvent): string {
  let h1 = 0x811c9dc5;
  const text = canonicalJson(event);
  for (let i = 0; i < text.length; i += 1) h1 = Math.imul(h1 ^ text.charCodeAt(i), 0x01000193);
  return (h1 >>> 0).toString(16).padStart(8, '0');
}
