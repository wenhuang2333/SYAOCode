/**
 * Shared adapter helpers.
 *
 * Every edge (MCP / A2A / ACP) implements the same frozen `ProtocolAdapter`
 * contract from `@syaocode/rpc`. This module holds the pieces that are
 * protocol-independent: deadline arithmetic, health, closure bookkeeping and
 * the "convert a wire failure into a CanonicalError" plumbing.
 *
 * Note on canonical events: adapters hand the kernel's `EventLog` an
 * `EventDraft` through `AdapterContext.append`, never a fully-formed event —
 * only the log can assign the gap-free per-task `seq` the replay contract
 * depends on. Edge-level notes are best effort: a failed append must never
 * fail the invocation it describes.
 */

import type { Logger, Runtime } from '@syaocode/core';
import {
  CanonicalError,
  canonicalFromJsonRpcError,
  type AdapterContext,
  type AuthorizedInvocation,
  type CanonicalErrorKind,
  type CanonicalErrorShape,
  type CanonicalEvent,
  type CanonicalEventType,
  type HealthStatus,
  type Protocol,
} from '@syaocode/rpc';
import {
  JsonRpcAbortedError,
  JsonRpcProtocolError,
  JsonRpcRemoteError,
  JsonRpcTimeoutError,
} from './jsonrpc.js';

/** Wall-clock helper: ISO timestamp from the injected clock. */
export function nowIso(runtime: Runtime): string {
  return new Date(runtime.clock.now()).toISOString();
}

/** Milliseconds left until `ctx.deadlineAt`; `undefined` when unbounded. */
export function remainingMs(runtime: Runtime, ctx: AdapterContext): number | undefined {
  const at = Date.parse(ctx.deadlineAt);
  if (Number.isNaN(at)) return undefined;
  return Math.max(0, at - runtime.clock.now());
}

/** True when the deadline has already passed. */
export function deadlineExceeded(runtime: Runtime, ctx: AdapterContext): boolean {
  const left = remainingMs(runtime, ctx);
  return left !== undefined && left <= 0;
}

/** A wire failure → CanonicalError, keeping the raw protocol payload. */
export function wireError(protocol: Protocol, error: unknown): CanonicalError {
  if (CanonicalError.is(error)) return error;
  if (error instanceof JsonRpcRemoteError) return canonicalFromJsonRpcError(protocol, error.raw);
  if (error instanceof JsonRpcTimeoutError) {
    return new CanonicalError({
      kind: 'timed_out',
      message: error.message,
      protocol,
      retryable: false,
      details: { sent: error.sent, timeoutMs: error.timeoutMs, method: error.method },
    });
  }
  if (error instanceof JsonRpcAbortedError) {
    return new CanonicalError({
      kind: 'cancelled',
      message: error.message,
      protocol,
      retryable: false,
      details: { sent: error.sent, method: error.method },
    });
  }
  if (error instanceof JsonRpcProtocolError) {
    return new CanonicalError({
      kind: 'invalid_request',
      message: error.message,
      protocol,
      retryable: false,
      protocolError: error.data,
    });
  }
  return CanonicalError.from(error, 'remote_error');
}

/**
 * Timeout semantics (I10 / ADR-R6): a timeout *after* the request was
 * dispatched has an unknown side effect → `indeterminate` (manual review),
 * never an automatic retry. A timeout before dispatch → `timed_out`.
 */
export function timeoutOutcome(sent: boolean): 'timed_out' | 'indeterminate' {
  return sent ? 'indeterminate' : 'timed_out';
}

/** Build a CanonicalErrorShape without an exception (for payloads). */
export function errorShape(error: CanonicalError): CanonicalErrorShape {
  return error.toShape();
}

/** Base class implementing the boilerplate half of `ProtocolAdapter`. */
export abstract class AdapterBase {
  protected closedFlag = false;
  private healthStatus: HealthStatus = 'healthy';

  constructor(
    readonly protocol: 'mcp' | 'a2a' | 'acp',
    readonly version: string,
    protected readonly runtime: Runtime,
    protected readonly logger: Logger | undefined,
  ) {}

  get closed(): boolean {
    return this.closedFlag;
  }

  protected setHealth(status: HealthStatus): void {
    this.healthStatus = status;
  }

  async health(): Promise<HealthStatus> {
    if (this.closedFlag) return 'down';
    return this.healthStatus;
  }

  async close(): Promise<void> {
    this.closedFlag = true;
    this.healthStatus = 'down';
  }
}

/** Merge lossy markers without duplicates, keeping first-seen order. */
export function mergeLossy(...groups: (readonly string[] | undefined)[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const group of groups) {
    if (group === undefined) continue;
    for (const item of group) {
      if (seen.has(item)) continue;
      seen.add(item);
      out.push(item);
    }
  }
  return out;
}

/** Error kind used when the peer simply does not implement a capability. */
export const UNSUPPORTED_CAPABILITY: CanonicalErrorKind = 'unsupported_capability';

// ── edge-level canonical events ───────────────────────────────────────────

export interface EdgeEventInput {
  type: CanonicalEventType;
  invocation: AuthorizedInvocation;
  protocol: 'mcp' | 'a2a' | 'acp';
  payload: Record<string, unknown>;
  /** Extra correlation (e.g. the wire method that produced the note). */
  causationId?: string;
}

/**
 * Append an edge-level canonical event.
 *
 * Best effort by design: the kernel owns the event log, and a logging failure
 * must never change the outcome of the invocation being described (the caller
 * still gets its `InvokeResultPayload`).
 */
export async function appendEdgeEvent(ctx: AdapterContext, input: EdgeEventInput): Promise<CanonicalEvent | undefined> {
  try {
    return await ctx.append({
      taskId: input.invocation.taskId,
      correlationId: input.invocation.invocationId,
      principalId: input.invocation.principal.id,
      protocol: input.protocol,
      type: input.type,
      payload: input.payload,
      ...(input.causationId !== undefined ? { causationId: input.causationId } : {}),
    });
  } catch (error) {
    ctx.logger.log('debug', 'edge event append failed', { type: input.type, error: String(error) });
    return undefined;
  }
}
