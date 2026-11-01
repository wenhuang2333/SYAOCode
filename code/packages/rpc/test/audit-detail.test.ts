/**
 * WP-3: `detailHash` — sidecar detail storage + `verify({ details })` (06 §8).
 *
 * The chain commits to a digest of the redacted detail; the payload itself
 * lives in a sidecar store so it can be retained, pruned and verified
 * independently of the chain.
 */

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MAX_DETAIL_BYTES,
  DETAIL_HASH_PREFIX,
  MemoryAuditDetailStore,
  MemoryAuditStore,
  canonicalBytes,
  detailHashOf,
  detailRefOf,
} from '../src/governance/audit.js';
import { RecordingRedactor } from '../src/governance/redactor-bridge.js';
import { canonicalJson } from '../src/ir/schemas.js';
import { deterministicIds } from '../src/ir/ids.js';
import { sha256Hex } from '@syaocode/core';
import type { AuditEvent, AuditDetailSidecar } from '../src/ir/types.js';

const TENANT = 'ten_a';
const HASHER = { sha256: (text: string) => sha256Hex(text) };
const NOW = '2026-01-01T00:00:00.000Z';

function newAudit(opts: { redactor?: RecordingRedactor; maxDetailBytes?: number; detailStore?: MemoryAuditDetailStore } = {}): MemoryAuditStore {
  return new MemoryAuditStore({
    hash: HASHER,
    ids: deterministicIds(),
    now: () => NOW,
    ...(opts.redactor !== undefined ? { redactor: opts.redactor } : {}),
    ...(opts.maxDetailBytes !== undefined ? { maxDetailBytes: opts.maxDetailBytes } : {}),
    ...(opts.detailStore !== undefined ? { detailStore: opts.detailStore } : {}),
  });
}

function baseEvent(
  overrides: Partial<Omit<AuditEvent, 'prevHash' | 'hash'>> & { id?: string } = {},
): Omit<AuditEvent, 'prevHash' | 'hash' | 'id'> & { id?: string } {
  return {
    ts: NOW,
    tenantId: TENANT,
    actor: { type: 'agent', id: 'prn_syao' },
    action: 'invocation.allowed',
    subject: { type: 'capability', id: 'mcp://github/tool/create_issue' },
    outcome: 'success',
    ...overrides,
  };
}

describe('detailHash derivation', () => {
  it('gives the same hash for the same detail', async () => {
    const audit = newAudit();
    const first = await audit.append(baseEvent({ id: 'aud_1' }), { capabilityId: 'mcp://github/tool/create_issue', inputHash: 'in_1' });
    const second = await audit.append(baseEvent({ id: 'aud_2' }), { capabilityId: 'mcp://github/tool/create_issue', inputHash: 'in_1' });
    expect(first.detailHash).toBe(second.detailHash);
    expect(first.detailHash?.startsWith(DETAIL_HASH_PREFIX)).toBe(true);
  });

  it('gives the same hash when the keys are reordered', async () => {
    const audit = newAudit();
    const a = await audit.append(baseEvent({ id: 'aud_1' }), { alpha: 1, beta: { x: 1, y: 2 } });
    const b = await audit.append(baseEvent({ id: 'aud_2' }), { beta: { y: 2, x: 1 }, alpha: 1 });
    expect(a.detailHash).toBe(b.detailHash);
  });

  it('gives a different hash for different details', async () => {
    const audit = newAudit();
    const a = await audit.append(baseEvent({ id: 'aud_1' }), { inputHash: 'in_1' });
    const b = await audit.append(baseEvent({ id: 'aud_2' }), { inputHash: 'in_2' });
    expect(a.detailHash).not.toBe(b.detailHash);
  });

  it('matches an independently computed digest', async () => {
    const detail = { b: 2, a: [1, { z: 1, y: 2 }] };
    const expected = `${DETAIL_HASH_PREFIX}${sha256Hex(canonicalJson({ a: [1, { y: 2, z: 1 }], b: 2 }))}`;
    expect(detailHashOf(HASHER, detail)).toBe(expected);
  });

  it('records the sidecar reference and the canonical byte size', async () => {
    const audit = newAudit();
    const event = await audit.append(baseEvent({ id: 'aud_1' }), { hello: 'world' });
    expect(event.detailRef).toBe(detailRefOf(event.detailHash!));
    expect(event.detailBytes).toBe(canonicalBytes(canonicalJson({ hello: 'world' })));
    expect(event.detailTruncated).toBeUndefined();
  });

  it('measures the detail in UTF-8 bytes, not characters', async () => {
    const audit = newAudit();
    const detail = { note: '审计明细' };
    const event = await audit.append(baseEvent({ id: 'aud_1' }), detail);
    // 4 CJK characters → 12 UTF-8 bytes, plus the JSON scaffolding.
    expect(event.detailBytes).toBe(canonicalBytes(canonicalJson(detail)));
    expect(event.detailBytes).toBeGreaterThan(canonicalJson(detail).length);
  });

  it('writes no detail fields when no detail is supplied', async () => {
    const audit = newAudit();
    const event = await audit.append(baseEvent({ id: 'aud_1' }));
    expect(event.detailHash).toBeUndefined();
    expect(event.detailRef).toBeUndefined();
    expect(event.detailBytes).toBeUndefined();
  });
});

