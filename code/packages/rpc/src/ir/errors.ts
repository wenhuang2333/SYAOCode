/**
 * CanonicalError — the single failure vocabulary of the governance kernel
 * (01 §5 / G10, 02 §5.6).
 *
 * Adapters must translate native protocol failures into a CanonicalError and
 * preserve the raw object in `protocolError`; they must never swallow it
 * (02 §12.2). The kernel never inspects protocol-native error shapes.
 */

import type { CanonicalErrorKind, CanonicalErrorShape, Protocol } from './types.js';

/** CLI exit codes (03 §5.5). */
export const EXIT = {
  OK: 0,
  ERROR: 1,
  USAGE: 2,
  DENIED: 3,
  LIMIT: 4,
  UNVERIFIED: 5,
  VERIFY_FAILED: 6,
  UNAVAILABLE: 7,
  INTERRUPTED: 130,
} as const;

const RETRYABLE_KINDS: ReadonlySet<CanonicalErrorKind> = new Set([
  'remote_error',
  'internal',
]);

const KIND_TO_EXIT: Record<CanonicalErrorKind, number> = {
  invalid_request: EXIT.USAGE,
  unauthenticated: EXIT.DENIED,
  unauthorized: EXIT.DENIED,
  denied: EXIT.DENIED,
  capability_not_found: EXIT.UNAVAILABLE,
  unsupported_capability: EXIT.UNAVAILABLE,
  unsupported_obligation: EXIT.UNAVAILABLE,
  version_mismatch: EXIT.UNAVAILABLE,
  idempotency_conflict: EXIT.USAGE,
  in_flight: EXIT.LIMIT,
  budget_exceeded: EXIT.LIMIT,
  timed_out: EXIT.ERROR,
  cancelled: EXIT.INTERRUPTED,
  indeterminate: EXIT.UNVERIFIED,
  remote_error: EXIT.ERROR,
  internal: EXIT.ERROR,
};

/** Human wording used by the CLI/TUI; the code is the machine contract. */
const KIND_TO_MESSAGE: Record<CanonicalErrorKind, string> = {
  invalid_request: 'The request is malformed.',
  unauthenticated: 'The caller could not be authenticated.',
  unauthorized: 'The caller is not allowed to use this capability.',
  denied: 'The policy engine or the approver denied this invocation.',
  capability_not_found: 'The capability is not registered.',
  unsupported_capability: 'The peer does not support this capability.',
  unsupported_obligation: 'A required policy obligation cannot be honoured.',
  version_mismatch: 'No common protocol version with the peer.',
  idempotency_conflict: 'The idempotency key was reused with different input.',
  in_flight: 'An identical request is already in flight.',
  budget_exceeded: 'The budget account cannot cover this invocation.',
  timed_out: 'The invocation exceeded its deadline.',
  cancelled: 'The invocation was cancelled.',
  indeterminate: 'The request was sent but the outcome is unknown; manual review required.',
  remote_error: 'The remote endpoint returned an error.',
  internal: 'Internal governance error.',
};

/**
 * The numeric code a protocol should use for a canonical kind.
 *
 * Adapters used to throw `toShape()` (no numeric code) and the JSON-RPC layer
 * answered `-32603` for everything, so an A2A `TaskNotFoundError` reached the
 * peer as "internal error". Deriving a default here makes the wire code part
 * of the error object itself, so no adapter can forget it.
 */
export function defaultWireCode(protocol: Protocol, kind: CanonicalErrorKind): number | undefined {
  if (protocol === 'a2a') {
    switch (kind) {
      case 'capability_not_found':
        return A2A_ERROR_CODES.taskNotFound;
      case 'invalid_request':
      case 'cancelled':
      case 'unauthorized':
      case 'unauthenticated':
        return A2A_ERROR_CODES.taskNotCancelable;
      case 'unsupported_capability':
      case 'unsupported_obligation':
        return A2A_ERROR_CODES.unsupportedOperation;
      case 'version_mismatch':
        return A2A_ERROR_CODES.versionNotSupported;
      default:
        return -32603;
    }
  }
  if (protocol === 'mcp') {
    switch (kind) {
      case 'invalid_request':
      case 'idempotency_conflict':
        return MCP_ERROR_CODES.invalidParams;
      case 'version_mismatch':
        return MCP_ERROR_CODES.unsupportedProtocolVersion;
      case 'unsupported_capability':
      case 'unsupported_obligation':
        return MCP_ERROR_CODES.missingRequiredClientCapability;
      case 'denied':
      case 'unauthorized':
      case 'unauthenticated':
        return -32002;
      default:
        return MCP_ERROR_CODES.internalError;
    }
  }
  if (protocol === 'acp') {
    switch (kind) {
      case 'invalid_request':
      case 'idempotency_conflict':
        return ACP_ERROR_CODES.invalidParams;
      case 'unauthorized':
      case 'unauthenticated':
        return ACP_ERROR_CODES.authRequired;
      case 'capability_not_found':
        return ACP_ERROR_CODES.resourceNotFound;
      case 'unsupported_capability':
      case 'unsupported_obligation':
        return ACP_ERROR_CODES.methodNotFound;
      default:
        return ACP_ERROR_CODES.internalError;
    }
  }
  return undefined;
}

