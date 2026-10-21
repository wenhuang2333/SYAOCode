import type { ContentBlock, Message, StopReason, Usage } from './types.js';
import type { Runtime } from './runtime/index.js';
import { SyaoError, ProviderError } from './errors/syao-error.js';

/**
 * Provider abstraction (DD-3). Adapters live in @syaocode/providers; the
 * kernel only knows this interface. Normalized stream events keep the loop
 * vendor-agnostic.
 */

export interface ModelRequest {
  model: string;
  system?: string;
  messages: Message[];
  tools?: ToolDefinition[];
  maxOutputTokens?: number;
  temperature?: number;
  thinkingBudget?: number;
}

export interface ToolDefinition {
  name: string;
  description: string;
  /** JSON Schema produced from the Zod source of truth (ADR-07). */
  inputSchema: Record<string, unknown>;
}

export type ModelStreamEvent =
  | { type: 'message_start'; messageId: string }
  | { type: 'block_start'; index: number; block: ContentBlock }
  | { type: 'block_delta'; index: number; delta: string }
  | { type: 'block_stop'; index: number }
  | { type: 'usage'; usage: Usage }
  | { type: 'message_stop'; stopReason: StopReason; message: Message };

export interface Pricing {
  inputPerMTok: number;
  outputPerMTok: number;
  cacheReadPerMTok?: number;
  cacheWritePerMTok?: number;
}

export interface Capabilities {
  contextWindow: number;
  maxOutputTokens: number;
  parallelToolCalls: boolean;
  thinking: 'none' | 'budget' | 'effort';
  promptCache: 'none' | 'explicit' | 'automatic';
  vision: boolean;
  structuredOutput: boolean;
  pricing?: Pricing;
}

export interface Provider {
  readonly id: string;
  capabilities(model: string): Capabilities;
  stream(req: ModelRequest, opts: { signal: AbortSignal }): AsyncIterable<ModelStreamEvent>;
  countTokens?(req: ModelRequest): Promise<number>;
}

export interface RetryAttemptInfo {
  /** 第几次重试（1 = 首次重试） */
  attempt: number;
  /** 触发重试的错误码（SY-PRV-002/003/007/009 等） */
  code: string;
  /** 本次退避时长（毫秒） */
  delayMs: number;
}

export interface RetryPolicy {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  /** 每次即将重试时回调（UI 用来显示"网络拥塞/重试中"，默认不回调） */
  onRetry?: (info: RetryAttemptInfo) => void;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = { maxAttempts: 5, baseDelayMs: 1_000, maxDelayMs: 30_000 };

function mapHttpStatus(status: number, body: string): ProviderError {
  if (status === 401 || status === 403) {
    return new ProviderError({ code: 'SY-PRV-001', status, details: { status } });
  }
  if (status === 429) {
    return new ProviderError({ code: 'SY-PRV-002', status, details: { status, body: body.slice(0, 500) } });
  }
  if (status >= 500) {
    return new ProviderError({ code: 'SY-PRV-009', status, details: { status, body: body.slice(0, 500) } });
  }
  return new ProviderError({ code: 'SY-PRV-008', status, details: { status, body: body.slice(0, 500) } });
}

export { mapHttpStatus };

/**
 * Retry wrapper (BR-014): exponential backoff, jitter, Retry-After honored,
 * only `retryable` codes retried; 401/400 never retried.
 */
export function withRetry(
  provider: Provider,
  runtime: Runtime,
  policy: RetryPolicy = DEFAULT_RETRY_POLICY,
): Provider {
  return {
    id: provider.id,
    capabilities: (m: string) => provider.capabilities(m),
    ...(provider.countTokens !== undefined ? { countTokens: provider.countTokens.bind(provider) } : {}),
    async *stream(req, opts) {
      let attempt = 0;
      for (;;) {
        let emittedDelta = false;
        let committedToolUse = false;
        try {
          for await (const ev of provider.stream(req, { signal: opts.signal })) {
            if (ev.type === 'block_delta') emittedDelta = true;
            if (ev.type === 'block_start' && ev.block.type === 'tool_use') committedToolUse = true;
            yield ev;
          }
          return;
        } catch (e) {
          if (opts.signal.aborted) throw e;
          const wrapped = SyaoError.is(e) ? e : mapUnknown(e);
          // A stream that already emitted content (and especially committed
          // tool_use) cannot be safely replayed (BR-014).
          const replayUnsafe = emittedDelta && committedToolUse;
          const canRetry =
            wrapped.retryable && attempt + 1 < policy.maxAttempts && !replayUnsafe && !opts.signal.aborted;
          if (!canRetry) throw wrapped;
          attempt += 1;
          const retryAfter = wrapped instanceof ProviderError ? wrapped.retryAfterMs : undefined;
          const jitter = Math.random() * 0.3 * (retryAfter ?? backoffMs(policy, attempt));
          const delay = Math.min(retryAfter ?? backoffMs(policy, attempt), policy.maxDelayMs) + jitter;
          runtime.logger.log('warn', 'provider retry', { attempt, code: wrapped.code, delayMs: Math.round(delay) });
          policy.onRetry?.({ attempt, code: wrapped.code, delayMs: Math.round(delay) });
          await runtime.clock.sleep(delay, opts.signal).catch(() => {
            throw wrapped;
          });
        }
      }
    },
  };
}

function backoffMs(policy: RetryPolicy, attempt: number): number {
  return policy.baseDelayMs * 2 ** (attempt - 1);
}

function mapUnknown(e: unknown): ProviderError {
  if (e instanceof DOMException && e.name === 'AbortError') {
    return new ProviderError({ code: 'SY-PRV-007', message: 'aborted', cause: e });
  }
  const msg = e instanceof Error ? e.message : String(e);
  if (/timeout|timed out|ECONNREFUSED|ENOTFOUND|fetch failed|network/i.test(msg)) {
    return new ProviderError({ code: 'SY-PRV-003', message: msg, cause: e });
  }
  return new ProviderError({ code: 'SY-PRV-008', message: msg, cause: e });
}
