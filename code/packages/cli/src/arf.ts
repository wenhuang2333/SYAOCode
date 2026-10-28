/**
 * The CLI's ARF (Agent RPC Fabric) instance.
 *
 * `createCliFabric()` assembles a `@syaocode/rpc` fabric out of the CLI's own
 * runtime and configuration:
 *
 *   - `nodeRuntime()` supplies the host primitives (fs / clock / ids / env);
 *   - the workspace roots fence every path-touching invocation;
 *   - the CLI permission tier is bridged through `createPermissionPreset(new
 *     PermissionEngine(...))` so the existing three-tier semantics keep
 *     working inside the governance kernel (ARF 02 §5.6);
 *   - policy rules derived from the tier become the session layer of the
 *     bundle (a lower layer can add rules, never relax a deny);
 *   - `presentApproval` records pending approvals so the TUI can list them and
 *     answer them with `/approve`.
 *
 * The fabric is a per-process singleton: `getCliFabric()` creates it lazily and
 * `disposeCliFabric()` tears it down. Nothing here touches the terminal.
 */

import {
  PermissionEngine,
  ToolRegistry,
  sha256Hex,
  type PermissionMode,
  type PermissionRule,
  type PermissionSubject,
  type PolicyVerdict,
  type Runtime,
  type ToolRisk,
} from '@syaocode/core';
import { nodeRuntime } from '@syaocode/node';
import { createBuiltinTools, FileStateTracker } from '@syaocode/tools';
import {
  CanonicalError,
  RulePolicyEngine,
  computeRevision,
  createFabric,
  emptyBundle,
  layerBundles,
  type ApprovalRecord,
  type BudgetEstimate,
  type Fabric,
  type FabricStores,
  type InvokeResult,
  type PolicyRule as ArfPolicyRule,
  type Principal,
  type SecretRedactor,
  type Session,
} from '@syaocode/rpc';
import { createCliRedactor } from './effective-config.js';
import { mountPeerEdge } from './edges.js';
import { listPeers, type PeerConfig } from './peers.js';
import type { ApprovalVerdict } from './arf-governor.js';

/** Loopback hosts that never need a bearer token (ARF 02 §11 / BR-041). */
export const LOOPBACK_HOSTS: readonly string[] = ['127.0.0.1', 'localhost', '::1', '0:0:0:0:0:0:0:1'];

export interface CliFabricOptions {
  /** Workspace root; defaults to `process.cwd()`. */
  cwd?: string;
  /** Extra directories that are in scope for path fencing. */
  extraDirs?: string[];
  /** Permission tier the CLI is currently running under. */
  permissionMode?: PermissionMode;
  /** Session-level permission rules (`/permissions allow|deny <tool>`). */
  rules?: PermissionRule[];
  /**
   * The permission engine the ARF policy preset must consult.
   *
   * The MAIN agent path passes the agent's own live engine (a getter, because
   * the agent is rebuilt on `/model` and `/permission`), so the kernel and the
   * agent gate on exactly the SAME rules and the same tier — a tier change is
   * picked up without recreating the fabric. When omitted the fabric builds
   * its own engine from `permissionMode` + `rules` (console / `serve` paths).
   */
  permissionEngine?: PermissionEngine | (() => PermissionEngine);
  /**
   * Mirror the tier into bundle rules (default). The main agent path sets
   * `false`: the preset already consults the live engine, and a bundle copy
   * would go stale the moment the user switches tier at runtime.
   */
  mirrorTierRules?: boolean;
  /**
   * Answer kernel `ask` decisions through the host's own authority.
   *
   * Returning `undefined` defers to `presentApproval` (used by the console
   * paths, which have no interactive agent engine).
   */
  approvalBridge?: (record: ApprovalRecord) => Promise<ApprovalVerdict | undefined>;
  /** Redactor for kernel input/output scrubbing; defaults to the CLI's. */
  redactor?: SecretRedactor;
  /** Tenant that owns every task / receipt / audit event. */
  tenantId?: string;
  /** Budget ceilings (USD). */
  maxBudgetUsd?: number;
  /** Overrides for the store bundle; see the PERSISTENCE SEAM below. */
  stores?: Partial<FabricStores>;
  /** Approval timeout in ms; defaults to the kernel's five minutes. */
  approvalTimeoutMs?: number;
  /** Injected runtime (tests use a deterministic one). */
  runtime?: Runtime;
  /** Called for every pending approval so a UI can show and answer it. */
  presentApproval?: (record: ApprovalRecord) => void | Promise<void>;
  /** Called after every governance pipeline step (progress / tracing). */
  onStep?: (step: string, detail: Record<string, unknown>) => void;
  /** Home override for the peer registry (tests pass a temp dir). */
  home?: string;
  /**
   * Built-in tool registry exposed as `local://tools/<name>` capabilities.
   *
   * Defaults to the CLI's built-ins. Pass `false` for a bare fabric (tests,
   * embedding) or a registry when the caller already owns one — the SAME
   * `FileStateTracker` must then be reused so read-before-write fencing holds.
   */
  tools?: ToolRegistry | false;
  /** FileStateTracker backing the built-in read/write/edit tools. */
  fileState?: FileStateTracker;
}

