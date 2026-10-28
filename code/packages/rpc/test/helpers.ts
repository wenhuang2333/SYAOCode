/**
 * Shared test scaffolding for the ARF kernel.
 *
 * Test-only: this file may import `node:`/core freely — the host-agnostic rule
 * (ADR-R11) applies to `packages/rpc/src`, not to the test suite.
 */

import { noopLogger, sha256Hex, type IdGenerator, type Logger, type Runtime } from '@syaocode/core';
import type { FabricStores, Hasher, KernelContext } from '../src/governance/contracts.js';
import { deterministicIds } from '../src/ir/ids.js';
import { createMemoryStores } from '../src/runtime/stores.js';
import type { ApprovalRecord, CanonicalEvent, Receipt, Task } from '../src/ir/types.js';

/** The host's SHA-256 hasher: exactly what a Node host injects into KernelContext. */
export function sha256Hasher(): Hasher {
  return { sha256: (text: string) => sha256Hex(text) };
}

/** Deterministic clock so hash chains and TTLs are reproducible. */
export function fixedClock(startIso = '2026-01-01T00:00:00.000Z'): { now: () => string; advance: (ms: number) => void } {
  let t = Date.parse(startIso);
  return {
    now: () => new Date(t).toISOString(),
    advance: (ms: number) => {
      t += ms;
    },
  };
}

/** Inert Runtime: the stores under test never touch fs/shell/http. */
export function inertRuntime(ids: IdGenerator, logger: Logger = noopLogger): Runtime {
  const deny = (what: string) => async (): Promise<never> => {
    throw new Error(`${what} is not available in this test runtime`);
  };
  return {
    fs: {
      readFile: deny('fs.readFile'),
      writeFile: deny('fs.writeFile'),
      appendFile: deny('fs.appendFile'),
      stat: deny('fs.stat'),
      readdir: deny('fs.readdir'),
      realpath: deny('fs.realpath'),
      mkdir: deny('fs.mkdir'),
      rmdir: deny('fs.rmdir'),
      unlink: deny('fs.unlink'),
      exists: async () => false,
    },
    shell: { spawn: () => { throw new Error('shell.spawn is not available in this test runtime'); } },
    http: { fetch: deny('http.fetch') },
    clock: { now: () => Date.now(), sleep: async () => {} },
    logger,
    env: { get: () => undefined },
    ids,
  };
}

/**
 * Minimal KernelContext for tests: deterministic ids + a real SHA-256 hasher.
 * Pass `now` to make time-dependent assertions stable.
 */
export function buildTestKernel(overrides: Partial<KernelContext> = {}): KernelContext {
  const ids = overrides.ids ?? deterministicIds();
  return {
    runtime: overrides.runtime ?? inertRuntime(ids),
    hash: overrides.hash ?? sha256Hasher(),
    ids,
    logger: overrides.logger ?? noopLogger,
  };
}

/**
 * The default in-memory storage面 with a deterministic clock.
 * `checkpointEvery` is forwarded to the audit store (0 disables it).
 */
export function buildTestStores(
  overrides: { ids?: IdGenerator; now?: () => string; hash?: Hasher; checkpointEvery?: number } = {},
): FabricStores {
  const ids = overrides.ids ?? deterministicIds();
  const now = overrides.now ?? (() => new Date().toISOString());
  const hash = overrides.hash ?? sha256Hasher();
  return createMemoryStores({
    ids,
    now,
    hash,
    ...(overrides.checkpointEvery !== undefined ? { checkpointEvery: overrides.checkpointEvery } : {}),
  });
}

// ── fixtures ──────────────────────────────────────────────────────────────

export const T0 = '2026-01-01T00:00:00.000Z';
export const T1 = '2026-01-01T00:01:00.000Z';
export const T2 = '2026-01-01T00:02:00.000Z';

export function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task_1',
    sessionId: 'ses_1',
    tenantId: 'ten_a',
    state: 'submitted',
    input: [{ type: 'text', text: 'do the thing' }],
    artifacts: [],
    createdAt: T0,
    updatedAt: T0,
    lastSeq: 0,
    ...overrides,
  };
}

export type UnsealedReceipt = Omit<Receipt, 'hash' | 'prevHash'>;

export function makeReceipt(overrides: Partial<UnsealedReceipt> = {}): UnsealedReceipt {
  return {
    id: 'rcpt_1',
    tenantId: 'ten_a',
    taskId: 'task_1',
    invocationId: 'inv_1',
    protocol: 'mcp',
    capabilityId: 'mcp://github/tool/create_issue',
    principalId: 'prn_alice',
    delegationChain: [],
    outcome: 'succeeded',
    inputHash: 'in_1',
    artifacts: [],
    approvals: [],
    policy: { revision: 'pol_1', decisionId: 'dec_1', effect: 'allow', obligations: [] },
    timing: { queuedAt: T0, startedAt: T0, endedAt: T1 },
    visibility: 'full',
    ...overrides,
  };
}

export function makeApproval(overrides: Partial<ApprovalRecord> = {}): ApprovalRecord {
  return {
    id: 'apr_1',
    tenantId: 'ten_a',
    taskId: 'task_1',
    subject: { kind: 'tool', summary: 'create an issue' },
    options: [{ id: 'opt_1', label: 'allow once', kind: 'allow_once' }],
    authority: 'local',
    delegationChain: [],
    policyRevision: 'pol_1',
    revision: 1,
    state: 'pending',
    createdAt: T0,
    expiresAt: T2,
    sensitive: false,
    ...overrides,
  };
}

/** The event body accepted by `EventLog.append`. */
export function makeEvent(
  overrides: Partial<Omit<CanonicalEvent, 'seq' | 'eventId' | 'ts'>> & { ts?: string } = {},
): Omit<CanonicalEvent, 'seq' | 'eventId' | 'ts'> & { ts?: string } {
  return {
    schemaVersion: 1,
    taskId: 'task_1',
    correlationId: 'cor_1',
    principalId: 'prn_alice',
    protocol: 'mcp',
    type: 'notice',
    payload: {},
    ...overrides,
  };
}
