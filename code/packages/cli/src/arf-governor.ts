/**
 * Route the main agent path through the ARF kernel.
 *
 * A normal `syao -p`, TUI or REPL tool call used to execute through core's
 * pipeline only: the model was gated by the local `PermissionEngine` and the
 * tool ran directly, so the run produced NO kernel receipt, NO audit link and
 * NO budget reservation — the ARF kernel was a parallel universe reachable
 * only from `syao serve|call|rpc` (05-实现评估与结论 §4).
 *
 * `ArfToolGovernor` closes that gap. It implements core's `ToolGovernor` seam
 * (`ToolGovernor` in packages/core/src/tool.ts) and turns one proposed tool
 * call into ONE governed invocation:
 *
 *   fabric.call({ capabilityId: 'local://tools/<name>', input, taskId })
 *
 * The kernel — not the CLI — then authorizes (policy → the SAME core
 * `PermissionEngine` through `createPermissionPreset`, never a second rule
 * set), asks for approval when the policy says `ask`, reserves budget,
 * dispatches to the registered tool executor, settles, and writes exactly one
 * receipt plus the `policy.decide` / `invocation.*` audit links.
 *
 * What stays in core's pipeline (so nothing about the agent loop or the UI
 * changes): schema validation, the timeout/hang guard, redaction,
 * truncation, `ToolReceipt` construction and the `tool.start` /
 * `tool.result` / `tool.receipt` events. `onAuthorized` fires from the
 * dispatcher's `dispatch` step, so a denied call emits no `tool.start` —
 * exactly like a local permission denial today.
 *
 * Cancellation: `Fabric.call()` does not accept an AbortSignal (the rpc
 * contract is frozen and owned elsewhere), so the caller's signal is carried
 * through AsyncLocalStorage into the tool wrapper (see `governedTools`). The
 * kernel executor calls the wrapped tool inside the caller's async context,
 * so `ctx.signal` is the real run signal and Ctrl-C still kills a child
 * process instead of leaking it.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import {
  PermissionEngine,
  ToolRegistry,
  type GovernedToolCall,
  type PermissionMode,
  type PermissionRule,
  type Runtime,
  type Tool,
  type ToolContext,
  type ToolGovernor,
  type ToolOutput,
  type ToolResultContent,
  type ToolResultMeta,
} from '@syaocode/core';
import { CanonicalError, type ApprovalRecord, type InvokeResult, type SecretRedactor } from '@syaocode/rpc';
import type { FileStateTracker } from '@syaocode/tools';
import { createCliFabric, type CliFabric, type CliFabricOptions } from './arf.js';

/** Verdict of one kernel approval, answered by the interactive authority. */
export interface ApprovalVerdict {
  decision: 'allow' | 'deny';
  /** Model-visible reason; for a denial this is the core engine's message. */
  reason?: string;
}

/**
 * Per-invocation context that the fabric cannot carry itself.
 *
 * `Fabric.call()` accepts no signal and no tool handle, so the governor parks
 * them here before calling and the two hooks that need them — the tool
 * wrapper (signal/progress) and the approval bridge (tool + input) — read
 * them back inside the same async context. Entries never leak across calls:
 * `AsyncLocalStorage.run` scopes them to one invocation, including the
 * concurrent tool batches the agent loop runs.
 */
interface GovernedScope {
  tool: Tool;
  input: unknown;
  callId: string;
  signal: AbortSignal;
  progress(note: string): void;
  onAuthorized?: () => void;
  /** Set once the dispatcher reaches `dispatch`; guards double emission. */
  authorized?: boolean;
}

const governedScope = new AsyncLocalStorage<GovernedScope>();

/**
 * Wrap tools so a kernel-dispatched execution inherits the CALLER's abort
 * signal, progress sink and ORIGINAL input.
 *
 * Two kernel-side defaults are wrong for an interactive local run:
 *
 *  - the executor supplies a never-aborting signal and a no-op progress sink
 *    — acceptable for a fire-and-forget edge, wrong when Ctrl-C must abort a
 *    running command;
 *  - the dispatcher scrubs the invocation INPUT with the kernel's redactor
 *    before dispatching. That scrubbing exists for data crossing a trust
 *    boundary (a remote peer); a local tool's input comes from the model in
 *    this very process, and rewriting it would change what the tool does —
 *    e.g. `write .env` with `API_KEY=…` would land `[REDACTED:…]` on disk.
 *
 * The caller's values are parked in the async scope by the governor, so the
 * wrapper restores them. Registration in the fabric and in the agent registry
 * uses the SAME wrapped instances, so the `FileStateTracker` shared by
 * read/write/edit is untouched.
 */
export function governedTools(tools: Tool[]): Tool[] {
  return tools.map(
    (tool): Tool => ({
      ...tool,
      execute: (input: unknown, ctx: ToolContext) => {
        const active = governedScope.getStore();
        if (active === undefined) return tool.execute(input, ctx);
        return tool.execute(active.input, {
          ...ctx,
          signal: active.signal,
          progress: (note: string) => active.progress(note),
        });
      },
    }),
  );
}

/**
 * Called from the fabric's `onStep` hook.
 *
 * `dispatch` is the first step that happens only after policy allowed the
 * call and every approval was granted, which is exactly when core used to
 * fire `tool.start`.
 */
export function markToolAuthorized(step: string): void {
  if (step !== 'dispatch') return;
  const active = governedScope.getStore();
  if (active === undefined || active.authorized === true) return;
  active.authorized = true;
  active.onAuthorized?.();
}

