/**
 * Budget ledger (02 §7).
 *
 * Account hierarchy: tenant → project → session → task. A reservation freezes
 * an estimate across **every** ancestor of the account, so a task can never
 * spend money the tenant budget does not have (I6).
 *
 * Rules:
 *   - reserve before dispatch, settle after (P4)
 *   - the balance never goes negative; a reservation that would exceed a
 *     limit is refused with `budget_exceeded`
 *   - settling is idempotent per reservation id
 *   - actual > reserved is allowed up to the account limit; beyond that the
 *     account is frozen and later calls are refused
 *   - expired holds are released on recovery (`recoverExpired`)
 */

import type { IdGenerator } from '@syaocode/core';
import type { BudgetAccount, BudgetEstimate, BudgetReservation, UsageReport } from '../ir/types.js';
import type { BudgetLedger, BudgetStore, ReserveRequest } from './contracts.js';

export const DEFAULT_RESERVATION_TTL_MS = 120_000;
export const DEFAULT_MAX_PER_INVOCATION_USD = 0.5;

export interface BudgetLedgerOptions {
  store: BudgetStore;
  ids: IdGenerator;
  /** ISO clock. */
  now: () => string;
  /** Per-invocation ceiling used when the estimate is unknown (02 §7.2). */
  maxPerInvocationUsd?: number;
  defaultTtlMs?: number;
  /**
   * Crash recovery hook: decide whether an expired hold was actually spent.
   * Returning a cost settles it; returning undefined releases it. Without this
   * hook recovery releases, which can hand out a free call.
   */
  resolveExpired?: (reservation: BudgetReservation) => Promise<number | undefined>;
}

export class BudgetLedgerImpl implements BudgetLedger {
  private readonly store: BudgetStore;
  private readonly ids: IdGenerator;
  private readonly now: () => string;
  private readonly maxPerInvocationUsd: number;
  private readonly defaultTtlMs: number;
  private readonly resolveExpired?: (reservation: BudgetReservation) => Promise<number | undefined>;
  /**
   * Per-root-account serialization. `reserve()` is read-check-write across a
   * whole ancestor chain; without this two concurrent reservations can both
   * pass the limit check and then both commit (classic TOCTOU). Locking on the
   * OUTERMOST account serializes every sibling that shares a tenant budget.
   */
  private readonly locks = new Map<string, Promise<unknown>>();

  constructor(opts: BudgetLedgerOptions) {
    this.store = opts.store;
    this.ids = opts.ids;
    this.now = opts.now;
    this.maxPerInvocationUsd = opts.maxPerInvocationUsd ?? DEFAULT_MAX_PER_INVOCATION_USD;
    this.defaultTtlMs = opts.defaultTtlMs ?? DEFAULT_RESERVATION_TTL_MS;
    if (opts.resolveExpired !== undefined) this.resolveExpired = opts.resolveExpired;
  }