export interface CanonicalErrorInit {
  kind: CanonicalErrorKind;
  message?: string;
  /** Registry code (`SY-*`) when one applies; must exist in the registry. */
  code?: string;
  retryable?: boolean;
  /** Numeric JSON-RPC code to emit on the wire (see CanonicalErrorShape). */
  wireCode?: number;
  protocol?: Protocol;
  protocolError?: unknown;
  details?: Record<string, unknown>;
  cause?: unknown;
}

export class CanonicalError extends Error {
  override readonly name = 'CanonicalError';
  readonly kind: CanonicalErrorKind;
  readonly code?: string;
  readonly wireCode?: number;
  readonly retryable: boolean;
  readonly protocol?: Protocol;
  readonly protocolError?: unknown;
  readonly details?: Record<string, unknown>;
  readonly rawCause?: unknown;

  constructor(init: CanonicalErrorInit) {
    super(init.message ?? KIND_TO_MESSAGE[init.kind], { cause: init.cause });
    this.kind = init.kind;
    if (init.code !== undefined) this.code = init.code;
    if (init.wireCode !== undefined) this.wireCode = init.wireCode;
    else {
      // Derive the protocol default so a caller cannot forget it and silently
      // degrade every failure to -32603.
      const derived = init.protocol !== undefined ? defaultWireCode(init.protocol, init.kind) : undefined;
      if (derived !== undefined) this.wireCode = derived;
    }
    this.retryable = init.retryable ?? RETRYABLE_KINDS.has(init.kind);
    if (init.protocol !== undefined) this.protocol = init.protocol;
    if (init.protocolError !== undefined) this.protocolError = init.protocolError;
    if (init.details !== undefined) this.details = init.details;
    this.rawCause = init.cause;
  }

  get exitCode(): number {
    return KIND_TO_EXIT[this.kind];
  }

  toShape(): CanonicalErrorShape {
    const out: CanonicalErrorShape = {
      kind: this.kind,
      message: this.message,
      retryable: this.retryable,
    };
    if (this.code !== undefined) out.code = this.code;
    if (this.wireCode !== undefined) out.wireCode = this.wireCode;
    if (this.protocolError !== undefined) out.protocolError = this.protocolError;
    if (this.details !== undefined) out.details = this.details;
    return out;
  }

  static is(e: unknown): e is CanonicalError {
    return e instanceof CanonicalError;
  }

  /** Coerce any thrown value into a CanonicalError (never loses the original). */
  static from(e: unknown, fallback: CanonicalErrorKind = 'internal'): CanonicalError {
    if (CanonicalError.is(e)) return e;
    const message = e instanceof Error ? e.message : String(e);
    return new CanonicalError({ kind: fallback, message, cause: e });
  }

  static fromShape(shape: CanonicalErrorShape): CanonicalError {
    return new CanonicalError({
      kind: shape.kind,
      message: shape.message,
      retryable: shape.retryable,
      ...(shape.code !== undefined ? { code: shape.code } : {}),
      ...(shape.wireCode !== undefined ? { wireCode: shape.wireCode } : {}),
      ...(shape.protocolError !== undefined ? { protocolError: shape.protocolError } : {}),
      ...(shape.details !== undefined ? { details: shape.details } : {}),
    });
  }

  static denied(reason: string, code?: string): CanonicalError {
    return new CanonicalError({ kind: 'denied', message: reason, ...(code !== undefined ? { code } : {}) });
  }
}

// ── retry matrix (02 §9.2) ────────────────────────────────────────────────

export type RetryVerdict = 'retry' | 'no_retry' | 'manual_review';

/**
 * Decide whether an invocation may be retried automatically.
 *
 * A timeout after the request was sent has an unknown side effect: it must be
 * `indeterminate` and reviewed by a human, never retried (I10 / ADR-R6).
 */
