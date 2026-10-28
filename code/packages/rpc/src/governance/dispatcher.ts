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
import { BudgetExceededError } from './budget.js';
import { derivedKey, idempotencyKeyOf, requestHash } from './idempotency.js';

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
    const { kernel, policy, approvals, budget, idempotency, receipts, audit, registry } = this.deps;
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
    // The principal arrives already authenticated (the identity service signs
    // it); here we assert the invariants the dispatcher owns (I1).
    step('authenticate');
    if (principal.id.trim() === '' || tenantId.trim() === '') {
      throw new CanonicalError({ kind: 'unauthenticated', message: 'the invocation carries no principal or tenant' });
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
    const hash = requestHash(kernel.hash, req.capabilityId, req.input, policy.revision);
    const clientKey = req.idempotencyKey ?? derivedKey(task.id, 'pending');
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
      throw error;
    }

    // Obligations the executor cannot honour must fail closed (02 §5.2).
    const sandbox = decision.obligations.find((o): o is Extract<Obligation, { type: 'sandbox' }> => o.type === 'sandbox');
    if (sandbox !== undefined && sandbox.level !== 'none') {
      const error = new CanonicalError({
        kind: 'unsupported_obligation',
        message: `The sandbox obligation '${sandbox.level}' cannot be honoured by this executor.`,
      });
      await idempotency.fail(key, error.toShape());
      throw error;
    }

    // ── 6. approve ──────────────────────────────────────────────────────
    step('approve');
    const approvalIds: string[] = [];
    if (decision.effect === 'ask') {
      const approval = await approvals.request({
        tenantId,
        taskId: task.id,
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
        throw error;
      }
    }

    // ── 7. reserve budget ───────────────────────────────────────────────
    step('reserve');
    let reservationId: string | undefined;
    const accountId = ctx.session?.budgetId ?? 'default';
    if (req.skipBudget !== true) {
      const estimate = ctx.estimate ?? { usd: this.deps.defaultEstimateUsd ?? 0 };
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
          throw error;
        }
        throw e;
      }
    }

    // ── 8. dispatch ─────────────────────────────────────────────────────
    step('dispatch');
    const invocationId = newId(kernel.ids, 'invocation');
    const authorized: AuthorizedInvocation = {
      invocationId,
      taskId: task.id,
      sessionId: ctx.session?.id ?? task.sessionId,
      tenantId,
      capability,
      endpoint: resolved.endpoint,
      input: this.sanitizeInput(req.input),
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
      await idempotency.fail(key, payload.error ?? { kind: 'remote_error', message: `invocation ${outcome}`, retryable: false });
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
      timing: { queuedAt: now, startedAt: now, endedAt: now },
      visibility: input.visibility,
      ...(input.lossy !== undefined && input.lossy.length > 0 ? { lossy: input.lossy } : {}),
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
    const event = await this.deps.events.append({
      taskId: task.id,
      ...(invocationId !== undefined ? { invocationId } : {}),
      correlationId: ctx.correlationId ?? task.id,
      principalId: principal.id,
      protocol: protocol === 'local' ? 'native' : protocol,
      type,
      payload,
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

function normalizeOutcome(outcome: InvokeResultPayload['outcome']): InvocationState {
  switch (outcome) {
    case 'succeeded': return 'succeeded';
    case 'failed': return 'failed';
    case 'cancelled': return 'cancelled';
    case 'timed_out': return 'timed_out';
    case 'indeterminate': return 'indeterminate';
  }
}