  /**
   * Run `fn` with exclusive access to a lock key. Callers queue behind each
   * other; a rejection does not break the queue.
   */
  private async withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(key) ?? Promise.resolve();
    const run = previous.then(fn, fn);
    this.locks.set(key, run.then(() => undefined, () => undefined));
    try {
      return await run;
    } finally {
      // Drop the entry once it is the tail, so the map cannot grow forever.
      const tail = this.locks.get(key);
      void tail?.then(() => {
        if (this.locks.get(key) === tail) this.locks.delete(key);
      });
    }
  }

  async ensureAccount(
    account: Omit<BudgetAccount, 'reservedUsd' | 'spentUsd' | 'tokensUsed' | 'timeUsedMs' | 'toolCallsUsed'>,
  ): Promise<BudgetAccount> {
    const existing = await this.store.get(account.id);
    if (existing !== undefined) return existing;
    const created: BudgetAccount = {
      ...account,
      reservedUsd: 0,
      spentUsd: 0,
      tokensUsed: 0,
      timeUsedMs: 0,
      toolCallsUsed: 0,
    };
    await this.store.put(created);
    return created;
  }

  async get(accountId: string): Promise<BudgetAccount | undefined> {
    return this.store.get(accountId);
  }

  async list(tenantId: string): Promise<BudgetAccount[]> {
    return this.store.list(tenantId);
  }

  async canAfford(accountId: string, estimate: BudgetEstimate): Promise<boolean> {
    const chain = await this.ancestors(accountId);
    for (const account of chain) {
      if (!canReserve(account, estimate)) return false;
    }
    return true;
  }

  async reserve(req: ReserveRequest): Promise<BudgetReservation> {
    const estimate = normalizeEstimate(req.estimate, this.maxPerInvocationUsd);
    const chain = await this.ancestors(req.accountId);
    if (chain.length === 0) {
      throw new Error(`budget account '${req.accountId}' does not exist`);
    }
    const rootId = chain[0]!.id;
    // Re-read and commit under the lock: the check and the write must be one
    // critical section or concurrent callers can both pass the limit check.
    return this.withLock(rootId, async () => {
      const fresh: BudgetAccount[] = [];
      for (const account of chain) {
        const current = await this.store.get(account.id);
        if (current === undefined) throw new Error(`budget account '${account.id}' disappeared`);
        fresh.push(current);
      }
      for (const account of fresh) {
        if (!canReserve(account, estimate)) {
          throw new BudgetExceededError(account.id, account.tenantId, estimate.usd, account);
        }
      }
      return this.commitReservation(req, fresh, estimate);
    });
  }

  private async commitReservation(
    req: ReserveRequest,
    chain: BudgetAccount[],
    estimate: BudgetEstimate,
  ): Promise<BudgetReservation> {
    const createdAt = this.now();
    const reservation: BudgetReservation = {
      id: this.ids.next('rsv'),
      accountId: req.accountId,
      accountChain: chain.map((a) => a.id),
      estimate,
      createdAt,
      expiresAt: new Date(Date.parse(createdAt) + (req.ttlMs ?? this.defaultTtlMs)).toISOString(),
      state: 'held',
    };
    for (const account of chain) {
      await this.store.put({
        ...account,
        reservedUsd: account.reservedUsd + estimate.usd,
        tokensUsed: account.tokensUsed + (estimate.tokens ?? 0),
        timeUsedMs: account.timeUsedMs + (estimate.timeMs ?? 0),
        toolCallsUsed: account.toolCallsUsed + (estimate.toolCalls ?? 0),
      });
    }
    await this.store.putReservation(reservation);
    return reservation;
  }

  async settle(reservationId: string, usage: UsageReport, _receiptId?: string): Promise<BudgetReservation> {
    const reservation = await this.store.getReservation(reservationId);
    if (reservation === undefined) throw new Error(`unknown reservation '${reservationId}'`);
    if (reservation.state !== 'held') return reservation; // settle is idempotent
    return this.withLock(reservation.accountChain[0] ?? reservation.accountId, () => this.settleLocked(reservation, usage));
  }

  private async settleLocked(reservation: BudgetReservation, usage: UsageReport): Promise<BudgetReservation> {
    const actual = actualCost(usage, reservation.estimate);
    const createdAt = this.now();

    for (const accountId of reservation.accountChain) {
      const account = await this.store.get(accountId);
      if (account === undefined) continue;
      const reserved = Math.min(account.reservedUsd, reservation.estimate.usd);
      const spent = actual.usd;
      const overLimit = account.limitUsd !== undefined && account.spentUsd + spent > account.limitUsd;
      // An omitted counter means "the executor did not report it", not "it went
      // back to zero": keep the reservation's estimate so toolCallLimit keeps
      // counting a real call.
      const tokensAfter = usage.inputTokens !== undefined || usage.outputTokens !== undefined
        ? (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0)
        : (reservation.estimate.tokens ?? 0);
      const timeAfter = usage.timeMs ?? reservation.estimate.timeMs ?? 0;
      const callsAfter = usage.toolCalls ?? reservation.estimate.toolCalls ?? 0;
      await this.store.put({
        ...account,
        reservedUsd: Math.max(0, account.reservedUsd - reserved),
        spentUsd: account.spentUsd + spent,
        tokensUsed: Math.max(0, account.tokensUsed - (reservation.estimate.tokens ?? 0) + tokensAfter),
        timeUsedMs: Math.max(0, account.timeUsedMs - (reservation.estimate.timeMs ?? 0) + timeAfter),
        toolCallsUsed: Math.max(0, account.toolCallsUsed - (reservation.estimate.toolCalls ?? 0) + callsAfter),
        // Actual spending beyond the limit freezes the account (02 §7.2).
        state: overLimit ? 'frozen' : account.state,
      });
    }

    const settled: BudgetReservation = { ...reservation, state: 'settled', settledUsd: actual.usd };
    await this.store.putReservation(settled);
    void createdAt;
    return settled;
  }

  async release(reservationId: string): Promise<BudgetReservation> {
    const reservation = await this.store.getReservation(reservationId);
    if (reservation === undefined) throw new Error(`unknown reservation '${reservationId}'`);
    if (reservation.state !== 'held') return reservation;
    return this.withLock(reservation.accountChain[0] ?? reservation.accountId, () => this.releaseLocked(reservation));
  }

  private async releaseLocked(reservation: BudgetReservation): Promise<BudgetReservation> {
    for (const accountId of reservation.accountChain) {
      const account = await this.store.get(accountId);
      if (account === undefined) continue;
      await this.store.put({
        ...account,
        reservedUsd: Math.max(0, account.reservedUsd - reservation.estimate.usd),
        tokensUsed: Math.max(0, account.tokensUsed - (reservation.estimate.tokens ?? 0)),
        timeUsedMs: Math.max(0, account.timeUsedMs - (reservation.estimate.timeMs ?? 0)),
        toolCallsUsed: Math.max(0, account.toolCallsUsed - (reservation.estimate.toolCalls ?? 0)),
      });
    }
    const released: BudgetReservation = { ...reservation, state: 'released' };
    await this.store.putReservation(released);
    return released;
  }

  async recoverExpired(nowIso: string): Promise<number> {
    const held = await this.store.listReservations({ state: 'held' });
    let count = 0;
    for (const reservation of held) {
      if (Date.parse(reservation.expiresAt) > Date.parse(nowIso)) continue;
      // A hold may have been spent without ever being settled (the process
      // died mid-flight). Charging the recorded cost is correct; releasing
      // would hand out a free call.
      const spent = this.resolveExpired !== undefined ? await this.resolveExpired(reservation) : undefined;
      if (spent !== undefined) await this.settle(reservation.id, { costUsd: spent });
      else await this.release(reservation.id);
      count += 1;
    }
    return count;
  }

  /** Ancestor chain, outermost (tenant) first. */
  private async ancestors(accountId: string): Promise<BudgetAccount[]> {
    const chain: BudgetAccount[] = [];
    let current = await this.store.get(accountId);
    const guard = new Set<string>();
    while (current !== undefined && !guard.has(current.id)) {
      guard.add(current.id);
      chain.unshift(current);
      current = current.parentId !== undefined ? await this.store.get(current.parentId) : undefined;
    }
    return chain;
  }
}