export interface CliFabric {
  fabric: Fabric;
  runtime: Runtime;
  cwd: string;
  workspaceRoots: string[];
  tenantId: string;
  permissionMode: PermissionMode;
  /** The principal every governed call runs as. */
  readonly principal: Principal;
  /**
   * Built-in tools as a registry (`local://tools/<name>` capabilities).
   * `undefined` when the caller opted out with `tools: false`.
   */
  readonly tools: ToolRegistry | undefined;
  /** FileStateTracker shared by the built-in read/write/edit tools. */
  readonly fileState: FileStateTracker;
  /** Pending approvals seen by the `presentApproval` hook. */
  readonly pendingApprovals: ApprovalRecord[];
  /**
   * Re-stamp the policy bundle for a new tier (`/permission si|yao|strict`).
   *
   * The preset already reads the live engine, so local tool decisions follow
   * a tier change with no rebuild; this keeps the *bundle* (the tier rules and
   * the default effect used for non-local capabilities) in step, which is what
   * the console's `/call mcp://…` and `/rpc policy` read.
   */
  setPermissionTier(mode: PermissionMode): void;
  /** Resolve a pending approval by id. Returns false when it was already taken. */
  decideApproval(id: string, optionId: string, by?: string, reason?: string): Promise<boolean>;
  /** Approval ids that were already decided (single-winner bookkeeping). */
  readonly decidedApprovals: Set<string>;
  /** Every approval this process ever saw, including already-decided ones. */
  readonly approvalHistory: ApprovalRecord[];
  /** The default session (created once); budget accounts hang off it. */
  ensureSession(): Promise<Session>;
  /** Governed invocation bound to the default session and workspace. */
  call(input: {
    capabilityId: string;
    input?: unknown;
    idempotencyKey?: string;
    estimate?: BudgetEstimate;
    taskId?: string;
  }): Promise<InvokeResult>;
  /**
   * Mount every peer in the user's edge registry (once per process).
   *
   * `/peer add`, `syao mcp add` and `/call` all funnel through here, so a peer
   * registered seconds ago is reachable without restarting the CLI.
   */
  mountRegisteredPeers(): Promise<MountReport[]>;
  /** Mount one peer that was just registered (fast path after `/peer add`). */
  mountPeer(id: string, peer?: PeerConfig): Promise<MountReport>;
  /** Peers whose mount failed, with the localized reason. */
  readonly failedPeers: ReadonlyMap<string, string>;
  dispose(): Promise<void>;
}

/** Outcome of mounting one registered peer. */
export interface MountReport {
  id: string;
  protocol: string;
  ok: boolean;
  capabilities: number;
  reason?: string;
  edgeUnavailable?: boolean;
}

