import type { ContentBlock, Message, StopReason, ToolCall, Usage } from './types.js';
import type { SerializedError } from './errors/syao-error.js';

/**
 * The event stream is the single outward-facing output of a run (ADR-02).
 * Subscribers must never mutate the objects they receive.
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
  | 'fatal_error';

export interface UsageEvent {
  type: 'usage';
  usage: Usage;
  costUsd?: number;
}

export type AgentEvent =
  | { type: 'session.start'; sessionId: string; permissionMode: PermissionMode }
  | { type: 'turn.start'; turn: number }
  | { type: 'text.delta'; text: string }
  | { type: 'thinking.delta'; text: string }
  | { type: 'message.complete'; message: Message; stopReason: StopReason }
  | { type: 'tool.proposed'; call: ToolCall }
  | { type: 'permission.request'; id: string; call: ToolCall; reason: string }
  | { type: 'permission.result'; id: string; decision: 'allow' | 'deny'; by: string }
  | { type: 'tool.start'; callId: string; name: string; input: unknown }
  | { type: 'tool.progress'; callId: string; note: string }
  | { type: 'tool.result'; callId: string; name: string; content: ContentBlock[]; isError: boolean; durationMs: number }
  | UsageEvent
  | { type: 'budget.warning'; kind: 'tokens' | 'cost' | 'turns'; ratio: number }
  | { type: 'error'; error: SerializedError; fatal: boolean }
  | { type: 'turn.end'; turn: number }
  | { type: 'session.end'; reason: EndReason; error?: SerializedError };

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
