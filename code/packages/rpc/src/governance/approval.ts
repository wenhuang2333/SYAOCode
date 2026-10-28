/**
 * Approval broker (02 §6).
 *
 * Invariants enforced here:
 *   I9  single winner — concurrent decisions use a CAS on `revision`; the
 *       loser gets `false` (surfaced as `already_decided`)
 *   I9  fail closed — timeout, cancellation, disconnect and malformed answers
 *       all resolve to `denied`, never to allow
 *   §6.5 recheck — a policy revision change while pending re-evaluates the
 *       request; allow auto-resolves, deny rejects, still-ask re-presents with
 *       `revision + 1`, and more than 8 rounds denies (`approval_loop_exceeded`)
 *   §6.4 sensitive subjects can never be remembered: only one-shot options
 *       survive normalization
 */

import type { IdGenerator } from '@syaocode/core';
import type { ApprovalOption, ApprovalRecord, Effect } from '../ir/types.js';
import type { ApprovalBroker, ApprovalOutcome, ApprovalRequest, ApprovalStore } from './contracts.js';

export const DEFAULT_APPROVAL_TIMEOUT_MS = 5 * 60 * 1000;
export const DEFAULT_MAX_APPROVAL_ROUNDS = 8;

export interface ApprovalBrokerOptions {
  store: ApprovalStore;
  ids: IdGenerator;
  /** ISO clock. */
  now: () => string;
  /** Host-agnostic sleep (Runtime.clock.sleep in production). */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  defaultTimeoutMs?: number;
  maxRounds?: number;
  /**
   * Present a pending approval to the authority (TUI panel, ACP request,
   * A2A status, MCP InputRequired). Must not decide on its own.
   */
  present?: (record: ApprovalRecord) => void | Promise<void>;
  /** Called when an approval expires or is cancelled, so the UI can retract it. */
  onExpire?: (record: ApprovalRecord) => void | Promise<void>;
  /** Re-evaluate policy for a pending approval after a revision change. */
  recheckPolicy?: (record: ApprovalRecord) => Promise<Effect | undefined>;
}

const ONCE: ApprovalOption = { id: 'allow_once', label: 'Allow once', kind: 'allow_once' };
const SESSION: ApprovalOption = { id: 'allow_session', label: 'Allow for this session', kind: 'allow_session' };
const ALWAYS: ApprovalOption = { id: 'allow_always', label: 'Always allow', kind: 'allow_always' };
const DENY_ONCE: ApprovalOption = { id: 'deny_once', label: 'Deny once', kind: 'deny_once' };
const DENY_ALWAYS: ApprovalOption = { id: 'deny_always', label: 'Always deny', kind: 'deny_always' };

export function defaultApprovalOptions(sensitive: boolean): ApprovalOption[] {
  return sensitive ? [ONCE, DENY_ONCE] : [ONCE, SESSION, ALWAYS, DENY_ONCE, DENY_ALWAYS];
}

/**
 * Strip rememberable options from sensitive subjects: a credential path or a
 * workspace secret must be approved one call at a time (02 §6.4).
 */
export function normalizeOptions(options: ApprovalOption[], sensitive: boolean): ApprovalOption[] {
  if (!sensitive) return options;
  const filtered = options.filter((o) => o.kind === 'allow_once' || o.kind === 'deny_once' || o.kind === 'deny_always');
  return filtered.length > 0 ? filtered : [ONCE, DENY_ONCE];
}

export function isAllowOption(option: ApprovalOption | undefined): boolean {
  if (option === undefined) return false;
  return option.kind === 'allow_once' || option.kind === 'allow_session' || option.kind === 'allow_always';
}

export class ApprovalBrokerImpl implements ApprovalBroker {
  private readonly store: ApprovalStore;
  private readonly ids: IdGenerator;
  private readonly now: () => string;
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  private readonly defaultTimeoutMs: number;
  private readonly maxRounds: number;
  private readonly present?: (record: ApprovalRecord) => void | Promise<void>;
  private readonly onExpire?: (record: ApprovalRecord) => void | Promise<void>;
  private readonly recheckPolicy?: (record: ApprovalRecord) => Promise<Effect | undefined>;

  private readonly waiters = new Map<string, (outcome: ApprovalOutcome) => void>();
  private readonly rounds = new Map<string, number>();
  /** Cancellable timeout per pending approval (see request()). */
  private readonly timers = new Map<string, AbortController>();

