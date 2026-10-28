import type { Runtime } from './runtime/index.js';
import { contentHash, sha256Hex } from './hash.js';

/**
 * Evidence ledger MVP (report §12 / v0.2.5).
 *
 * Every tool call leaves a receipt. Outputs are content-addressed so a report
 * can show the actual bytes, not just a hash; `scope` distinguishes related
 * tests from a full run so wording can stay honest.
 *
 * Hashing split (report C6): the audit/evidence chain and receipt digests use
 * SHA-256, while `contentHash` (FNV-1a) remains only for read-before-write
 * fencing in @syaocode/tools.
 */

/** SHA-256 digest of a string — the governance-facing hash. */
export type Sha256 = (text: string) => string;

/** Default governance hasher: the dependency-free SHA-256 from ./hash.js. */
export const defaultSha256: Sha256 = sha256Hex;

export type TrustLevel = 'trusted' | 'workspace' | 'untrusted';

/** Isolation a tool actually ran under (receipt `sandbox`, report C4). */
export type SandboxLevel = 'none' | 'platform' | 'container';

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
  constructor(private readonly hasher: Sha256 = defaultSha256) {}
  async put(text: string): Promise<StoredOutput> {
    const hash = this.hasher(text);
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
  sandbox: SandboxLevel;
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

export function receiptInputHash(input: unknown, hasher: Sha256 = defaultSha256): string {
  return hasher(stableStringify(input));
}

/**
 * FNV digest retained for read-before-write fencing only (report C6). Tool
 * result hashes, receipts and audit chains must use SHA-256.
 */
export { contentHash as fencingHash };

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