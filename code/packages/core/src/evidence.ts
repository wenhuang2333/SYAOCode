import type { Runtime } from './runtime/index.js';
import { contentHash } from './hash.js';

/**
 * Evidence ledger MVP (report §12 / v0.2.5).
 *
 * Every tool call leaves a receipt. Outputs are content-addressed so a report
 * can show the actual bytes, not just a hash; `scope` distinguishes related
 * tests from a full run so wording can stay honest.
 */

export type TrustLevel = 'trusted' | 'workspace' | 'untrusted';

export interface TestStats {
  total: number;
  passed: number;
  failed: number;
  skipped: number;
}

export interface StoredOutput {
  hash: string;
  ref: string;
}

export interface ReceiptStore {
  put(text: string): Promise<StoredOutput>;
  get(ref: string): Promise<string | undefined>;
}

export class MemoryReceiptStore implements ReceiptStore {
  readonly entries = new Map<string, string>();
  async put(text: string): Promise<StoredOutput> {
    const hash = contentHash(text);
    const ref = `mem://${hash}`;
    if (!this.entries.has(ref)) this.entries.set(ref, text);
    return { hash, ref };
  }
  async get(ref: string): Promise<string | undefined> {
    return this.entries.get(ref);
  }
}

export interface ToolReceipt {
  callId: string;
  tool: string;
  /** Wall clock at tool start. */
  timestamp: number;
  durationMs: number;
  inputHash: string;
  outputHash: string;
  /** Present when a ReceiptStore is configured; the bytes can be recalled. */
  outputRef?: string;
  outputChars: number;
  truncated: boolean;
  isError: boolean;
  exitCode?: number;
  command?: string;
  paths?: string[];
  testStats?: TestStats;
  trust: TrustLevel;
  sandbox: 'none' | 'platform' | 'container';
}

export interface VerificationResult {
  command: string;
  source: string;
  scope: 'related' | 'full';
  exitCode: number;
  timestamp: number;
  durationMs: number;
  outputHash: string;
  outputRef?: string;
  truncated: boolean;
  testStats?: TestStats;
}

export interface VerificationReport {
  commands: number;
  results: VerificationResult[];
  baseline?: VerificationResult[];
}

export function receiptInputHash(input: unknown): string {
  return contentHash(stableStringify(input));
}

/** Deterministic JSON for hashing receipts (key order independent). */
export function stableStringify(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, sortKeys(v)]),
    );
  }
  return value;
}

/** Best-effort stats from Vitest/Jest/Pytest/Cargo output. */
export function parseTestStats(text: string): TestStats | undefined {
  const total = matchNumber(text, /Tests\s+(\d+)\s+passed/m) ?? matchNumber(text, /(\d+)\s+passed/i);
  const failed = matchNumber(text, /(\d+)\s+failed/i);
  const skipped = matchNumber(text, /(\d+)\s+skipped/i);
  const explicitTotal = matchNumber(text, /Tests:\s+(\d+)\s+total/i) ?? matchNumber(text, /(\d+)\s+tests?\s+(?:ran|collected)/i);
  if (total === undefined && failed === undefined && explicitTotal === undefined) return undefined;
  const failedCount = failed ?? 0;
  const passed = total ?? 0;
  return {
    total: explicitTotal ?? passed + failedCount + (skipped ?? 0),
    passed,
    failed: failedCount,
    skipped: skipped ?? 0,
  };
}

function matchNumber(text: string, re: RegExp): number | undefined {
  const m = text.match(re);
  return m?.[1] !== undefined ? Number(m[1]) : undefined;
}