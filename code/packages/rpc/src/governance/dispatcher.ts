/**
 * The ten-step governance pipeline (02 §4).
 *
 * Order (02 §4.3 — the recommended order, not the ASCII-art order):
 *
 *   1 normalize      → build the canonical InvokeRequest
 *   2 authenticate   → Principal + tenant (I1)
 *   3 resolve        → capability from the registry (never from the peer)
 *   4 idempotency    → replay / in_flight / conflict, BEFORE spending money
 *   5 authorize      → policy decision (I2: no decision ⇒ no dispatch)
 *   6 approve        → approval for an `ask` decision (I3)
 *   7 reserve        → budget hold (I6: reserve before dispatch)
 *   8 dispatch       → the ONLY path to a side effect
 *   9 settle         → release the difference, record the actual usage
 *  10 receipt+audit  → seal the evidence, extend the audit chain
 *
 * Every terminal path produces exactly one receipt (I5) and one audit trail.
 * Nothing here executes a tool directly: the executor is injected, and it only
 * ever receives an `AuthorizedInvocation` (I13).
 */

import type { Redactor } from '@syaocode/core';
import { CanonicalError } from '../ir/errors.js';
import { newId } from '../ir/ids.js';
import { canonicalJson } from '../ir/schemas.js';
import type {
  ArtifactRef,
  CanonicalErrorShape,
  CanonicalEvent,
  InvocationState,
  Obligation,
  Principal,
  Receipt,
  Session,
  Task,
  TaskState,
  UsageReport,
} from '../ir/types.js';
import type {
  ApprovalBroker,
  AuditStore,
  AuthorizedInvocation,
  BudgetLedger,
  CapabilityRegistry,
  DispatchContext,
  Dispatcher,
  DispatcherDeps,
  EventLog,
  IdempotencyStore,
  InvokeRequest,
  InvokeResult,
  InvokeResultPayload,
  PolicyEngine,
  ReceiptStore,
  TaskStore,
} from './contracts.js';
import { BudgetExceededError, DEFAULT_MAX_PER_INVOCATION_USD } from './budget.js';
import { derivedKey, idempotencyKeyOf, requestHash } from './idempotency.js';
import { retryVerdict } from '../ir/errors.js';
import { redactError } from './redactor-bridge.js';

export interface DispatcherOptions extends DispatcherDeps {
  /** How long an approval may wait before it is denied (fail closed). */
  approvalTimeoutMs?: number;
  /** Default budget estimate when the caller supplies none. */
  defaultEstimateUsd?: number;
}

export class GovernanceDispatcher implements Dispatcher {
  private readonly deps: DispatcherOptions;

  constructor(deps: DispatcherOptions) {
    this.deps = deps;
  }

