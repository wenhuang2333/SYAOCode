/**
 * Canonical IR helpers and the redaction bridge.
 *
 * The v0.4 audit flagged that the coverage target was unverifiable because
 * there was no tooling; adding the tooling exposed that these helpers — which
 * the dispatcher now relies on for redaction and id generation — were only
 * indirectly exercised.
 */

import { describe, expect, it } from 'vitest';
import {
  acpCapabilityId,
  a2aCapabilityId,
  deterministicIds,
  isId,
  localCapabilityId,
  mcpCapabilityId,
  mcpToolName,
  newId,
  parseCapabilityId,
  parseMcpToolName,
} from '../src/ir/ids.js';
import {
  RecordingRedactor,
  redactError,
  redactEvent,
  redactReceipt,
  registerSecret,
  sanitizeUsage,
} from '../src/governance/redactor-bridge.js';
import {
  APPROVAL_STATES,
  INVOCATION_STATES,
  INVOCATION_TERMINAL,
  TASK_STATES,
  TASK_TERMINAL,
  TASK_WAITING,
  assertApprovalTransition,
  assertInvocationTransition,
  assertTaskTransition,
  canTransitionApproval,
  canTransitionInvocation,
  canTransitionTask,
  isApprovalTerminal,
  isInvocationTerminal,
  isTaskTerminal,
  nextInvocationStates,
  nextTaskStates,
  TASK_TO_A2A,
  TASK_TO_ACP_STOP,
  TASK_TO_MCP,
} from '../src/ir/states.js';
import { computeRevision, emptyBundle, isBundleExpired, layerBundles, loadBundle, rulesHash, withRevision } from '../src/governance/policy-bundle.js';
import { hasher, TEST_TENANT } from './kernel-helpers.js';
import { createFileStores } from '../src/runtime/file-stores.js';
import { MemoryAuditStore } from '../src/governance/audit.js';
import { FakeRuntime } from './kernel-helpers.js';
import { CanonicalError, A2A_ERROR_CODES, ACP_ERROR_CODES, MCP_ERROR_CODES, defaultWireCode, retryVerdict } from '../src/ir/errors.js';
import type { CanonicalEvent, Receipt } from '../src/ir/types.js';
import { TEST_NOW } from './kernel-helpers.js';

describe('capability ids (01 §4.5.1)', () => {
  it('builds the documented namespaces', () => {
    expect(mcpCapabilityId('github', 'tool', 'create_issue')).toBe('mcp://github/tool/create_issue');
    expect(mcpCapabilityId('docs', 'resource', 'file:///spec.md')).toBe('mcp://docs/resource/file:///spec.md');
    expect(a2aCapabilityId('researcher', 'web-research')).toBe('a2a://researcher/skill/web-research');
    expect(acpCapabilityId('zed', 'fs', 'write_text_file')).toBe('acp://zed/fs/write_text_file');
    expect(localCapabilityId('bash')).toBe('local://tools/bash');
  });

  it('round-trips through parseCapabilityId', () => {
    for (const id of [
      'mcp://github/tool/create_issue',
      'a2a://researcher/skill/web-research',
      'acp://zed/fs/write_text_file',
      'local://tools/bash',
    ]) {
      const parsed = parseCapabilityId(id);
      expect(parsed).toBeDefined();
      // `local://` has no owner segment: its owner is the literal `local`.
      const rebuilt = parsed!.protocol === 'local'
        ? `local://${parsed!.kind}/${parsed!.name}`
        : `${parsed!.protocol}://${parsed!.owner}/${parsed!.kind}/${parsed!.name}`;
      expect(rebuilt).toBe(id);
    }
    expect(parseCapabilityId('not-a-capability')).toBeUndefined();
  });

  it('applies the DD-8 MCP tool-name rule and its inverse', () => {
    expect(mcpToolName('github', 'create_issue')).toBe('mcp__github__create_issue');
    // Unsafe characters are neutralised so the model sees a valid identifier.
    expect(mcpToolName('my server', 'create.issue')).toBe('mcp__my_server__create_issue');
    expect(parseMcpToolName('mcp__github__create_issue')).toEqual({ serverId: 'github', toolName: 'create_issue' });
    expect(parseMcpToolName('read')).toBeUndefined();
  });

  it('validates ids and generates them through the injected generator', () => {
    const ids = deterministicIds();
    const taskId = newId(ids, 'task');
    expect(taskId.startsWith('task_')).toBe(true);
    expect(isId(taskId)).toBe(true);
    expect(isId(taskId, 'task')).toBe(true);
    expect(isId(taskId, 'receipt')).toBe(false);
    expect(isId('nope')).toBe(false);
  });
});

