import {
  createAgent,
  SyaoError,
  nodeRuntime,
  type Agent,
  type AgentEvent,
  type EndReason,
  type PermissionHandler,
  type RunSummary,
} from '@syaocode/core';
import { createBuiltinTools } from '@syaocode/tools';
import { createOpenAICompatibleProvider, createAnthropicProvider } from '@syaocode/providers';
import { MockProvider } from '@syaocode/testing';
import type { CliArgs } from './args.js';
import { resolvePermissionTier } from './args.js';
import { readUserConfig, resolveDefaultModel } from './model-config.js';
import { buildCliContext } from './context.js';
import { recordUsage } from './usage-store.js';
import { resolveProvider } from './provider-select.js';

/** BR-042 exit codes. */
export const EXIT_OK = 0;
export const EXIT_ERROR = 1;
export const EXIT_USAGE = 2;
export const EXIT_PERM = 3;
export const EXIT_LIMIT = 4;
export const EXIT_INTERRUPT = 130;

export function exitCodeFor(summary: RunSummary): number {
  switch (summary.endReason) {
    case 'completed':
      return EXIT_OK;
    case 'max_turns':
    case 'budget_exhausted':
    case 'timeout':
      return EXIT_LIMIT;
    case 'aborted':
      return EXIT_INTERRUPT;
    case 'repeated_failure':
    case 'fatal_error':
      return EXIT_ERROR;
    default:
      return EXIT_ERROR;
  }
}

export async function runPrint(args: CliArgs, prompt: string): Promise<number> {
  const runtime = nodeRuntime();
  const out = args.outputFormat;
  const write = (line: string) => process.stdout.write(`${line}\n`);
  const stderr = (msg: string) => process.stderr.write(`${msg}\n`);

  const provider = resolveProvider(args, { mockProvider: (script) => new MockProvider({ script }) });
  const { tools } = createBuiltinTools();
  const tier = resolvePermissionTier(args, readUserConfig().permissionMode);

  // Headless permission policy (BR-042): ask → deny with a clear note.
  const headlessHandler: PermissionHandler = async (req) => ({
    decision: 'deny',
    message: `Non-interactive run: '${req.tool}' needs approval; headless ask resolves to deny (SY-CLI-002). Pre-approve via --allowed-tools, raise the tier (--HuangAura/--WenNova), or run interactively.`,
  });

  const agent: Agent = createAgent({
    provider,
    model: provider.model,
    cwd: args.cwd ?? process.cwd(),
    context: buildCliContext(args.cwd ?? process.cwd()),
    tools,
    permissionMode: tier.mode,
    permissionHandler: headlessHandler,
    limits: {
      ...(args.maxTurns !== undefined ? { maxTurns: args.maxTurns } : {}),
      ...(args.maxBudgetUsd !== undefined ? { maxBudgetUsd: args.maxBudgetUsd } : {}),
    },
    runtime,
    rules: [
      ...args.allowedTools.map((tool) => ({ effect: 'allow' as const, tool, source: 'user' as const })),
      ...args.disallowedTools.map((tool) => ({ effect: 'deny' as const, tool, source: 'user' as const })),
    ],
  });

  let exitCode = EXIT_OK;
  let summary: RunSummary | undefined;
  /** 本次运行的请求数（usage 事件数）——非交互运行同样计入工作区账本 */
  let runRequests = 0;

  const interrupt = new AbortController();
  process.on('SIGINT', () => {
    interrupt.abort(new Error('SIGINT'));
  });

  try {
    const stream = agent.run(prompt, { signal: interrupt.signal });
    for (;;) {
      const r = await stream.next();
      if (r.done) {
        summary = r.value;
        break;
      }
      emitEvent(r.value);
    }
  } catch (e) {
    if (SyaoError.is(e)) {
      stderr(`error: ${e.code} ${e.message}`);
      exitCode = e.code === 'SY-CLI-002' || e.category === 'permission' ? EXIT_PERM : EXIT_ERROR;
    } else {
      stderr(`error: ${e instanceof Error ? e.message : String(e)}`);
      exitCode = EXIT_ERROR;
    }
  }

  if (summary !== undefined) {
    exitCode = exitCodeFor(summary);
    recordRunUsage(summary, runRequests);
    if (out === 'text') {
      write(summary.finalText);
    } else if (out === 'json') {
      write(
        JSON.stringify({
          schemaVersion: 1,
          sessionId: summary.sessionId,
          endReason: summary.endReason,
          turns: summary.turns,
          usage: summary.totalUsage,
          ...(summary.costUsd !== undefined ? { costUsd: summary.costUsd } : {}),
          finalText: summary.finalText,
        }),
      );
    }
  }
  return exitCode;

  /**
   * 把本次运行用量记入工作区账本（/cost 的累计口径）。
   * 无用量（例如启动即失败）不记账；账本不可写也不改变本次运行的退出码。
   */
  function recordRunUsage(result: RunSummary, requests: number): void {
    const u = result.totalUsage;
    const tokens = u.inputTokens + u.outputTokens + (u.cacheReadTokens ?? 0) + (u.cacheWriteTokens ?? 0);
    if (tokens === 0 && (result.costUsd ?? 0) === 0) return;
    const spec = resolveDefaultModel(args.model);
    try {
      recordUsage(
        args.cwd ?? process.cwd(),
        { provider: spec.provider, model: spec.name },
        u,
        result.costUsd,
        { requests: Math.max(1, requests) },
      );
    } catch {
      /* ledger write failure must not change the run's exit code */
    }
  }

  function emitEvent(ev: AgentEvent): void {
    if (ev.type === 'usage') runRequests += 1;
    if (out === 'stream-json') {
      write(
        JSON.stringify({
          schemaVersion: 1,
          sessionId: summaryAgentSessionId(),
          ts: Date.now(),
          type: ev.type,
          event: ev,
        }),
      );
      return;
    }
    if (out === 'text' && ev.type === 'error') {
      stderr(`[${ev.error.code}] ${ev.error.message}`);
    }
  }
  function summaryAgentSessionId(): string {
    return agent.sessionId;
  }
}

export { resolveProvider };
export type { EndReason };