  async invoke(req: InvokeRequest, ctx: DispatchContext): Promise<InvokeResult> {
    const { kernel, policy, approvals, budget, idempotency, receipts, audit, registry, identity } = this.deps;
    const step = (name: Parameters<NonNullable<DispatcherDeps['onStep']>>[0], detail: Record<string, unknown> = {}): void => {
      this.deps.onStep?.(name, detail);
    };

    // ── 1. normalize ───────────────────────────────────────────────────
    step('normalize');
    if (req.capabilityId.trim() === '') {
      throw new CanonicalError({ kind: 'invalid_request', message: 'capabilityId must not be empty' });
    }
    const principal = req.principal;
    const tenantId = principal.tenantId;
    const correlationId = ctx.correlationId ?? kernel.ids.next('corr');

    // ── 2. authenticate ─────────────────────────────────────────────────
    // The principal must be authenticated by the identity service, not merely
    // asserted by the caller (I1). The service is also the only component that
    // can widen a delegation chain, so it runs on every invocation.
    step('authenticate');
    if (principal.id.trim() === '' || tenantId.trim() === '') {
      throw new CanonicalError({ kind: 'unauthenticated', message: 'the invocation carries no principal or tenant' });
    }
    let authenticated;
    try {
      authenticated = await identity.authenticate(
        req.credential ?? { kind: 'local', principal },
      );
    } catch (e) {
      throw CanonicalError.from(e, 'unauthenticated');
    }
    if (authenticated.principal.tenantId !== tenantId) {
      throw new CanonicalError({
        kind: 'unauthorized',
        message: 'the authenticated principal belongs to a different tenant',
      });
    }
    // A host may pin the tenant it serves; the caller cannot name another one.
    if (ctx.tenantId !== undefined && ctx.tenantId !== tenantId) {
      throw new CanonicalError({
        kind: 'unauthorized',
        message: `tenant mismatch: this host serves '${ctx.tenantId}', the request claims '${tenantId}'`,
      });
    }
    if (ctx.session !== undefined && ctx.session.tenantId !== tenantId) {
      throw new CanonicalError({
        kind: 'unauthorized',
        message: 'the session belongs to a different tenant than the principal',
      });
    }
    const delegationChain: string[] =
      ctx.session !== undefined && ctx.session.approvalAuthority === 'chain' ? [ctx.session.id] : [];

    // ── 3. resolve ──────────────────────────────────────────────────────
    step('resolve');
    let resolved;
    try {
      resolved = await registry.resolve(req.capabilityId, { tenantId });
    } catch (e) {
      throw CanonicalError.from(e, 'capability_not_found');
    }
    const capability = resolved.capability;

    const task = await this.ensureTask(req, ctx, principal, tenantId);

    // ── 4. idempotency ──────────────────────────────────────────────────
    // Before the budget: a replay must not reserve money twice.
    step('idempotency');
    // Hash the SANITIZED input: the receipt and the idempotency key must
    // describe what the executor actually received, not the pre-redaction form.
    const sanitizedInput = this.sanitizeInput(req.input);
    const hash = requestHash(kernel.hash, req.capabilityId, sanitizedInput, policy.revision);
    // Allocate the invocation id BEFORE idempotency so the derived key is
    // unique per invocation. A constant ('pending') made every second call in
    // a task collide with the first one's key.
    const invocationId = newId(kernel.ids, 'invocation');
    const clientKey = req.idempotencyKey ?? derivedKey(task.id, invocationId);
    const key = idempotencyKeyOf({ tenantId, principalId: principal.id, capabilityId: req.capabilityId, clientKey });
    const begin = await idempotency.begin(key, hash);
    if (begin.kind === 'conflict') {
      throw new CanonicalError({
        kind: 'idempotency_conflict',
        message: 'The idempotency key was reused with a different request.',
        details: { key },
      });
    }
    if (begin.kind === 'in_flight') {
      throw new CanonicalError({ kind: 'in_flight', message: 'An identical request is already in flight.', details: { key } });
    }
    if (begin.kind === 'replay') {
      const cached = begin.record.result as InvokeResult | undefined;
      await this.writeAudit('invocation.replay', tenantId, principal, { type: 'capability', id: req.capabilityId }, 'success', policy.revision);
      return {
        invocationId: cached?.invocationId ?? 'unknown',
        taskId: cached?.taskId ?? task.id,
        receiptId: cached?.receiptId ?? 'unknown',
        outcome: cached?.outcome ?? 'succeeded',
        ...(cached?.output !== undefined ? { output: cached.output } : {}),
        replayed: true,
        approvalIds: cached?.approvalIds ?? [],
        ...(cached?.lossy !== undefined ? { lossy: cached.lossy } : {}),
      };
    }

    // ── 5. authorize ────────────────────────────────────────────────────
    step('authorize');
    const policyInput = {
      principal,
      session: ctx.session ?? this.fallbackSession(tenantId, principal),
      capability,
      input: req.input,
      inputHash: hash,
      context: {
        protocol: req.protocol,
        direction: req.direction,
        workspaceRoots: ctx.workspaceRoots,
        cwd: ctx.cwd,
        now: this.now(),
        trust: principal.trustTier,
        dataClass: capability.dataClass,
      },
      budget: { accountId: ctx.session?.budgetId ?? 'default' },
      approvalHistory: [],
    };
    const decision = await policy.evaluate(policyInput);
    await this.writeAudit(
      'policy.decide',
      tenantId,
      principal,
      { type: 'capability', id: req.capabilityId },
      decision.effect === 'deny' ? 'denied' : 'success',
      decision.policyRevision,
    );

    if (decision.effect === 'deny') {
      const error = CanonicalError.denied(decision.reason);
      await idempotency.fail(key, error.toShape());
      // A denied call is still evidence: it proves the request was refused and
      // why (I5 — "every invocation has exactly one receipt").
      await this.writeTerminalReceipt({
        task,
        tenantId,
        capabilityId: capability.id,
        protocol: req.protocol,
        principal,
        outcome: 'denied',
        inputHash: hash,
        policyRevision: decision.policyRevision,
        decisionId: decision.id,
        effect: 'deny',
        obligations: decision.obligations,
        visibility: capability.visibility,
        delegationChain,
        error: error.toShape(),
      }, ctx);
      throw error;
    }

    // I7: secret-class data must not leave the kernel unredacted. Without a
    // redactor configured we cannot guarantee that, so the call is refused
    // rather than run with a silent leak.
    if (capability.dataClass === 'secret' && this.deps.redactor === undefined) {
      const error = new CanonicalError({
        kind: 'unsupported_obligation',
        message: 'This capability carries secret-class data but no redactor is configured.',
      });
      await idempotency.fail(key, error.toShape());
      await this.writeTerminalReceipt({
        task, tenantId, capabilityId: capability.id, protocol: req.protocol, principal,
        outcome: 'denied', inputHash: hash, policyRevision: decision.policyRevision,
        decisionId: decision.id, effect: decision.effect, obligations: decision.obligations,
        visibility: capability.visibility, delegationChain, error: error.toShape(),
      }, ctx);
      throw error;
    }

    // Obligations are hard constraints: if any cannot be honoured the call is
    // refused, never silently run without it (02 §5.2).
    const unsupportedObligation = firstUnsupportedObligation(decision.obligations);
    if (unsupportedObligation !== undefined) {
      const error = new CanonicalError({
        kind: 'unsupported_obligation',
        message: `The obligation '${unsupportedObligation}' cannot be honoured by this executor.`,
      });
      await idempotency.fail(key, error.toShape());
      await this.writeTerminalReceipt({
        task,
        tenantId,
        capabilityId: capability.id,
        protocol: req.protocol,
        principal,
        outcome: 'denied',
        inputHash: hash,
        policyRevision: decision.policyRevision,
        decisionId: decision.id,
        effect: decision.effect,
        obligations: decision.obligations,
        visibility: capability.visibility,
        delegationChain,
        error: error.toShape(),
      }, ctx);
      throw error;
    }
    const sandbox = decision.obligations.find((o): o is Extract<Obligation, { type: 'sandbox' }> => o.type === 'sandbox');
    if (sandbox !== undefined && sandbox.level !== 'none') {
      const error = new CanonicalError({
        kind: 'unsupported_obligation',
        message: `The sandbox obligation '${sandbox.level}' cannot be honoured by this executor.`,
      });
      await idempotency.fail(key, error.toShape());
      await this.writeTerminalReceipt({
        task,
        tenantId,
        capabilityId: capability.id,
        protocol: req.protocol,
        principal,
        outcome: 'denied',
        inputHash: hash,
        policyRevision: decision.policyRevision,
        decisionId: decision.id,
        effect: decision.effect,
        obligations: decision.obligations,
        visibility: capability.visibility,
        delegationChain,
        error: error.toShape(),
      }, ctx);
      throw error;
    }

    // ── 6. approve ──────────────────────────────────────────────────────
    step('approve');
    const approvalIds: string[] = [];
    // An `allow` decision carrying `require_approval` still needs a human:
    // the obligation is not advisory.
    const approvalRequired = decision.effect === 'ask' || decision.obligations.some((o) => o.type === 'require_approval');
    if (approvalRequired) {
      const approval = await approvals.request({
        tenantId,
        taskId: task.id,
        invocationId,
        capabilityId: capability.id,
        inputHash: hash,
        subject: this.subjectFor(capability, req, decision.reason),
        ...(this.deps.approvalTimeoutMs !== undefined ? { timeoutMs: this.deps.approvalTimeoutMs } : {}),
        authority: req.approvalAuthority ?? ctx.session?.approvalAuthority ?? 'local',
        ...(delegationChain.length > 0 ? { delegationChain } : {}),
        policyRevision: decision.policyRevision,
        sensitive: capability.dataClass === 'secret',
      });
      approvalIds.push(approval.approvalId);
      if (approval.state !== 'allowed') {
        const error = CanonicalError.denied(approval.reason ?? 'The request was not approved.');
        await idempotency.fail(key, error.toShape());
        await this.writeAudit('approval.denied', tenantId, principal, { type: 'approval', id: approval.approvalId }, 'denied', decision.policyRevision);
        await this.writeTerminalReceipt({
          task,
          tenantId,
          capabilityId: capability.id,
          protocol: req.protocol,
          principal,
          outcome: 'denied',
          inputHash: hash,
          policyRevision: decision.policyRevision,
          decisionId: decision.id,
          effect: 'ask',
          obligations: decision.obligations,
          visibility: capability.visibility,
          delegationChain,
          approvalIds,
          error: error.toShape(),
        }, ctx);
        throw error;
      }
    }

    // ── 7. reserve budget ───────────────────────────────────────────────
    step('reserve');
    let reservationId: string | undefined;
    const accountId = ctx.session?.budgetId ?? 'default';
    // `skipBudget` is a REQUEST, not a switch: only a free read-only
    // capability may actually skip the ledger, so a caller cannot opt out of
    // the budget (I6).
    const exempt = req.skipBudget === true && capability.risk === 'read' && capability.sideEffect === 'none';
    if (!exempt) {
      // No estimate means "unknown price", which must reserve the conservative
      // per-invocation ceiling — reserving $0 would make the ledger a no-op.
      const estimate = ctx.estimate ?? { usd: this.deps.defaultEstimateUsd ?? DEFAULT_MAX_PER_INVOCATION_USD };
      try {
        const reservation = await budget.reserve({
          accountId,
          estimate,
          ...(ctx.estimate === undefined ? { ttlMs: 120_000 } : {}),
        });
        reservationId = reservation.id;
        await this.emit(task, principal, req.protocol, 'budget.reserved', {
          reservationId: reservation.id,
          estimate: reservation.estimate,
        }, ctx);
      } catch (e) {
        if (e instanceof BudgetExceededError) {
          const error = new CanonicalError({
            kind: 'budget_exceeded',
            message: e.message,
            details: { accountId: e.accountId, requestedUsd: e.requestedUsd },
          });
          await idempotency.fail(key, error.toShape());
          await this.emit(task, principal, req.protocol, 'budget.exceeded', { accountId: e.accountId }, ctx);
          await this.writeTerminalReceipt({
            task,
            tenantId,
            capabilityId: capability.id,
            protocol: req.protocol,
            principal,
            outcome: 'failed',
            inputHash: hash,
            policyRevision: decision.policyRevision,
            decisionId: decision.id,
            effect: decision.effect,
            obligations: decision.obligations,
            visibility: capability.visibility,
            delegationChain,
            error: error.toShape(),
          }, ctx);
          throw error;
        }
        throw e;
      }
    }

    // ── 8. dispatch ─────────────────────────────────────────────────────
    step('dispatch');
    // A deadline in the past is already a timeout: do not start work that can
    // only be abandoned (02 §9.4).
    if (req.deadlineAt !== undefined && Date.parse(req.deadlineAt) <= kernel.runtime.clock.now()) {
      const error = new CanonicalError({ kind: 'timed_out', message: 'the deadline passed before dispatch' });
      await idempotency.fail(key, error.toShape(), { retryable: false, sideEffect: capability.sideEffect, outcome: 'timed_out' });
      await this.writeTerminalReceipt({
        task, tenantId, capabilityId: capability.id, protocol: req.protocol, principal,
        outcome: 'timed_out', inputHash: hash, policyRevision: decision.policyRevision,
        decisionId: decision.id, effect: decision.effect, obligations: decision.obligations,
        visibility: capability.visibility, delegationChain, error: error.toShape(),
      }, ctx);
      throw error;
    }
    const queuedAtForReceipt = this.now();
    const startedAt = queuedAtForReceipt;
    const authorized: AuthorizedInvocation = {
      invocationId,
      taskId: task.id,
      sessionId: ctx.session?.id ?? task.sessionId,
      tenantId,
      capability,
      endpoint: resolved.endpoint,
      input: sanitizedInput,
      inputHash: hash,
      principal,
      protocol: req.protocol,
      direction: req.direction,
      ...(req.deadlineAt !== undefined ? { deadlineAt: req.deadlineAt } : {}),
      obligations: decision.obligations,
      visibility: capability.visibility,
      idempotencyKey: key,
      ...(reservationId !== undefined ? { reservationId } : {}),
    };

    await this.emit(task, principal, req.protocol, 'invocation.started', { invocationId, capabilityId: capability.id }, ctx, invocationId);

    let payload: InvokeResultPayload;
    try {
      payload = await this.deps.execute(authorized, ctx);
    } catch (e) {
      payload = this.payloadFromError(e);
    }
    // Everything that leaves the kernel is scrubbed (I7): the output, the
    // error text and the artifacts.
    payload = this.sanitizePayload(payload);

    // ── 9. settle ───────────────────────────────────────────────────────
    step('settle');
    if (reservationId !== undefined) {
      try {
        await budget.settle(reservationId, payload.usage ?? {});
        await this.emit(task, principal, req.protocol, 'budget.settled', { reservationId }, ctx, invocationId);
      } catch (e) {
        kernel.logger.log('warn', 'budget settle failed', { error: e instanceof Error ? e.message : String(e) });
      }
    }

    // ── 10. receipt + audit ─────────────────────────────────────────────
    step('receipt');
    const outcome = normalizeOutcome(payload.outcome);
    const receipt = await this.writeReceipt({
      task,
      tenantId,
      invocationId,
      capabilityId: capability.id,
      protocol: req.protocol,
      principal,
      outcome,
      inputHash: hash,
      ...(payload.output !== undefined ? { outputHash: kernel.hash.sha256(canonicalJson(payload.output)) } : {}),
      artifacts: payload.artifacts ?? [],
      approvalIds,
      policyRevision: decision.policyRevision,
      decisionId: decision.id,
      effect: decision.effect,
      obligations: decision.obligations,
      ...(payload.usage !== undefined ? { usage: payload.usage } : {}),
      visibility: capability.visibility,
      ...(payload.lossy !== undefined ? { lossy: payload.lossy } : {}),
      ...(payload.error !== undefined ? { error: payload.error } : {}),
      queuedAt: queuedAtForReceipt,
      startedAt,
      delegationChain,
    }, ctx);

    await this.writeAudit(
      `invocation.${outcome}`,
      tenantId,
      principal,
      { type: 'invocation', id: invocationId },
      outcome === 'succeeded' ? 'success' : 'failure',
      decision.policyRevision,
    );

    await this.emit(task, principal, req.protocol, this.eventTypeFor(outcome), {
      invocationId,
      receiptId: receipt.id,
      outcome,
    }, ctx, invocationId);

    if (outcome === 'succeeded') {
      await idempotency.complete(key, {
        invocationId,
        taskId: task.id,
        receiptId: receipt.id,
        outcome,
        output: payload.output,
        approvalIds,
      });
    } else {
      // Record WHY the attempt failed so the retry gate can refuse to repeat a
      // side effect whose outcome is unknown (I10).
      const shape = payload.error ?? { kind: 'remote_error' as const, message: `invocation ${outcome}`, retryable: false };
      const verdict = retryVerdict(
        CanonicalError.fromShape(shape),
        { sideEffect: capability.sideEffect, sent: outcome === 'indeterminate' || outcome === 'timed_out' },
      );
      await idempotency.fail(key, shape, {
        retryable: verdict === 'retry',
        sideEffect: capability.sideEffect,
        outcome,
      });
    }

    return {
      invocationId,
      taskId: task.id,
      receiptId: receipt.id,
      outcome,
      approvalIds,
      ...(payload.output !== undefined ? { output: payload.output } : {}),
      ...(payload.error !== undefined ? { error: payload.error } : {}),
      ...(payload.lossy !== undefined ? { lossy: payload.lossy } : {}),
    };
  }

