import type { Runtime } from './runtime/index.js';
import type { SandboxLevel, ToolRegistry, ToolResultMeta, TrustLevel } from './tool.js';
import type { PermissionEngine } from './permissions.js';
import type { ToolCall, ToolResultBlock, ToolResultContent } from './types.js';
import { SyaoError, ToolError } from './errors/syao-error.js';
import { redactToolResultContent, type Redactor } from './redact.js';
import {
  parseTestStats,
  receiptInputHash,
  type ReceiptStore,
  type ToolReceipt,
} from './evidence.js';
import { sha256Hex } from './hash.js';

/**
 * Tool execution pipeline (DD-4, BR-025):
 * validate → permission → execute(timeout, abort) → redact → truncate.
 * Redaction happens *before* the result enters history or the event stream,
 * so a secret returned by a tool never reaches the provider (report S1).
 * Every failure becomes a structured tool_result so the history stays legal
 * for any provider (BR-009). Nothing here throws outward.
 */

export const TRUNCATION_MAX_CHARS = 30_000;
export const TRUNCATION_MAX_LINES = 2_000;

export interface PipelineEvents {
  onToolStart?: (callId: string, name: string, input: unknown) => void;
  onToolProgress?: (callId: string, note: string) => void;
  onToolResult?: (callId: string, name: string, content: ToolResultContent[], isError: boolean, durationMs: number) => void;
  onToolReceipt?: (receipt: ToolReceipt) => void;
  onPermissionRequest?: (call: ToolCall, reason: string) => Promise<'allow' | 'deny'>;
}