describe('verify({ details })', () => {
  it('reports ok when the sidecar matches', async () => {
    const audit = newAudit();
    await audit.append(baseEvent({ id: 'aud_1' }), { inputHash: 'in_1' });
    const result = await audit.verify(TENANT, { details: true });
    expect(result.ok).toBe(true);
    expect(result.details).toBe('ok');
    expect(result.pruned).toBe(0);
    expect(result.detailBroken).toBeUndefined();
  });

  it('reports ok for an event without a detail', async () => {
    const audit = newAudit();
    await audit.append(baseEvent({ id: 'aud_1' }));
    const result = await audit.verify(TENANT, { details: true });
    expect(result.ok).toBe(true);
    expect(result.details).toBe('ok');
  });

  it('always reports a detail verdict, even with nothing to check', async () => {
    const audit = newAudit();
    // Empty tenant: nothing to check, so the verdict is ok (never undefined).
    expect(await audit.verify(TENANT)).toMatchObject({ ok: true, details: 'ok', pruned: 0 });
    // Events but no detail sidecars.
    await audit.append(baseEvent({ id: 'aud_1' }));
    expect(await audit.verify(TENANT)).toMatchObject({ ok: true, details: 'ok', pruned: 0 });
  });

  it('reports mismatch when the sidecar was tampered with', async () => {
    const detailStore = new MemoryAuditDetailStore();
    const audit = newAudit({ detailStore });
    await audit.append(baseEvent({ id: 'aud_1' }), { inputHash: 'in_1' });
    // Rewrite the stored payload behind the store's back.
    const sidecar = await detailStore.get(detailHashOf(HASHER, { inputHash: 'in_1' }), TENANT);
    detailStore.overwriteForTest({ ...sidecar!, detail: { inputHash: 'forged' } });
    const result = await audit.verify(TENANT, { details: true });
    expect(result.details).toBe('mismatch');
    expect(result.ok).toBe(false);
    expect(result.detailBroken).toEqual(['aud_1']);
    expect(result.reason).toMatch(/detail hash mismatch/);
  });

  it('reports pruned (not missing) when retention dropped the payload', async () => {
    const detailStore = new MemoryAuditDetailStore();
    const audit = newAudit({ detailStore });
    await audit.append(baseEvent({ id: 'aud_1' }), { inputHash: 'in_1' });
    const sidecar = await detailStore.get(detailHashOf(HASHER, { inputHash: 'in_1' }), TENANT);
    expect(sidecar).toBeDefined();
    await detailStore.prune(sidecar!.hash, TENANT);
    const pruned = await audit.verify(TENANT, { details: true });
    expect(pruned.details).toBe('ok');
    expect(pruned.pruned).toBe(1);
    expect(pruned.ok).toBe(true);
  });

  it('reports missing when the sidecar record was deleted entirely', async () => {
    const audit = newAudit();
    await audit.append(baseEvent({ id: 'aud_1' }), { inputHash: 'in_1' });
    // Remove the record from the store, as a lost sidecar file would.
    const store = audit.detailStore as MemoryAuditDetailStore;
    const sidecar = await store.get(detailHashOf(HASHER, { inputHash: 'in_1' }), TENANT);
    expect(sidecar).toBeDefined();
    (store as unknown as { rows: Map<string, AuditDetailSidecar> }).rows.clear();
    const result = await audit.verify(TENANT, { details: true });
    expect(result.details).toBe('missing');
    expect(result.ok).toBe(true);
    expect(result.reason).toBeUndefined();
  });

  it('does not look at sidecars when the check is switched off', async () => {
    const detailStore = new MemoryAuditDetailStore();
    const audit = newAudit({ detailStore });
    await audit.append(baseEvent({ id: 'aud_1' }), { inputHash: 'in_1' });
    const sidecar = await detailStore.get(detailHashOf(HASHER, { inputHash: 'in_1' }), TENANT);
    detailStore.overwriteForTest({ ...sidecar!, detail: { inputHash: 'forged' } });
    const result = await audit.verify(TENANT, { details: false });
    expect(result.details).toBe('ok');
    expect(result.ok).toBe(true);
    // The same tampered sidecar is caught once the check runs.
    const checked = await audit.verify(TENANT, { details: true });
    expect(checked.details).toBe('mismatch');
    expect(checked.ok).toBe(false);
  });

  it('keeps the legacy checkpoint argument working', async () => {
    const audit = newAudit();
    for (let i = 0; i < 4; i += 1) await audit.append(baseEvent({ id: `aud_${i}` }), { inputHash: `in_${i}` });
    const checkpoint = await audit.checkpoint(TENANT);
    const resumed = await audit.verify(TENANT, checkpoint.checkpointHash);
    expect(resumed.ok).toBe(true);
    expect(resumed.details).toBe('ok');
    expect(resumed.reason).toMatch(/resumed from checkpoint/);

    const resumedWithDetails = await audit.verify(TENANT, { fromCheckpoint: checkpoint.checkpointHash, details: true });
    expect(resumedWithDetails.ok).toBe(true);
    expect(resumedWithDetails.details).toBe('ok');
    expect(resumedWithDetails.reason).toMatch(/resumed from checkpoint/);
  });

  it('still detects a broken chain when details are requested', async () => {
    const audit = newAudit();
    for (let i = 0; i < 3; i += 1) await audit.append(baseEvent({ id: `aud_${i}` }), { inputHash: `in_${i}` });
    audit.dropForTest(TENANT, 1);
    const result = await audit.verify(TENANT, { details: true });
    expect(result.ok).toBe(false);
    expect(result.brokenAt).toBeDefined();
  });
});