export function retryVerdict(
  error: CanonicalError,
  opts: { sideEffect: 'none' | 'idempotent' | 'non_idempotent'; sent: boolean },
): RetryVerdict {
  if (error.kind === 'timed_out' && opts.sent) return 'manual_review';
  if (error.kind === 'indeterminate') return 'manual_review';
  if (error.kind === 'denied' || error.kind === 'unauthorized' || error.kind === 'unauthenticated') return 'no_retry';
  if (error.kind === 'budget_exceeded' || error.kind === 'invalid_request') return 'no_retry';
  if (error.kind === 'idempotency_conflict') return 'no_retry';
  if (error.kind === 'version_mismatch' || error.kind === 'unsupported_capability') return 'no_retry';
  if (!error.retryable) return 'no_retry';
  if (opts.sideEffect === 'non_idempotent') return 'no_retry';
  return 'retry';
}

// ── protocol error mapping (adapters) ─────────────────────────────────────

/**
 * Map a JSON-RPC error object (MCP / A2A / ACP all use JSON-RPC 2.0) onto a
 * CanonicalError while keeping the raw payload.
 */
export function canonicalFromJsonRpcError(protocol: Protocol, error: unknown): CanonicalError {
  const raw = error as { code?: unknown; message?: unknown; data?: unknown } | null;
  const numeric = typeof raw?.code === 'number' ? raw.code : undefined;
  const message = typeof raw?.message === 'string' ? raw.message : 'JSON-RPC error';
  return new CanonicalError({
    kind: jsonRpcKind(protocol, numeric),
    message,
    protocol,
    protocolError: error,
    ...(numeric !== undefined ? { details: { jsonRpcCode: numeric } } : {}),
  });
}

function jsonRpcKind(protocol: Protocol, code: number | undefined): CanonicalErrorKind {
  switch (code) {
    case -32700:
    case -32600:
      return 'invalid_request';
    case -32601:
      return 'unsupported_capability';
    case -32602:
      return 'invalid_request';
    case -32001:
      return protocol === 'a2a' ? 'capability_not_found' : 'remote_error';
    case -32002:
      return 'unauthorized';
    case -32003:
      return 'unsupported_capability';
    case -32004:
      return 'unsupported_capability';
    case -32010:
      // MRTR: the peer wants input before the call can complete.
      return 'invalid_request';
    case -32011:
      // MRTR: requestState missing/stale/tampered -> fail closed.
      return 'unsupported_capability';
    case -32020:
      // HeaderMismatch (MCP): the request as sent cannot be honoured.
      return 'invalid_request';
    case -32021:
      // MissingRequiredClientCapability (MCP).
      return 'unsupported_capability';
    case -32022:
      return 'version_mismatch';
    case -32009:
      // A2A VersionNotSupportedError (04 A16).
      return 'version_mismatch';
    case -32800:
      return 'cancelled';
    default:
      return 'remote_error';
  }
}

/**
 * MCP error codes ↔ CanonicalError (01 §5.2 / 04 M18).
 *
 * M18: `-32000..-32019` are implementation-defined, `-32020..-32099` are
 * reserved for MCP. The reserved three are HeaderMismatch, MissingRequired
 * ClientCapability and UnsupportedProtocolVersion — they are *not* the MRTR
 * codes, which live in the implementation-defined range.
 */
export const MCP_ERROR_CODES = {
  parseError: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internalError: -32603,
  /**
   * MRTR: the client must supply input and retry with the same requestState.
   * Lives in the implementation-defined range so the reserved -32020.. is not
   * borrowed for MRTR semantics (04 M18).
   */
  inputRequired: -32010,
  /** MRTR: requestState was missing, stale or tampered with → fail closed. */
  requestStateInvalid: -32011,
  /** 04 M18: request header does not match the body. */
  headerMismatch: -32020,
  /** 04 M18: the client lacks a capability the call requires. */
  missingRequiredClientCapability: -32021,
  /** 04 M13/M18 + M5: unsupported protocol version (HTTP 400 + this code). */
  unsupportedProtocolVersion: -32022,
  /** Kept as an alias: older call sites read `versionNegotiationFailed`. */
  versionNegotiationFailed: -32022,
} as const;

/** A2A error codes (01 §5.3 / 04 A16: `-32001 TaskNotFound` … `-32009 VersionNotSupported`). */
export const A2A_ERROR_CODES = {
  taskNotFound: -32001,
  taskNotCancelable: -32002,
  pushNotificationNotSupported: -32003,
  unsupportedOperation: -32004,
  contentTypeNotSupported: -32005,
  invalidAgentResponse: -32006,
  /** 04 A16: version negotiation failure is -32009, *not* MCP's -32022. */
  versionNotSupported: -32009,
} as const;

/** ACP error codes (01 §5.4). */
export const ACP_ERROR_CODES = {
  parseError: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internalError: -32603,
  authRequired: -32000,
  resourceNotFound: -32002,
} as const;