  // ── task lifecycle ───────────────────────────────────────────────────

  async createTask(input: {
    sessionId: string;
    tenantId: string;
    principal: Principal;
    blocks: Task['input'];
    parentTaskId?: string;
  }): Promise<Task> {
    const now = this.now();
    const task: Task = {
      id: newId(this.deps.kernel.ids, 'task'),
      sessionId: input.sessionId,
      tenantId: input.tenantId,
      ...(input.parentTaskId !== undefined ? { parentTaskId: input.parentTaskId } : {}),
      state: 'submitted',
      input: input.blocks,
      artifacts: [],
      createdAt: now,
      updatedAt: now,
      lastSeq: 0,
    };
    await this.deps.tasks.create(task);
    await this.deps.events.append({
      taskId: task.id,
      correlationId: task.id,
      principalId: input.principal.id,
      protocol: 'native',
      type: 'task.created',
      payload: { state: task.state },
    });
    return task;
  }

  async cancelTask(taskId: string, reason: string, tenantId = 'default'): Promise<Task> {
    const task = await this.deps.tasks.get(taskId, tenantId);
    if (task === undefined) throw new CanonicalError({ kind: 'invalid_request', message: `unknown task '${taskId}'` });
    if (task.state === 'cancelled') return task;
    // Pending approvals must not outlive the task (02 §9.3).
    await this.deps.approvals.cancelForTask(taskId, reason);
    const updated: Task = { ...task, state: 'cancelled', updatedAt: this.now(), terminalReason: reason };
    await this.deps.tasks.put(updated);
    await this.deps.events.append({
      taskId,
      correlationId: taskId,
      principalId: task.id,
      protocol: 'native',
      type: 'task.cancelled',
      payload: { reason },
    });
    return updated;
  }

