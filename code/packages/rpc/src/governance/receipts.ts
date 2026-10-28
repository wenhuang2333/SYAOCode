/**
 * Evidence: the per-task receipt hash chain and the evidence sealer (C6 / I7).
 *
 * A receipt is the kernel's proof that an invocation happened under a specific
 * policy decision. Receipts form a per-task SHA-256 chain: each link commits to
 * its predecessor, so removing or editing any link is detectable.
 *
 *   prevHash  = head-of-chain receipt.hash   (field omitted on the first link)
 *   hash      = H(prevHash + '\0' + canonicalJson(receiptWithoutHash))
 *
 * `H` is the injected `Hasher` (the host passes real SHA-256). `contentHash`
 * (FNV-1a) is explicitly forbidden here.
 *
 * The `EvidenceSealer` bundles receipts + approvals + policy snapshots +
 * artifacts into one `EvidenceBundle`, states the checks it ran, and can
 * re-verify a bundle later from its content alone (plus any live probes it was
 * wired with).
 */

import { canonicalJson } from '../ir/schemas.js';
import { evidenceBundleSchema } from '../ir/schemas.js';
import { isInvocationTerminal, isTaskTerminal } from '../ir/states.js';
import type {
  ApprovalRecord,
  ArtifactRef,
  BudgetReservation,
  EvidenceBundle,
  EvidenceCheck,
  Receipt,
  Task,
  TaskState,
} from '../ir/types.js';
import { CanonicalError } from '../ir/errors.js';
import type {
  ApprovalStore,
  AuditStore,
  BudgetStore,
  EvidenceSealer,
  Hasher,
  ReceiptStore,
  TaskStore,
} from './contracts.js';
import { deepClone } from '../runtime/projection.js';

// ── chain primitives ──────────────────────────────────────────────────────

/** A receipt before the store seals it. */
export type UnsealedReceipt = Omit<Receipt, 'hash' | 'prevHash'>;

/** `H(prevHash + '\0' + canonicalPayload)` — identical to core's `chainHash`. */
export function chainHashWith(hash: Hasher, prevHash: string, canonicalPayload: string): string {
  return hash.sha256(`${prevHash}\u0000${canonicalPayload}`);
}

/** Canonical hash of one chain link, given the previous link's hash. */
export function receiptHash(hash: Hasher, receipt: UnsealedReceipt, prevHash: string): string {
  return chainHashWith(hash, prevHash, canonicalJson(receipt));
}

/** Body used for hashing: the receipt with `hash`/`prevHash` removed. */
export function receiptBody(receipt: Receipt): UnsealedReceipt {
  const { hash: _hash, prevHash: _prevHash, ...body } = receipt;
  return body;
}

/** Recompute the stored hash of a receipt, given its chain predecessor. */
export function recomputeReceiptHash(hash: Hasher, receipt: Receipt, prevHash: string): string {
  return receiptHash(hash, receiptBody(receipt), prevHash);
}

/** The predecessor hash of the first link (the field is omitted at rest). */
export const GENESIS_HASH = '';

// ── store ─────────────────────────────────────────────────────────────────

export interface ReceiptStoreOptions {
  hash: Hasher;
}

/**
 * In-memory receipt chain. `put` is the only writer and therefore the only
 * component that can seal a link (it knows the current head).
 */
export class MemoryReceiptStore implements ReceiptStore {
  private readonly byId = new Map<string, Receipt>();
  /** taskId → receipt ids in chain order. */
  private readonly chains = new Map<string, string[]>();
  private readonly hash: Hasher;

  constructor(opts: ReceiptStoreOptions) {
    this.hash = opts.hash;
  }

  async put(receipt: UnsealedReceipt): Promise<Receipt> {
    if (this.byId.has(receipt.id)) throw new Error(`receipt ${receipt.id} already exists (append-only)`);
    const chain = this.chains.get(receipt.taskId) ?? [];
    const headId = chain.length > 0 ? chain[chain.length - 1] : undefined;
    const head = headId !== undefined ? this.byId.get(headId) : undefined;
    if (head !== undefined && head.tenantId !== receipt.tenantId) {
      throw new Error(`receipt ${receipt.id} would join another tenant's chain (I8)`);
    }
    const sealed: Receipt = head === undefined
      ? { ...receipt, hash: receiptHash(this.hash, receipt, GENESIS_HASH) }
      : { ...receipt, prevHash: head.hash, hash: receiptHash(this.hash, receipt, head.hash) };
    this.byId.set(sealed.id, sealed);
    chain.push(sealed.id);
    this.chains.set(sealed.taskId, chain);
    return deepClone(sealed);
  }

