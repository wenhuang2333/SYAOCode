/**
 * Install the ARF kernel on the MAIN agent path.
 *
 * The CLI used to have two parallel worlds:
 *
 *   - the agent path (`syao -p`, TUI, REPL): core's pipeline gated the call
 *     with the local `PermissionEngine` and ran the tool directly — no kernel
 *     receipt, no audit link, no budget reservation;
 *   - the governance path (`syao serve|call|rpc`, `/rpc`, `/call`): every call
 *     went through the kernel.
 *
 * `installMainPathGovernance` joins them. It registers the agent's own tools
 * with the kernel as `local://tools/<name>` capabilities and hands the agent a
 * `ToolGovernor` that routes every tool call through `fabric.call(...)`. The
 * kernel then becomes the single gate: it evaluates the policy (through the
 * SAME live `PermissionEngine` the agent uses, so the tier semantics are
 * unchanged), asks for approval when the policy says `ask`, reserves and
 * settles budget, dispatches the tool, and writes the receipt and the audit
 * links.
 *
 * The fabric is installed as the process singleton, so `/rpc`, `/peer`,
 * `/call` and `/approve` read the SAME evidence chain the agent produced.
 */

import { PermissionEngine, ToolRegistry, type PermissionMode, type PermissionRule, type Runtime, type Tool } from '@syaocode/core';
import type { SecretRedactor } from '@syaocode/rpc';
import type { FileStateTracker } from '@syaocode/tools';
import { createCliFabric, installCliFabric, type CliFabric } from './arf.js';
import {
  ArfToolGovernor,
  createPermissionEngineApprovalBridge,
  governedTools,
  markToolAuthorized,
} from './arf-governor.js';

export interface MainPathGovernanceOptions {
  /** The agent's tools; they are registered with the kernel as capabilities. */
  tools: Tool[];
  /** The tracker shared by the read/write/edit tools (fencing). */
  fileState: FileStateTracker;
  /** Initial tier; `setPermissionTier` keeps the bundle in step afterwards. */
  permissionMode: PermissionMode;
  /** Session rules (`/permissions allow|deny`) captured at startup. */
  rules: PermissionRule[];
  /** Workspace root of the run. */
  cwd: string;
  /** Host runtime (ids, clock, logger). */
  runtime: Runtime;
  /** Redactor shared with the agent so both scrub the same secrets. */
  redactor?: SecretRedactor;
  /** Extra directories in scope for path fencing. */
  extraDirs?: string[];
  /** Budget ceilings (USD) from the config. */
  maxBudgetUsd?: number;
  /** Label of the kernel task that groups the session's invocations. */
  taskLabel?: string;
}

export interface MainPathGovernance {
  /**
   * Tools to hand to `createAgent`.
   *
   * These are the wrapped instances: the SAME objects are registered with the
   * kernel, so a kernel-dispatched call and a locally executed call share one
   * `FileStateTracker` (read-before-write fencing) and one abort plumbing.
   */
  tools: Tool[];
  /** The governor to hand to `createAgent({ governor })`. */
  governor: ArfToolGovernor;
  /** Point the kernel at the agent's live permission engine. */
  bindEngine(engine: PermissionEngine): void;
  /** The fabric; created on first use (the engine must be bound first). */
  cli(): CliFabric;
  /** Tear the fabric down (end of a `-p` run). */
  dispose(): Promise<void>;
}