  async getTask(taskId: string, tenantId: string): Promise<Task | undefined> {
    return this.deps.tasks.get(taskId, tenantId);
  }

  async listTasks(filter: { tenantId: string; sessionId?: string; state?: TaskState; limit?: number }): Promise<Task[]> {
    return this.deps.tasks.list(filter);
  }

  // ── helpers ──────────────────────────────────────────────────────────

  private async ensureTask(req: InvokeRequest, ctx: DispatchContext, principal: Principal, tenantId: string): Promise<Task> {
    if (req.taskId !== undefined) {
      const existing = await this.deps.tasks.get(req.taskId, tenantId);
      if (existing !== undefined) return existing;
    }
    return this.createTask({
      sessionId: ctx.session?.id ?? req.sessionId ?? 'ephemeral',
      tenantId,
      principal,
      blocks: [{ type: 'text', text: `invoke ${req.capabilityId}` }],
    });
  }

  private fallbackSession(tenantId: string, principal: Principal): Session {
    const now = this.now();
    return {
      id: 'ephemeral',
      tenantId,
      principal,
      protocolBinding: 'native',
      workspaceRoots: [],
      policyRevision: this.deps.policy.revision,
      budgetId: 'default',
      createdAt: now,
      updatedAt: now,
      state: 'open',
      approvalAuthority: 'local',
    };
  }

