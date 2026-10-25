import {
  createAgent,
  rulesFromConfig,
  SyaoError,
  type Agent,
  type AgentEvent,
  type EndReason,
  type PermissionHandler,
  type RunSummary,
} from '@syaocode/core';
import { nodeRuntime, createFileReceiptStore } from '@syaocode/node';
import { createBuiltinTools } from '@syaocode/tools';
import { createOpenAICompatibleProvider, createAnthropicProvider } from '@syaocode/providers';
import { MockProvider } from '@syaocode/testing';
import type { CliArgs } from './args.js';
import { resolvePermissionTier } from './args.js';
import { buildCliContext } from './context.js';
import { recordUsage } from './usage-store.js';
import { resolveProvider } from './provider-select.js';
import { cliCwd, cliModelSpec, createCliRedactor, loadCliConfig } from './effective-config.js';
import { syaoHome } from './model-config.js';

/** BR-042 exit codes. */
export const EXIT_OK = 0;
export const EXIT_ERROR = 1;
export const EXIT_USAGE = 2;
export const EXIT_PERM = 3;
export const EXIT_LIMIT = 4;
export const EXIT_UNVERIFIED = 5;
export const EXIT_VERIFICATION_FAILED = 6;
export const EXIT_INTERRUPT = 130;

export function exitCodeFor(summary: RunSummary): number {
  switch (summary.endReason) {
    case 'completed':
      // A denied approval is a permission outcome for the run, not a generic
      // failure: script callers can branch on exit code 3 (BR-042, report L4).
      return summary.permissionDenied ? EXIT_PERM : EXIT_OK;
    case 'max_turns':
    case 'budget_exhausted':
    case 'timeout':
      return EXIT_LIMIT;
    case 'aborted':
      return EXIT_INTERRUPT;
    case 'unverified':
      return EXIT_UNVERIFIED;
    case 'verification_failed':
      return EXIT_VERIFICATION_FAILED;
    case 'repeated_failure':
    case 'permission_denied':
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

  const config = await loadCliConfig(args, runtime);
  const spec = cliModelSpec(args, config);
  const provider = resolveProvider(args, { mockProvider: (script) => new MockProvider({ script }) }, { spec });
  const { tools } = createBuiltinTools();
  const redactor = createCliRedactor();
  const receipts = createFileReceiptStore(runtime, `${syaoHome()}/evidence`);

  // Headless permission policy (BR-042): ask → deny with a clear note.
  const headlessHandler: PermissionHandler = async (req) => ({
    decision: 'deny',
    message: `Non-interactive run: '${req.tool}' needs approval; headless ask resolves to deny (SY-CLI-002). Pre-approve via --allowed-tools, raise the tier (--yao/--si), or run interactively.`,
  });

  const agent: Agent = createAgent({
    provider,
    model: provider.model,
    cwd: cliCwd(args),
    context: buildCliContext(cliCwd(args), { model: `${spec.provider}:${spec.model}` }),
    tools,
    permissionMode: config.permissionMode,
    permissionHandler: headlessHandler,
    limits: config.limits,
    runtime,
    redactor,
    receipts,
    ...(args.verify === false ? {} : { verification: { enabled: true } }),
    rules: rulesFromConfig(config),
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
      stderr(redactor.redact(`error: ${e.code} ${e.message}`).text);
      exitCode = e.code === 'SY-CLI-002' || e.category === 'permission' ? EXIT_PERM : EXIT_ERROR;
    } else {
      stderr(redactor.redact(`error: ${e instanceof Error ? e.message : String(e)}`).text);
      exitCode = EXIT_ERROR;
    }
  }

  if (summary !== undefined) {
    exitCode = exitCodeFor(summary);
    recordRunUsage(summary, runRequests);
    if (out === 'text') {
      write(redactor.redact(summary.finalText).text);
      if (summary.verdict === 'verified') {
        stderr(`verified: ${summary.verification?.results.map((r) => r.command).join('; ') ?? ''}`);
      } else if (summary.verdict === 'failed') {
        stderr(
          `verification failed: ${summary.verification?.results
            .filter((r) => r.exitCode !== 0)
            .map((r) => r.command)
            .join('; ') ?? ''}`,
        );
      } else if (summary.verdict === 'unverified') {
        const unsupported = summary.claims.filter((c) => c.status !== 'supported').map((c) => c.text);
        stderr(`unverified${unsupported.length > 0 ? `: ${unsupported.join(' | ')}` : ' (no verification ran)'}`);
      } else if (summary.verificationNote !== undefined) {
        stderr(summary.verificationNote);
      }
    } else if (out === 'json') {
      const payload = {
        schemaVersion: 2,
        sessionId: summary.sessionId,
        endReason: summary.endReason,
        turns: summary.turns,
        usage: summary.totalUsage,
        ...(summary.costUsd !== undefined ? { costUsd: summary.costUsd } : {}),
        permissionDenied: summary.permissionDenied,
        verdict: summary.verdict,
        unsupportedClaims: summary.claims.filter((c) => c.status !== 'supported').map((c) => c.text),
        staleClaims: summary.claims.filter((c) => c.status === 'stale').map((c) => c.text),
        claims: summary.claims,
        ...(summary.verification !== undefined ? { verification: summary.verification } : {}),
        ...(summary.verificationNote !== undefined ? { verificationNote: summary.verificationNote } : {}),
        finalText: summary.finalText,
      };
      write(JSON.stringify(redactor.redactValue(payload).value));
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
    try {
      recordUsage(
        cliCwd(args),
        { provider: spec.provider, model: spec.model },
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
        JSON.stringify(
          redactor.redactValue({
            schemaVersion: 1,
            sessionId: summaryAgentSessionId(),
            ts: Date.now(),
            type: ev.type,
            event: ev,
          }).value,
        ),
      );
      return;
    }
    if (out === 'text' && ev.type === 'error') {
      stderr(redactor.redact(`[${ev.error.code}] ${ev.error.message}`).text);
    }
  }
  function summaryAgentSessionId(): string {
    return agent.sessionId;
  }
}

export { resolveProvider };
export type { EndReason };