describe('detail caps and data classes', () => {
  it('truncates an over-cap detail and keeps no payload', async () => {
    const audit = newAudit({ maxDetailBytes: 256 });
    const detail = { blob: 'x'.repeat(1000) };
    const event = await audit.append(baseEvent({ id: 'aud_1' }), detail);
    expect(event.detailTruncated).toBe(true);
    expect(event.detailBytes).toBeGreaterThan(256);
    expect(event.detailHash).toBeDefined();
    const sidecar = await audit.detailStore.get(event.detailHash!, TENANT);
    expect(sidecar?.truncated).toBe(true);
    expect(sidecar?.detail).toBeUndefined();
    expect(sidecar?.bytes).toBe(event.detailBytes);
    const result = await audit.verify(TENANT, { details: true });
    expect(result.ok).toBe(true);
    expect(result.details).toBe('ok');
  });

  it('stores a detail that is exactly at the cap', async () => {
    const detail = { blob: 'x'.repeat(200) };
    const bytes = canonicalJson(detail).length;
    const audit = newAudit({ maxDetailBytes: bytes });
    const event = await audit.append(baseEvent({ id: 'aud_1' }), detail);
    expect(event.detailTruncated).toBeUndefined();
    expect(event.detailBytes).toBe(bytes);
    const sidecar = await audit.detailStore.get(event.detailHash!, TENANT);
    expect(sidecar?.detail).toEqual(detail);
  });

  it('defaults the cap to 16 KiB', () => {
    expect(DEFAULT_MAX_DETAIL_BYTES).toBe(16 * 1024);
  });

  it('keeps only the hash for a secret detail', async () => {
    const audit = newAudit();
    const event = await audit.append(baseEvent({ id: 'aud_1' }), { apiKey: 'DUMMY-KEY-NOT-A-SECRET-001' }, { dataClass: 'secret' });
    expect(event.detailStored).toBe(false);
    expect(event.detailHash).toBeDefined();
    const sidecar = await audit.detailStore.get(event.detailHash!, TENANT);
    expect(sidecar?.hashOnly).toBe(true);
    expect(sidecar?.detail).toBeUndefined();
    const result = await audit.verify(TENANT, { details: true });
    expect(result.ok).toBe(true);
    expect(result.details).toBe('ok');
  });

  it('never stores a secret payload, even in a non-secret class', async () => {
    const redactor = new RecordingRedactor('audit');
    redactor.register('DUMMY-KEY-NOT-A-SECRET-001', 'api-key');
    const audit = newAudit({ redactor });
    const event = await audit.append(baseEvent({ id: 'aud_1' }), { apiKey: 'DUMMY-KEY-NOT-A-SECRET-001', ok: 'fine' });
    const sidecar = await audit.detailStore.get(event.detailHash!, TENANT);
    expect(JSON.stringify(sidecar?.detail)).not.toContain('DUMMY-KEY-NOT-A-SECRET-001');
    expect(sidecar?.redacted).toBe(true);
    expect(event.detailRedacted).toBe(true);
    expect(redactor.hits.length).toBeGreaterThan(0);
  });

  it('hashes the redacted detail, not the raw one', async () => {
    const redactor = new RecordingRedactor('audit');
    redactor.register('DUMMY-KEY-NOT-A-SECRET-001', 'api-key');
    const audit = newAudit({ redactor });
    const event = await audit.append(baseEvent({ id: 'aud_1' }), { apiKey: 'DUMMY-KEY-NOT-A-SECRET-001' });
    expect(event.detailHash).toBe(detailHashOf(HASHER, { apiKey: '[REDACTED:api-key]' }));
  });

  it('accepts an already-redacted detail when no redactor is bound', async () => {
    const audit = newAudit();
    const event = await audit.append(baseEvent({ id: 'aud_1' }), { apiKey: '[REDACTED:api-key]' });
    expect(event.detailRedacted).toBe(false);
    expect(event.detailHash).toBe(detailHashOf(HASHER, { apiKey: '[REDACTED:api-key]' }));
  });

  it('redacts nested secrets', async () => {
    const redactor = new RecordingRedactor('audit');
    redactor.register('DUMMY-KEY-NOT-A-SECRET-001', 'api-key');
    const audit = newAudit({ redactor });
    const event = await audit.append(baseEvent({ id: 'aud_1' }), { nested: { list: ['DUMMY-KEY-NOT-A-SECRET-001', 'safe'] } });
    const sidecar = await audit.detailStore.get(event.detailHash!, TENANT);
    expect(JSON.stringify(sidecar?.detail)).not.toContain('DUMMY-KEY-NOT-A-SECRET-001');
    expect(JSON.stringify(sidecar?.detail)).toContain('[REDACTED:api-key]');
  });
});