  private subjectFor(
    capability: { id: string; risk: string; kind: string },
    req: InvokeRequest,
    reason: string,
  ): import('../ir/types.js').ApprovalSubject {
    const input = req.input as Record<string, unknown> | null;
    const readString = (key: string): string | undefined => {
      const v = input?.[key];
      return typeof v === 'string' ? v : undefined;
    };
    const kind: import('../ir/types.js').ApprovalSubjectKind =
      capability.kind === 'fs' ? 'fs'
      : capability.kind === 'terminal' ? 'terminal'
      : capability.risk === 'network' ? 'network'
      : 'tool';
    const subject: import('../ir/types.js').ApprovalSubject = {
      kind,
      summary: `Allow ${capability.id}?`,
      detail: reason,
      detailTrust: 'untrusted',
    };
    const path = readString('path') ?? readString('file_path') ?? readString('filePath');
    if (path !== undefined) subject.resource = { uri: path, operation: capability.risk === 'write' ? 'write' : 'read' };
    const command = readString('command');
    if (command !== undefined) subject.command = { argv: [command], cwd: '' };
    const url = readString('url');
    if (url !== undefined) subject.resource = { uri: url, operation: 'read' };
    return subject;
  }

  private sanitizeInput(input: unknown): unknown {
    const redactor = this.deps.redactor;
    if (redactor === undefined) return input;
    const { value } = redactor.redactValue(input);
    return value;
  }

