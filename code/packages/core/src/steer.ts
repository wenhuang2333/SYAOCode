/**
 * Run-scoped steer channel (N-2 / FR-N-032).
 *
 * Contract (frozen): `doc/DesktopDoc/28-多轮steer行为契约.md` §3.1.
 *
 * A steer is a supplementary user instruction submitted *while an execution is
 * still running*. The queue only admits it; the run loop injects it at the next
 * safe boundary as one ordinary user message (contract §3.2/§3.3). The queue
 * itself performs no IO and holds no global state.
 */

/** Contract §2/§3.1: a steer text longer than this is rejected (Host maps it to `invalid_request`). */
export const STEER_MAX_TEXT_LENGTH = 10_000;

/** Contract §2/§3.1: fail-closed capacity of one execution's queue. */
export const STEER_DEFAULT_MAX_ITEMS = 32;

export interface SteerSubmission {
  readonly id: string;
  readonly text: string;
}

export type SteerRejectReason = 'empty' | 'too_long' | 'queue_full' | 'closed' | 'duplicate';

export type SteerPushResult =
  | { readonly accepted: true; readonly id: string; readonly position: number }
  | { readonly accepted: false; readonly id: string; readonly reason: SteerRejectReason };

/**
 * Producer-facing view of one execution's steer channel. The Host holds the
 * richer {@link SteerQueueHandle}; `RunOptions.steer` requires the handle
 * because the run loop must be able to drain it (contract §3.1).
 */
export interface SteerQueue {
  push(submission: SteerSubmission): SteerPushResult;
  readonly size: number;
  readonly closed: boolean;
}

/**
 * Consumer handle returned by {@link createSteerQueue}. `drain` is called by the
 * run loop at each safe boundary; `close` is called when the run ends, so no
 * steer outlives its execution (contract §3.2/§3.4).
 */
export interface SteerQueueHandle extends SteerQueue {
  /** Take every pending submission, FIFO. The queue keeps accepting new ones. */
  drain(): SteerSubmission[];
  /** Close the queue and return whatever was never consumed. */
  close(): SteerSubmission[];
}

/** Contract §3.4: reasons a queued steer may end up unconsumed. */
export type SteerNotConsumedReason =
  | 'aborted'
  | 'max_turns'
  | 'budget_exhausted'
  | 'timeout'
  | 'fatal_error'
  | 'repeated_failure'
  | 'closed';

/**
 * Create one execution's steer queue.
 *
 * `push` is fail-closed and never throws: rejected submissions carry a
 * {@link SteerRejectReason}. Precedence follows the contract: a closed queue
 * wins over everything, then content validation, then id de-duplication, then
 * capacity.
 */
export function createSteerQueue(opts: { maxItems?: number; maxTextLength?: number } = {}): SteerQueueHandle {
  const maxItems = opts.maxItems ?? STEER_DEFAULT_MAX_ITEMS;
  const maxTextLength = opts.maxTextLength ?? STEER_MAX_TEXT_LENGTH;
  /** Pending submissions in acceptance order. */
  let items: SteerSubmission[] = [];
  /** Every id ever accepted: a consumed id must never be admitted again. */
  const admitted = new Set<string>();
  let closed = false;

  return {
    push(submission: SteerSubmission): SteerPushResult {
      const { id, text } = submission;
      if (closed) return { accepted: false, id, reason: 'closed' };
      if (text.length === 0) return { accepted: false, id, reason: 'empty' };
      if (text.length > maxTextLength) return { accepted: false, id, reason: 'too_long' };
      if (admitted.has(id)) return { accepted: false, id, reason: 'duplicate' };
      if (items.length >= maxItems) return { accepted: false, id, reason: 'queue_full' };
      items.push({ id, text });
      admitted.add(id);
      // `position` is the 0-based slot among currently pending submissions.
      return { accepted: true, id, position: items.length - 1 };
    },

    get size(): number {
      return items.length;
    },

    get closed(): boolean {
      return closed;
    },

    drain(): SteerSubmission[] {
      const drained = items;
      items = [];
      return drained;
    },

    close(): SteerSubmission[] {
      closed = true;
      const leftover = items;
      items = [];
      return leftover;
    },
  };
}
