/**
 * The fabric (02 §2): one kernel, three edges.
 *
 * `createFabric()` assembles the governance kernel — policy, approvals, budget,
 * idempotency, receipts, audit, registry, identity, tasks, events — and exposes
 * the surface every host needs:
 *
 *   fabric.call(...)      → one governed invocation (inbound or outbound)
 *   fabric.mount(adapter) → attach an MCP / A2A / ACP edge
 *   fabric.tasks.*        → the task engine
 *   fabric.approvals.*    → the approval queue
 *   fabric.budget.*       → the ledger
 *   fabric.audit.*        → the hash chain
 *   fabric.evidence.*     → the evidence bundles
 *
 * The fabric is the ONLY place that knows how to reach a side effect: it owns
 * the executor and hands adapters an `AuthorizedInvocation` (I13).
 */

import {
  sha256Hex,
  type Logger,
  type PermissionEngine,
  type Runtime,
  type Tool,
  type ToolOutput,
  type ToolRegistry,
} from '@syaocode/core';
import { CanonicalError } from '../ir/errors.js';
import { newId } from '../ir/ids.js';
import type {
  ApprovalRecord,
  Capability,
  CanonicalEvent,
  Effect,
  EvidenceBundle,
  InvocationState,
  Principal,
  Protocol,
  Session,
  Task,
  TaskState,
} from '../ir/types.js';
import type {
  AdapterContext,
  AuthorizedInvocation,
  DispatchContext,
  Dispatcher,
  FabricStores,
  Hasher,
  InvokeRequest,
  InvokeResult,
  InvokeResultPayload,
  KernelContext,
  PolicyEngine,
  ProtocolAdapter,
  SecretRedactor,
} from '../governance/contracts.js';
import { ApprovalBrokerImpl } from '../governance/approval.js';
import { BudgetLedgerImpl } from '../governance/budget.js';
import { GovernanceDispatcher } from '../governance/dispatcher.js';
import { MemoryIdempotencyStore } from '../governance/idempotency.js';
import { RulePolicyEngine, createPermissionPreset } from '../governance/policy.js';
import { computeRevision, emptyBundle, layerBundles } from '../governance/policy-bundle.js';
import { createMemoryStores } from './stores.js';

export interface FabricPolicyOptions {
  /** Base bundle. When absent, a deny-by-default bundle is generated. */
  bundle?: import('../ir/types.js').PolicyBundle;
  /** Extra rules appended to the base bundle (session / user layer). */
  rules?: import('../ir/types.js').PolicyRule[];
  defaultEffect?: Effect;
  /** Bridge to the existing local permission engine (02 §5.6). */
  permissionEngine?: PermissionEngine;
  /** Maps a capability id onto the tool name used for local rule matching. */
  localToolName?: (capabilityId: string) => string;
}

export interface FabricBudgetOptions {
  tenantLimitUsd?: number;
  sessionLimitUsd?: number;
  taskLimitUsd?: number;
}

export interface FabricOptions {
  runtime: Runtime;
  /** Cryptographic digest for the audit/evidence chains. Defaults to core SHA-256. */
  hash?: Hasher;
  logger?: Logger;
  policy?: FabricPolicyOptions;
  budget?: FabricBudgetOptions;
  /** Override individual stores (durable hosts pass file-backed ones). */
  stores?: Partial<FabricStores>;
  /** Present pending approvals to the authority (TUI panel, ACP request). */
  presentApproval?: (record: ApprovalRecord) => void | Promise<void>;
  approvalTimeoutMs?: number;
  redactor?: SecretRedactor;
  /** Built-in tools exposed as `local://tools/<name>` capabilities. */
  tools?: ToolRegistry;
  /** Default workspace roots for path fencing. */
  workspaceRoots?: string[];
  tenantId?: string;
  /** Default principal for calls that do not name one. */
  principal?: Principal;
  /** Called for every pipeline step — used by the CLI to show progress. */
  onStep?: (step: string, detail: Record<string, unknown>) => void;
}