describe('state machine tables (01 §4.4)', () => {
  it('knows which task states are terminal', () => {
    expect(isTaskTerminal('completed')).toBe(true);
    expect(isTaskTerminal('cancelled')).toBe(true);
    expect(isTaskTerminal('working')).toBe(false);
    expect(nextTaskStates('completed')).toEqual([]);
    expect(canTransitionTask('submitted', 'working')).toBe(true);
    expect(canTransitionTask('completed', 'working')).toBe(false);
  });

  it('maps every task state onto each protocol vocabulary', () => {
    for (const [taskState, a2a] of Object.entries(TASK_TO_A2A)) {
      expect(a2a).toMatch(/^TASK_STATE_[A-Z_]+$/);
      expect(typeof TASK_TO_MCP[taskState as keyof typeof TASK_TO_MCP]).toBe('string');
    }
    // ACP has no stopReason for a still-running turn.
    expect(TASK_TO_ACP_STOP.completed).toBe('end_turn');
    expect(TASK_TO_ACP_STOP.cancelled).toBe('cancelled');
    expect(TASK_TO_ACP_STOP.working).toBeUndefined();
  });
});

describe('error codes and the retry matrix (02 §9.2)', () => {
  it('gives each protocol its own reserved codes (04 M18 / A16)', () => {
    expect(MCP_ERROR_CODES.headerMismatch).toBe(-32020);
    expect(MCP_ERROR_CODES.missingRequiredClientCapability).toBe(-32021);
    expect(MCP_ERROR_CODES.unsupportedProtocolVersion).toBe(-32022);
    expect(A2A_ERROR_CODES.versionNotSupported).toBe(-32009);
    expect(ACP_ERROR_CODES.authRequired).toBe(-32000);
    // The MRTR codes must not squat on the reserved MCP partition.
    expect(MCP_ERROR_CODES.inputRequired).not.toBe(-32020);
  });

  it('derives a default wire code per protocol', () => {
    expect(defaultWireCode('a2a', 'capability_not_found')).toBe(A2A_ERROR_CODES.taskNotFound);
    expect(defaultWireCode('a2a', 'version_mismatch')).toBe(-32009);
    expect(defaultWireCode('mcp', 'version_mismatch')).toBe(-32022);
    expect(defaultWireCode('acp', 'unauthorized')).toBe(ACP_ERROR_CODES.authRequired);
    expect(defaultWireCode('native', 'denied')).toBeUndefined();
  });

  it('lets the shape carry the wire code (the A2A fix)', () => {
    const error = new CanonicalError({ kind: 'capability_not_found', protocol: 'a2a' });
    expect(error.toShape().wireCode).toBe(-32001);
    // An explicit code wins over the derived default.
    expect(new CanonicalError({ kind: 'denied', protocol: 'a2a', wireCode: -32002 }).toShape().wireCode).toBe(-32002);
  });

  it('never retries a side effect whose outcome is unknown', () => {
    const timedOut = new CanonicalError({ kind: 'timed_out', message: 'x', retryable: true });
    expect(retryVerdict(timedOut, { sideEffect: 'non_idempotent', sent: true })).toBe('manual_review');
    expect(retryVerdict(timedOut, { sideEffect: 'idempotent', sent: true })).toBe('manual_review');
    // A failure before the request was sent is retryable on a safe capability.
    expect(retryVerdict(timedOut, { sideEffect: 'idempotent', sent: false })).toBe('retry');
    expect(retryVerdict(timedOut, { sideEffect: 'non_idempotent', sent: false })).toBe('no_retry');
    expect(retryVerdict(CanonicalError.denied('no'), { sideEffect: 'none', sent: false })).toBe('no_retry');
    // A retryable transport failure on an idempotent capability is retryable.
    expect(
      retryVerdict(new CanonicalError({ kind: 'remote_error', message: 'x', retryable: true }), {
        sideEffect: 'idempotent',
        sent: false,
      }),
    ).toBe('retry');
  });
});

