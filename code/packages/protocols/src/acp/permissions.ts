/**
 * ACP `session/request_permission` ↔ ARF Approval (01 §4.7.4, 03 §5.3).
 *
 * ACP is the only one of the three protocols with real approval *options*, so
 * the mapping is nearly lossless in this direction. The one hard rule:
 *
 * > ACP has no `denied` outcome. A rejection MUST be expressed as
 * > `{ outcome: "selected", optionId: <reject_*> }`; `{ outcome: "cancelled" }`
 * > means the user dismissed the request, which the kernel also treats as
 * > fail-closed.
 *
 * Both directions are provided: {@link optionsFromAcp} for ACP → ARF and
 * {@link acpOutcomeFromApproval} for ARF → ACP.
 */

import type { ApprovalOption, ApprovalOptionKind, ApprovalOutcome, ApprovalSubject } from '@syaocode/rpc';

export type AcpPermissionOptionKind = 'allow_once' | 'allow_always' | 'reject_once' | 'reject_always';

export interface AcpPermissionOption {
  optionId: string;
  name: string;
  kind: AcpPermissionOptionKind;
}

export interface AcpToolCallRef {
  toolCallId: string;
  title?: string;
  kind?: string;
  rawInput?: unknown;
  rawOutput?: unknown;
  content?: unknown[];
  locations?: unknown[];
}

export interface AcpPermissionRequest {
  sessionId: string;
  toolCall: AcpToolCallRef;
  options: AcpPermissionOption[];
}

export type AcpPermissionOutcome = { outcome: 'selected'; optionId: string } | { outcome: 'cancelled' };

// ── option kinds ──────────────────────────────────────────────────────────

export function approvalKindOfAcp(kind: AcpPermissionOptionKind): ApprovalOptionKind {
  switch (kind) {
    case 'allow_once':
      return 'allow_once';
    case 'allow_always':
      return 'allow_always';
    case 'reject_once':
      return 'deny_once';
    case 'reject_always':
      return 'deny_always';
  }
}

export function acpKindOfApproval(kind: ApprovalOptionKind): AcpPermissionOptionKind {
  switch (kind) {
    case 'allow_once':
      return 'allow_once';
    case 'allow_always':
      return 'allow_always';
    // ACP has no session-scoped option; `allow_session` degrades to
    // `allow_always` and the caller records the degradation as lossy.
    case 'allow_session':
      return 'allow_always';
    case 'deny_once':
      return 'reject_once';
    case 'deny_always':
      return 'reject_always';
  }
}

/** True when the canonical kind has no exact ACP equivalent. */
export function isLossyApprovalKind(kind: ApprovalOptionKind): boolean {
  return kind === 'allow_session';
}

export function isRejectKind(kind: AcpPermissionOptionKind): boolean {
  return kind === 'reject_once' || kind === 'reject_always';
}

// ── request mapping ───────────────────────────────────────────────────────

/** ACP options → canonical approval options (ids are preserved). */
export function optionsFromAcp(request: AcpPermissionRequest): ApprovalOption[] {
  return request.options.map((option) => ({
    id: option.optionId,
    label: option.name,
    kind: approvalKindOfAcp(option.kind),
    // `allow_always` must be scoped (01 §4.7.3 rule 4).
    ...(option.kind === 'allow_always' || option.kind === 'reject_always'
      ? { scope: { capabilityId: request.toolCall.toolCallId } }
      : {}),
  }));
}

/** Canonical approval options → ACP options. */
export function optionsToAcp(options: readonly ApprovalOption[]): AcpPermissionOption[] {
  return options.map((option) => ({ optionId: option.id, name: option.label, kind: acpKindOfApproval(option.kind) }));
}

/**
 * Kernel-authored approval subject. The peer's `title`/`rawInput` are
 * quarantined as untrusted detail (01 §4.7.3 rule 6).
 */
export function subjectFromToolCall(toolCall: AcpToolCallRef, sessionId: string): ApprovalSubject {
  const summary = toolCall.title !== undefined && toolCall.title.length > 0 ? `ACP tool call: ${toolCall.title}` : `ACP tool call ${toolCall.toolCallId}`;
  const detail = toolCall.rawInput !== undefined ? JSON.stringify(toolCall.rawInput) : undefined;
  return {
    kind: 'tool',
    summary,
    ...(detail !== undefined ? { detail, detailTrust: 'untrusted' as const } : {}),
    ...(toolCall.locations !== undefined
      ? { resource: { uri: `acp://session/${sessionId}/toolCall/${toolCall.toolCallId}`, operation: 'read' as const } }
      : {}),
  };
}

