/**
 * MRTR — "Multi-Round Tool Retry" (MCP SEP-2322, 01 §2.1 / §4.7.4).
 *
 * A modern-era MCP server never initiates a request. When it needs user input
 * it returns
 *
 * ```json
 * { "resultType": "input_required", "requestState": "<opaque>", "inputRequests": [ … ] }
 * ```
 *
 * and the client answers by retrying **the same logical request** with
 * `inputResponses` plus the **verbatim** `requestState`. The state token is the
 * server's continuity handle: it binds the answers to the request that asked
 * for them.
 *
 * Security rules implemented here:
 *   - the echoed `requestState` must be byte-identical to the issued one —
 *     a mismatch fails closed with `-32021` (`requestStateInvalid`);
 *   - the request state is consumed exactly once (a replay fails closed);
 *   - a host without an MRTR-capable approval path must fail closed, never
 *     silently drop the answers (G1).
 */

import { CanonicalError, type ApprovalOption, type ApprovalSubject } from '@syaocode/rpc';
import { mcpRequestStateInvalid } from './errors.js';
import type { McpInputRequest } from './mapping.js';

// ── request state ─────────────────────────────────────────────────────────

export interface MrtrState {
  /** Opaque token issued by the server; MUST be echoed verbatim. */
  requestState: string;
  /** Elicitation requests the server wants answered. */
  inputRequests: McpInputRequest[];
  /** The logical request being retried (method + params fingerprint). */
  requestFingerprint: string;
}

export interface MrtrRetry {
  method: string;
  params: Record<string, unknown>;
  /** Answers keyed by the elicitation request id (or method when unkeyed). */
  inputResponses: Record<string, unknown>;
  /** The verbatim `requestState` from the original `input_required` result. */
  requestState: string;
}

/**
 * Custodian for the request states of one MCP peer.
 *
 * It only *verifies*; it never re-issues. A state is single-use so a captured
 * token cannot be replayed against a different invocation.
 */
export class MrtrCustodian {
  private readonly issued = new Map<string, { fingerprint: string; used: boolean }>();

  /** Record a state the server just issued. */
  track(state: string, fingerprint: string): void {
    this.issued.set(state, { fingerprint, used: false });
  }

  /** True when the token was issued by this custodian. */
  knows(state: string): boolean {
    return this.issued.has(state);
  }

  /**
   * Verify that `echoed` is the verbatim token for `fingerprint` and that it
   * has not been used yet. Throws `CanonicalError` (-32021) otherwise.
   */
  verify(fingerprint: string, echoed: string | undefined): string {
    if (echoed === undefined || echoed.length === 0) {
      throw mcpRequestStateInvalid('the retry did not echo requestState', { fingerprint });
    }
    const record = this.issued.get(echoed);
    if (record === undefined) {
      throw mcpRequestStateInvalid('the echoed requestState was not issued by this peer', { fingerprint });
    }
    if (record.fingerprint !== fingerprint) {
      throw mcpRequestStateInvalid('the echoed requestState belongs to a different request', {
        fingerprint,
        expected: record.fingerprint,
      });
    }
    if (record.used) {
      throw mcpRequestStateInvalid('the echoed requestState was already consumed', { fingerprint });
    }
    record.used = true;
    return echoed;
  }
}

// ── elicitation → approval ────────────────────────────────────────────────

/** Options derived from an elicitation request's enum / oneOf schema. */
export function optionsFromInputRequest(request: McpInputRequest): ApprovalOption[] {
  const schema = request.schema as { enum?: unknown; oneOf?: { const?: unknown; title?: unknown }[] } | undefined;
  const values: { value: unknown; label: string }[] = [];
  if (schema !== undefined && Array.isArray(schema.enum)) {
    for (const value of schema.enum) values.push({ value, label: String(value) });
  } else if (schema !== undefined && Array.isArray(schema.oneOf)) {
    for (const option of schema.oneOf) values.push({ value: option.const, label: String(option.title ?? option.const) });
  }
  if (values.length === 0) {
    return [
      { id: 'allow_once', label: 'Allow once', kind: 'allow_once' },
      { id: 'deny_once', label: 'Deny', kind: 'deny_once' },
    ];
  }
  return values.map((entry, index) => {
    const label = entry.label;
    const deny = /^(no|deny|reject|cancel|abort)/i.test(label) || entry.value === false;
    return {
      id: `option_${index}`,
      label,
      kind: deny ? 'deny_once' : 'allow_once',
    };
  });
}

/** Kernel-authored approval subject (04 §4.7.3 rule 6: never raw peer text). */
export function subjectFromInputRequest(request: McpInputRequest, toolName: string): ApprovalSubject {
  const method = typeof request.method === 'string' ? request.method : 'elicitation';
  const detail = typeof request.message === 'string' ? request.message : undefined;
  return {
    kind: 'tool',
    summary: `MCP tool "${toolName}" requires additional input (${method})`,
    // The peer's own wording is quarantined as untrusted detail.
    ...(detail !== undefined ? { detail, detailTrust: 'untrusted' as const } : {}),
  };
}

/** Build the `inputResponses` payload from the chosen option / raw answers. */
export function buildInputResponses(
  requests: readonly McpInputRequest[],
  answers: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const request of requests) {
    const key = request.id ?? (typeof request.method === 'string' ? request.method : undefined);
    if (key === undefined) continue;
    if (key in answers) out[key] = answers[key];
  }
  return out;
}