describe('redaction bridge (I7)', () => {
  const secret = 'sk-super-secret-value-123456';
  function redactor(): RecordingRedactor {
    const r = new RecordingRedactor('test');
    r.register(secret, 'api-key');
    return r;
  }

  it('registers a concrete secret and scrubs it', () => {
    const r = redactor();
    expect(registerSecret(r, secret, 'api-key')).toBe(secret);
    expect(r.redact(`token=${secret}`).text).toBe('token=[REDACTED:api-key]');
    expect(r.hits).toHaveLength(1);
  });

  it('scrubs an event payload but leaves the envelope alone', () => {
    const event: CanonicalEvent = {
      schemaVersion: 1,
      eventId: 'evt_1',
      seq: 1,
      taskId: 'task_1',
      correlationId: 'c',
      ts: TEST_NOW,
      principalId: 'user:local',
      protocol: 'native',
      type: 'invocation.started',
      payload: { token: secret, ok: true },
    };
    const redacted = redactEvent(redactor(), event);
    expect(JSON.stringify(redacted.payload)).not.toContain(secret);
    expect(redacted.eventId).toBe('evt_1');
    expect(redacted.seq).toBe(1);
  });

  it('scrubs a receipt without touching its hashes', () => {
    const receipt = {
      id: 'rcpt_1',
      tenantId: 't',
      taskId: 'task_1',
      invocationId: 'inv_1',
      protocol: 'mcp',
      capabilityId: 'c',
      principalId: 'user:local',
      delegationChain: [],
      outcome: 'succeeded',
      inputHash: 'abc123',
      artifacts: [],
      approvals: [],
      policy: { revision: 'r', decisionId: 'd', effect: 'allow', obligations: [] },
      timing: { queuedAt: TEST_NOW, startedAt: TEST_NOW, endedAt: TEST_NOW },
      visibility: 'full',
      hash: 'deadbeef',
      lossy: [secret],
    } as unknown as Receipt;
    const redacted = redactReceipt(redactor(), receipt);
    expect(JSON.stringify(redacted)).not.toContain(secret);
    expect(redacted.hash).toBe('deadbeef');
    expect(redacted.inputHash).toBe('abc123');
  });

  it('scrubs an error message', () => {
    const redacted = redactError(redactor(), {
      kind: 'remote_error',
      message: `upstream rejected ${secret}`,
      retryable: false,
    });
    expect(redacted.message).not.toContain(secret);
  });

  it('keeps only the numeric fields of a usage report', () => {
    const usage = sanitizeUsage({
      inputTokens: 10,
      outputTokens: 5,
      costUsd: 0.01,
      // A provider echo of a request body must not survive.
      ...({ echoedBody: secret } as Record<string, unknown>),
    } as never);
    expect(usage).toEqual({ inputTokens: 10, outputTokens: 5, costUsd: 0.01 });
    expect(sanitizeUsage(undefined)).toBeUndefined();
  });
});