/**
 * Answer a kernel `ask` decision through the live core permission engine.
 *
 * This is deliberately the ONLY approval path for the main agent path: it
 * calls `engine.check(tool, input, callId)` — the exact gate the pipeline used
 * to call — so prompt wording, `remember: once|session|project`, sensitive
 * path handling, hot tier changes (`{recheck:true}`) and the
 * `permission.request` / `permission.result` events stay byte-identical.
 * The kernel approval record is then the evidence of that decision, not a
 * second question.
 *
 * Returns `undefined` when the call did not come from the agent path (e.g.
 * `syao call …`), so the host's own presenter handles it.
 */
export function createPermissionEngineApprovalBridge(
  engine: () => PermissionEngine,
  /** Fallback for a kernel `ask` that did not come from the agent path. */
  offPath?: (record: ApprovalRecord) => Promise<ApprovalVerdict | undefined>,
): (record: ApprovalRecord) => Promise<ApprovalVerdict | undefined> {
  return async (record): Promise<ApprovalVerdict | undefined> => {
    const active = governedScope.getStore();
    if (active === undefined) return offPath !== undefined ? offPath(record) : undefined;
    const outcome = await engine().check(active.tool, active.input, active.callId);
    if (outcome.outcome === 'allow') return { decision: 'allow' };
    return { decision: 'deny', reason: outcome.error.modelMessage ?? outcome.error.message };
  };
}

export interface ArfToolGovernorOptions {
  /** Resolve the live CLI fabric: it is created lazily and shared with `/rpc`. */
  cli(): CliFabric;
  /** Text stored on the kernel task that groups this agent session. */
  taskLabel?: string;
}

/**
 * The `ToolGovernor` the CLI passes to `createAgent`.
 *
 * One kernel task per governor (= per agent session): every tool call of the
 * session appends to the same receipt hash chain, so
 * `fabric.evidence.seal(taskId)` covers the whole session and `/rpc audit`
 * shows one coherent story.
 */
export class ArfToolGovernor implements ToolGovernor {
  private readonly opts: ArfToolGovernorOptions;
  private task: Promise<string> | undefined;

  constructor(opts: ArfToolGovernorOptions) {
    this.opts = opts;
  }

  /** Kernel task id used for every call of this agent session (created once). */
  async taskId(): Promise<string> {
    this.task ??= (async () => {
      const cli = this.opts.cli();
      const session = await cli.ensureSession();
      const created = await cli.fabric.tasks.create({
        sessionId: session.id,
        blocks: [{ type: 'text', text: this.opts.taskLabel ?? 'syao agent session' }],
      });
      return created.id;
    })().catch((e: unknown) => {
      // A task-creation failure must not poison every later call: the kernel
      // can still govern the invocation with an implicit task.
      this.task = undefined;
      throw e;
    });
    return this.task;
  }

  async execute(request: GovernedToolCall): Promise<ToolOutput> {
    const cli = this.opts.cli();
    const capabilityId = `local://tools/${request.tool.name}`;
    const active: GovernedScope = {
      tool: request.tool,
      input: request.input,
      callId: request.call.id,
      signal: request.signal,
      progress: request.progress,
      ...(request.onAuthorized !== undefined ? { onAuthorized: request.onAuthorized } : {}),
    };

    let result: InvokeResult;
    try {
      let taskId: string | undefined;
      try {
        taskId = await this.taskId();
      } catch {
        taskId = undefined;
      }
      result = await governedScope.run(active, () =>
        cli.call({
          capabilityId,
          input: request.input,
          // A local tool call costs no model money; the reservation still
          // exists (and settles) so the ledger records the invocation.
          estimate: { usd: 0, toolCalls: 1 },
          ...(taskId !== undefined ? { taskId } : {}),
        }),
      );
    } catch (e) {
      return { content: [{ type: 'text', text: failureText(request.tool.name, capabilityId, e) }], isError: true };
    }
    return toToolOutput(result);
  }
}

/** Map one governed invocation onto the `ToolOutput` the pipeline expects. */
function toToolOutput(result: InvokeResult): ToolOutput {
  const payload = result.output as { content?: unknown; meta?: ToolResultMeta } | undefined;
  const content: ToolResultContent[] =
    Array.isArray(payload?.content)
      ? (payload?.content as ToolResultContent[])
      : [{ type: 'text', text: invokeFailureText(result) }];
  const meta: ToolResultMeta = {
    ...(payload?.meta ?? {}),
    governance: {
      invocationId: result.invocationId,
      taskId: result.taskId,
      receiptId: result.receiptId,
      outcome: result.outcome,
    },
  };
  return result.outcome === 'succeeded'
    ? { content, meta }
    : { content, meta, isError: true };
}

function invokeFailureText(result: InvokeResult): string {
  if (result.error !== undefined) {
    return result.error.code !== undefined ? `${result.error.code} ${result.error.message}` : result.error.message;
  }
  return `The governed invocation did not succeed (${result.outcome}).`;
}

/**
 * Model-visible text for a kernel failure.
 *
 * A policy or approval denial carries the core `PermissionEngine` message
 * (`modelMessage`), so the agent sees exactly what it saw before the kernel
 * was in the loop (report requirement: no semantic change on deny).
 */
function failureText(toolName: string, capabilityId: string, e: unknown): string {
  if (CanonicalError.is(e)) {
    if (e.kind === 'capability_not_found') {
      return `Tool '${toolName}' is not registered with the governance kernel (${capabilityId}).`;
    }
    return e.message;
  }
  return e instanceof Error ? e.message : String(e);
}