  constructor(opts: ApprovalBrokerOptions) {
    this.store = opts.store;
    this.ids = opts.ids;
    this.now = opts.now;
    this.sleep = opts.sleep ?? ((ms, signal) => defaultSleep(ms, signal));
    this.defaultTimeoutMs = opts.defaultTimeoutMs ?? DEFAULT_APPROVAL_TIMEOUT_MS;
    this.maxRounds = opts.maxRounds ?? DEFAULT_MAX_APPROVAL_ROUNDS;
    if (opts.present !== undefined) this.present = opts.present;
    if (opts.onExpire !== undefined) this.onExpire = opts.onExpire;
    if (opts.recheckPolicy !== undefined) this.recheckPolicy = opts.recheckPolicy;
  }

  async request(req: ApprovalRequest): Promise<ApprovalOutcome> {
    const sensitive = req.sensitive === true;
    const timeoutMs = req.timeoutMs ?? this.defaultTimeoutMs;
    const createdAt = this.now();
    const record: ApprovalRecord = {
      id: this.ids.next('apr'),
      tenantId: req.tenantId,
      taskId: req.taskId,
      ...(req.invocationId !== undefined ? { invocationId: req.invocationId } : {}),
      subject: req.subject,
      options: normalizeOptions(req.options ?? defaultApprovalOptions(sensitive), sensitive),
      authority: req.authority,
      delegationChain: req.delegationChain ?? [],
      policyRevision: req.policyRevision,
      revision: 1,
      state: 'pending',
      createdAt,
      expiresAt: new Date(Date.parse(createdAt) + timeoutMs).toISOString(),
      sensitive,
    };
    this.rounds.set(record.id, 1);
    await this.store.insert(record);

    // The timeout must be cancellable: a leaked timer keeps the host's event
    // loop alive (a one-shot CLI would linger for the whole approval window).
    const timer = new AbortController();
    this.timers.set(record.id, timer);

    const decided = new Promise<ApprovalOutcome>((resolve) => {
      this.waiters.set(record.id, resolve);
    });

    if (this.present !== undefined) await this.present(record);

    try {
      return await this.awaitWithTimeout(record, decided, timeoutMs, timer.signal);
    } finally {
      // Cancel the pending timeout and drop the bookkeeping for this request.
      timer.abort();
      this.timers.delete(record.id);
      this.waiters.delete(record.id);
      this.rounds.delete(record.id);
    }
  }

  private async awaitWithTimeout(
    record: ApprovalRecord,
    decided: Promise<ApprovalOutcome>,
    timeoutMs: number,
    signal: AbortSignal,
  ): Promise<ApprovalOutcome> {
    const timeout = (async (): Promise<ApprovalOutcome> => {
      await this.sleep(timeoutMs, signal);
      // A decision that arrived first cancelled the timer: do not expire a
      // record that is already terminal (and never race the CAS).
      if (signal.aborted) {
        return { approvalId: record.id, state: 'cancelled', reason: 'decided before the timeout' };
      }
      return this.expire(record.id);
    })();

    return Promise.race([decided, timeout]);
  }

  private async expire(approvalId: string): Promise<ApprovalOutcome> {
    const current = await this.store.get(approvalId);
    if (current === undefined || current.state !== 'pending') {
      return {
        approvalId,
        state: current?.state === 'allowed' ? 'allowed' : 'denied',
        ...(current?.decisionOptionId !== undefined ? { optionId: current.decisionOptionId } : {}),
        reason: 'already decided',
      };
    }
    const ok = await this.store.decide(approvalId, current.revision, {
      state: 'expired',
      decidedAt: this.now(),
      decidedBy: 'timeout',
      decisionReason: 'Approval timed out; treated as deny (fail closed).',
    });
    if (!ok) {
      const after = await this.store.get(approvalId);
      return this.outcomeOf(after, 'denied');
    }
    if (this.onExpire !== undefined) await this.onExpire({ ...current, state: 'expired' });
    const resolved: ApprovalOutcome = {
      approvalId,
      state: 'expired',
      reason: 'Approval timed out; treated as deny (fail closed).',
    };
    this.resolve(approvalId, resolved);
    return resolved;
  }

  async decide(approvalId: string, expectedRevision: number, decision: import('../ir/types.js').ApprovalDecision): Promise<boolean> {
    const current = await this.store.get(approvalId);
    if (current === undefined) return false;
    if (current.state !== 'pending') return false;
    const option = current.options.find((o) => o.id === decision.optionId);
    // An unknown option id is a malformed answer: deny, never guess.
    const state: ApprovalRecord['state'] = isAllowOption(option) ? 'allowed' : 'denied';
    const ok = await this.store.decide(approvalId, expectedRevision, {
      state,
      decidedAt: this.now(),
      decidedBy: decision.by,
      decisionOptionId: option?.id ?? decision.optionId,
      ...(decision.reason !== undefined ? { decisionReason: decision.reason } : {}),
    });
    if (!ok) return false;
    const resolved: ApprovalOutcome = {
      approvalId,
      state,
      optionId: option?.id ?? decision.optionId,
      decidedBy: decision.by,
      ...(decision.reason !== undefined ? { reason: decision.reason } : {}),
    };
    this.resolve(approvalId, resolved);
    return true;
  }