export interface MountOptions {
  /** Registry-assigned provider id. Defaults to `<protocol>-<n>`. */
  providerId?: string;
  endpoint?: string;
  trust?: import('../ir/types.js').TrustTier;
  ttlMs?: number;
  /** Defaults applied to every discovered capability. */
  risk?: import('../ir/types.js').Risk;
  sideEffect?: import('../ir/types.js').SideEffect;
  dataClass?: import('../ir/types.js').DataClass;
  visibility?: import('../ir/types.js').Visibility;
  reversible?: boolean;
}

export interface MountedAdapter {
  adapter: ProtocolAdapter;
  providerId: string;
  capabilities(): import('../ir/types.js').AdapterCapabilities;
}

export interface FabricStatus {
  tenantId: string;
  adapters: {
    providerId: string;
    protocol: string;
    version: string;
    capabilities: number;
    health: string;
    lossy: string[];
    /** True when the edge is mounted but its catalogue could not be read. */
    unavailable?: boolean;
    /** Why the edge is unavailable (mount or discovery failure). */
    reason?: string;
  }[];
  capabilityCount: number;
  pendingApprovals: number;
  tasks: { total: number; unterminated: number };
  policyRevision: string;
}

export interface Fabric {
  readonly kernel: KernelContext;
  readonly stores: FabricStores;
  readonly policy: PolicyEngine;
  readonly dispatcher: Dispatcher;

  createSession(input: {
    principal?: Principal;
    protocolBinding?: Session['protocolBinding'];
    workspaceRoots?: string[];
    budgetId?: string;
    approvalAuthority?: Session['approvalAuthority'];
    metadata?: Record<string, string>;
  }): Promise<Session>;

  mount(adapter: ProtocolAdapter, opts?: MountOptions): Promise<MountedAdapter>;
  /** Refresh the capability catalogue from every mounted edge. */
  discover(): Promise<Capability[]>;
  capabilities(filter?: { kind?: Capability['kind']; protocol?: string; q?: string }): Promise<Capability[]>;

  /** One governed invocation. */
  call(input: {
    capabilityId: string;
    input?: unknown;
    principal?: Principal;
    sessionId?: string;
    taskId?: string;
    direction?: import('../ir/types.js').Direction;
    protocol?: Protocol;
    idempotencyKey?: string;
    deadlineAt?: string;
    estimate?: import('../ir/types.js').BudgetEstimate;
    cwd?: string;
    workspaceRoots?: string[];
  }): Promise<InvokeResult>;

  readonly tasks: {
    create(input: { sessionId?: string; principal?: Principal; blocks?: Task['input']; parentTaskId?: string }): Promise<Task>;
    get(taskId: string): Promise<Task | undefined>;
    list(filter?: { state?: TaskState; sessionId?: string; limit?: number }): Promise<Task[]>;
    cancel(taskId: string, reason: string): Promise<Task>;
    events(taskId: string, afterSeq?: number): Promise<CanonicalEvent[]>;
  };

  readonly approvals: {
    listPending(): Promise<ApprovalRecord[]>;
    get(id: string): Promise<ApprovalRecord | undefined>;
    decide(id: string, optionId: string, by: string, reason?: string): Promise<boolean>;
  };

  readonly budget: {
    list(): Promise<import('../ir/types.js').BudgetAccount[]>;
    get(accountId: string): Promise<import('../ir/types.js').BudgetAccount | undefined>;
  };

  readonly audit: {
    list(filter?: { limit?: number }): Promise<import('../ir/types.js').AuditEvent[]>;
    verify(tenantId?: string): Promise<import('../ir/types.js').AuditVerifyResult>;
  };

  readonly evidence: {
    seal(taskId: string): Promise<EvidenceBundle>;
    verify(bundle: EvidenceBundle): Promise<{ ok: boolean; checks: import('../ir/types.js').EvidenceCheck[] }>;
  };

