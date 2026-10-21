import { requireError, type ErrorCodeEntry, type ErrorCategory, type Recovery, type Severity } from './registry.js';

export interface SerializedError {
  code: string;
  category: ErrorCategory;
  severity: Severity;
  retryable: boolean;
  recovery: Recovery;
  message: string;
  details?: Record<string, unknown>;
}

export interface ErrorInit {
  code: string;
  message?: string;
  modelMessage?: string;
  details?: Record<string, unknown>;
  cause?: unknown;
}

/** Cross-copy-safe brand: `is()` must never rely on instanceof or .name. */
const SYAO_BRAND = Symbol.for('syaocode.error');

/**
 * The only error type that may cross a package boundary (BR-025).
 * Identify with `SyaoError.is(e)` — never `instanceof`, which breaks when
 * multiple copies of the package are loaded.
 */
export class SyaoError extends Error {
  override readonly name: string = 'SyaoError';
  readonly code: string;
  readonly category: ErrorCategory;
  readonly severity: Severity;
  readonly retryable: boolean;
  readonly recovery: Recovery;
  readonly registry: ErrorCodeEntry;
  readonly modelMessage?: string;
  readonly details?: Record<string, unknown>;
  readonly rawCause?: unknown;

  constructor(init: ErrorInit) {
    const entry = requireError(init.code);
    super(init.message ?? entry.description, { cause: init.cause });
    this.code = entry.code;
    this.category = entry.category;
    this.severity = entry.severity;
    this.retryable = entry.retryable;
    this.recovery = entry.recovery;
    this.registry = entry;
    if (init.modelMessage !== undefined) this.modelMessage = init.modelMessage;
    if (init.details !== undefined) this.details = init.details;
    this.rawCause = init.cause;
    Object.defineProperty(this, SYAO_BRAND, { value: true, enumerable: false });
  }

  toJSON(): SerializedError {
    const out: SerializedError = {
      code: this.code,
      category: this.category,
      severity: this.severity,
      retryable: this.retryable,
      recovery: this.recovery,
      message: this.message,
    };
    if (this.details !== undefined) out.details = this.details;
    return out;
  }

  /** True when the run must stop immediately (09 §9.4). */
  get fatal(): boolean {
    return this.severity === 'fatal';
  }

  static is(e: unknown): e is SyaoError {
    return (
      typeof e === 'object' &&
      e !== null &&
      (e as Record<symbol, unknown>)[SYAO_BRAND] === true
    );
  }

  /** Wrap a non-SyaoError throw into SY-INT-001; pass SyaoError through. */
  static wrap(e: unknown, defaults: Partial<ErrorInit> = {}): SyaoError {
    if (SyaoError.is(e)) return e;
    const message = e instanceof Error ? e.message : String(e);
    return new SyaoError({
      code: 'SY-INT-001',
      message: defaults.message ?? message,
      ...(defaults.modelMessage !== undefined ? { modelMessage: defaults.modelMessage } : {}),
      ...(defaults.details !== undefined ? { details: defaults.details } : {}),
      cause: e,
    });
  }
}

export class ProviderError extends SyaoError {
  override readonly name = 'ProviderError';
  readonly status?: number;
  readonly requestId?: string;
  readonly retryAfterMs?: number;
  constructor(init: ErrorInit & { status?: number; requestId?: string; retryAfterMs?: number }) {
    super(init);
    if (init.status !== undefined) this.status = init.status;
    if (init.requestId !== undefined) this.requestId = init.requestId;
    if (init.retryAfterMs !== undefined) this.retryAfterMs = init.retryAfterMs;
  }
}

export class ToolError extends SyaoError {
  override readonly name = 'ToolError';
  readonly toolName?: string;
  readonly callId?: string;
  constructor(init: ErrorInit & { toolName?: string; callId?: string }) {
    super(init);
    if (init.toolName !== undefined) this.toolName = init.toolName;
    if (init.callId !== undefined) this.callId = init.callId;
  }
}

export class PermissionError extends SyaoError {
  override readonly name = 'PermissionError';
  constructor(init: ErrorInit) {
    super(init);
  }
}

export class FsError extends SyaoError {
  override readonly name = 'FsError';
  constructor(init: ErrorInit) {
    super(init);
  }
}

export class ContextError extends SyaoError {
  override readonly name = 'ContextError';
  constructor(init: ErrorInit) {
    super(init);
  }
}

export class SessionError extends SyaoError {
  override readonly name = 'SessionError';
  constructor(init: ErrorInit) {
    super(init);
  }
}

export class InternalError extends SyaoError {
  override readonly name = 'InternalError';
  constructor(init: ErrorInit) {
    super(init);
  }
}
