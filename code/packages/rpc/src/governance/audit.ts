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
 * ## `detailHash` (06 §8 / WP-3)
 *
 * The chain can prove *that* an event happened but not *what its details were*.
 * A detail payload is therefore redacted, canonicalised and hashed:
 *
 *   detailHash = 'sha256:' + H(canonicalJson(redactedDetail))
 *
 * Only the digest goes into the chain; the redacted payload lives in a sidecar
 * store (`AuditDetailStore`) that can be retained, redacted and pruned without
 * touching the chain. `verify(tenantId, { details: true })` re-reads each
 * sidecar and recomputes the digest, reporting `ok | missing | mismatch`.
 *
 * Host-agnostic: the digest is the injected `Hasher` (real SHA-256), never
 * `contentHash`.
 */

import type { IdGenerator } from '@syaocode/core';
import { canonicalJson } from '../ir/schemas.js';
import { newId } from '../ir/ids.js';
import type {
  AuditCheckpoint,
  AuditDetailSidecar,
  AuditDetailVerdict,
  AuditEvent,
  AuditVerifyResult,
  DataClass,
} from '../ir/types.js';
import type {
  AuditDetailOptions,
  AuditDetailStore,
  AuditStore,
  AuditVerifyOptions,
  Hasher,
  SecretRedactor,
} from './contracts.js';
import { deepClone } from '../runtime/projection.js';

/** 02 §10.1: checkpoint cadence when the host does not override it. */
export const DEFAULT_CHECKPOINT_EVERY = 1000;

/** 06 §8.2 / §11: per-record detail cap (16 KiB). */
export const DEFAULT_MAX_DETAIL_BYTES = 16 * 1024;

/** Algorithm prefix used by `detailHash` (the chain hash stays bare hex). */
export const DETAIL_HASH_PREFIX = 'sha256:';

/** Sidecar address prefix; the file store may scope this per tenant. */
export const DETAIL_REF_PREFIX = 'audit-details/';

export interface AuditStoreOptions {
  hash: Hasher;
  ids: IdGenerator;
  /** ISO clock; used when the caller does not stamp `ts` itself. */
  now: () => string;
  /** Append a checkpoint every N events (0 disables auto-checkpointing). */
  checkpointEvery?: number;
  /**
   * Also take a checkpoint when this much wall-clock time has passed since the
   * last one. A count-only trigger means a low-traffic or long-running process
   * may never checkpoint at all, which is what the audit meant by checkpoints
   * never being taken automatically.
   */
  checkpointIntervalMs?: number;
  /**
   * Redactor applied to audit detail payloads *before* they are hashed and
   * stored (I7). When absent, the caller must hand in an already-redacted
   * detail: the store cannot invent a policy it was not given.
   */
  redactor?: SecretRedactor;
  /** Detail sidecar seam. Defaults to an in-memory sidecar store. */
  detailStore?: AuditDetailStore;
  /** Hard ceiling for one detail payload; default {@link DEFAULT_MAX_DETAIL_BYTES}. */
  maxDetailBytes?: number;
}

// ── hashing helpers ───────────────────────────────────────────────────────

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

/**
 * Content address of a detail payload: `sha256:<hex>` over
 * `canonicalJson(detail)` (06 §8.2). Same detail ⇒ same digest, regardless of
 * key order.
 */
export function detailHashOf(hash: Hasher, detail: unknown): string {
  return `${DETAIL_HASH_PREFIX}${hash.sha256(canonicalJson(detail))}`;
}

/** Sidecar address for a digest, e.g. `audit-details/<hex>.json`. */
export function detailRefOf(detailHash: string): string {
  const bare = detailHash.startsWith(DETAIL_HASH_PREFIX) ? detailHash.slice(DETAIL_HASH_PREFIX.length) : detailHash;
  return `${DETAIL_REF_PREFIX}${bare}.json`;
}

/** Canonical UTF-8 byte length of an already-canonical JSON string. */
export function canonicalBytes(canonical: string): number {
  return new TextEncoder().encode(canonical).length;
}