  /** Scrub the result of an execution before it is stored or returned. */
  private sanitizePayload(payload: InvokeResultPayload): InvokeResultPayload {
    const redactor = this.deps.redactor;
    if (redactor === undefined) return payload;
    const output = payload.output !== undefined ? redactor.redactValue(payload.output).value : undefined;
    const error = payload.error !== undefined ? redactError(redactor, payload.error) : undefined;
    const lossy = payload.lossy !== undefined ? redactor.redactValue(payload.lossy).value : undefined;
    const artifacts = payload.artifacts !== undefined ? redactor.redactValue(payload.artifacts).value : undefined;
    return {
      ...payload,
      ...(output !== undefined ? { output } : {}),
      ...(error !== undefined ? { error } : {}),
      ...(lossy !== undefined ? { lossy } : {}),
      ...(artifacts !== undefined ? { artifacts } : {}),
    };
  }

  private payloadFromError(e: unknown): InvokeResultPayload {
    if (CanonicalError.is(e)) {
      const shape = e.toShape();
      const outcome: InvokeResultPayload['outcome'] =
        shape.kind === 'timed_out' ? 'timed_out'
        : shape.kind === 'cancelled' ? 'cancelled'
        : shape.kind === 'indeterminate' ? 'indeterminate'
        : 'failed';
      return { outcome, error: shape };
    }
    const error: CanonicalErrorShape = {
      kind: 'internal',
      message: e instanceof Error ? e.message : String(e),
      retryable: false,
    };
    return { outcome: 'failed', error };
  }