describe('chain integration and isolation', () => {
  it('commits the detail digest to the chain', async () => {
    const audit = newAudit();
    const event = await audit.append(baseEvent({ id: 'aud_1' }), { inputHash: 'in_1' });
    // Editing the committed digest breaks the chain, not just the details.
    const internals = audit as unknown as { byTenant: Map<string, AuditEvent[]> };
    internals.byTenant.get(TENANT)![0] = { ...event, detailHash: 'sha256:forged' };
    const result = await audit.verify(TENANT, { details: true });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/hash mismatch/);
  });

  it('keeps detail sidecars tenant-scoped (I8)', async () => {
    const audit = newAudit();
    const event = await audit.append(baseEvent({ id: 'aud_1', tenantId: 'ten_a' }), { inputHash: 'in_1' });
    expect(await audit.detailStore.get(event.detailHash!, 'ten_b')).toBeUndefined();
    expect(await audit.detailStore.get(event.detailHash!, 'ten_a')).toBeDefined();
  });

  it('shares one sidecar between identical details of the same tenant', async () => {
    const audit = newAudit();
    await audit.append(baseEvent({ id: 'aud_1' }), { inputHash: 'in_1' });
    await audit.append(baseEvent({ id: 'aud_2' }), { inputHash: 'in_1' });
    const result = await audit.verify(TENANT, { details: true });
    expect(result.ok).toBe(true);
    expect(result.details).toBe('ok');
  });

  it('lists the committed digest with the event', async () => {
    const audit = newAudit();
    await audit.append(baseEvent({ id: 'aud_1' }), { inputHash: 'in_1' });
    const listed = await audit.list({ tenantId: TENANT });
    expect(listed[0]?.detailHash).toBeDefined();
    expect(listed[0]?.detailRef).toBeDefined();
  });
});