export class BudgetExceededError extends Error {
  override readonly name = 'BudgetExceededError';
  readonly accountId: string;
  readonly tenantId: string;
  readonly requestedUsd: number;
  readonly account: BudgetAccount;

  constructor(accountId: string, tenantId: string, requestedUsd: number, account: BudgetAccount) {
    super(`budget exceeded on account '${accountId}': requested $${requestedUsd.toFixed(4)}, available $${Math.max(0, (account.limitUsd ?? Infinity) - account.spentUsd - account.reservedUsd).toFixed(4)}`);
    this.accountId = accountId;
    this.tenantId = tenantId;
    this.requestedUsd = requestedUsd;
    this.account = account;
  }
}

function canReserve(account: BudgetAccount, estimate: BudgetEstimate): boolean {
  if (account.state === 'frozen' || account.state === 'closed') return false;
  if (account.limitUsd !== undefined && account.spentUsd + account.reservedUsd + estimate.usd > account.limitUsd) return false;
  if (account.tokenLimit !== undefined && account.tokensUsed + (estimate.tokens ?? 0) > account.tokenLimit) return false;
  if (account.toolCallLimit !== undefined && account.toolCallsUsed + (estimate.toolCalls ?? 0) > account.toolCallLimit) return false;
  if (account.timeLimitMs !== undefined && account.timeUsedMs + (estimate.timeMs ?? 0) > account.timeLimitMs) return false;
  return true;
}

/**
 * Resolve the estimate to reserve.
 *
 * `maxPerInvocationUsd` is the ceiling used when the estimate is UNKNOWN
 * (02 §7.2) — a caller that supplies a concrete number is taken at its word,
 * otherwise a cheap-looking caller could smuggle an expensive call past the
 * ledger by under-reporting.
 */
function normalizeEstimate(estimate: BudgetEstimate | undefined, maxPerInvocationUsd: number): BudgetEstimate {
  if (estimate === undefined) return { usd: maxPerInvocationUsd };
  return {
    usd: Math.max(0, estimate.usd),
    ...(estimate.tokens !== undefined ? { tokens: estimate.tokens } : {}),
    ...(estimate.timeMs !== undefined ? { timeMs: estimate.timeMs } : {}),
    ...(estimate.toolCalls !== undefined ? { toolCalls: estimate.toolCalls } : {}),
  };
}

/**
 * Actual cost of a usage report. A gateway-reported cost wins; otherwise the
 * estimate is used, because an unknown price must never silently cost zero.
 */
function actualCost(usage: UsageReport, estimate: BudgetEstimate): BudgetEstimate {
  const usd = usage.costUsd ?? estimate.usd;
  const tokens = (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0);
  return {
    usd: Math.max(0, usd),
    tokens: tokens > 0 ? tokens : (estimate.tokens ?? 0),
    ...(usage.timeMs !== undefined ? { timeMs: usage.timeMs } : {}),
    ...(usage.toolCalls !== undefined ? { toolCalls: usage.toolCalls } : {}),
  };
}