  /**
   * A receipt for an invocation that never reached dispatch (denied, approval
   * refused, budget exhausted, obligation unsupported). Without this the four
   * most security-relevant outcomes would leave no evidence at all.
   */
  private async writeTerminalReceipt(input: {
    task: Task;
    tenantId: string;
    capabilityId: string;
    protocol: InvokeRequest['protocol'];
    principal: Principal;
    outcome: InvocationState;
    inputHash: string;
    policyRevision: string;
    decisionId: string;
    effect: 'allow' | 'deny' | 'ask';
    obligations: Obligation[];
    visibility: Receipt['visibility'];
    delegationChain: string[];
    approvalIds?: string[];
    error?: CanonicalErrorShape;
  }, ctx: DispatchContext): Promise<Receipt> {
    const now = this.now();
    const draft: Omit<Receipt, 'hash' | 'prevHash'> = {
      id: newId(this.deps.kernel.ids, 'receipt'),
      tenantId: input.tenantId,
      taskId: input.task.id,
      invocationId: newId(this.deps.kernel.ids, 'invocation'),
      protocol: input.protocol,
      capabilityId: input.capabilityId,
      principalId: input.principal.id,
      delegationChain: input.delegationChain,
      outcome: input.outcome,
      inputHash: input.inputHash,
      artifacts: [],
      approvals: input.approvalIds ?? [],
      policy: {
        revision: input.policyRevision,
        decisionId: input.decisionId,
        effect: input.effect,
        obligations: input.obligations.map((o) => o.type),
      },
      timing: { queuedAt: now, startedAt: now, endedAt: now },
      visibility: input.visibility,
      ...(input.error !== undefined ? { error: input.error } : {}),
    } as Omit<Receipt, 'hash' | 'prevHash'>;
    const receipt = await this.deps.receipts.put(draft);
    await this.emit(
      input.task,
      input.principal,
      input.protocol,
      'receipt.issued',
      { receiptId: receipt.id, outcome: input.outcome, error: input.error?.kind },
      ctx,
    );
    return receipt;
  }

  private async writeReceipt(input: {
    task: Task;
    tenantId: string;
    invocationId: string;
    capabilityId: string;
    protocol: InvokeRequest['protocol'];
    principal: Principal;
    outcome: InvocationState;
    inputHash: string;
    outputHash?: string;
    artifacts: ArtifactRef[];
    approvalIds: string[];
    policyRevision: string;
    decisionId: string;
    effect: 'allow' | 'deny' | 'ask';
    obligations: Obligation[];
    usage?: UsageReport;
    visibility: Receipt['visibility'];
    lossy?: string[];
    delegationChain: string[];
    error?: CanonicalErrorShape;
    queuedAt?: string;
    startedAt?: string;
  }, ctx: DispatchContext): Promise<Receipt> {
    const now = this.now();
    const draft: Omit<Receipt, 'hash' | 'prevHash'> = {
      id: newId(this.deps.kernel.ids, 'receipt'),
      tenantId: input.tenantId,
      taskId: input.task.id,
      invocationId: input.invocationId,
      protocol: input.protocol,
      capabilityId: input.capabilityId,
      principalId: input.principal.id,
      delegationChain: input.delegationChain,
      outcome: input.outcome,
      inputHash: input.inputHash,
      ...(input.outputHash !== undefined ? { outputHash: input.outputHash } : {}),
      artifacts: input.artifacts,
      approvals: input.approvalIds,
      policy: {
        revision: input.policyRevision,
        decisionId: input.decisionId,
        effect: input.effect,
        obligations: input.obligations.map((o) => o.type),
      },
      ...(input.usage !== undefined
        ? {
            usage: {
              ...(input.usage.inputTokens !== undefined ? { inputTokens: input.usage.inputTokens } : {}),
              ...(input.usage.outputTokens !== undefined ? { outputTokens: input.usage.outputTokens } : {}),
              ...(input.usage.cacheReadTokens !== undefined ? { cacheReadTokens: input.usage.cacheReadTokens } : {}),
              ...(input.usage.cacheWriteTokens !== undefined ? { cacheWriteTokens: input.usage.cacheWriteTokens } : {}),
              ...(input.usage.costUsd !== undefined ? { costUsd: input.usage.costUsd } : {}),
            },
          }
        : {}),
      timing: {
        queuedAt: input.queuedAt ?? now,
        startedAt: input.startedAt ?? now,
        endedAt: now,
      },
      visibility: input.visibility,
      ...(input.lossy !== undefined && input.lossy.length > 0 ? { lossy: input.lossy } : {}),
      ...(input.error !== undefined ? { error: input.error } : {}),
    };
    const receipt = await this.deps.receipts.put(draft);
    await this.emit(
      input.task,
      input.principal,
      input.protocol,
      'receipt.issued',
      { receiptId: receipt.id, outcome: input.outcome },
      ctx,
      input.invocationId,
    );
    return receipt;
  }

