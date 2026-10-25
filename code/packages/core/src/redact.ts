/**
 * Redactor (BR-023 / FR-045): every outbound write of logs, events, session
 * files and error messages passes through this. Hits record only the type —
 * never the value (SY-SEC-001 is info-level for a reason).
 */

import type { LogLevel, Logger } from './runtime/index.js';
import type { LogEntry, SessionStore } from './session/index.js';
import type { ToolResultContent } from './types.js';

const SECRET_PATTERNS: { type: string; re: RegExp }[] = [
  { type: 'openai-key', re: /\bsk-(proj-)?[A-Za-z0-9_-]{20,}\b/g },
  { type: 'anthropic-key', re: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g },
  { type: 'deepseek-key', re: /\bsk-[a-f0-9]{32}\b/g },
  { type: 'github-token', re: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g },
  { type: 'aws-access-key', re: /\bAKIA[0-9A-Z]{16}\b/g },
  { type: 'bearer', re: /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/g },
  { type: 'private-key-block', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g },
  { type: 'env-assignment', re: /\b(API_KEY|APIKEY|SECRET|TOKEN|PASSWORD|PASSWD)=(?!=)[^\s&"']+/gi },
];

export class Redactor {
  private secretValues: { value: string; type: string }[] = [];

  /** Register a concrete secret (e.g. a resolved API key) for exact matching. */
  register(value: string, type = 'secret'): void {
    if (value.length >= 8) this.secretValues.push({ value, type });
  }

  redact(text: string): { text: string; hits: string[] } {
    const hits = new Set<string>();
    let out = text;
    for (const { type, re } of SECRET_PATTERNS) {
      out = out.replace(re, () => {
        hits.add(type);
        return `[REDACTED:${type}]`;
      });
    }
    for (const { value, type } of this.secretValues) {
      if (out.includes(value)) {
        hits.add(type);
        out = out.split(value).join(`[REDACTED:${type}]`);
      }
    }
    return { text: out, hits: [...hits] };
  }

  /** Deep-redact a JSON-serializable value (mutates a copy). */
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
        for (const [k, val] of Object.entries(v)) out[k] = walk(val);
        return out;
      }
      return v;
    };
    return { value: walk(value) as T, hits: [...hits] };
  }
}

export function redactToolResultContent(content: ToolResultContent[], redactor?: Redactor): ToolResultContent[] {
  if (redactor === undefined) return content;
  return content.map((c) => (c.type === 'text' ? { ...c, text: redactor.redact(c.text).text } : c));
}

/** Logger decorator: secret values never reach the log sink. */
export class RedactingLogger implements Logger {
  constructor(private readonly inner: Logger, private readonly redactor: Redactor) {}
  log(level: LogLevel, msg: string, fields?: Record<string, unknown>): void {
    const redacted = this.redactor.redactValue({ msg, fields });
    this.inner.log(level, redacted.value.msg, redacted.value.fields);
  }
}

/** Session-store decorator: redact every entry before it is persisted. */
export class RedactingSessionStore implements SessionStore {
  constructor(private readonly inner: SessionStore, private readonly redactor: Redactor) {}
  async append(sessionId: string, entries: LogEntry[]): Promise<void> {
    await this.inner.append(
      sessionId,
      entries.map((entry) => ({ ...entry, data: this.redactor.redactValue(entry.data).value })),
    );
  }
  load(sessionId: string): Promise<LogEntry[]> {
    return this.inner.load(sessionId);
  }
  list(filter?: { limit?: number }) {
    return this.inner.list(filter);
  }
  fork(sessionId: string, atEntryId?: string): Promise<string> {
    return this.inner.fork(sessionId, atEntryId);
  }
  delete(sessionId: string): Promise<void> {
    return this.inner.delete(sessionId);
  }
}
