import type { ContentBlock, Message, StopReason, ToolCall, Usage } from './types.js';
import type { SerializedError } from './errors/syao-error.js';
import type { PermissionRequest } from './permissions.js';
import type { ToolReceipt, VerificationResult } from './evidence.js';

/**
 * The event stream is the single outward-facing output of a run (ADR-02).
 * Subscribers must never mutate the objects they receive.
 *
 * Contract v2 (report A3/L1): every event carries a run-scoped envelope so a
 * stream can be replayed, audited and correlated across clients.
 */

/**
 * Permission modes. Strictness ladder:
 * strict (everything asks) < default (reads pass, writes/exec ask)
 * < acceptEdits (workspace writes also pass) < plan (read-only)
 * and bypass (everything passes; dangerous-command library still denies, BR-006).
 */
export type PermissionMode = 'strict' | 'default' | 'acceptEdits' | 'plan' | 'bypass';

export type EndReason =
  | 'completed'
  | 'aborted'
  | 'max_turns'
  | 'budget_exhausted'
  | 'timeout'
  | 'repeated_failure'
  | 'permission_denied'
  | 'unverified'
  | 'verification_failed'
  | 'fatal_error';

export interface UsageEvent {
  type: 'usage';
  usage: Usage;
  costUsd?: number;
}

export interface EventEnvelope {
  /** Monotonic per run, starting at 1. */
  seq: number;
  runId: string;
  /** Present for events produced while a turn is active. */
  turnId?: string;
  /** Direct cause: tool call id, permission request id, or message id. */
  causationId?: string;
  /** Event contract version. Optional so pre-C2 consumers keep compiling. */
  schemaVersion?: number;
  /** Wall clock at production time (Runtime.clock), not at delivery time. */
  ts?: number;
  /** Session the run belongs to; lifted out of `session.start` (C2). */
  sessionId?: string;
}

/** Event contract version stamped on every envelope (report C2). */
export const AGENT_EVENT_SCHEMA_VERSION = 2;

export type AgentEventBody =
  | { type: 'session.start'; sessionId: string; permissionMode: PermissionMode }
  | { type: 'turn.start'; turn: number }
  | { type: 'text.delta'; text: string }
  | { type: 'thinking.delta'; text: string }
  | { type: 'message.complete'; message: Message; stopReason: StopReason }
  | { type: 'tool.proposed'; call: ToolCall }
  | { type: 'permission.request'; id: string; request: PermissionRequest }
  | { type: 'permission.result'; id: string; decision: 'allow' | 'deny'; by: string }
  | { type: 'tool.start'; callId: string; name: string; input: unknown }
  | { type: 'tool.progress'; callId: string; note: string }
  | { type: 'tool.result'; callId: string; name: string; content: ContentBlock[]; isError: boolean; durationMs: number }
  | { type: 'tool.receipt'; receipt: ToolReceipt }
  | { type: 'verification.start'; command: string; index: number; total: number }
  | { type: 'verification.result'; result: VerificationResult }
  | UsageEvent
  | { type: 'budget.warning'; kind: 'tokens' | 'cost' | 'turns'; ratio: number }
  | { type: 'error'; error: SerializedError; fatal: boolean }
  | { type: 'turn.end'; turn: number }
  | { type: 'session.end'; reason: EndReason; error?: SerializedError };

export type AgentEvent = AgentEventBody & EventEnvelope;

export type AgentEventBus = AsyncIterable<AgentEvent>;

/** Bounded fan-out helper. Each subscriber gets its own queue; slow
 * subscribers receive coalesced text deltas rather than blocking others. */
export class EventBus {
  private listeners = new Set<(e: AgentEvent) => void>();
  private queue: AgentEvent[] = [];
  private resolvers: ((r: IteratorResult<AgentEvent>) => void)[] = [];
  private done = false;

  emit(event: AgentEvent): void {
    if (this.done) return;
    for (const fn of this.listeners) fn(event);
    const r = this.resolvers.shift();
    if (r !== undefined) r({ value: event, done: false });
    else this.queue.push(event);
  }

  end(): void {
    this.done = true;
    while (this.resolvers.length > 0) {
      const r = this.resolvers.shift();
      r?.({ value: undefined, done: true });
    }
  }

  /** Immediate callback subscription (no backpressure). */
  subscribe(fn: (e: AgentEvent) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  [Symbol.asyncIterator](): AsyncIterator<AgentEvent> {
    return {
      next: (): Promise<IteratorResult<AgentEvent>> => {
        const queued = this.queue.shift();
        if (queued !== undefined) return Promise.resolve({ value: queued, done: false });
        if (this.done) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => this.resolvers.push(resolve));
      },
    };
  }
}

// ── event sinks (report C3) ───────────────────────────────────────────────

/**
 * Out-of-band event channel. Unlike the run generator — which can only yield
 * after the current tool batch settles — a sink is called **synchronously at
 * production time**, so an approval request is visible to every subscriber
 * before the permission handler is awaited (report C1/C3).
 *
 * Implementations must not throw: a broken sink may not fail a run.
 */
export interface EventSink {
  emit(event: AgentEvent): void | Promise<void>;
  /** Flush buffered writes; called once at the end of each run. */
  flush?(): void | Promise<void>;
  /** Release resources; called by the host, never by the agent. */
  close?(): void | Promise<void>;
}

/** Collects events in memory — the fixture used by tests and evals. */
export class MemoryEventSink implements EventSink {
  readonly events: AgentEvent[] = [];
  private closed = false;

  emit(event: AgentEvent): void {
    if (this.closed) return;
    this.events.push(event);
  }

  get isClosed(): boolean {
    return this.closed;
  }

  close(): void {
    this.closed = true;
  }

  ofType<T extends AgentEvent['type']>(type: T): Extract<AgentEvent, { type: T }>[] {
    return this.events.filter((e): e is Extract<AgentEvent, { type: T }> => e.type === type);
  }
}

/**
 * Events worth persisting for governance (report C3). Everything else is
 * derivable from the session log or is pure streaming UI noise.
 */
export const PERSISTED_EVENT_TYPES = [
  'permission.request',
  'permission.result',
  'tool.receipt',
  'verification.start',
  'verification.result',
  'usage',
] as const;

export type PersistedEventType = (typeof PERSISTED_EVENT_TYPES)[number];

export function isPersistableEvent(event: AgentEvent): event is Extract<AgentEvent, { type: PersistedEventType }> {
  return (PERSISTED_EVENT_TYPES as readonly string[]).includes(event.type);
}

/**
 * Session-log bucket for a persisted event. `LogEntry.type` already reserves
 * every kind used here, so a sink can append straight to a session log.
 */
export type EventLogEntryType = 'permission' | 'usage' | 'checkpoint' | 'meta';

export function logEntryTypeOf(event: AgentEvent): EventLogEntryType {
  switch (event.type) {
    case 'permission.request':
    case 'permission.result':
      return 'permission';
    case 'usage':
      return 'usage';
    case 'tool.receipt':
      return 'checkpoint';
    default:
      return 'meta';
  }
}