  private async writeAudit(
    action: string,
    tenantId: string,
    principal: Principal,
    subject: { type: string; id: string },
    outcome: 'success' | 'failure' | 'denied',
    policyRevision: string,
  ): Promise<void> {
    await this.deps.audit.append({
      ts: this.now(),
      tenantId,
      actor: {
        type: principal.kind === 'user' ? 'user' : principal.kind === 'agent' ? 'agent' : 'service',
        id: principal.id,
      },
      action,
      subject,
      outcome,
      policyRevision,
    });
  }

  private async emit(
    task: Task,
    principal: Principal,
    protocol: InvokeRequest['protocol'],
    type: CanonicalEvent['type'],
    payload: unknown,
    ctx: DispatchContext,
    invocationId?: string,
  ): Promise<void> {
    // Redact BEFORE the event reaches the log or a subscriber (I7).
    const redactor = this.deps.redactor;
    const safePayload = redactor !== undefined ? redactor.redactValue(payload).value : payload;
    const event = await this.deps.events.append({
      taskId: task.id,
      ...(invocationId !== undefined ? { invocationId } : {}),
      correlationId: ctx.correlationId ?? task.id,
      principalId: principal.id,
      protocol: protocol === 'local' ? 'native' : protocol,
      type,
      payload: safePayload,
    });
    ctx.emit?.(event);
  }

  private now(): string {
    return new Date(this.deps.kernel.runtime.clock.now()).toISOString();
  }

  private eventTypeFor(outcome: InvocationState): CanonicalEvent['type'] {
    switch (outcome) {
      case 'succeeded': return 'invocation.completed';
      case 'denied': return 'invocation.denied';
      default: return 'invocation.failed';
    }
  }
}

/**
 * Obligations the kernel cannot enforce on its own.
 *
 * `require_approval` IS enforced (the approval step runs), and `redact`,
 * `audit_level`, `ttl`, `no_retry` and `max_output_bytes` are applied by the
 * kernel/dispatcher. The rest would have to be honoured by the executor; if
 * the executor cannot prove it did, the call must be refused rather than run
 * unguarded (02 §5.2).
 */
function firstUnsupportedObligation(obligations: Obligation[]): string | undefined {
  for (const o of obligations) {
    switch (o.type) {
      case 'require_approval':
      case 'redact':
      case 'audit_level':
      case 'no_retry':
      case 'ttl':
      case 'max_output_bytes':
        continue;
      case 'sandbox':
        if (o.level === 'none') continue;
        return `sandbox:${o.level}`;
      case 'network_allowlist':
        return `network_allowlist:${o.hosts.join(',')}`;
      case 'delegation_limit':
        return `delegation_limit:${o.maxHops}`;
    }
  }
  return undefined;
}

function normalizeOutcome(outcome: InvokeResultPayload['outcome']): InvocationState {
  switch (outcome) {
    case 'succeeded': return 'succeeded';
    case 'failed': return 'failed';
    case 'cancelled': return 'cancelled';
    case 'timed_out': return 'timed_out';
    case 'indeterminate': return 'indeterminate';
  }
}