describe('state predicates and transition guards', () => {
  it('classifies every state', () => {
    for (const state of TASK_STATES) {
      expect(isTaskTerminal(state)).toBe(TASK_TERMINAL.includes(state));
      expect(Array.isArray(nextTaskStates(state))).toBe(true);
    }
    for (const state of INVOCATION_STATES) {
      expect(isInvocationTerminal(state)).toBe(INVOCATION_TERMINAL.includes(state));
      expect(Array.isArray(nextInvocationStates(state))).toBe(true);
    }
    for (const state of APPROVAL_STATES) expect(isApprovalTerminal(state)).toBe(state !== 'pending');
    expect(TASK_WAITING).toEqual(['input_required', 'auth_required']);
  });

  it('guards invocation and approval transitions', () => {
    expect(canTransitionInvocation('proposed', 'authorized')).toBe(true);
    expect(canTransitionInvocation('succeeded', 'running')).toBe(false);
    expect(() => assertInvocationTransition('succeeded', 'running')).toThrow(/illegal/);
    expect(() => assertInvocationTransition('proposed', 'authorized')).not.toThrow();
    expect(canTransitionApproval('pending', 'allowed')).toBe(true);
    expect(canTransitionApproval('allowed', 'denied')).toBe(false);
    expect(() => assertApprovalTransition('denied', 'allowed')).toThrow(/illegal/);
    expect(() => assertTaskTransition('working', 'completed')).not.toThrow();
    expect(() => assertTaskTransition('completed', 'working')).toThrow(/illegal/);
  });
});

