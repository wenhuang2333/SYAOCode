/**
 * Unified redaction entry point (I7 / P11 / 02 §8.3).
 *
 * Every value that leaves the kernel — tool results, events, receipts, audit
 * details, model context — passes through one place. Credentials resolved by a
 * `CredentialBroker` are registered here first, so a leaked key is replaced by
 * its type and never by its value.
 *
 * The kernel depends on the `Redactor` interface only; the implementation is
 * injected (core's `Redactor` in production, a recording fake in tests).
 */

import type { CanonicalEvent, CanonicalErrorShape, Receipt, UsageReport } from '../ir/types.js';
import type { SecretRedactor } from './contracts.js';

/** A redactor that keeps a record of what it replaced, for tests and audits. */
export class RecordingRedactor implements SecretRedactor {
  readonly hits: { type: string; context: string }[] = [];
  private readonly secrets: { value: string; type: string }[] = [];

  private readonly context: string;

  constructor(context = 'kernel') {
    this.context = context;
  }

  register(value: string, type = 'secret'): void {
    if (value.length >= 8) this.secrets.push({ value, type });
  }

  redact(text: string): { text: string; hits: string[] } {
    let out = text;
    const hits: string[] = [];
    for (const { value, type } of this.secrets) {
      if (out.includes(value)) {
        hits.push(type);
        out = out.split(value).join(`[REDACTED:${type}]`);
      }
    }
    if (hits.length > 0) for (const h of hits) this.hits.push({ type: h, context: this.context });
    return { text: out, hits };
  }

  redactValue<T>(value: T): { value: T; hits: string[] } {
    const hits = new Set<string>();
    const walk = (v: unknown): unknown => {
      if (typeof v === 'string') {
        const r = this.redact(v);
        for (const h of r.hits) hits.add(h);
        return r.text;
      }
      if (Array.isArray(v)) return v.map(walk);
      if (v !== null && typeof v === 'object') {
        const out: Record<string, unknown> = {};
        for (const [k, val] of Object.entries(v as Record<string, unknown>)) out[k] = walk(val);
        return out;
      }
      return v;
    };
    return { value: walk(value) as T, hits: [...hits] };
  }
}

/** Register a resolved credential for redaction and return it unchanged. */
export function registerSecret(redactor: SecretRedactor | undefined, value: string, label: string): string {
  redactor?.register(value, label);
  return value;
}

/** Scrub an event payload before it is persisted or fanned out. */
export function redactEvent<T>(redactor: SecretRedactor | undefined, event: CanonicalEvent<T>): CanonicalEvent<T> {
  if (redactor === undefined) return event;
  const { value } = redactor.redactValue(event.payload);
  return { ...event, payload: value };
}

/** Scrub a receipt's free-text fields; hashes are never touched. */
export function redactReceipt(redactor: SecretRedactor | undefined, receipt: Receipt): Receipt {
  if (redactor === undefined) return receipt;
  const { value } = redactor.redactValue(receipt);
  return value;
}

/** Scrub an error before it is shown to a model or a user. */
export function redactError(redactor: SecretRedactor | undefined, error: CanonicalErrorShape): CanonicalErrorShape {
  if (redactor === undefined) return error;
  const { value } = redactor.redactValue(error);
  return value;
}

/**
 * Cost metadata is not secret, but a usage report can carry provider echoes of
 * request bodies. Keep only the numeric fields.
 */
export function sanitizeUsage(usage: UsageReport | undefined): UsageReport | undefined {
  if (usage === undefined) return undefined;
  return {
    ...(usage.inputTokens !== undefined ? { inputTokens: usage.inputTokens } : {}),
    ...(usage.outputTokens !== undefined ? { outputTokens: usage.outputTokens } : {}),
    ...(usage.cacheReadTokens !== undefined ? { cacheReadTokens: usage.cacheReadTokens } : {}),
    ...(usage.cacheWriteTokens !== undefined ? { cacheWriteTokens: usage.cacheWriteTokens } : {}),
    ...(usage.costUsd !== undefined ? { costUsd: usage.costUsd } : {}),
    ...(usage.timeMs !== undefined ? { timeMs: usage.timeMs } : {}),
    ...(usage.toolCalls !== undefined ? { toolCalls: usage.toolCalls } : {}),
  };
}