/** True when the host is a loopback address (no token required). */
export function isLoopbackHost(host: string): boolean {
  const h = host.trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (LOOPBACK_HOSTS.includes(h)) return true;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h);
}

/**
 * Rules derived from the CLI permission tier.
 *
 * The kernel's bundle is deny-by-default; the tier decides how the *local*
 * half behaves. `ask` keeps the tier visible in the trace, and an explicit
 * `deny` rule can never be relaxed by the tier.
 */
export function tierPolicyRules(mode: PermissionMode, rules: readonly PermissionRule[] = []): ArfPolicyRule[] {
  const out: ArfPolicyRule[] = [];
  let priority = 10;
  for (const rule of rules) {
    out.push({
      id: `cli-rule-${priority}`,
      priority,
      effect: rule.effect,
      match: {
        ...(rule.tool !== '*' ? { capabilities: [rule.tool] } : {}),
        ...(rule.match?.path !== undefined ? { paths: [rule.match.path] } : {}),
        ...(rule.match?.command !== undefined ? { commands: [rule.match.command] } : {}),
        ...(rule.match?.url !== undefined ? { urls: [rule.match.url] } : {}),
      },
      source: 'session',
      ...(rule.source === 'project' ? { reason: 'project rule' } : {}),
    });
    priority += 1;
  }
  // The tier itself becomes an `ask` rule for anything not covered above, so
  // the governance console can explain *why* a call needs an approval.
  if (mode === 'strict') {
    out.push({
      id: 'cli-tier-strict',
      priority: 900,
      effect: 'ask',
      match: { protocols: ['mcp', 'a2a', 'acp', 'local'] },
      source: 'session',
      reason: 'strict tier: every action needs confirmation',
    });
  }
  return out;
}

/** Map a CLI tier onto the bundle's default effect for *unmatched* calls. */
export function tierDefaultEffect(mode: PermissionMode): 'allow' | 'deny' | 'ask' {
  switch (mode) {
    case 'bypass':
      return 'allow';
    case 'acceptEdits':
    case 'default':
      return 'ask';
    case 'plan':
    case 'strict':
      return 'deny';
  }
}

