/**
 * Audit log — append-only, per-tenant SHA-256 chain (02 §10, C6).
 *
 * Each tenant has its own chain:
 *
 *   prevHash = previous event's hash (empty string for the first link)
 *   hash     = H(prevHash + '\0' + canonicalJson({ ...event, prevHash }))
 *
 * `verify()` recomputes the chain and therefore detects a modified link, a
 * re-ordered link, and a link deleted from the middle. A link deleted from the
 * TAIL cannot be seen by hashing alone, which is exactly why `checkpoint()`
 * records `{ count, lastHash }` every N appends: `verify()` anchors the newest
 * checkpoint against the chain and reports `events missing since checkpoint`.
 *
 * Host-agnostic: the digest is the injected `Hasher` (real SHA-256), never
 * `contentHash`.
 */

import type { IdGenerator } from '@syaocode/core';
import { canonicalJson } from '../ir/schemas.js';
import { newId } from '../ir/ids.js';
import type { AuditCheckpoint, AuditEvent, AuditVerifyResult } from '../ir/types.js';
import type { AuditStore, Hasher } from './contracts.js';
import { deepClone } from '../runtime/projection.js';

/** 02 §10.1: checkpoint cadence when the host does not override it. */
export const DEFAULT_CHECKPOINT_EVERY = 1000;

export interface AuditStoreOptions {
  hash: Hasher;
  ids: IdGenerator;
  /** ISO clock; used when the caller does not stamp `ts` itself. */
  now: () => string;
  /** Append a checkpoint every N events (0 disables auto-checkpointing). */
  checkpointEvery?: number;
}

/** Body used for hashing: the event with `hash` removed (prevHash is included). */
export function auditBody(event: AuditEvent): Omit<AuditEvent, 'hash'> {
  const { hash: _hash, ...body } = event;
  return body;
}

/** `H(prevHash + '\0' + canonicalJson({ ...event, prevHash }))`. */
export function auditHash(hash: Hasher, body: Omit<AuditEvent, 'hash' | 'prevHash'>, prevHash: string): string {
  return hash.sha256(`${prevHash}\u0000${canonicalJson({ ...body, prevHash })}`);
}

/** Recompute the stored hash of an audit event given its chain predecessor. */
export function recomputeAuditHash(hash: Hasher, event: AuditEvent, prevHash: string): string {
  const { hash: _hash, prevHash: _prevHash, ...body } = event;
  return auditHash(hash, body, prevHash);
}

/** Checkpoint digest — recomputable from the chain alone (no wall clock). */
export function checkpointHashOf(hash: Hasher, tenantId: string, count: number, lastHash: string): string {
  return hash.sha256(canonicalJson({ tenantId, count, lastHash }));
}

/** In-memory audit log. Hosts may swap in a durable one. */
export class MemoryAuditStore implements AuditStore {
  private readonly byTenant = new Map<string, AuditEvent[]>();
  private readonly checkpoints = new Map<string, AuditCheckpoint[]>();
  private readonly hash: Hasher;
  private readonly ids: IdGenerator;
  private readonly now: () => string;
  private readonly checkpointEvery: number;

  constructor(opts: AuditStoreOptions) {
    this.hash = opts.hash;
    this.ids = opts.ids;
    this.now = opts.now;
    this.checkpointEvery = opts.checkpointEvery ?? DEFAULT_CHECKPOINT_EVERY;
  }

  /** Load a persisted chain, verifying each link as it is restored. */
  hydrate(events: readonly AuditEvent[]): void {
    for (const event of events) {
      const chain = this.byTenant.get(event.tenantId) ?? [];
      const expectedPrev = chain.length > 0 ? chain[chain.length - 1]!.hash : '';
      if (event.prevHash !== expectedPrev) {
        throw new Error(`audit chain for tenant ${event.tenantId} is broken at ${event.id}`);
      }
      chain.push(deepClone(event));
      this.byTenant.set(event.tenantId, chain);
    }
  }

  dump(): AuditEvent[] {
    return [...this.byTenant.values()].flat().map((event) => deepClone(event));
  }

  async append(event: Omit<AuditEvent, 'prevHash' | 'hash' | 'id'> & { id?: string }): Promise<AuditEvent> {
    const chain = this.byTenant.get(event.tenantId) ?? [];
    const prevHash = chain.length > 0 ? chain[chain.length - 1]!.hash : '';
    // The id is part of the hashed body, so it must be resolved before sealing.
    const body = { ...event, id: event.id !== undefined && event.id !== '' ? event.id : newId(this.ids, 'audit') };
    const stamped: AuditEvent = {
      ...body,
      prevHash,
      hash: auditHash(this.hash, body, prevHash),
    };
    chain.push(stamped);
    this.byTenant.set(event.tenantId, chain);
    if (this.checkpointEvery > 0 && chain.length % this.checkpointEvery === 0) await this.checkpoint(event.tenantId);
    return deepClone(stamped);
  }

