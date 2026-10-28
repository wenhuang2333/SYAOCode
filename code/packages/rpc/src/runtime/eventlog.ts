/**
 * Event log — append-only, per-task, gap-free sequence (01 §4.4, 02 §3 I1).
 *
 * Guarantees:
 *   - `seq` starts at 1 per task and is gap-free; append is serialized so two
 *     concurrent appends can never claim the same seq.
 *   - `list(taskId, afterSeq)` replays the log in seq order; `afterSeq` is
 *     exclusive, so `list(t, 0)` replays everything.
 *   - `snapshot(taskId)` rebuilds the projected task from the log.
 *   - events are immutable once written (append-only); nothing rewrites history.
 *
 * Delivery semantics: **at-least-once**. A subscriber that reconnects replays
 * from its last applied seq and may observe an event again, so every consumer
 * must be idempotent (apply-once semantics live in the projection: re-applying
 * the current state is a no-op). Ordering is guaranteed per task, not across
 * tasks.
 *
 * Host-agnostic: no `node:` imports, ids and the clock are injected.
 */

import type { IdGenerator } from '@syaocode/core';
import { newId } from '../ir/ids.js';
import type { CanonicalEvent, Task } from '../ir/types.js';
import type { EventLog } from '../governance/contracts.js';
import { applyEvent, deepClone } from './projection.js';
import type { EventDraft } from '../governance/contracts.js';

export interface EventLogOptions {
  ids: IdGenerator;
  /** ISO clock; used when the caller does not stamp `ts` itself. */
  now: () => string;
}

/**
 * Event body accepted by {@link MemoryEventLog.append} (seq/id/ts are stamped).
 * Re-exported from the frozen contract so adapters and hosts share one shape.
 */
export type { EventDraft } from '../governance/contracts.js';

type Waiter = {
  taskId: string;
  afterSeq: number;
  resolve: (value: CanonicalEvent | undefined) => void;
  done: boolean;
};

/** In-memory event log. Hosts may swap in a durable one. */
export class MemoryEventLog implements EventLog {
  private readonly byTask = new Map<string, CanonicalEvent[]>();
  private readonly waiters = new Set<Waiter>();
  private readonly ids: IdGenerator;
  private readonly now: () => string;
  /** Serializes appends so seq allocation stays gap-free under concurrency. */
  private tail: Promise<unknown> = Promise.resolve();

  constructor(opts: EventLogOptions) {
    this.ids = opts.ids;
    this.now = opts.now;
  }

  async append(event: EventDraft): Promise<CanonicalEvent> {
    // Queue behind the previous append so seq allocation is serialized.
    const run = this.tail.then(
      () => this.appendNow(event),
      () => this.appendNow(event),
    );
    this.tail = run.catch(() => undefined);
    return run;
  }

  private async appendNow(event: EventDraft): Promise<CanonicalEvent> {
    const list = this.byTask.get(event.taskId) ?? [];
    const seq = list.length + 1;
    const stamped: CanonicalEvent = {
      schemaVersion: 1,
      eventId: newId(this.ids, 'event'),
      seq,
      taskId: event.taskId,
      correlationId: event.correlationId,
      ts: event.ts ?? this.now(),
      principalId: event.principalId,
      protocol: event.protocol,
      type: event.type,
      payload: event.payload,
      ...(event.invocationId !== undefined ? { invocationId: event.invocationId } : {}),
      ...(event.causationId !== undefined ? { causationId: event.causationId } : {}),
    };
    list.push(stamped);
    this.byTask.set(event.taskId, list);
    this.wake(stamped);
    return deepClone(stamped);
  }

  async list(taskId: string, afterSeq = 0): Promise<CanonicalEvent[]> {
    const list = this.byTask.get(taskId) ?? [];
    return list.filter((event) => event.seq > afterSeq).map(deepClone);
  }

  async snapshot(taskId: string): Promise<{ task?: Task; lastSeq: number }> {
    const list = this.byTask.get(taskId) ?? [];
    let task: Task | undefined;
    for (const event of list) task = applyEvent(task, event);
    const last = list.length > 0 ? list[list.length - 1] : undefined;
    return {
      ...(task !== undefined ? { task: deepClone(task) } : {}),
      lastSeq: last?.seq ?? 0,
    };
  }

  /**
   * Stream events for a task. Replays everything after `afterSeq` first, then
   * waits for new appends. At-least-once: a reconnecting consumer may see the
   * same event twice.
   */
  async *subscribe(taskId: string, afterSeq = 0): AsyncIterable<CanonicalEvent> {
    let cursor = afterSeq;
    for (;;) {
      const buffered = await this.list(taskId, cursor);
      for (const event of buffered) {
        cursor = event.seq;
        yield event;
      }
      const next = await this.waitFor(taskId, cursor);
      if (next === undefined) return;
      cursor = next.seq;
      yield next;
    }
  }

  // ── internals ───────────────────────────────────────────────────────────

  /**
   * Wait for the next event after `afterSeq`. Registration and the replay check
   * happen in one synchronous block, so an append that lands in the microtask
   * gap can never be missed.
   */
  private waitFor(taskId: string, afterSeq: number): Promise<CanonicalEvent | undefined> {
    return new Promise<CanonicalEvent | undefined>((resolve) => {
      const waiter: Waiter = { taskId, afterSeq, resolve, done: false };
      this.waiters.add(waiter);
      const pending = (this.byTask.get(taskId) ?? []).find((event) => event.seq > afterSeq);
      if (pending !== undefined) {
        waiter.done = true;
        this.waiters.delete(waiter);
        resolve(deepClone(pending));
      }
    });
  }

  private wake(event: CanonicalEvent): void {
    for (const waiter of [...this.waiters]) {
      if (waiter.done) continue;
      if (waiter.taskId !== event.taskId) continue;
      if (event.seq <= waiter.afterSeq) continue;
      waiter.done = true;
      this.waiters.delete(waiter);
      waiter.resolve(deepClone(event));
    }
  }
}