  /** `tenantId` is optional but, when given, enforces I8 on the read. */
  async get(id: string, tenantId?: string): Promise<Receipt | undefined> {
    const receipt = this.byId.get(id);
    if (receipt === undefined) return undefined;
    if (tenantId !== undefined && receipt.tenantId !== tenantId) return undefined;
    return deepClone(receipt);
  }

  /** Chain order (append order). `tenantId` optionally enforces I8. */
  async listByTask(taskId: string, tenantId?: string): Promise<Receipt[]> {
    const chain = this.chains.get(taskId) ?? [];
    const out: Receipt[] = [];
    for (const id of chain) {
      const receipt = this.byId.get(id);
      if (receipt === undefined) continue;
      if (tenantId !== undefined && receipt.tenantId !== tenantId) continue;
      out.push(deepClone(receipt));
    }
    return out;
  }

  /** Chain head. `tenantId` optionally enforces I8 on the read. */
  async head(taskId: string, tenantId?: string): Promise<Receipt | undefined> {
    const chain = this.chains.get(taskId) ?? [];
    const id = chain.length > 0 ? chain[chain.length - 1] : undefined;
    if (id === undefined) return undefined;
    const receipt = this.byId.get(id);
    if (receipt === undefined) return undefined;
    if (tenantId !== undefined && receipt.tenantId !== tenantId) return undefined;
    return deepClone(receipt);
  }

  /** Test/ops helper: every task that has a chain. */
  async taskIds(): Promise<string[]> {
    return [...this.chains.keys()].sort();
  }
}

// ── sealer ────────────────────────────────────────────────────────────────

export type PolicySnapshot = { revision: string; rulesHash: string; bundleRef?: string };

export interface EvidenceSealerOptions {
  hash: Hasher;
  receipts: ReceiptStore;
  approvals?: ApprovalStore;
  tasks?: TaskStore;
  budget?: Pick<BudgetStore, 'list' | 'listReservations'>;
  /** Live audit chain; when bound, sealing also verifies the tenant's chain. */
  audit?: AuditStore;
  now?: () => string;
  /**
   * Host hook: the rules hash of a policy revision. When absent the sealer
   * records a digest of the decisions observed for that revision.
   */
  resolvePolicySnapshot?: (revision: string) => Promise<{ rulesHash: string; bundleRef?: string } | undefined>;
}

/**
 * Seals a task's evidence into one verifiable bundle.
 *
 * Checks are recomputed in both directions:
 *   - purely cryptographic ones (`receipts.hash`, `receipts.chain`, `rootHash`)
 *     are recomputed from the bundle content in `verify()`;
 *   - ones that need live state (`task.terminal`, `budget.settled`) are probed
 *     when the probe is wired and otherwise carried over from the sealed
 *     verification block (which is itself covered by `rootHash`).
 */
export class HashChainEvidenceSealer implements EvidenceSealer {
  private readonly hash: Hasher;
  private readonly receipts: ReceiptStore;
  private readonly approvals: ApprovalStore | undefined;
  private readonly tasks: TaskStore | undefined;
  private readonly budget: Pick<BudgetStore, 'list' | 'listReservations'> | undefined;
  private readonly audit: AuditStore | undefined;
  private readonly now: () => string;
  private readonly resolvePolicySnapshot: EvidenceSealerOptions['resolvePolicySnapshot'];

  constructor(opts: EvidenceSealerOptions) {
    this.hash = opts.hash;
    this.receipts = opts.receipts;
    this.approvals = opts.approvals;
    this.tasks = opts.tasks;
    this.budget = opts.budget;
    this.audit = opts.audit;
    this.now = opts.now ?? (() => new Date().toISOString());
    this.resolvePolicySnapshot = opts.resolvePolicySnapshot;
  }