export async function executeToolCall(
  call: ToolCall,
  registry: ToolRegistry,
  engine: PermissionEngine,
  runtime: Runtime,
  opts: {
    cwd: string;
    signal: AbortSignal;
    events?: PipelineEvents;
    redactor?: Redactor;
    receipts?: ReceiptStore;
  },
): Promise<ToolResultBlock> {
  const started = runtime.clock.now();
  const sanitize = (content: ToolResultContent[]): ToolResultContent[] =>
    redactToolResultContent(content, opts.redactor);
  const progress = (note: string): void => {
    opts.events?.onToolProgress?.(call.id, opts.redactor?.redact(note).text ?? note);
  };

  const textOf = (content: ToolResultContent[]): string =>
    content.filter((c): c is Extract<ToolResultContent, { type: 'text' }> => c.type === 'text').map((c) => c.text).join('\n');

  /** Trust the resolved tool declares for its own results (report C4). */
  let declaredTrust: TrustLevel | undefined;

  const finish = async (
    toolName: string,
    content: ToolResultContent[],
    isError: boolean,
    meta: ToolResultMeta = {},
    truncated = false,
  ): Promise<ToolResultBlock> => {
    const fullText = textOf(content);
    // Governance-facing digest: SHA-256, never the FNV `contentHash` that
    // read-before-write fencing uses (report C6).
    const hasher = runtime.hash?.sha256 ?? sha256Hex;
    let outputHash = hasher(fullText);
    let outputRef: string | undefined;
    if (opts.receipts !== undefined) {
      try {
        const stored = await opts.receipts.put(fullText);
        outputHash = stored.hash;
        outputRef = stored.ref;
      } catch {
        /* evidence storage is best-effort; never fail the tool call for it */
      }
    }
    const command = meta.command;
    const testStats = meta.testStats ?? (command !== undefined ? parseTestStats(fullText) : undefined);
    // C4: real provenance instead of the previous hardcoded pair. Precedence:
    // the tool's per-result meta, then the tool's declared trust, then the
    // local-workspace default.
    const trust: TrustLevel = meta.trust ?? declaredTrust ?? 'workspace';
    const sandbox: SandboxLevel = meta.sandbox ?? 'none';
    const receipt: ToolReceipt = {
      callId: call.id,
      tool: toolName,
      timestamp: started,
      durationMs: runtime.clock.now() - started,
      inputHash: receiptInputHash(call.input ?? {}, hasher),
      outputHash,
      ...(outputRef !== undefined ? { outputRef } : {}),
      outputChars: fullText.length,
      truncated,
      isError,
      ...(meta.exitCode !== undefined ? { exitCode: meta.exitCode } : {}),
      ...(command !== undefined ? { command } : {}),
      ...(meta.paths !== undefined ? { paths: meta.paths } : {}),
      ...(testStats !== undefined ? { testStats } : {}),
      trust,
      sandbox,
    };
    opts.events?.onToolReceipt?.(receipt);
    const block: ToolResultBlock = {
      type: 'tool_result',
      toolUseId: call.id,
      content,
      ...(isError ? { isError: true } : {}),
      // Only the two wire-visible levels are stamped: local workspace results
      // keep the historical unset value so existing consumers are unaffected.
      ...(trust === 'untrusted' ? { trust: 'untrusted' as const } : trust === 'trusted' ? { trust: 'trusted' as const } : {}),
    };
    opts.events?.onToolResult?.(call.id, toolName, content, isError, receipt.durationMs);
    return block;
  };

  const fail = (code: string, modelMessage: string, details?: Record<string, unknown>): ToolResultBlock => ({
    type: 'tool_result',
    toolUseId: call.id,
    content: sanitize([{ type: 'text', text: modelMessage }]),
    isError: true,
  });
  void fail;

  // ── validate: tool exists ──
  const tool = registry.get(call.name);
  if (tool === undefined) {
    const available = registry.list().map((t) => t.name).join(', ');
    return finish(
      call.name,
      sanitize([{ type: 'text', text: `Tool '${call.name}' is not registered. Available tools: ${available}.` }]),
      true,
    );
  }
  declaredTrust = tool.trust;
  // ── validate: args against Zod schema ──
  const parsed = tool.inputSchema.safeParse(call.input ?? {});
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('; ');
    return finish(
      call.name,
      sanitize([{ type: 'text', text: `Invalid arguments for '${call.name}'. ${issues}` }]),
      true,
    );
  }

  // ── permission gate (the only authority — ADR-04) ──
  const gate = await engine.check(tool, parsed.data, call.id);
  if (gate.outcome === 'deny') {
    return finish(
      call.name,
      sanitize([{ type: 'text', text: gate.error.modelMessage ?? gate.error.message }]),
      true,
    );
  }

  // ── execute with timeout + abort ──
  opts.events?.onToolStart?.(call.id, tool.name, parsed.data);
  const timeoutMs = tool.timeoutMs ?? 120_000;
  const timeoutSignal = new AbortController();
  const onOuterAbort = () => timeoutSignal.abort(opts.signal.reason);
  if (opts.signal.aborted) onOuterAbort();
  else opts.signal.addEventListener('abort', onOuterAbort, { once: true });
  const timeoutHandle = setTimeout(() => timeoutSignal.abort(new Error('tool timeout')), timeoutMs);

  // Hang guard (NFR-007): tools that ignore the signal can't stall the loop.
  const guard = new Promise<never>((_, reject) => {
    const onKill = () => {
      if (opts.signal.aborted) {
        reject(
          new ToolError({
            code: 'SY-LOOP-003',
            toolName: tool.name,
            callId: call.id,
            modelMessage: `Run aborted while '${tool.name}' was executing (SY-LOOP-003).`,
          }),
        );
      } else {
        reject(
          new ToolError({
            code: 'SY-TOOL-004',
            toolName: tool.name,
            callId: call.id,
            modelMessage: `Tool '${tool.name}' exceeded its ${timeoutMs}ms timeout and was abandoned (subprocess signalled if applicable).`,
          }),
        );
      }
    };
    if (timeoutSignal.signal.aborted) onKill();
    else timeoutSignal.signal.addEventListener('abort', onKill, { once: true });
  });

  let output;
  try {
    const ctx = {
      runtime,
      cwd: opts.cwd,
      signal: timeoutSignal.signal,
      progress,
    };
    const result = tool.execute(parsed.data as never, ctx);
    const runIt = async (): Promise<{ content: ToolResultContent[]; isError?: boolean; meta?: ToolResultMeta }> => {
      if (isAsyncGenerator(result)) {
        for (;;) {
          const n = await result.next();
          if (n.done) return n.value;
          if (typeof n.value?.note === 'string') {
            progress(n.value.note);
          }
        }
      }
      return result;
    };
    output = await Promise.race([runIt(), guard]);
  } catch (e) {
    const err = SyaoError.is(e) ? e : new ToolError({ code: 'SY-TOOL-003', message: String(e), cause: e, toolName: call.name });
    return finish(call.name, sanitize([{ type: 'text', text: err.modelMessage ?? err.message }]), true);
  } finally {
    clearTimeout(timeoutHandle);
    opts.signal.removeEventListener('abort', onOuterAbort);
  }

  if (output === undefined) {
    output = { content: [{ type: 'text' as const, text: '' }] };
  }

  // ── redact → truncate (BR-012 / S1): keep head 40% + tail 60% of budget ──
  const redacted = sanitize(output.content);
  const { content, truncated } = truncateOutput(redacted);
  const isError = output.isError === true;
  if (truncated) {
    runtime.logger.log('warn', 'tool result truncated', { tool: call.name, code: 'SY-TOOL-005' });
  }
  const subject = tool.permissionSubject?.(parsed.data as never);
  const meta: ToolResultMeta = {
    ...(output.meta ?? {}),
    ...(subject?.command !== undefined && output.meta?.command === undefined ? { command: subject.command } : {}),
    ...(subject?.path !== undefined
      ? { paths: output.meta?.paths ?? [subject.path] }
      : output.meta?.paths !== undefined
        ? { paths: output.meta.paths }
        : {}),
  };
  return finish(tool.name, content, isError, meta, truncated);
}