/**
 * Redact a detail payload immediately before hashing (I7).
 *
 * The redactor is the injected `SecretRedactor` (core's `Redactor` satisfies it
 * structurally). With no redactor bound the payload is used verbatim — the
 * caller is then responsible for handing in an already-redacted detail.
 */
export function redactAuditDetail(
  redactor: SecretRedactor | undefined,
  detail: unknown,
): { detail: unknown; redacted: boolean; hits: string[] } {
  if (redactor === undefined) return { detail, redacted: false, hits: [] };
  const result = redactor.redactValue(detail);
  return { detail: result.value, redacted: true, hits: result.hits };
}

// ── in-memory sidecar store ───────────────────────────────────────────────

/**
 * In-memory `AuditDetailStore`.
 *
 * Content-addressed: identical details (from any event) map to one record, so
 * the first writer's `eventId` is the one recorded. Keys are tenant-scoped, so
 * tenant A can never read tenant B's payload even when the bytes are identical
 * (I8).
 */
export class MemoryAuditDetailStore implements AuditDetailStore {
  private readonly rows = new Map<string, AuditDetailSidecar>();

  async put(sidecar: AuditDetailSidecar): Promise<void> {
    const key = detailKey(sidecar.tenantId, sidecar.hash);
    // Idempotent: the record is content-addressed, so a second writer with the
    // same digest must not clobber the original provenance.
    if (this.rows.has(key)) return;
    this.rows.set(key, deepClone(sidecar));
  }

  async get(hash: string, tenantId?: string): Promise<AuditDetailSidecar | undefined> {
    const row = this.rows.get(detailKey(tenantId ?? '', hash))
      ?? (tenantId === undefined ? this.findAcrossTenants(hash) : undefined);
    if (row === undefined) return undefined;
    if (tenantId !== undefined && row.tenantId !== tenantId) return undefined;
    return deepClone(row);
  }

  /** Retention: drop the payload, keep the tombstone so `verify` reports `pruned`. */
  async prune(hash: string, tenantId?: string): Promise<boolean> {
    const row = (tenantId === undefined ? this.findAcrossTenants(hash) : this.rows.get(detailKey(tenantId, hash)));
    if (row === undefined) return false;
    const key = detailKey(row.tenantId, row.hash);
    const { detail: _detail, ...rest } = row;
    this.rows.set(key, { ...rest, pruned: true });
    return true;
  }

  /** Number of stored records (tests/ops). */
  get size(): number {
    return this.rows.size;
  }

  /** Test/ops helper: bypass the store's own API the way a corrupt file would. */
  overwriteForTest(sidecar: AuditDetailSidecar): void {
    this.rows.set(detailKey(sidecar.tenantId, sidecar.hash), deepClone(sidecar));
  }

  private findAcrossTenants(hash: string): AuditDetailSidecar | undefined {
    for (const row of this.rows.values()) if (row.hash === hash) return row;
    return undefined;
  }
}

function detailKey(tenantId: string, hash: string): string {
  return `${tenantId}\u0000${hash}`;
}

// ── store ─────────────────────────────────────────────────────────────────

/** In-memory audit log. Hosts may swap in a durable one. */
export class MemoryAuditStore implements AuditStore {
  private readonly byTenant = new Map<string, AuditEvent[]>();
  private readonly checkpoints = new Map<string, AuditCheckpoint[]>();
  private readonly hash: Hasher;
  private readonly ids: IdGenerator;
  private readonly now: () => string;
  private readonly checkpointEvery: number;
  private readonly checkpointIntervalMs: number;
  private readonly lastCheckpointAt = new Map<string, number>();
  private redactor: SecretRedactor | undefined;
  private readonly maxDetailBytes: number;
  /** Sidecar seam for `detailHash`; in-memory by default. */
  readonly detailStore: AuditDetailStore;

  /** Drop the chain so a reload can rebuild it from disk. */
  reset(): void {
    this.byTenant.clear();
    this.checkpoints.clear();
    this.lastCheckpointAt.clear();
  }