// ── outcome mapping ───────────────────────────────────────────────────────

/**
 * Canonical approval outcome → ACP response.
 *
 * `allowed` → `selected` with the decided (or first allow) option.
 * anything else → `selected` with a `reject_*` option when the client offered
 * one, else `cancelled` (fail closed).
 */
export function acpOutcomeFromApproval(outcome: ApprovalOutcome, options: readonly AcpPermissionOption[]): AcpPermissionOutcome {
  if (outcome.state === 'allowed') {
    const chosen = outcome.optionId !== undefined ? options.find((option) => option.optionId === outcome.optionId) : undefined;
    const allow = chosen ?? options.find((option) => !isRejectKind(option.kind));
    if (allow !== undefined) return { outcome: 'selected', optionId: allow.optionId };
    return { outcome: 'cancelled' };
  }
  const reject = options.find((option) => option.kind === 'reject_once') ?? options.find((option) => option.kind === 'reject_always');
  if (reject !== undefined) return { outcome: 'selected', optionId: reject.optionId };
  return { outcome: 'cancelled' };
}

/** ACP response → canonical approval outcome (used when the client decides). */
export function approvalFromAcpOutcome(
  response: AcpPermissionOutcome,
  options: readonly AcpPermissionOption[],
  by = 'acp-client',
): ApprovalOutcome {
  if (response.outcome === 'cancelled') return { approvalId: '', state: 'cancelled', decidedBy: by, reason: 'the client dismissed the request' };
  const option = options.find((entry) => entry.optionId === response.optionId);
  if (option === undefined) return { approvalId: '', state: 'denied', decidedBy: by, reason: 'the client selected an unknown option' };
  if (isRejectKind(option.kind)) {
    return { approvalId: '', state: 'denied', optionId: option.optionId, decidedBy: by, reason: option.name };
  }
  return { approvalId: '', state: 'allowed', optionId: option.optionId, decidedBy: by, reason: option.name };
}

// ── wire channel ──────────────────────────────────────────────────────────

/** Minimal request function the ACP edge uses to reach the editor. */
export type AcpRequester = (method: string, params: unknown, opts?: { timeoutMs?: number; signal?: AbortSignal }) => Promise<unknown>;

/**
 * The agent→client approval channel.
 *
 * `request()` sends `session/request_permission` and maps the response back to
 * a canonical {@link ApprovalOutcome}; timeouts, aborts and malformed answers
 * all resolve to `cancelled` (fail closed, 01 §4.7.3 rule 1).
 */
export class AcpApprovalChannel {
  constructor(
    private readonly request: AcpRequester,
    private readonly sessionId: string,
    private readonly timeoutMs?: number,
  ) {}

  async requestPermission(request: AcpPermissionRequest, opts?: { signal?: AbortSignal }): Promise<AcpPermissionOutcome> {
    const params = { sessionId: request.sessionId, toolCall: request.toolCall, options: request.options };
    const callOpts: { timeoutMs?: number; signal?: AbortSignal } = {};
    if (this.timeoutMs !== undefined) callOpts.timeoutMs = this.timeoutMs;
    if (opts?.signal !== undefined) callOpts.signal = opts.signal;
    try {
      const raw = (await this.request('session/request_permission', params, callOpts)) as AcpPermissionOutcome | null;
      return normalizeOutcome(raw, request.options);
    } catch {
      return { outcome: 'cancelled' };
    }
  }

  /** Convenience: send the request and return a canonical ApprovalOutcome. */
  async decide(request: AcpPermissionRequest, opts?: { signal?: AbortSignal }): Promise<ApprovalOutcome> {
    const response = await this.requestPermission(request, opts);
    return approvalFromAcpOutcome(response, request.options);
  }

  get session(): string {
    return this.sessionId;
  }
}

/** Validate an untrusted response; anything malformed fails closed. */
export function normalizeOutcome(raw: AcpPermissionOutcome | null | undefined, options: readonly AcpPermissionOption[]): AcpPermissionOutcome {
  if (raw === null || raw === undefined || typeof raw !== 'object') return { outcome: 'cancelled' };
  if (raw.outcome === 'cancelled') return { outcome: 'cancelled' };
  if (raw.outcome !== 'selected' || typeof raw.optionId !== 'string') return { outcome: 'cancelled' };
  if (!options.some((option) => option.optionId === raw.optionId)) return { outcome: 'cancelled' };
  return { outcome: 'selected', optionId: raw.optionId };
}