function isAsyncGenerator(
  v: unknown,
): v is AsyncGenerator<{ note: string }, { content: ToolResultContent[]; isError?: boolean }, unknown> {
  return (
    typeof v === 'object' && v !== null &&
    typeof (v as AsyncGenerator).next === 'function' &&
    typeof (v as AsyncGenerator).return === 'function'
  );
}

export function truncateOutput(content: ToolResultContent[]): { content: ToolResultContent[]; truncated: boolean } {
  const textBlocks = content.filter((c): c is Extract<ToolResultContent, { type: 'text' }> => c.type === 'text');
  const totalChars = textBlocks.reduce((a, c) => a + c.text.length, 0);
  const totalLines = textBlocks.reduce((a, c) => a + c.text.split('\n').length, 0);
  if (totalChars <= TRUNCATION_MAX_CHARS && totalLines <= TRUNCATION_MAX_LINES) {
    return { content, truncated: false };
  }
  const full = textBlocks.map((c) => c.text).join('\n');
  const lines = full.split('\n');
  const overLines = totalLines > TRUNCATION_MAX_LINES;
  let kept: string;
  if (overLines) {
    const headCount = Math.floor(TRUNCATION_MAX_LINES * 0.4);
    const tailCount = TRUNCATION_MAX_LINES - headCount;
    kept =
      `${lines.slice(0, headCount).join('\n')}\n` +
      `… [truncated: ${totalLines - TRUNCATION_MAX_LINES} middle lines removed; re-read with a narrower range] …\n` +
      `${lines.slice(-tailCount).join('\n')}`;
  } else {
    const headCount = Math.floor(TRUNCATION_MAX_CHARS * 0.4);
    const tailCount = TRUNCATION_MAX_CHARS - headCount;
    kept =
      `${full.slice(0, headCount)}\n` +
      `… [truncated: ${totalChars - TRUNCATION_MAX_CHARS} middle chars removed; re-read with a narrower range] …\n` +
      `${full.slice(-tailCount)}`;
  }
  return { content: [{ type: 'text', text: kept }], truncated: true };
}
