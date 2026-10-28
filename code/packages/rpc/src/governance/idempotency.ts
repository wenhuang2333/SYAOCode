/**
 * Idempotency (02 §9.1).
 *
 * MCP 2026-07-28 explicitly tells clients to re-send a dropped request with a
 * NEW request id, so the protocol offers no idempotency guarantee at all. The
 * kernel supplies it: `Idempotency-Key + requestHash + result cache`.
 *
 *   same key + same hash + completed  → return the cached result, no re-charge
 *   same key + same hash + in_flight  → `in_flight` (never a second side effect)
 *   same key + different hash         → `idempotency_conflict`
 *   same key + failed (retryable)     → retry allowed
 *
 * A request hash covers the input AND the capability id, so reusing a key for a
 * different capability is a conflict, not a replay.
 */

import type { IdGenerator } from '@syaocode/core';
import { canonicalJson } from '../ir/schemas.js';
import type { CanonicalErrorShape, IdempotencyRecord, SideEffect } from '../ir/types.js';
import type { Hasher, IdempotencyBegin, IdempotencyStore } from './contracts.js';

export const DEFAULT_IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;

/** Hash the logical request: capability + input (and optionally the policy revision). */
export function requestHash(hasher: Hasher, capabilityId: string, input: unknown, policyRevision?: string): string {
  return hasher.sha256(
    canonicalJson({
      capabilityId,
      input,
      ...(policyRevision !== undefined ? { policyRevision } : {}),
    }),
  );
}

/**
 * Compose the storage key. The tenant and principal are part of the key so one
 * caller can never replay another caller's result (I8).
 */
export function idempotencyKeyOf(parts: {
  tenantId: string;
  principalId: string;
  capabilityId: string;
  clientKey: string;
}): string {
  return [parts.tenantId, parts.principalId, parts.capabilityId, parts.clientKey].join('::');
}

/**
 * Generate a key when the caller supplied none. A non-idempotent capability
 * without a client key must NOT be retried automatically, so the key is bound
 * to the invocation itself (02 §9.1 last row).
 */
export function derivedKey(taskId: string, invocationId: string): string {
  return `${taskId}#${invocationId}`;
}

export interface IdempotencyStoreOptions {
  ids: IdGenerator;
  now: () => string;
  defaultTtlMs?: number;
}

/** In-memory idempotency store. Hosts may swap in a durable one. */
export class MemoryIdempotencyStore implements IdempotencyStore {
  readonly records = new Map<string, IdempotencyRecord>();
  private readonly ids: IdGenerator;
  private readonly now: () => string;
  private readonly defaultTtlMs: number;

  constructor(opts: IdempotencyStoreOptions) {
    this.ids = opts.ids;
    this.now = opts.now;
    this.defaultTtlMs = opts.defaultTtlMs ?? DEFAULT_IDEMPOTENCY_TTL_MS;
  }

  async begin(key: string, hash: string, ttlMs?: number): Promise<IdempotencyBegin> {
    const existing = this.records.get(key);
    if (existing !== undefined && Date.parse(existing.expiresAt) > Date.parse(this.now())) {
      if (existing.requestHash !== hash) return { kind: 'conflict', record: existing };
      if (existing.state === 'completed') return { kind: 'replay', record: existing };
      if (existing.state === 'in_flight') return { kind: 'in_flight', record: existing };
      // A previous attempt failed. Retrying is only safe when the failure was
      // retryable, the capability is idempotent, and the outcome is known.
      // An `indeterminate` outcome means the side effect MAY have happened:
      // retrying it would duplicate it, so it must be reviewed by a human.
      const retryable = existing.retryable === true;
      const idempotent = existing.sideEffect !== 'non_idempotent';
      const knownOutcome = existing.outcome !== 'indeterminate';
      if (!retryable || !idempotent || !knownOutcome) {
        return { kind: 'conflict', record: existing };
      }
      const retried: IdempotencyRecord = {
        ...existing,
        state: 'in_flight',
        createdAt: this.now(),
        expiresAt: this.expiry(ttlMs),
      };
      this.records.set(key, retried);
      return { kind: 'new', record: retried };
    }

    const record: IdempotencyRecord = {
      key,
      requestHash: hash,
      state: 'in_flight',
      createdAt: this.now(),
      expiresAt: this.expiry(ttlMs),
    };
    this.records.set(key, record);
    void this.ids;
    return { kind: 'new', record };
  }

  async get(key: string): Promise<IdempotencyRecord | undefined> {
    return this.records.get(key);
  }

  async complete(key: string, result: unknown, resultRef?: string): Promise<void> {
    const existing = this.records.get(key);
    if (existing === undefined) return;
    this.records.set(key, {
      ...existing,
      state: 'completed',
      result,
      ...(resultRef !== undefined ? { resultRef } : {}),
    });
  }

  async fail(
    key: string,
    error: CanonicalErrorShape,
    meta?: { retryable?: boolean; sideEffect?: SideEffect; outcome?: string },
  ): Promise<void> {
    const existing = this.records.get(key);
    if (existing === undefined) return;
    this.records.set(key, {
      ...existing,
      state: 'failed',
      error,
      ...(meta?.retryable !== undefined ? { retryable: meta.retryable } : {}),
      ...(meta?.sideEffect !== undefined ? { sideEffect: meta.sideEffect } : {}),
      ...(meta?.outcome !== undefined ? { outcome: meta.outcome } : {}),
    });
  }

  private expiry(ttlMs?: number): string {
    return new Date(Date.parse(this.now()) + (ttlMs ?? this.defaultTtlMs)).toISOString();
  }
}