  /** Chronological; `from` is inclusive and `limit` takes the oldest matches. */
  async list(filter?: { tenantId?: string; from?: string; limit?: number }): Promise<AuditEvent[]> {
    const chains = filter?.tenantId !== undefined
      ? [this.byTenant.get(filter.tenantId) ?? []]
      : [...this.byTenant.values()];
    let out = chains.flat().sort(compareAudit);
    if (filter?.from !== undefined) {
      const from = Date.parse(filter.from);
      out = out.filter((event) => Date.parse(event.ts) >= from);
    }
    if (filter?.limit !== undefined) out = out.slice(0, Math.max(0, filter.limit));
    return out.map(deepClone);
  }

  /**
   * Recompute the chain. Detects a modified, re-ordered or mid-chain-deleted
   * link; the newest checkpoint additionally anchors the tail.
   *
   * `fromCheckpoint` is a `checkpointHash`; when it resolves, only the links
   * after it are recomputed (the checkpoint itself is validated first).
   */
  async verify(tenantId: string, fromCheckpoint?: string): Promise<AuditVerifyResult> {
    const events = this.byTenant.get(tenantId) ?? [];
    const checkpoints = this.checkpoints.get(tenantId) ?? [];

    let start = 0;
    let expectedPrev = '';
    let note = '';
    if (fromCheckpoint !== undefined) {
      const anchor = checkpoints.find((checkpoint) => checkpoint.checkpointHash === fromCheckpoint);
      if (anchor === undefined) {
        return { ok: false, checked: 0, reason: `unknown checkpoint ${fromCheckpoint}` };
      }
      const stored = checkpointHashOf(this.hash, tenantId, anchor.count, anchor.lastHash);
      if (stored !== anchor.checkpointHash) {
        return { ok: false, checked: 0, reason: `checkpoint ${fromCheckpoint} is corrupt` };
      }
      if (anchor.count > events.length) {
        return { ok: false, checked: 0, reason: `events missing since checkpoint ${fromCheckpoint}` };
      }
      start = anchor.count;
      expectedPrev = anchor.lastHash;
      note = `resumed from checkpoint ${fromCheckpoint}`;
    }

    for (let i = start; i < events.length; i += 1) {
      const event = events[i]!;
      if (event.prevHash !== expectedPrev) {
        return { ok: false, checked: i - start, brokenAt: event.id, reason: `prevHash mismatch at index ${i}` };
      }
      const recomputed = recomputeAuditHash(this.hash, event, expectedPrev);
      if (recomputed !== event.hash) {
        return { ok: false, checked: i - start, brokenAt: event.id, reason: `hash mismatch at index ${i}` };
      }
      expectedPrev = event.hash;
    }

    // Tail anchor: the newest checkpoint proves the log has not been truncated.
    const newest = checkpoints.length > 0 ? checkpoints[checkpoints.length - 1] : undefined;
    if (newest !== undefined) {
      if (events.length < newest.count) {
        return { ok: false, checked: events.length - start, reason: `events missing since checkpoint at count ${newest.count}` };
      }
      const anchored = events[newest.count - 1];
      if (anchored === undefined || anchored.hash !== newest.lastHash) {
        return {
          ok: false,
          checked: events.length - start,
          ...(anchored !== undefined ? { brokenAt: anchored.id } : {}),
          reason: `checkpoint at count ${newest.count} does not match the chain`,
        };
      }
    }

    return { ok: true, checked: events.length - start, ...(note !== '' ? { reason: note } : {}) };
  }

  /**
   * Record `{ count, lastHash, checkpointHash }` for the tenant's current head.
   * Idempotent: re-checkpointing an unchanged head returns the same checkpoint.
   */
  async checkpoint(tenantId: string): Promise<AuditCheckpoint> {
    const events = this.byTenant.get(tenantId) ?? [];
    const list = this.checkpoints.get(tenantId) ?? [];
    const count = events.length;
    const lastHash = count > 0 ? events[count - 1]!.hash : '';
    const existing = list[list.length - 1];
    if (existing !== undefined && existing.count === count && existing.lastHash === lastHash) return deepClone(existing);
    const checkpoint: AuditCheckpoint = {
      tenantId,
      at: this.now(),
      count,
      lastHash,
      checkpointHash: checkpointHashOf(this.hash, tenantId, count, lastHash),
    };
    list.push(checkpoint);
    this.checkpoints.set(tenantId, list);
    return deepClone(checkpoint);
  }

  /** Newest checkpoint for a tenant, if any. */
  async lastCheckpoint(tenantId: string): Promise<AuditCheckpoint | undefined> {
    const list = this.checkpoints.get(tenantId) ?? [];
    const checkpoint = list[list.length - 1];
    return checkpoint === undefined ? undefined : deepClone(checkpoint);
  }

  /** All checkpoints for a tenant, oldest first. */
  async listCheckpoints(tenantId: string): Promise<AuditCheckpoint[]> {
    return (this.checkpoints.get(tenantId) ?? []).map(deepClone);
  }

  /** Test/ops helper: drop a link (only used to prove `verify` detects it). */
  dropForTest(tenantId: string, index: number): void {
    const chain = this.byTenant.get(tenantId);
    if (chain === undefined) return;
    chain.splice(index, 1);
  }
}

function compareAudit(a: AuditEvent, b: AuditEvent): number {
  if (a.ts !== b.ts) return a.ts < b.ts ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}