export function installMainPathGovernance(opts: MainPathGovernanceOptions): MainPathGovernance {
  const wrapped = governedTools(opts.tools);
  const registry = new ToolRegistry();
  for (const tool of wrapped) registry.register(tool);

  let engineRef: PermissionEngine | undefined;
  const engine = (): PermissionEngine => {
    if (engineRef === undefined) {
      throw new Error('ARF: the main-path governance was used before an agent engine was bound');
    }
    return engineRef;
  };

  let cliRef: CliFabric | undefined;
  const ensureCli = (): CliFabric => {
    cliRef ??= createCliFabric({
      cwd: opts.cwd,
      ...(opts.extraDirs !== undefined ? { extraDirs: opts.extraDirs } : {}),
      permissionMode: opts.permissionMode,
      rules: opts.rules,
      // The kernel consults the agent's LIVE engine: a runtime tier change is
      // picked up with no rebuild and the rule set is never duplicated.
      permissionEngine: engine,
      tools: registry,
      fileState: opts.fileState,
      runtime: opts.runtime,
      ...(opts.redactor !== undefined ? { redactor: opts.redactor } : {}),
      ...(opts.maxBudgetUsd !== undefined ? { maxBudgetUsd: opts.maxBudgetUsd } : {}),
      // The kernel's `ask` is answered by the agent's own permission handler
      // (same prompt, same remember scope, same hot-tier recheck).
      approvalBridge: createPermissionEngineApprovalBridge(engine),
      // `dispatch` is the first step that happens only after the policy allowed
      // the call and every approval was granted: it is where core used to emit
      // `tool.start`.
      onStep: (step) => markToolAuthorized(step),
    });
    installCliFabric(cliRef);
    return cliRef;
  };

  const governor = new ArfToolGovernor({
    cli: ensureCli,
    ...(opts.taskLabel !== undefined ? { taskLabel: opts.taskLabel } : {}),
  });

  return {
    tools: wrapped,
    governor,
    bindEngine(next: PermissionEngine): void {
      engineRef = next;
    },
    cli: ensureCli,
    async dispose(): Promise<void> {
      if (cliRef !== undefined) await cliRef.dispose();
    },
  };
}

/** One receipt as it appears in a governance report. */
export interface GovernanceReceiptRow {
  id: string;
  taskId: string;
  capabilityId: string;
  outcome: string;
  /** Chain link: `prevHash` is the previous receipt of the same task. */
  hash: string;
  prevHash?: string;
}

/** One audit entry as it appears in a governance report. */
export interface GovernanceAuditRow {
  id: string;
  action: string;
  outcome: string;
  hash: string;
  prevHash?: string;
}

export interface GovernanceReport {
  tenantId: string;
  tasks: string[];
  receipts: GovernanceReceiptRow[];
  audit: GovernanceAuditRow[];
  budget: {
    accounts: { id: string; state: string; reservedUsd: number; spentUsd: number; toolCallsUsed: number }[];
    reservations: { id: string; accountId: string; state: string; estimateUsd: number; accountChain: string[] }[];
  };
  /** True when the tenant's audit hash chain verifies end to end. */
  auditChainOk: boolean;
}

/**
 * The evidence one main-path run left in the kernel.
 *
 * `syao -p --output-format json` reports it, so a script can prove that a
 * normal run produced receipts, audit links and budget reservations without
 * reaching into the process (the same data `/rpc audit` and `/rpc budget`
 * render in the TUI).
 */
export async function governanceReport(cli: CliFabric, limit = 50): Promise<GovernanceReport> {
  const tasks = await cli.fabric.tasks.list({ limit: 25 });
  const receipts: GovernanceReceiptRow[] = [];
  for (const task of tasks) {
    for (const receipt of await cli.fabric.stores.receipts.listByTask(task.id, cli.tenantId)) {
      receipts.push({
        id: receipt.id,
        taskId: receipt.taskId,
        capabilityId: receipt.capabilityId,
        outcome: receipt.outcome,
        hash: receipt.hash,
        ...(receipt.prevHash !== undefined ? { prevHash: receipt.prevHash } : {}),
      });
    }
  }
  const audit = await cli.fabric.audit.list({ limit });
  const accounts = await cli.fabric.budget.list();
  const reservations = await cli.fabric.stores.budget.listReservations({});
  const chain = await cli.fabric.audit.verify();
  return {
    tenantId: cli.tenantId,
    tasks: tasks.map((t) => t.id),
    receipts,
    audit: audit.map((e) => ({
      id: e.id,
      action: e.action,
      outcome: e.outcome,
      hash: e.hash,
      ...(e.prevHash !== undefined ? { prevHash: e.prevHash } : {}),
    })),
    budget: {
      accounts: accounts.map((a) => ({
        id: a.id,
        state: a.state,
        reservedUsd: a.reservedUsd,
        spentUsd: a.spentUsd,
        toolCallsUsed: a.toolCallsUsed,
      })),
      reservations: reservations.map((r) => ({
        id: r.id,
        accountId: r.accountId,
        state: r.state,
        estimateUsd: r.estimate.usd,
        accountChain: r.accountChain,
      })),
    },
    auditChainOk: chain.ok,
  };
}