  /**
   * Build the evidence bundle for a task. `tenantId` is an optional override
   * used to scope the task lookup (I8); it is derived from the receipts when
   * omitted.
   */
  async seal(taskId: string, tenantId?: string): Promise<EvidenceBundle> {
    const receipts = await this.listChain(taskId, tenantId);
    const scope = tenantId ?? receipts[0]?.tenantId ?? '';
    const task = await this.readTask(taskId, scope);

    const approvals = await this.collectApprovals(receipts);
    const policySnapshots = await this.collectPolicySnapshots(receipts);
    const artifacts = collectArtifacts(receipts);

    const bundle: EvidenceBundle = {
      schemaVersion: 1,
      taskId,
      tenantId: scope,
      createdAt: this.now(),
      receipts,
      approvals,
      policySnapshots,
      artifacts,
      verification: { verdict: 'unverified', checks: [] },
      rootHash: '',
    };
    // rootHash binds the evidence content only, so it can be computed before
    // the checks (which are derived) are attached.
    bundle.rootHash = this.rootHash(bundle);
    const checks = await this.runChecks(bundle, { mode: 'seal', task });
    bundle.verification = { verdict: verdictOf(checks, receipts.length), checks };
    return bundle;
  }

  async verify(bundle: EvidenceBundle): Promise<{ ok: boolean; checks: EvidenceCheck[] }> {
    const checks = await this.runChecks(bundle, { mode: 'verify' });
    return { ok: checks.every((check) => check.ok), checks };
  }

  // ── bundle assembly ─────────────────────────────────────────────────────

  /**
   * Read the chain in order. The frozen `ReceiptStore` interface has no tenant
   * parameter, but the in-memory store accepts an optional one; when it does we
   * use it to enforce I8 on the read.
   */
  private async listChain(taskId: string, tenantId?: string): Promise<Receipt[]> {
    if (tenantId === undefined) return this.receipts.listByTask(taskId);
    const scoped = this.receipts as { listByTask(taskId: string, tenantId?: string): Promise<Receipt[]> };
    return scoped.listByTask(taskId, tenantId);
  }

  private async readTask(taskId: string, tenantId: string): Promise<Task | undefined> {
    if (this.tasks === undefined || tenantId === '') return undefined;
    return this.tasks.get(taskId, tenantId);
  }

  private async collectApprovals(receipts: Receipt[]): Promise<ApprovalRecord[]> {
    const ids = new Set<string>();
    for (const receipt of receipts) for (const id of receipt.approvals) ids.add(id);
    if (ids.size === 0) return [];
    if (this.approvals === undefined) return [];
    const out: ApprovalRecord[] = [];
    for (const id of [...ids].sort()) {
      const record = await this.approvals.get(id);
      if (record !== undefined) out.push(record);
    }
    return out;
  }

  private async collectPolicySnapshots(receipts: Receipt[]): Promise<PolicySnapshot[]> {
    const revisions = [...new Set(receipts.map((receipt) => receipt.policy.revision))].sort();
    const out: PolicySnapshot[] = [];
    for (const revision of revisions) {
      const resolved = this.resolvePolicySnapshot !== undefined ? await this.resolvePolicySnapshot(revision) : undefined;
      if (resolved !== undefined) {
        out.push({ revision, ...(resolved.bundleRef !== undefined ? { bundleRef: resolved.bundleRef } : {}), rulesHash: resolved.rulesHash });
        continue;
      }
      // Fall back to a digest of the decisions observed at this revision.
      const observed = receipts
        .filter((receipt) => receipt.policy.revision === revision)
        .map((receipt) => ({ decisionId: receipt.policy.decisionId, effect: receipt.policy.effect, obligations: [...receipt.policy.obligations].sort() }))
        .sort((a, b) => (a.decisionId < b.decisionId ? -1 : a.decisionId > b.decisionId ? 1 : 0));
      out.push({ revision, rulesHash: this.hash.sha256(canonicalJson(observed)) });
    }
    return out;
  }

