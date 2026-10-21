import type { Runtime } from './runtime/index.js';
import type { ToolRegistry } from './tool.js';
import type { PermissionEngine } from './permissions.js';
import type { ToolCall, ToolResultBlock, ToolResultContent } from './types.js';
import { SyaoError, ToolError } from './errors/syao-error.js';

/**
 * Tool execution pipeline (DD-4, BR-025):
 * validate → permission → execute(timeout, abort) → truncate.
 * Every failure becomes a structured tool_result so the history stays legal
 * for any provider (BR-009). Nothing here throws outward.
 */

export const TRUNCATION_MAX_CHARS = 30_000;
export const TRUNCATION_MAX_LINES = 2_000;

export interface PipelineEvents {
  onToolStart?: (callId: string, name: string, input: unknown) => void;
  onToolProgress?: (callId: string, note: string) => void;
  onToolResult?: (callId: string, name: string, content: ToolResultContent[], isError: boolean, durationMs: number) => void;
  onPermissionRequest?: (call: ToolCall, reason: string) => Promise<'allow' | 'deny'>;
}

export async function executeToolCall(
  call: ToolCall,
  registry: ToolRegistry,
  engine: PermissionEngine,
  runtime: Runtime,
  opts: { cwd: string; signal: AbortSignal; events?: PipelineEvents },
): Promise<ToolResultBlock> {
  const started = runtime.clock.now();

  const fail = (code: string, modelMessage: string, details?: Record<string, unknown>): ToolResultBlock => ({
    type: 'tool_result',
    toolUseId: call.id,
    content: [{ type: 'text', text: modelMessage }],
    isError: true,
  });

  // ── validate: tool exists ──
  const tool = registry.get(call.name);
  if (tool === undefined) {
    const available = registry.list().map((t) => t.name).join(', ');
    const r = fail('SY-TOOL-001', `Tool '${call.name}' is not registered. Available tools: ${available}.`);
    opts.events?.onToolResult?.(call.id, call.name, r.content, true, runtime.clock.now() - started);
    return r;
  }

  // ── validate: args against Zod schema ──
  const parsed = tool.inputSchema.safeParse(call.input ?? {});
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('; ');
    const r = fail('SY-TOOL-002', `Invalid arguments for '${call.name}'. ${issues}`);
    opts.events?.onToolResult?.(call.id, call.name, r.content, true, runtime.clock.now() - started);
    return r;
  }

  // ── permission gate (the only authority — ADR-04) ──
  const gate = await engine.check(tool, parsed.data);
  if (gate.outcome === 'deny') {
    const r: ToolResultBlock = {
      type: 'tool_result',
      toolUseId: call.id,
      content: [{ type: 'text', text: gate.error.modelMessage ?? gate.error.message }],
      isError: true,
    };
    opts.events?.onToolResult?.(call.id, call.name, r.content, true, runtime.clock.now() - started);
    return r;
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
      progress: (note: string) => opts.events?.onToolProgress?.(call.id, note),
    };
    const result = tool.execute(parsed.data as never, ctx);
    const runIt = async (): Promise<{ content: ToolResultContent[]; isError?: boolean }> => {
      if (isAsyncGenerator(result)) {
        for (;;) {
          const n = await result.next();
          if (n.done) return n.value;
          if (typeof n.value?.note === 'string') {
            opts.events?.onToolProgress?.(call.id, n.value.note);
          }
        }
      }
      return result;
    };
    output = await Promise.race([runIt(), guard]);
  } catch (e) {
    const err = SyaoError.is(e) ? e : new ToolError({ code: 'SY-TOOL-003', message: String(e), cause: e, toolName: call.name });
    const r = fail(err.code, err.modelMessage ?? err.message, err.details);
    opts.events?.onToolResult?.(call.id, call.name, r.content, true, runtime.clock.now() - started);
    return r;
  } finally {
    clearTimeout(timeoutHandle);
    opts.signal.removeEventListener('abort', onOuterAbort);
  }

  if (output === undefined) {
    output = { content: [{ type: 'text' as const, text: '' }] };
  }

  // ── truncate (BR-012): keep head 40% + tail 60% of budget ──
  const { content, truncated } = truncateOutput(output.content);
  const isError = output.isError === true;
  if (truncated) {
    runtime.logger.log('warn', 'tool result truncated', { tool: call.name, code: 'SY-TOOL-005' });
  }
  opts.events?.onToolResult?.(call.id, tool.name, content, isError, runtime.clock.now() - started);
  return { type: 'tool_result', toolUseId: call.id, content, ...(isError ? { isError: true } : {}) };
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