  constructor(opts: AuditStoreOptions) {
    this.hash = opts.hash;
    this.ids = opts.ids;
    this.now = opts.now;
    this.checkpointEvery = opts.checkpointEvery ?? DEFAULT_CHECKPOINT_EVERY;
    this.checkpointIntervalMs = opts.checkpointIntervalMs ?? 0;
    this.redactor = opts.redactor;
    this.maxDetailBytes = opts.maxDetailBytes ?? DEFAULT_MAX_DETAIL_BYTES;
    this.detailStore = opts.detailStore ?? new MemoryAuditDetailStore();
  }

  /** Late-bind the redactor (the fabric holds it, the store is built first). */
  setRedactor(redactor: SecretRedactor | undefined): void {
    this.redactor = redactor;
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

  /**
   * Append one event, optionally with a detail payload (06 §8.2).
   *
   * The detail is redacted (when a redactor is bound), canonicalised, hashed and
   * written to the sidecar store; the chain only receives the digest plus the
   * size/truncation facts, so a later `verify({details:true})` can prove the
   * detail was not altered.
   */
  async append(
    event: Omit<AuditEvent, 'prevHash' | 'hash' | 'id'> & { id?: string },
    detail?: unknown,
    options?: AuditDetailOptions,
  ): Promise<AuditEvent> {
    const chain = this.byTenant.get(event.tenantId) ?? [];
    const prevHash = chain.length > 0 ? chain[chain.length - 1]!.hash : '';
    // The id is part of the hashed body, so it must be resolved before sealing.
    const id = event.id !== undefined && event.id !== '' ? event.id : newId(this.ids, 'audit');
    const detailFields = detail === undefined
      ? {}
      : await this.sealDetail({ eventId: id, tenantId: event.tenantId, detail, options });
    const body = { ...event, id, ...detailFields };
    const stamped: AuditEvent = {
      ...body,
      prevHash,
      hash: auditHash(this.hash, body, prevHash),
    };
    chain.push(stamped);
    this.byTenant.set(event.tenantId, chain);
    if (this.shouldCheckpoint(event.tenantId, chain.length)) await this.checkpoint(event.tenantId);
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
   * The second argument is either a `checkpointHash` (legacy form) or
   * `{ fromCheckpoint?, details? }`.
   *
   * The result always carries a detail verdict (`details`) and a pruned count
   * (`pruned`), because the CLI prints them. `details: false` skips the
   * sidecar re-hash — the verdict is then `ok` because nothing was checked.
   *
   * Verdict semantics (06 §8.3):
   *   - `details: 'missing'` — the sidecar is gone (rotation pruned it, or it
   *     was deleted). Retention is not chain corruption, so `ok` stays true;
   *     the chain still proves the event happened, only the payload is lost.
   *   - `details: 'mismatch'` — the sidecar disagrees with the digest the chain
   *     committed to. That is tampering, so `ok` is false.
   */
  async verify(tenantId: string, opts?: string | AuditVerifyOptions): Promise<AuditVerifyResult> {
    const options: AuditVerifyOptions = typeof opts === 'string' ? { fromCheckpoint: opts } : opts ?? {};
    const events = this.byTenant.get(tenantId) ?? [];
    const checkpoints = this.checkpoints.get(tenantId) ?? [];
    const detailReport = options.details === false
      ? { details: 'ok' as AuditDetailVerdict, pruned: 0, broken: [] as string[] }
      : await this.verifyDetails(tenantId, events);
    const finish = (result: AuditVerifyResult): AuditVerifyResult => ({
      ...result,
      details: detailReport.details,
      pruned: detailReport.pruned,
      ...(detailReport.broken.length > 0 ? { detailBroken: detailReport.broken } : {}),
    });

    let start = 0;
    let expectedPrev = '';
    let note = '';
    if (options.fromCheckpoint !== undefined) {
      const anchor = checkpoints.find((checkpoint) => checkpoint.checkpointHash === options.fromCheckpoint);
      if (anchor === undefined) {
        return finish({ ok: false, checked: 0, reason: `unknown checkpoint ${options.fromCheckpoint}` });
      }
      const stored = checkpointHashOf(this.hash, tenantId, anchor.count, anchor.lastHash);
      if (stored !== anchor.checkpointHash) {
        return finish({ ok: false, checked: 0, reason: `checkpoint ${options.fromCheckpoint} is corrupt` });
      }
      if (anchor.count > events.length) {
        return finish({ ok: false, checked: 0, reason: `events missing since checkpoint ${options.fromCheckpoint}` });
      }
      start = anchor.count;
      expectedPrev = anchor.lastHash;
      note = `resumed from checkpoint ${options.fromCheckpoint}`;
    }

    for (let i = start; i < events.length; i += 1) {
      const event = events[i]!;
      if (event.prevHash !== expectedPrev) {
        return finish({ ok: false, checked: i - start, brokenAt: event.id, reason: `prevHash mismatch at index ${i}` });
      }
      const recomputed = recomputeAuditHash(this.hash, event, expectedPrev);
      if (recomputed !== event.hash) {
        return finish({ ok: false, checked: i - start, brokenAt: event.id, reason: `hash mismatch at index ${i}` });
      }
      expectedPrev = event.hash;
    }

    // Tail anchor: the newest checkpoint proves the log has not been truncated.
    const newest = checkpoints.length > 0 ? checkpoints[checkpoints.length - 1] : undefined;
    if (newest !== undefined) {
      if (events.length < newest.count) {
        return finish({ ok: false, checked: events.length - start, reason: `events missing since checkpoint at count ${newest.count}` });
      }
      const anchored = events[newest.count - 1];
      if (anchored === undefined || anchored.hash !== newest.lastHash) {
        return finish({
          ok: false,
          checked: events.length - start,
          ...(anchored !== undefined ? { brokenAt: anchored.id } : {}),
          reason: `checkpoint at count ${newest.count} does not match the chain`,
        });
      }
    }

    if (detailReport.details === 'mismatch') {
      return finish({
        ok: false,
        checked: events.length - start,
        ...(detailReport.broken.length > 0 ? { brokenAt: detailReport.broken[0] } : {}),
        reason: `detail hash mismatch at ${detailReport.broken.join(', ')}`,
      });
    }
    return finish({ ok: true, checked: events.length - start, ...(note !== '' ? { reason: note } : {}) });
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
    if (existing !== undefined && existing.count === count && existing.lastHash === lastHash) {
      this.lastCheckpointAt.set(tenantId, Date.parse(existing.at));
      return deepClone(existing);
    }
    const checkpoint: AuditCheckpoint = {
      tenantId,
      at: this.now(),
      count,
      lastHash,
      checkpointHash: checkpointHashOf(this.hash, tenantId, count, lastHash),
    };
    list.push(checkpoint);
    this.checkpoints.set(tenantId, list);
    this.lastCheckpointAt.set(tenantId, Date.parse(checkpoint.at));
    return deepClone(checkpoint);
  }

  /**
   * Count trigger OR time trigger, whichever fires first.
   *
   * The time trigger measures from the last checkpoint, and from the start of
   * the stream before the first one exists — otherwise a tenant whose only
   * trigger is the interval would never checkpoint at all.
   */
  private shouldCheckpoint(tenantId: string, count: number): boolean {
    if (this.checkpointEvery > 0 && count % this.checkpointEvery === 0) return true;
    if (this.checkpointIntervalMs <= 0) return false;
    const since = this.lastCheckpointAt.get(tenantId);
    if (since === undefined) {
      this.lastCheckpointAt.set(tenantId, Date.parse(this.now()));
      return false;
    }
    return Date.parse(this.now()) - since >= this.checkpointIntervalMs;
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

  // ── detail sealing / verification ───────────────────────────────────────

  /**
   * Redact → canonicalise → hash → sidecar (06 §8.2), returning only the fields
   * the chain is allowed to see.
   *
   * Over-cap payloads are never stored: the record keeps `bytes` and
   * `truncated:true`. `dataClass: 'secret'` payloads never reach the sidecar at
   * all — only the digest does.
   */
  private async sealDetail(input: {
    eventId: string;
    tenantId: string;
    detail: unknown;
    options: AuditDetailOptions | undefined;
  }): Promise<Pick<AuditEvent, 'detailHash' | 'detailRef' | 'detailBytes' | 'detailTruncated' | 'detailStored' | 'detailRedacted'>> {
    const { detail: redacted, redacted: wasRedacted } = redactAuditDetail(this.redactor, input.detail);
    const canonical = canonicalJson(redacted);
    const bytes = canonicalBytes(canonical);
    const hash = detailHashOf(this.hash, redacted);
    const dataClass: DataClass = input.options?.dataClass ?? 'internal';
    const cap = Math.min(input.options?.maxBytes ?? this.maxDetailBytes, this.maxDetailBytes);
    const hashOnly = dataClass === 'secret';
    const truncated = !hashOnly && bytes > cap;
    const sidecar: AuditDetailSidecar = {
      hash,
      eventId: input.eventId,
      tenantId: input.tenantId,
      bytes,
      truncated,
      redacted: wasRedacted,
      createdAt: this.now(),
      ...(hashOnly ? { hashOnly: true } : {}),
      ...(!hashOnly && !truncated ? { detail: redacted } : {}),
    };
    await this.detailStore.put(sidecar);
    return {
      detailHash: hash,
      detailRef: detailRefOf(hash),
      detailBytes: bytes,
      detailRedacted: wasRedacted,
      ...(truncated ? { detailTruncated: true } : {}),
      ...(hashOnly ? { detailStored: false } : {}),
    };
  }

  /** Re-hash every sidecar referenced by the tenant's chain (06 §8.3). */
  private async verifyDetails(
    tenantId: string,
    events: readonly AuditEvent[],
  ): Promise<{ details: AuditDetailVerdict; pruned: number; broken: string[] }> {
    let missing = false;
    let mismatch = false;
    let pruned = 0;
    const broken: string[] = [];

    for (const event of events) {
      const declared = event.detailHash;
      if (declared === undefined) continue;
      const sidecar = await this.detailStore.get(declared, tenantId);
      if (sidecar === undefined) {
        // Retention removed the payload: report it, but do not fail the chain.
        missing = true;
        continue;
      }
      const fail = (): void => {
        mismatch = true;
        if (!broken.includes(event.id)) broken.push(event.id);
      };
      if (sidecar.pruned === true) {
        pruned += 1;
        continue;
      }
      if (sidecar.tenantId !== tenantId || sidecar.hash !== declared) {
        fail();
        continue;
      }
      // Hash-only (secret data class): the payload must not exist at all.
      if (event.detailStored === false) {
        if (sidecar.detail !== undefined) fail();
        else if (event.detailBytes !== undefined && sidecar.bytes !== event.detailBytes) fail();
        continue;
      }
      // Truncated: only the digest and the size were kept, so there is nothing
      // to re-hash — but the tombstone must agree with the event.
      if (event.detailTruncated === true) {
        if (sidecar.truncated !== true || sidecar.detail !== undefined) fail();
        else if (event.detailBytes !== undefined && sidecar.bytes !== event.detailBytes) fail();
        continue;
      }
      // The chain says the payload was stored.
      if (sidecar.truncated === true || sidecar.detail === undefined) {
        fail();
        continue;
      }
      if (detailHashOf(this.hash, sidecar.detail) !== declared) fail();
      else if (event.detailBytes !== undefined && sidecar.bytes !== event.detailBytes) fail();
    }

    if (mismatch) broken.sort();
    const details: AuditDetailVerdict = mismatch ? 'mismatch' : missing ? 'missing' : 'ok';
    return { details, pruned, broken };
  }
}

function compareAudit(a: AuditEvent, b: AuditEvent): number {
  if (a.ts !== b.ts) return a.ts < b.ts ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}