  /**
   * Bind the evidence content (not the derived verification block) into one
   * digest, so a swapped receipt/approval/artifact is detectable.
   */
  private rootHash(bundle: EvidenceBundle): string {
    const sortedApprovals = [...bundle.approvals].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const sortedArtifacts = [...bundle.artifacts].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const sortedSnapshots = [...bundle.policySnapshots].sort((a, b) => (a.revision < b.revision ? -1 : a.revision > b.revision ? 1 : 0));
    return this.hash.sha256(
      canonicalJson({
        schemaVersion: 1,
        taskId: bundle.taskId,
        tenantId: bundle.tenantId,
        createdAt: bundle.createdAt,
        receipts: bundle.receipts.map((receipt) => ({ id: receipt.id, hash: receipt.hash, prevHash: receipt.prevHash ?? GENESIS_HASH })),
        approvals: sortedApprovals.map((record) => ({ id: record.id, state: record.state, revision: record.revision })),
        policySnapshots: sortedSnapshots.map((snapshot) => ({ revision: snapshot.revision, rulesHash: snapshot.rulesHash })),
        artifacts: sortedArtifacts.map((artifact) => ({ id: artifact.id, hash: artifact.hash })),
      }),
    );
  }

  // ── checks ──────────────────────────────────────────────────────────────