describe('policy bundle helpers (02 §5.5)', () => {
  it('detects an expired bundle', () => {
    const bundle = emptyBundle(hasher, TEST_TENANT);
    expect(isBundleExpired(bundle, TEST_NOW)).toBe(false);
    expect(isBundleExpired({ ...bundle, expiresAt: '2020-01-01T00:00:00.000Z' }, TEST_NOW)).toBe(true);
  });

  it('loads, re-stamps and hashes a bundle', () => {
    const bundle = emptyBundle(hasher, TEST_TENANT);
    const raw = JSON.stringify(bundle);
    const loaded = loadBundle(hasher, raw);
    expect(loaded.revision).toBe(bundle.revision);
    // A hand-edited revision is not trusted: the content wins.
    const tampered = loadBundle(hasher, JSON.stringify({ ...bundle, revision: 'sha256:deadbeef' }));
    expect(tampered.revision).toBe(computeRevision(hasher, tampered));
    expect(rulesHash(hasher, bundle)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('rejects a malformed bundle with a readable message', () => {
    expect(() => loadBundle(hasher, { schemaVersion: 99 })).toThrow(/invalid policy bundle/);
  });

  it('layers four levels and takes the earliest expiry', () => {
    const base = (source: 'org' | 'project' | 'user' | 'session', effect: 'allow' | 'deny') =>
      withRevision(hasher, {
        schemaVersion: 1 as const,
        tenantId: TEST_TENANT,
        defaultEffect: 'deny' as const,
        rules: [{ id: `${source}-rule`, priority: 1, effect, match: {}, source }],
        ...(source === 'project' ? { expiresAt: '2030-01-01T00:00:00.000Z' } : {}),
        ...(source === 'user' ? { expiresAt: '2029-01-01T00:00:00.000Z' } : {}),
      });
    const merged = layerBundles({
      hasher,
      tenantId: TEST_TENANT,
      org: base('org', 'allow'),
      project: base('project', 'deny'),
      user: base('user', 'allow'),
      session: base('session', 'allow'),
    });
    expect(merged.rules.map((r) => r.id)).toEqual(['org-rule', 'project-rule', 'user-rule', 'session-rule']);
    // The earliest expiry bounds the merged bundle.
    expect(merged.expiresAt).toBe('2029-01-01T00:00:00.000Z');
    expect(merged.defaultEffect).toBe('deny');
  });
});

describe('file-backed store bundle (C-4)', () => {
  it('exposes every store and hydrates nothing on a fresh directory', async () => {
    const runtime = new FakeRuntime();
    const ids = deterministicIds();
    const stores = createFileStores({
      runtime,
      dir: '/tmp/syao-bundle-test',
      ids,
      now: () => TEST_NOW,
      hash: hasher,
    });
    for (const key of ['tasks', 'sessions', 'approvals', 'budget', 'idempotency', 'receipts', 'audit', 'events'] as const) {
      expect(stores[key]).toBeDefined();
    }
    // A fresh bundle serves an empty catalogue rather than throwing.
    expect(await stores.tasks.list({ tenantId: TEST_TENANT })).toEqual([]);
    expect(await stores.audit.list({ tenantId: TEST_TENANT })).toEqual([]);
    expect(await stores.receipts.listByTask('task_x', TEST_TENANT)).toEqual([]);
  });
});

describe('file-backed stores round-trip every record kind', () => {
  // One runtime per test, re-opened: `FakeRuntime.fs` is in-memory, so a fresh
  // runtime would be a fresh disk and "restart" would prove nothing.
  async function bundle(dir: string, runtime: FakeRuntime = new FakeRuntime()) {
    const stores = createFileStores({
      runtime,
      dir,
      ids: deterministicIds(),
      now: () => TEST_NOW,
      hash: hasher,
      checkpointEvery: 2,
    });
    return { runtime, stores };
  }

  it('sessions survive a restart', async () => {
    const dir = '/tmp/syao-bundle-sessions';
    const { runtime, stores } = await bundle(dir);
    const session = {
      id: 'ses_1', tenantId: TEST_TENANT,
      principal: { id: 'user:local', kind: 'user' as const, tenantId: TEST_TENANT, scopes: [], trustTier: 'first_party' as const },
      protocolBinding: 'native' as const, workspaceRoots: ['/work'], policyRevision: 'r', budgetId: 'default',
      createdAt: TEST_NOW, updatedAt: TEST_NOW, state: 'open' as const, approvalAuthority: 'local' as const,
    };
    await stores.sessions.create(session);
    await stores.sessions.put({ ...session, state: 'closed' });

    const { stores: reopened } = await bundle(dir, runtime);
    const found = await reopened.sessions.get('ses_1', TEST_TENANT);
    expect(found?.state).toBe('closed');
    expect((await reopened.sessions.list(TEST_TENANT)).map((x) => x.id)).toContain('ses_1');
  });

  it('approval decisions and expiry survive a restart', async () => {
    const dir = '/tmp/syao-bundle-approvals';
    const { runtime, stores } = await bundle(dir);
    await stores.approvals.insert({
      id: 'apr_1', tenantId: TEST_TENANT, taskId: 'task_1',
      subject: { kind: 'tool', summary: 'x' },
      options: [{ id: 'allow_once', label: 'once', kind: 'allow_once' }],
      authority: 'local', delegationChain: [], policyRevision: 'r', revision: 1, state: 'pending',
      createdAt: TEST_NOW, expiresAt: '2030-01-01T00:00:00.000Z', sensitive: false,
    });
    expect(await stores.approvals.decide('apr_1', 1, { state: 'allowed', decidedAt: TEST_NOW, decidedBy: 't' })).toBe(true);
    // A stale revision loses the CAS.
    expect(await stores.approvals.decide('apr_1', 1, { state: 'denied' })).toBe(false);

    const { stores: reopened } = await bundle(dir, runtime);
    expect((await reopened.approvals.get('apr_1', TEST_TENANT))?.state).toBe('allowed');
    expect(await reopened.approvals.list({ tenantId: TEST_TENANT })).toHaveLength(1);
    // Nothing is pending, so expiry is a no-op.
    expect(await reopened.approvals.expire('2031-01-01T00:00:00.000Z')).toBe(0);
  });

  it('budget reservations survive a restart', async () => {
    const dir = '/tmp/syao-bundle-budget';
    const { runtime, stores } = await bundle(dir);
    await stores.budget.putReservation({
      id: 'rsv_1', accountId: 'default', accountChain: ['default'],
      estimate: { usd: 1 }, createdAt: TEST_NOW, expiresAt: '2030-01-01T00:00:00.000Z', state: 'held',
    });
    const { stores: reopened } = await bundle(dir, runtime);
    expect((await reopened.budget.getReservation('rsv_1'))?.estimate.usd).toBe(1);
    expect(await reopened.budget.listReservations({ state: 'held' })).toHaveLength(1);
  });

  it('idempotency records survive a restart', async () => {
    const dir = '/tmp/syao-bundle-idem';
    const { runtime, stores } = await bundle(dir);
    await stores.idempotency.begin('k', 'hash', 60_000);
    await stores.idempotency.complete('k', { ok: true });
    await stores.idempotency.begin('k2', 'hash2', 60_000);
    await stores.idempotency.fail('k2', { kind: 'remote_error', message: 'x', retryable: true }, { retryable: true, sideEffect: 'idempotent', outcome: 'failed' });

    const { stores: reopened } = await bundle(dir, runtime);
    expect((await reopened.idempotency.get('k'))?.state).toBe('completed');
    expect((await reopened.idempotency.get('k2'))?.state).toBe('failed');
    expect((await reopened.idempotency.begin('k', 'hash', 60_000)).kind).toBe('replay');
  });

  it('events snapshot and audit checkpoint work over the files', async () => {
    const dir = '/tmp/syao-bundle-events';
    const { runtime, stores } = await bundle(dir);
    await stores.events.append({
      taskId: 'task_1', correlationId: 'c', principalId: 'user:local', protocol: 'native',
      type: 'task.created', payload: { state: 'submitted' },
    });
    expect((await stores.events.snapshot('task_1')).lastSeq).toBe(1);
    await stores.audit.append({
      ts: TEST_NOW, tenantId: TEST_TENANT, actor: { type: 'user', id: 'user:local' },
      action: 'policy.decide', subject: { type: 'capability', id: 'c' }, outcome: 'success',
    });
    await stores.audit.append({
      ts: TEST_NOW, tenantId: TEST_TENANT, actor: { type: 'user', id: 'user:local' },
      action: 'invocation.succeeded', subject: { type: 'invocation', id: 'i' }, outcome: 'success',
    });
    // checkpointEvery=2, so the second append took a checkpoint.
    const checkpoint = await stores.audit.checkpoint(TEST_TENANT);
    expect(checkpoint.count).toBe(2);
    expect((await stores.audit.verify(TEST_TENANT)).ok).toBe(true);
  });
});

describe('audit checkpoints fire on count OR time (P2)', () => {
  it('takes a checkpoint when the interval elapses, even at low traffic', async () => {
    let nowMs = Date.parse('2026-10-28T00:00:00.000Z');
    const store = new MemoryAuditStore({
      hash: hasher,
      ids: deterministicIds(),
      now: () => new Date(nowMs).toISOString(),
      // A count trigger alone would never fire for a quiet process.
      checkpointEvery: 0,
      checkpointIntervalMs: 60_000,
    });
    const append = () =>
      store.append({
        ts: new Date(nowMs).toISOString(),
        tenantId: TEST_TENANT,
        actor: { type: 'user', id: 'user:local' },
        action: 'policy.decide',
        subject: { type: 'capability', id: 'c' },
        outcome: 'success',
      });

    await append();
    // The first event has no previous checkpoint to measure from.
    expect(await store.lastCheckpoint(TEST_TENANT)).toBeUndefined();

    nowMs += 30_000;
    await append();
    expect(await store.lastCheckpoint(TEST_TENANT)).toBeUndefined();

    // The interval has now passed since the last append, so the next one
    // checkpoints — with a count-only trigger this would never happen.
    nowMs += 45_000;
    await append();
    const checkpoint = await store.lastCheckpoint(TEST_TENANT);
    expect(checkpoint).toBeDefined();
    expect(checkpoint?.count).toBe(3);
    expect((await store.verify(TEST_TENANT)).ok).toBe(true);
  });
});