  policyExplain(input: { capabilityId: string; input?: unknown; principal?: Principal; sessionId?: string }): Promise<import('../ir/types.js').PolicyDecision>;

  status(): Promise<FabricStatus>;
  /** Crash recovery: release stale holds and rebuild unterminated tasks. */
  recover(): Promise<{ releasedReservations: number; unterminatedTasks: number }>;
  close(): Promise<void>;
}

export function createFabric(opts: FabricOptions): Fabric {
  const runtime = opts.runtime;
  const logger = opts.logger ?? runtime.logger;
  const hash: Hasher = opts.hash ?? { sha256: sha256Hex };
  const now = (): string => new Date(runtime.clock.now()).toISOString();

  const kernel: KernelContext = { runtime, hash, ids: runtime.ids, logger };

  const stores: FabricStores = {
    ...createMemoryStores({ ids: runtime.ids, now, hash }),
    ...(opts.stores ?? {}),
  };
  if (opts.stores?.idempotency === undefined) {
    stores.idempotency = new MemoryIdempotencyStore({ ids: runtime.ids, now });
  }

  // ── policy ───────────────────────────────────────────────────────────
  const tenantId = opts.tenantId ?? 'default';
  const policyOptions = opts.policy ?? {};
  const baseBundle = policyOptions.bundle ?? emptyBundle(hash, tenantId, policyOptions.defaultEffect ?? 'deny');
  const bundle = policyOptions.rules !== undefined && policyOptions.rules.length > 0
    ? layerBundles({
        hasher: hash,
        tenantId,
        defaultEffect: policyOptions.defaultEffect ?? baseBundle.defaultEffect,
        org: baseBundle,
        session: {
          ...baseBundle,
          rules: policyOptions.rules,
          revision: computeRevision(hash, { ...baseBundle, rules: policyOptions.rules }),
        },
      })
    : baseBundle;

  const preset = policyOptions.permissionEngine !== undefined
    ? createPermissionPreset(policyOptions.permissionEngine, {
        ...(policyOptions.localToolName !== undefined ? { toolNameFor: policyOptions.localToolName } : {}),
      })
    : undefined;

  const policy: PolicyEngine = new RulePolicyEngine({
    bundle,
    ids: runtime.ids,
    now,
    ...(preset !== undefined ? { preset } : {}),
  });

  // ── governance engines ───────────────────────────────────────────────
  const approvals = new ApprovalBrokerImpl({
    store: stores.approvals,
    ids: runtime.ids,
    now,
    ...(opts.presentApproval !== undefined ? { present: opts.presentApproval } : {}),
    ...(opts.approvalTimeoutMs !== undefined ? { defaultTimeoutMs: opts.approvalTimeoutMs } : {}),
    recheckPolicy: async (record): Promise<Effect | undefined> => {
      const entry = await stores.registry.get(capabilityIdOfApproval(record));
      if (entry === undefined) return undefined;
      const decision = await policy.evaluate({
        principal: { id: 'unknown', kind: 'service', tenantId: record.tenantId, scopes: [], trustTier: 'verified' },
        session: {
          id: record.taskId,
          tenantId: record.tenantId,
          principal: { id: 'unknown', kind: 'service', tenantId: record.tenantId, scopes: [], trustTier: 'verified' },
          protocolBinding: 'native',
          workspaceRoots: opts.workspaceRoots ?? [],
          policyRevision: record.policyRevision,
          budgetId: 'default',
          createdAt: record.createdAt,
          updatedAt: record.createdAt,
          state: 'open',
          approvalAuthority: record.authority,
        },
        capability: entry.capability,
        input: undefined,
        inputHash: record.id,
        context: {
          protocol: entry.capability.protocol,
          direction: 'outbound',
          workspaceRoots: opts.workspaceRoots ?? [],
          cwd: opts.workspaceRoots?.[0] ?? '',
          now: now(),
          trust: 'verified',
          dataClass: entry.capability.dataClass,
        },
        budget: { accountId: 'default' },
        approvalHistory: [],
      });
      return decision.effect;
    },
  });

  const budget = new BudgetLedgerImpl({
    store: stores.budget,
    ids: runtime.ids,
    now,
    resolveExpired: async (reservation) => {
      // A hold whose invocation produced a receipt was really spent: charge it
      // rather than refunding (02 §7.2 crash recovery).
      const receipts = await stores.receipts.listByTask(reservation.accountId, tenantId).catch(() => []);
      const matched = receipts.find((r) => r.usage?.costUsd !== undefined);
      return matched?.usage?.costUsd;
    },
  });

  /**
   * The tenant and default session accounts must exist before the first
   * reservation, otherwise a session-less call would fail on a missing
   * account instead of being governed. Created once, lazily.
   */
  let accountsReady: Promise<void> | undefined;
  const ensureAccounts = (): Promise<void> => {
    accountsReady ??= (async () => {
      // Root first: the tenant account is the outermost budget.
      await budget.ensureAccount({
        id: `tenant:${tenantId}`,
        tenantId,
        currency: 'USD',
        state: 'active',
        ...(opts.budget?.tenantLimitUsd !== undefined ? { limitUsd: opts.budget.tenantLimitUsd } : {}),
      });
      // `default` is the implicit session account, parented to the tenant so a
      // session can never outspend the tenant budget.
      await budget.ensureAccount({
        id: 'default',
        tenantId,
        parentId: `tenant:${tenantId}`,
        currency: 'USD',
        state: 'active',
        ...(opts.budget?.sessionLimitUsd !== undefined ? { limitUsd: opts.budget.sessionLimitUsd } : {}),
      });
    })();
    return accountsReady;
  };

  // ── capability registry + local tools ────────────────────────────────
  const localTools = new Map<string, Tool>();
  if (opts.tools !== undefined) {
    for (const tool of opts.tools.list()) localTools.set(tool.name, tool);
  }

  const mounted: MountedAdapter[] = [];
  /**
   * Executors keyed by PROVIDER ID, not by protocol: several edges of the same
   * protocol may be mounted at once, and un-mounting one must not unroute the
   * others. `local` is the provider id of the built-in tools.
   */
  const executors = new Map<string, (inv: AuthorizedInvocation, ctx: DispatchContext) => Promise<InvokeResultPayload>>();
  /**
   * Edges whose catalogue could not be read. Kept so `status()` can report a
   * degraded edge instead of hiding it, and so one broken peer never makes the
   * whole capability catalogue unavailable (02 §16).
   */
  const edgeFailures = new Map<string, string>();

  const dispatcher = new GovernanceDispatcher({
    kernel,
    policy,
    approvals,
    budget,
    idempotency: stores.idempotency,
    receipts: stores.receipts,
    audit: stores.audit,
    registry: stores.registry,
    identity: stores.identity,
    tasks: stores.tasks,
    sessions: stores.sessions,
    events: stores.events,
    ...(opts.redactor !== undefined ? { redactor: opts.redactor } : {}),
    ...(opts.onStep !== undefined ? { onStep: opts.onStep } : {}),
    async execute(invocation, ctx): Promise<InvokeResultPayload> {
      const providerId = invocation.capability.provider.id;
      const executor = executors.get(providerId);
      if (executor === undefined) {
        throw new CanonicalError({
          kind: 'unsupported_capability',
          message: `No edge is mounted for provider '${providerId}' (protocol '${invocation.capability.protocol}').`,
        });
      }
      return executor(invocation, ctx);
    },
  });

  const fabric: Fabric = {
    kernel,
    stores,
    policy,
    dispatcher,

    async createSession(input) {
      await ensureAccounts();
      const principal = input.principal ?? opts.principal ?? defaultPrincipal(tenantId);
      const ts = now();
      const session: Session = {
        id: newId(runtime.ids, 'session'),
        tenantId,
        principal,
        protocolBinding: input.protocolBinding ?? 'native',
        workspaceRoots: input.workspaceRoots ?? opts.workspaceRoots ?? [],
        policyRevision: policy.revision,
        budgetId: input.budgetId ?? 'default',
        createdAt: ts,
        updatedAt: ts,
        state: 'open',
        approvalAuthority: input.approvalAuthority ?? 'local',
        ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
      };
      await stores.sessions.create(session);
      await budget.ensureAccount({
        id: session.budgetId,
        tenantId,
        // Every session account is bounded by the tenant account.
        ...(session.budgetId === `tenant:${tenantId}` ? {} : { parentId: `tenant:${tenantId}` }),
        currency: 'USD',
        state: 'active',
        ...(opts.budget?.sessionLimitUsd !== undefined ? { limitUsd: opts.budget.sessionLimitUsd } : {}),
      });
      return session;
    },

    async mount(adapter, mountOpts = {}) {
      const providerId = mountOpts.providerId ?? `${adapter.protocol}-${mounted.length + 1}`;
      const mountedAdapter: MountedAdapter = {
        adapter,
        providerId,
        capabilities: () => adapter.capabilities(),
      };
      mounted.push(mountedAdapter);

      executors.set(providerId, async (invocation, ctx) => {
        const adapterCtx: AdapterContext = {
          runtime,
          signal: ctx.signal ?? new AbortController().signal,
          deadlineAt: invocation.deadlineAt ?? now(),
          append: async (draft) => {
            // The event log owns `seq`; the adapter only supplies the body.
            const event = await stores.events.append({
              ...draft,
              taskId: draft.taskId === '' ? invocation.taskId : draft.taskId,
              correlationId: draft.correlationId === '' ? invocation.taskId : draft.correlationId,
              principalId: draft.principalId === '' ? invocation.principal.id : draft.principalId,
            });
            ctx.emit?.(event);
            return event;
          },
          approval: approvals,
          redactor: opts.redactor ?? new NoopRedactor(),
          logger,
        };
        return adapter.invoke(invocation, adapterCtx);
      });

      // Register the local tools of this fabric as `local://tools/<name>`.
      if (adapter.protocol === 'acp') {
        // ACP reverse calls (fs/terminal) are client-owned capabilities; they
        // are discovered by the ACP adapter itself.
      }
      try {
        await refreshCapabilities(mountedAdapter, mountOpts);
        edgeFailures.delete(providerId);
      } catch (e) {
        // A mount that cannot discover anything is not usable: roll it back so
        // the edge never lingers as a poisoned entry that breaks discover().
        const index = mounted.indexOf(mountedAdapter);
        if (index >= 0) mounted.splice(index, 1);
        executors.delete(providerId);
        edgeFailures.set(providerId, e instanceof Error ? e.message : String(e));
        throw e;
      }
      return mountedAdapter;
    },

    async discover() {
      // One unreachable edge must not take the catalogue down with it: record
      // the failure, keep serving the edges that do answer.
      for (const m of mounted) {
        try {
          await refreshCapabilities(m, {});
          edgeFailures.delete(m.providerId);
        } catch (e) {
          const reason = e instanceof Error ? e.message : String(e);
          edgeFailures.set(m.providerId, reason);
          logger.log('warn', `edge '${m.providerId}' discovery failed: ${reason}`);
        }
      }
      return stores.registry.list({ tenantId });
    },

    async capabilities(filter) {
      return stores.registry.list({ ...(filter ?? {}), tenantId });
    },

    async call(input) {
      await ensureAccounts();
      const principal = input.principal ?? opts.principal ?? defaultPrincipal(tenantId);
      // I1: a caller cannot choose its own tenant. The host's tenant wins, and
      // a principal claiming another tenant is rejected rather than trusted.
      if (principal.tenantId !== tenantId) {
        throw new CanonicalError({
          kind: 'unauthorized',
          message: `principal tenant '${principal.tenantId}' does not match this fabric's tenant '${tenantId}'`,
        });
      }
      const session = input.sessionId !== undefined
        ? await stores.sessions.get(input.sessionId, tenantId)
        : undefined;
      const req: InvokeRequest = {
        principal,
        capabilityId: input.capabilityId,
        input: input.input ?? {},
        protocol: input.protocol ?? 'native',
        direction: input.direction ?? 'outbound',
        ...(input.taskId !== undefined ? { taskId: input.taskId } : {}),
        ...(input.sessionId !== undefined ? { sessionId: input.sessionId } : {}),
        ...(input.idempotencyKey !== undefined ? { idempotencyKey: input.idempotencyKey } : {}),
        ...(input.deadlineAt !== undefined ? { deadlineAt: input.deadlineAt } : {}),
      };
      const ctx: DispatchContext = {
        ...(session !== undefined ? { session } : {}),
        // The authoritative tenant for every downstream check.
        tenantId,
        cwd: input.cwd ?? opts.workspaceRoots?.[0] ?? runtime.env.get('PWD') ?? '',
        workspaceRoots: input.workspaceRoots ?? session?.workspaceRoots ?? opts.workspaceRoots ?? [],
      };
      if (input.estimate !== undefined) ctx.estimate = input.estimate;
      return dispatcher.invoke(req, ctx);
    },

    tasks: {
      async create(input) {
        const principal = input.principal ?? opts.principal ?? defaultPrincipal(tenantId);
        const sessionId = input.sessionId ?? 'ephemeral';
        return dispatcher.createTask({
          sessionId,
          tenantId,
          principal,
          blocks: input.blocks ?? [{ type: 'text', text: '' }],
          ...(input.parentTaskId !== undefined ? { parentTaskId: input.parentTaskId } : {}),
        });
      },
      async get(taskId) {
        return stores.tasks.get(taskId, tenantId);
      },
      async list(filter) {
        return stores.tasks.list({ tenantId, ...(filter ?? {}) });
      },
      async cancel(taskId, reason) {
        return dispatcher.cancelTask(taskId, reason, tenantId);
      },
      async events(taskId, afterSeq = 0) {
        return stores.events.list(taskId, afterSeq);
      },
    },

    approvals: {
      listPending: () => approvals.listPending({ tenantId }),
      get: (id) => approvals.get(id),
      async decide(id, optionId, by, reason) {
        const record = await approvals.get(id);
        if (record === undefined) return false;
        return approvals.decide(id, record.revision, {
          optionId,
          by,
          ...(reason !== undefined ? { reason } : {}),
        });
      },
    },

    budget: {
      list: () => budget.list(tenantId),
      get: (accountId) => budget.get(accountId),
    },

    audit: {
      // Always tenant-scoped: an unfiltered audit list would merge tenants.
      list: (filter) => stores.audit.list({ tenantId, ...(filter ?? {}) }),
      verify: (id) => stores.audit.verify(id ?? tenantId),
    },

    evidence: {
      async seal(taskId: string) {
        // I8: a task of another tenant must not be sealable here.
        const task = await stores.tasks.get(taskId, tenantId);
        if (task === undefined) {
          throw new CanonicalError({ kind: 'capability_not_found', message: `unknown task '${taskId}'` });
        }
        return stores.evidence.seal(taskId, tenantId);
      },
      verify: (bundle) => stores.evidence.verify(bundle),
    },

    async policyExplain(input) {
      const principal = input.principal ?? opts.principal ?? defaultPrincipal(tenantId);
      const session = input.sessionId !== undefined
        ? await stores.sessions.get(input.sessionId, tenantId)
        : undefined;
      const entry = await stores.registry.get(input.capabilityId);
      if (entry === undefined) {
        throw new CanonicalError({ kind: 'capability_not_found', message: `unknown capability '${input.capabilityId}'` });
      }
      const decision = await policy.explain({
        principal,
        session: session ?? {
          id: 'ephemeral',
          tenantId,
          principal,
          protocolBinding: 'native',
          workspaceRoots: opts.workspaceRoots ?? [],
          policyRevision: policy.revision,
          budgetId: 'default',
          createdAt: now(),
          updatedAt: now(),
          state: 'open',
          approvalAuthority: 'local',
        },
        capability: entry.capability,
        input: input.input ?? {},
        inputHash: hash.sha256(JSON.stringify(input.input ?? {})),
        context: {
          protocol: entry.capability.protocol,
          direction: 'outbound',
          workspaceRoots: opts.workspaceRoots ?? [],
          cwd: opts.workspaceRoots?.[0] ?? '',
          now: now(),
          trust: principal.trustTier,
          dataClass: entry.capability.dataClass,
        },
        budget: { accountId: 'default' },
        approvalHistory: [],
      });
      return decision;
    },

    async status() {
      const capabilities = await stores.registry.list({ tenantId });
      const pending = await approvals.listPending({ tenantId });
      const tasks = await stores.tasks.list({ tenantId });
      return {
        tenantId,
        adapters: mounted.map((m) => {
          const failure = edgeFailures.get(m.providerId);
          return {
            providerId: m.providerId,
            protocol: m.adapter.protocol,
            version: m.adapter.version,
            capabilities: capabilities.filter((c) => c.provider.id === m.providerId).length,
            health: failure === undefined ? 'healthy' : 'degraded',
            lossy: m.adapter.capabilities().lossy,
            ...(failure !== undefined ? { unavailable: true, reason: failure } : {}),
          };
        }),
        capabilityCount: capabilities.length,
        pendingApprovals: pending.length,
        tasks: {
          total: tasks.length,
          unterminated: tasks.filter((t) => t.state !== 'completed' && t.state !== 'failed' && t.state !== 'cancelled' && t.state !== 'rejected' && t.state !== 'expired').length,
        },
        policyRevision: policy.revision,
      };
    },

    async recover() {
      const releasedReservations = await budget.recoverExpired(now());
      const unterminated = await stores.tasks.listUnterminated(tenantId);
      return { releasedReservations, unterminatedTasks: unterminated.length };
    },

    async close() {
      for (const m of mounted) await m.adapter.close();
      mounted.length = 0;
      executors.clear();
    },
  };

  // Local tools are executed through the same governed path: the policy engine
  // already consulted the local permission engine via the preset.
  let localRegistration: Promise<void> | undefined;
  if (localTools.size > 0) {
    executors.set('local', async (invocation, ctx) => {
      const name = invocation.capability.id.replace(/^local:\/\/tools\//, '');
      const tool = localTools.get(name);
      if (tool === undefined) {
        throw new CanonicalError({ kind: 'capability_not_found', message: `unknown local tool '${name}'` });
      }
      const produced = tool.execute(invocation.input as never, {
        runtime,
        cwd: ctx.cwd,
        signal: ctx.signal ?? new AbortController().signal,
        progress: () => undefined,
      });
      // Tools may stream progress and finish with their output.
      const output: ToolOutput = isAsyncGenerator(produced) ? await drainTool(produced) : await produced;
      return {
        outcome: output.isError === true ? 'failed' : 'succeeded',
        output: {
          content: output.content,
          ...(output.meta !== undefined ? { meta: output.meta } : {}),
        },
        ...(output.meta?.trust === 'untrusted' ? { lossy: ['untrusted-content'] } : {}),
      };
    });

    // Register the local tools in the catalogue.
    localRegistration = (async (): Promise<void> => {
      for (const tool of localTools.values()) {
          await stores.registry.register({
          capability: {
            id: `local://tools/${tool.name}`,
            kind: 'tool',
            protocol: 'local',
            displayName: tool.name,
            risk: tool.risk === 'exec' ? 'execute' : tool.risk === 'network' ? 'network' : tool.risk === 'read' ? 'read' : 'write',
            sideEffect: tool.readOnly ? 'none' : 'non_idempotent',
            dataClass: 'internal',
            visibility: 'full',
            reversible: tool.readOnly,
            provider: {
              id: 'local',
              protocol: 'local',
              endpoint: `local://${tool.name}`,
              trust: 'first_party',
              health: 'healthy',
              // A built-in tool's catalogue is fixed for the process
              // lifetime: a TTL would make the tool "down" after a minute and
              // silently drop it out of the registry.
              ttlMs: 0,
              lastSeenAt: now(),
            },
          },
          labels: { tool: tool.name },
        });
      }
    })();
  }

  // Registration is asynchronous; expose it through `discover()` so callers
  // never observe a half-populated catalogue.
  const originalDiscover = fabric.discover;
  fabric.discover = async () => {
    if (localRegistration !== undefined) await localRegistration;
    return originalDiscover();
  };

  return fabric;

  /** Re-discover one edge and refresh its registry entries. */
  async function refreshCapabilities(m: MountedAdapter, mountOpts: MountOptions): Promise<void> {
    const adapterCtx: AdapterContext = {
      runtime,
      signal: new AbortController().signal,
      deadlineAt: now(),
      append: async (draft) => stores.events.append(draft),
      approval: approvals,
      redactor: opts.redactor ?? new NoopRedactor(),
      logger,
    };
    const discovered = await m.adapter.discover(adapterCtx);
    await stores.registry.registerDiscovered(
      {
        id: m.providerId,
        protocol: m.adapter.protocol,
        endpoint: mountOpts.endpoint ?? `${m.adapter.protocol}://${m.providerId}`,
        ...(m.adapter.version !== '' ? { version: m.adapter.version } : {}),
        trust: mountOpts.trust ?? 'verified',
        ttlMs: mountOpts.ttlMs ?? 300_000,
      },
      discovered,
      {
        ...(mountOpts.risk !== undefined ? { risk: mountOpts.risk } : {}),
        ...(mountOpts.sideEffect !== undefined ? { sideEffect: mountOpts.sideEffect } : {}),
        ...(mountOpts.dataClass !== undefined ? { dataClass: mountOpts.dataClass } : {}),
        ...(mountOpts.visibility !== undefined ? { visibility: mountOpts.visibility } : {}),
        ...(mountOpts.reversible !== undefined ? { reversible: mountOpts.reversible } : {}),
      },
    );
  }
}

function defaultPrincipal(tenantId: string): Principal {
  return {
    id: 'user:local',
    kind: 'user',
    tenantId,
    scopes: [],
    trustTier: 'verified',
  };
}

function capabilityIdOfApproval(record: ApprovalRecord): string {
  const subject = record.subject;
  if (subject.resource !== undefined) return subject.resource.uri;
  if (subject.command !== undefined) return subject.command.argv.join(' ');
  return record.id;
}

/** Minimal redactor used when the host does not inject one. */
class NoopRedactor implements SecretRedactor {
  register(_value: string, _type?: string): void {
    /* no-op */
  }
  redact(text: string): { text: string; hits: string[] } {
    return { text, hits: [] };
  }
  redactValue<T>(value: T): { value: T; hits: string[] } {
    return { value, hits: [] };
  }
}

export type { InvocationState };

function isAsyncGenerator(value: unknown): value is AsyncGenerator<unknown, ToolOutput, unknown> {
  return typeof (value as { next?: unknown } | null)?.next === 'function';
}

/** Drive a streaming tool to completion, discarding progress notes. */
async function drainTool(gen: AsyncGenerator<unknown, ToolOutput, unknown>): Promise<ToolOutput> {
  for (;;) {
    const step = await gen.next();
    if (step.done === true) return step.value;
  }
}