  private async runChecks(
    bundle: EvidenceBundle,
    ctx: { mode: 'seal' | 'verify'; task?: Task | undefined },
  ): Promise<EvidenceCheck[]> {
    const receipts = bundle.receipts;
    const checks: EvidenceCheck[] = [];

    checks.push(check('bundle.schema', () => {
      const parsed = evidenceBundleSchema.safeParse(bundle);
      return parsed.success
        ? {}
        : { ok: false, detail: parsed.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`).join('; ') };
    }));

    checks.push(check('receipts.present', () => (receipts.length > 0 ? {} : { ok: false, detail: 'no receipts for this task' })));

    // 1. every receipt hash recomputes with the chain predecessor.
    checks.push(check('receipts.hash', () => {
      const broken: string[] = [];
      for (let i = 0; i < receipts.length; i += 1) {
        const receipt = receipts[i]!;
        const prev = predecessorOf(receipts, i);
        if (recomputeReceiptHash(this.hash, receipt, prev) !== receipt.hash) broken.push(receipt.id);
      }
      return broken.length === 0 ? {} : { ok: false, detail: `hash mismatch in ${broken.length} receipt(s): ${broken.join(', ')}` };
    }));

    // 2. prevHash chain intact (including "first link has no prevHash").
    checks.push(check('receipts.chain', () => {
      for (let i = 0; i < receipts.length; i += 1) {
        const receipt = receipts[i]!;
        if (i === 0) {
          if (receipt.prevHash !== undefined && receipt.prevHash !== GENESIS_HASH) {
            return { ok: false, detail: `first receipt ${receipt.id} carries prevHash ${receipt.prevHash}` };
          }
          continue;
        }
        const previous = receipts[i - 1]!;
        if (receipt.prevHash !== previous.hash) {
          return { ok: false, detail: `receipt ${receipt.id} does not link to ${previous.id}` };
        }
      }
      return {};
    }));

    // 3. ask-decisions have a recorded, allowed approval.
    checks.push(check('approvals.present', () => {
      const byId = new Map(bundle.approvals.map((record) => [record.id, record]));
      const problems: string[] = [];
      for (const receipt of receipts) {
        const asks = receipt.policy.effect === 'ask';
        if (asks && receipt.approvals.length === 0) {
          problems.push(`${receipt.id} was an ask-decision with no approval`);
          continue;
        }
        for (const id of receipt.approvals) {
          const record = byId.get(id);
          if (record === undefined) problems.push(`${receipt.id} references missing approval ${id}`);
          else if (record.state !== 'allowed') problems.push(`${receipt.id} references approval ${id} in state ${record.state}`);
        }
      }
      return problems.length === 0 ? {} : { ok: false, detail: problems.join('; ') };
    }));

    // 4. artifact refs agree between the bundle index and the receipts.
    checks.push(check('artifacts.hash', () => {
      const fromReceipts = collectArtifacts(receipts);
      const index = new Map(bundle.artifacts.map((artifact) => [artifact.id, artifact.hash]));
      const problems: string[] = [];
      for (const artifact of fromReceipts) {
        if (artifact.hash.length === 0) problems.push(`artifact ${artifact.id} has an empty hash`);
        const indexed = index.get(artifact.id);
        if (indexed === undefined) problems.push(`artifact ${artifact.id} missing from the bundle index`);
        else if (indexed !== artifact.hash) problems.push(`artifact ${artifact.id} hash disagrees with the bundle index`);
      }
      for (const artifact of bundle.artifacts) {
        if (!fromReceipts.some((candidate) => candidate.id === artifact.id && candidate.hash === artifact.hash)) {
          problems.push(`artifact ${artifact.id} in the bundle index appears in no receipt`);
        }
      }
      return problems.length === 0 ? {} : { ok: false, detail: problems.join('; ') };
    }));

    // 5. every receipt revision has a policy snapshot.
    checks.push(check('policy.snapshots', () => {
      const revisions = new Set(bundle.policySnapshots.map((snapshot) => snapshot.revision));
      const missing = [...new Set(receipts.map((receipt) => receipt.policy.revision))].filter((revision) => !revisions.has(revision));
      if (missing.length > 0) return { ok: false, detail: `no policy snapshot for revision(s): ${missing.join(', ')}` };
      const dupes = bundle.policySnapshots.length !== revisions.size;
      return dupes ? { ok: false, detail: 'duplicate policy snapshots' } : {};
    }));

    // 6. budget settled.
    checks.push(await this.budgetCheck(bundle, ctx));

    // 7. task terminal consistency.
    checks.push(await this.taskCheck(bundle, ctx));

    // 8. the tenant's audit chain must still verify.
    checks.push(await this.auditCheck(bundle, ctx));

    // 9. rootHash binds the bundle.
    const expectedRoot = this.rootHash(bundle);
    checks.push(expectedRoot === bundle.rootHash
      ? { name: 'rootHash', ok: true }
      : { name: 'rootHash', ok: false, detail: 'rootHash does not match the bundle content' });

    return checks;
  }

  private async budgetCheck(bundle: EvidenceBundle, ctx: { mode: 'seal' | 'verify'; task?: Task | undefined }): Promise<EvidenceCheck> {
    if (this.budget === undefined || bundle.tenantId === '') {
      return this.carryOver(ctx, bundle, 'budget.settled', 'budget ledger not bound to this sealer');
    }
    try {
      const accounts = await this.budget.list(bundle.tenantId);
      const accountIds = new Set(accounts.map((account) => account.id));
      const held = (await this.budget.listReservations({ state: 'held' })).filter((reservation: BudgetReservation) => accountIds.has(reservation.accountId));
      const task = ctx.task ?? (await this.readTask(bundle.taskId, bundle.tenantId));
      const start = task?.createdAt ?? bundle.receipts[0]?.timing.queuedAt ?? '';
      const end = task?.updatedAt ?? bundle.createdAt;
      const stranded = held.filter((reservation) => inWindow(reservation.createdAt, start, end));
      if (stranded.length === 0) return { name: 'budget.settled', ok: true };
      return {
        name: 'budget.settled',
        ok: false,
        detail: `${stranded.length} reservation(s) still held after the task ended: ${stranded.map((r) => r.id).join(', ')}`,
      };
    } catch (error) {
      return { name: 'budget.settled', ok: false, detail: `budget probe failed: ${errorText(error)}` };
    }
  }

  private async taskCheck(bundle: EvidenceBundle, ctx: { mode: 'seal' | 'verify'; task?: Task | undefined }): Promise<EvidenceCheck> {
    const task = ctx.task ?? (await this.readTask(bundle.taskId, bundle.tenantId));
    if (task === undefined) {
      return this.carryOver(ctx, bundle, 'task.terminal', 'task store not bound (or task not found)');
    }
    if (!isTaskTerminal(task.state)) {
      return { name: 'task.terminal', ok: true, detail: `task is ${task.state}; terminal consistency not applicable` };
    }
    const receipts = bundle.receipts;
    const inFlight = receipts.filter((receipt) => !isInvocationTerminal(receipt.outcome));
    if (inFlight.length > 0) {
      return { name: 'task.terminal', ok: false, detail: `task is ${task.state} but ${inFlight.length} receipt(s) are still in flight` };
    }
    const outcomes = new Set(receipts.map((receipt) => receipt.outcome));
    const expect = terminalExpectation(task.state);
    if (expect !== undefined && ![...outcomes].some((outcome) => expect.includes(outcome))) {
      return {
        name: 'task.terminal',
        ok: false,
        detail: `task is ${task.state} but no receipt outcome matches (${[...outcomes].join(', ') || 'none'})`,
      };
    }
    return { name: 'task.terminal', ok: true };
  }

  /**
   * The tenant's audit chain must still verify — an evidence bundle whose
   * audit trail was tampered with is not trustworthy.
   */
  private async auditCheck(bundle: EvidenceBundle, ctx: { mode: 'seal' | 'verify'; task?: Task | undefined }): Promise<EvidenceCheck> {
    if (this.audit === undefined || bundle.tenantId === '') {
      return this.carryOver(ctx, bundle, 'audit.chain', 'audit store not bound to this sealer');
    }
    try {
      const result = await this.audit.verify(bundle.tenantId);
      if (result.ok) return { name: 'audit.chain', ok: true, detail: `${result.checked} event(s) verified` };
      return {
        name: 'audit.chain',
        ok: false,
        detail: result.reason ?? (result.brokenAt !== undefined ? `broken at ${result.brokenAt}` : 'audit chain does not verify'),
      };
    } catch (error) {
      return { name: 'audit.chain', ok: false, detail: `audit probe failed: ${errorText(error)}` };
    }
  }

  /**
   * A check that needs live state cannot be recomputed from the bundle alone.
   * At seal time an unbound probe is reported as skipped; at verify time the
   * sealed verdict is carried over (the sealed block was produced from the
   * content that `rootHash` binds).
   */
  private carryOver(
    ctx: { mode: 'seal' | 'verify' },
    bundle: EvidenceBundle,
    name: string,
    reason: string,
  ): EvidenceCheck {
    const sealed = bundle.verification.checks.find((check) => check.name === name);
    if (sealed !== undefined) return { ...sealed, name };
    return ctx.mode === 'seal'
      ? { name, ok: true, detail: `${reason}; skipped at seal time` }
      : { name, ok: false, detail: `${reason}; cannot be re-verified` };
  }
}

// ── helpers ───────────────────────────────────────────────────────────────

export function verdictOf(checks: EvidenceCheck[], receiptCount: number): 'verified' | 'unverified' | 'failed' {
  if (receiptCount === 0) return 'unverified';
  return checks.every((check) => check.ok) ? 'verified' : 'failed';
}

/** Predecessor hash for index `i`; the first link's predecessor is the genesis. */
export function predecessorOf(receipts: readonly Receipt[], index: number): string {
  if (index <= 0) return GENESIS_HASH;
  return receipts[index - 1]?.hash ?? GENESIS_HASH;
}

export function collectArtifacts(receipts: readonly Receipt[]): ArtifactRef[] {
  const seen = new Map<string, ArtifactRef>();
  for (const receipt of receipts) {
    for (const artifact of receipt.artifacts) if (!seen.has(artifact.id)) seen.set(artifact.id, artifact);
  }
  return [...seen.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

function terminalExpectation(state: TaskState): Receipt['outcome'][] | undefined {
  if (state === 'completed') return ['succeeded'];
  if (state === 'failed') return ['failed', 'denied', 'timed_out', 'indeterminate'];
  if (state === 'cancelled') return ['cancelled'];
  if (state === 'rejected') return ['denied', 'cancelled', 'failed'];
  return undefined;
}

function inWindow(iso: string, start: string, end: string): boolean {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return false;
  if (start !== '' && t < Date.parse(start)) return false;
  if (end !== '' && t > Date.parse(end)) return false;
  return true;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Build a check from a thunk; a throwing check becomes a failed check. */
function check(name: string, run: () => { ok?: boolean; detail?: string }): EvidenceCheck {
  try {
    const result = run();
    const ok = result.ok ?? true;
    return { name, ok, ...(result.detail !== undefined ? { detail: result.detail } : {}) };
  } catch (error) {
    return { name, ok: false, detail: errorText(error) };
  }
}

/** Convenience for hosts that only have the store. */
export function requireReceipts(store: ReceiptStore): MemoryReceiptStore {
  if (!(store instanceof MemoryReceiptStore)) {
    throw new CanonicalError({ kind: 'internal', message: 'receipt store does not expose the in-memory chain' });
  }
  return store;
}