  async get(approvalId: string): Promise<ApprovalRecord | undefined> {
    return this.store.get(approvalId);
  }

  async listPending(filter?: { tenantId?: string; taskId?: string }): Promise<ApprovalRecord[]> {
    return this.store.list({ ...(filter ?? {}), state: 'pending' });
  }

  async cancelForTask(taskId: string, reason: string): Promise<number> {
    const pending = await this.store.list({ taskId, state: 'pending' });
    let count = 0;
    for (const record of pending) {
      const ok = await this.store.decide(record.id, record.revision, {
        state: 'cancelled',
        decidedAt: this.now(),
        decidedBy: 'system',
        decisionReason: reason,
      });
      if (!ok) continue;
      count += 1;
      this.resolve(record.id, { approvalId: record.id, state: 'cancelled', reason });
    }
    return count;
  }

  /**
   * Re-evaluate pending approvals after a policy change (§6.5).
   *
   * Returns the number of approvals that moved. A still-`ask` verdict bumps the
   * revision and re-presents; exceeding `maxRounds` denies.
   */
  async recheck(taskId: string): Promise<number> {
    if (this.recheckPolicy === undefined) return 0;
    const pending = await this.store.list({ taskId, state: 'pending' });
    let moved = 0;
    for (const record of pending) {
      const effect = await this.recheckPolicy(record);
      if (effect === undefined || effect === 'ask') {
        const round = (this.rounds.get(record.id) ?? record.revision) + 1;
        this.rounds.set(record.id, round);
        if (round > this.maxRounds) {
          await this.store.decide(record.id, record.revision, {
            state: 'denied',
            decidedAt: this.now(),
            decidedBy: 'policy-recheck',
            decisionReason: `Approval did not settle after ${this.maxRounds} rounds of policy changes (approval_loop_exceeded).`,
          });
          this.resolve(record.id, {
            approvalId: record.id,
            state: 'denied',
            reason: 'approval_loop_exceeded',
          });
          moved += 1;
          continue;
        }
        // Still pending: bump the revision so the CAS precondition changes and
        // the authority is asked again.
        const updated: ApprovalRecord = { ...record, revision: round, policyRevision: this.currentPolicyRevision(record) };
        await this.store.decide(record.id, record.revision, { revision: round, policyRevision: updated.policyRevision });
        if (this.present !== undefined) await this.present(updated);
        moved += 1;
        continue;
      }

      const state: ApprovalRecord['state'] = effect === 'allow' ? 'allowed' : 'denied';
      const ok = await this.store.decide(record.id, record.revision, {
        state,
        decidedAt: this.now(),
        decidedBy: 'policy-recheck',
        decisionReason: `Policy re-evaluation resolved this request as ${effect}.`,
      });
      if (!ok) continue;
      this.resolve(record.id, {
        approvalId: record.id,
        state,
        decidedBy: 'policy-recheck',
        reason: `policy-recheck:${effect}`,
      });
      moved += 1;
    }
    return moved;
  }

  /** Kept as a hook: the fabric passes the live revision through the record. */
  private currentPolicyRevision(record: ApprovalRecord): string {
    return record.policyRevision;
  }

  private resolve(approvalId: string, outcome: ApprovalOutcome): void {
    const waiter = this.waiters.get(approvalId);
    if (waiter !== undefined) waiter(outcome);
  }

  private outcomeOf(record: ApprovalRecord | undefined, fallback: ApprovalOutcome['state']): ApprovalOutcome {
    if (record === undefined) return { approvalId: 'unknown', state: fallback };
    return {
      approvalId: record.id,
      state: record.state === 'pending' ? fallback : (record.state as ApprovalOutcome['state']),
      ...(record.decisionOptionId !== undefined ? { optionId: record.decisionOptionId } : {}),
      ...(record.decidedBy !== undefined ? { decidedBy: record.decidedBy } : {}),
      ...(record.decisionReason !== undefined ? { reason: record.decisionReason } : {}),
    };
  }
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    if (signal?.aborted === true) {
      resolve();
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}