/** Build the CLI's fabric. Pure-ish: it only reads the runtime and config. */
export function createCliFabric(opts: CliFabricOptions = {}): CliFabric {
  const runtime = opts.runtime ?? nodeRuntime();
  const cwd = opts.cwd ?? process.cwd();
  const workspaceRoots = [cwd, ...(opts.extraDirs ?? [])].filter((r) => r !== '');
  const tenantId = opts.tenantId ?? 'syaocode-local';
  const permissionMode = opts.permissionMode ?? 'default';
  const rules = opts.rules ?? [];

  const pendingApprovals: ApprovalRecord[] = [];
  const decidedApprovals = new Set<string>();
  const approvalHistory: ApprovalRecord[] = [];
  let session: Session | undefined;

  const engine = new PermissionEngine({
    mode: permissionMode,
    rules,
    workspaceRoots,
    runtime,
  });
  // The MAIN agent path hands the fabric a getter for the agent's LIVE engine
  // (the agent is rebuilt on `/model` and `/permission`), so the kernel always
  // gates on exactly the rules and tier the agent is using right now — no
  // second rule set, no stale snapshot.
  const policyEngine: PermissionEngine =
    opts.permissionEngine === undefined
      ? engine
      : typeof opts.permissionEngine === 'function'
        ? new LivePermissionEngine(opts.permissionEngine, runtime)
        : opts.permissionEngine;

  const principal: Principal = {
    id: 'user:local',
    kind: 'user',
    tenantId,
    scopes: [],
    trustTier: 'first_party',
    displayName: 'local user',
  };

  /**
   * Policy bundle for one tier.
   *
   * Built here (rather than letting `createFabric` layer `policy.rules`) so
   * `setPermissionTier()` can re-stamp the SAME bundle shape on a runtime
   * tier switch without recreating the fabric — recreating it would drop the
   * receipts, approvals and audit chain collected so far.
   */
  const hasher = { sha256: sha256Hex };
  const bundleFor = (mode: PermissionMode): import('@syaocode/rpc').PolicyBundle => {
    const base = emptyBundle(hasher, tenantId, tierDefaultEffect(mode));
    const tier = opts.mirrorTierRules === false ? [] : tierPolicyRules(mode, rules);
    if (tier.length === 0) return base;
    const session = { ...base, rules: tier };
    return layerBundles({
      hasher,
      tenantId,
      defaultEffect: base.defaultEffect,
      org: base,
      session: { ...session, revision: computeRevision(hasher, session) },
    });
  };

  // ── built-in tools as `local://tools/<name>` capabilities ─────────────
  // ONE FileStateTracker for the whole CLI session: read-before-write fencing
  // (a stale-read edit must fail) only works if every tool shares it.
  const builtins = opts.tools === false ? undefined : createBuiltinTools();
  const fileState = opts.fileState ?? builtins?.fileState ?? new FileStateTracker();
  const tools: ToolRegistry | undefined =
    opts.tools === false
      ? undefined
      : (opts.tools ?? (() => {
          const registry = new ToolRegistry();
          for (const tool of builtins?.tools ?? []) registry.register(tool);
          return registry;
        })());

  const fabric = createFabric({
    runtime,
    principal,
    tenantId,
    workspaceRoots,
    policy: {
      bundle: bundleFor(permissionMode),
      permissionEngine: policyEngine,
      // `local://tools/<name>` maps onto the bare tool name for rule matching.
      localToolName: (capabilityId) => capabilityId.replace(/^local:\/\/tools\//, ''),
    },
    budget:
      opts.maxBudgetUsd !== undefined
        ? { tenantLimitUsd: opts.maxBudgetUsd, sessionLimitUsd: opts.maxBudgetUsd }
        : {},
    redactor: opts.redactor ?? createCliRedactor(),
    ...(tools !== undefined ? { tools } : {}),
    presentApproval: async (record: ApprovalRecord) => {
      pendingApprovals.push(record);
      approvalHistory.push(record);
      // The agent path answers the kernel's `ask` through the SAME permission
      // engine the pipeline used to call, so the prompt, the remember scope
      // and the hot-tier recheck behave exactly as before. The console paths
      // have no live engine and fall through to their own presenter.
      const verdict = await opts.approvalBridge?.(record);
      if (verdict !== undefined) {
        await fabric.approvals.decide(
          record.id,
          verdict.decision === 'allow' ? 'allow_once' : 'deny_once',
          'user:local',
          ...(verdict.reason !== undefined ? [verdict.reason] : []),
        );
        return;
      }
      await opts.presentApproval?.(record);
    },
    ...(opts.approvalTimeoutMs !== undefined ? { approvalTimeoutMs: opts.approvalTimeoutMs } : {}),
    ...(opts.onStep !== undefined ? { onStep: opts.onStep } : {}),
    // PERSISTENCE SEAM ────────────────────────────────────────────────────
    // Everything above uses the kernel's in-memory store bundle, so tasks,
    // receipts, approvals, the audit chain and idempotency keys live for one
    // CLI process only. A durable host swaps the whole bundle here — the file
    // stores land in @syaocode/node (createFileTaskStore / createFileAuditStore
    // / createFileBudgetStore / createFileIdempotencyStore) and are passed
    // through `opts.stores`. No file-store implementation belongs in the CLI:
    // this is the single line where persistence plugs in, and `createFabric`
    // already accepts a partial `FabricStores` override.
    ...(opts.stores !== undefined ? { stores: opts.stores } : {}),
    // ──────────────────────────────────────────────────────────────────────
  });

  // ── registered protocol edges ─────────────────────────────────────────
  // The registry (peers.ts) is the source of truth; this keeps the mounted
  // set in sync so `/peer add` is usable in the same session.
  const mountedPeers = new Map<string, MountReport>();
  const failedPeers = new Map<string, string>();
  let mountPromise: Promise<MountReport[]> | undefined;

  const mountOptions = {
    runtime,
    fabric,
    principal,
    cwd,
    workspaceRoots,
    tenantId,
  };

  async function mountOne(id: string, peer: PeerConfig): Promise<MountReport> {
    const existing = mountedPeers.get(id);
    if (existing !== undefined && existing.ok) return existing;
    // One unreachable peer must never take the whole console down: a dead
    // server, a bad command or a protocol edge missing from this build all
    // degrade to a failed report that `/peer list` can show.
    let outcome: Awaited<ReturnType<typeof mountPeerEdge>>;
    try {
      outcome = await mountPeerEdge(peer, id, mountOptions);
    } catch (e) {
      outcome = {
        providerId: id,
        ok: false,
        capabilities: 0,
        reason: e instanceof Error ? e.message : String(e),
      };
    }
    const report: MountReport = {
      id,
      protocol: peer.protocol,
      ok: outcome.ok,
      capabilities: outcome.capabilities,
      ...(outcome.reason !== undefined ? { reason: outcome.reason } : {}),
      ...(outcome.edgeUnavailable === true ? { edgeUnavailable: true } : {}),
    };
    if (report.ok) {
      mountedPeers.set(id, report);
      failedPeers.delete(id);
    } else {
      failedPeers.set(id, report.reason ?? 'mount failed');
    }
    return report;
  }

  /** One default session per process: budget accounts hang off it. */
  async function ensureSession(): Promise<Session> {
    if (session === undefined) {
      session = await fabric.createSession({
        principal,
        workspaceRoots,
        metadata: { host: 'cli' },
      });
    }
    return session;
  }

  return {
    fabric,
    runtime,
    cwd,
    workspaceRoots,
    tenantId,
    permissionMode,
    principal,
    tools,
    fileState,
    pendingApprovals,
    decidedApprovals,
    approvalHistory,
    failedPeers,
    ensureSession,
    setPermissionTier(mode: PermissionMode): void {
      // Only the concrete rule engine can swap a bundle; a host-supplied
      // policy engine is left alone (it owns its own revision).
      if (!(fabric.policy instanceof RulePolicyEngine)) return;
      fabric.policy.setBundle(bundleFor(mode));
    },
    async mountPeer(id: string, peer?: PeerConfig): Promise<MountReport> {
      const entry = peer ?? listPeers(opts.home)[id];
      if (entry === undefined) {
        const missing: MountReport = { id, protocol: 'mcp', ok: false, capabilities: 0, reason: 'not registered' };
        failedPeers.set(id, missing.reason ?? 'not registered');
        return missing;
      }
      return mountOne(id, entry);
    },
    async mountRegisteredPeers(): Promise<MountReport[]> {
      if (mountPromise === undefined) {
        mountPromise = (async () => {
          const declared = listPeers(opts.home);
          const reports: MountReport[] = [];
          for (const [id, peer] of Object.entries(declared)) {
            reports.push(await mountOne(id, peer));
          }
          return reports;
        })();
      }
      return mountPromise;
    },
    async call(input): Promise<InvokeResult> {
      const active = await ensureSession();
      return fabric.call({
        capabilityId: input.capabilityId,
        input: input.input ?? {},
        sessionId: active.id,
        cwd,
        workspaceRoots,
        ...(input.idempotencyKey !== undefined ? { idempotencyKey: input.idempotencyKey } : {}),
        ...(input.estimate !== undefined ? { estimate: input.estimate } : {}),
        ...(input.taskId !== undefined ? { taskId: input.taskId } : {}),
      });
    },
    async decideApproval(id: string, optionId: string, by = 'user:local', reason?: string): Promise<boolean> {
      const ok = await fabric.approvals.decide(
        id,
        optionId,
        by,
        ...(reason !== undefined ? [reason] : []),
      );
      if (ok) {
        decidedApprovals.add(id);
        const idx = pendingApprovals.findIndex((r) => r.id === id);
        if (idx >= 0) pendingApprovals.splice(idx, 1);
        const after = await fabric.approvals.get(id);
        if (after !== undefined) {
          const h = approvalHistory.findIndex((r) => r.id === id);
          if (h >= 0) approvalHistory[h] = after;
        }
      }
      return ok;
    },
    async dispose(): Promise<void> {
      mountedPeers.clear();
      failedPeers.clear();
      mountPromise = undefined;
      await fabric.close();
    },
  };
}

/**
 * A `PermissionEngine` that always defers to the host's CURRENT engine.
 *
 * The fabric is a process singleton while the agent (and therefore its
 * engine) is rebuilt on `/model`, `/resume` and `/permission`. The ARF policy
 * preset must consult the LIVE engine — otherwise a runtime tier change could
 * be evaluated against a stale mode, which would either re-prompt in `si`
 * (annoying) or silently skip a `strict` confirmation (unsafe). The preset
 * only ever reads `mode` and `policyVerdict`, so those two are all that is
 * delegated; every other member keeps the base behaviour and is unused here.
 */
class LivePermissionEngine extends PermissionEngine {
  private readonly liveEngine: () => PermissionEngine;

  constructor(liveEngine: () => PermissionEngine, runtime: Runtime) {
    super({ mode: 'default', rules: [], workspaceRoots: [], runtime });
    this.liveEngine = liveEngine;
  }

  override get mode(): PermissionMode {
    return this.liveEngine().mode;
  }

  override policyVerdict(toolName: string, risk: ToolRisk, subject: PermissionSubject): Promise<PolicyVerdict> {
    return this.liveEngine().policyVerdict(toolName, risk, subject);
  }
}

// ── process singleton ─────────────────────────────────────────────────────

let singleton: CliFabric | undefined;

/** Lazily create the process-wide fabric (one per CLI process). */
export function getCliFabric(opts: CliFabricOptions = {}): CliFabric {
  if (singleton === undefined) singleton = createCliFabric(opts);
  return singleton;
}

/** Tear the singleton down (tests, `/exit`, `syao serve` shutdown). */
export async function disposeCliFabric(): Promise<void> {
  const current = singleton;
  singleton = undefined;
  if (current !== undefined) await current.dispose();
}

/** True when the singleton exists (the TUI checks before wiring panels). */
export function hasCliFabric(): boolean {
  return singleton !== undefined;
}

/** The live singleton, when one was created (used by the main-path installer). */
export function peekCliFabric(): CliFabric | undefined {
  return singleton;
}

/**
 * Install an externally-built fabric as the process singleton.
 *
 * The MAIN agent path builds the fabric itself (it must hand the agent the
 * same wrapped tools it registers), and installs it here so `/rpc`, `/peer`,
 * `/call` and `/approve` all read and extend the ONE evidence chain that the
 * agent's tool calls produce — instead of a second, empty fabric.
 */
export function installCliFabric(cli: CliFabric): void {
  singleton = cli;
}

/**
 * Map any thrown value onto a CLI exit code.
 *
 * `CanonicalError` already knows the mapping (03 §5.5); anything else is a
 * generic error (1). Usage problems are the caller's business (2).
 */
export function exitCodeForError(e: unknown): number {
  if (CanonicalError.is(e)) return e.exitCode;
  return 1;
}

/** Human sentence for a thrown value (already redacted by the caller). */
export function errorText(e: unknown): string {
  if (CanonicalError.is(e)) {
    return e.code !== undefined ? `${e.code} ${e.message}` : e.message;
  }
  return e instanceof Error ? e.message : String(e);
}
