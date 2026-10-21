import {
  SyaoError,
  mapHttpStatus,
  type Capabilities,
  type ContentBlock,
  type Message,
  type ModelRequest,
  type ModelStreamEvent,
  type Provider,
  type Runtime,
} from '@syaocode/core';
import { sseEvents } from './sse.js';

/**
 * Native Anthropic Messages adapter (FR-011) — the "native official"
 * provider. Streaming SSE with content_block_start/delta/stop, thinking
 * blocks with signature, and native tool_use.
 */

export interface AnthropicOptions {
  runtime: Runtime;
  apiKey: string;
  baseUrl?: string;
  version?: string;
  models?: Record<string, Partial<Capabilities>>;
}

interface WireBlock {
  type: string;
  [k: string]: unknown;
}

export function createAnthropicProvider(opts: AnthropicOptions): Provider {
  const base = opts.baseUrl ?? 'https://api.anthropic.com/v1';
  const version = opts.version ?? '2023-06-01';
  return {
    id: 'anthropic',
    capabilities(model: string): Capabilities {
      const overrides = opts.models?.[model] ?? {};
      const thinking: Capabilities['thinking'] = /claude.*(opus|sonnet-4|sonnet-3\.7|haiku-4)/.test(model) ? 'budget' : 'none';
      const maxOutputTokens = thinking === 'budget' ? 64_000 : 8_192;
      return {
        contextWindow: 200_000,
        maxOutputTokens,
        thinking,
        parallelToolCalls: true,
        promptCache: 'explicit',
        vision: true,
        structuredOutput: false,
        ...overrides,
      };
    },
    async *stream(req, { signal }): AsyncGenerator<ModelStreamEvent> {
      let res;
      try {
        res = await opts.runtime.http.fetch(`${base}/messages`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-api-key': opts.apiKey,
            'anthropic-version': version,
          },
          body: JSON.stringify(toWire(req)),
          signal,
        });
      } catch (e) {
        throw new SyaoError({ code: 'SY-PRV-003', message: e instanceof Error ? e.message : String(e), cause: e });
      }
      if (res.status !== 200) {
        const text = await res.text();
        throw mapHttpStatus(res.status, text);
      }

      const blocks: ContentBlock[] = [];
      const usage: { inputTokens: number; outputTokens: number; cacheReadTokens?: number; cacheWriteTokens?: number } = { inputTokens: 0, outputTokens: 0 };
      let stopReason: 'end_turn' | 'tool_use' | 'max_tokens' | 'refusal' | 'error' = 'end_turn';

      for await (const data of sseEvents(res)) {
        if (data === '[DONE]') continue;
        let ev: {
          type: string;
          message?: { id?: string; usage?: { input_tokens?: number; output_tokens?: number } };
          index?: number;
          content_block?: WireBlock;
          delta?: { type?: string; text?: string; partial_json?: string; stop_reason?: string; thinking?: string };
          usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number };
        };
        try {
          ev = JSON.parse(data);
        } catch {
          throw new SyaoError({ code: 'SY-PRV-008', message: 'unparsable SSE chunk', details: { data: data.slice(0, 200) } });
        }

        switch (ev.type) {
          case 'message_start':
            if (ev.message?.usage !== undefined) {
              usage.inputTokens = ev.message.usage.input_tokens ?? 0;
            }
            yield { type: 'message_start', messageId: ev.message?.id ?? 'msg' };
            break;
          case 'content_block_start': {
            const b = ev.content_block;
            const idx = ev.index ?? blocks.length;
            if (b?.type === 'text') blocks[idx] = { type: 'text', text: '' };
            else if (b?.type === 'thinking') blocks[idx] = { type: 'thinking', text: '', ...(typeof b.signature === 'string' ? { signature: b.signature } : {}) };
            else if (b?.type === 'redacted_thinking') blocks[idx] = { type: 'thinking', text: '', redacted: true };
            else if (b?.type === 'tool_use') blocks[idx] = { type: 'tool_use', id: String(b.id ?? ''), name: String(b.name ?? ''), input: {} };
            else blocks[idx] = { type: 'text', text: '' };
            yield { type: 'block_start', index: idx, block: blocks[idx]! };
            break;
          }
          case 'content_block_delta': {
            const idx = ev.index ?? 0;
            const target = blocks[idx];
            const d = ev.delta ?? {};
            if (d.type === 'text_delta' && d.text !== undefined && target?.type === 'text') {
              target.text += d.text;
              yield { type: 'block_delta', index: idx, delta: d.text };
            } else if ((d.type === 'thinking_delta' || d.type === 'signature_delta') && target?.type === 'thinking') {
              if (d.thinking !== undefined) {
                target.text += d.thinking;
                yield { type: 'block_delta', index: idx, delta: d.thinking };
              }
              // signature_delta: no incremental yield; final signature lands on message_stop.
            } else if (d.type === 'input_json_delta' && d.partial_json !== undefined && target?.type === 'tool_use') {
              const prev = (target.input as { __args?: string }).__args ?? '';
              (target as unknown as { input: { __args?: string } }).input = { __args: prev + d.partial_json };
              yield { type: 'block_delta', index: idx, delta: d.partial_json };
            }
            break;
          }
          case 'content_block_stop': {
            const idx = ev.index ?? 0;
            const target = blocks[idx];
            if (target?.type === 'tool_use') {
              const raw = (target.input as { __args?: string } | undefined)?.__args ?? '';
              let input: unknown = {};
              if (raw !== '') {
                try {
                  input = JSON.parse(raw);
                } catch {
                  input = { _raw: raw };
                }
              }
              target.input = input;
            }
            yield { type: 'block_stop', index: idx };
            break;
          }
          case 'message_delta':
            if (ev.delta?.stop_reason !== undefined) {
              stopReason = mapStop(ev.delta.stop_reason);
            }
            if (ev.usage?.output_tokens !== undefined) usage.outputTokens = ev.usage.output_tokens;
            if (ev.usage?.input_tokens !== undefined) usage.inputTokens = ev.usage.input_tokens;
            if (ev.usage?.cache_read_input_tokens !== undefined && ev.usage.cache_read_input_tokens > 0) {
              usage.cacheReadTokens = ev.usage.cache_read_input_tokens;
            }
            if (ev.usage?.cache_creation_input_tokens !== undefined && ev.usage.cache_creation_input_tokens > 0) {
              usage.cacheWriteTokens = ev.usage.cache_creation_input_tokens;
            }
            break;
          case 'message_stop':
            break;
          case 'error':
            throw new SyaoError({ code: 'SY-PRV-009', message: 'provider streamed an error event', details: { data: data.slice(0, 300) } });
          default:
            break;
        }
      }

      const compact = blocks.filter((b) => b !== undefined);
      const message: Message = {
        id: `msg_${Date.now().toString(36)}`,
        role: 'assistant',
        content: compact.length > 0 ? compact : [{ type: 'text', text: '' }],
        meta: { createdAt: Date.now() },
      };
      yield { type: 'usage', usage };
      yield { type: 'message_stop', stopReason, message };
    },
  };
}

function mapStop(reason: string): 'end_turn' | 'tool_use' | 'max_tokens' | 'refusal' | 'error' {
  switch (reason) {
    case 'tool_use': return 'tool_use';
    case 'max_tokens': return 'max_tokens';
    case 'refusal': return 'refusal';
    default: return 'end_turn';
  }
}

function toWire(req: ModelRequest): Record<string, unknown> {
  const messages: { role: 'user' | 'assistant'; content: WireBlock[] }[] = [];
  for (const m of req.messages) {
    const content: WireBlock[] = [];
    for (const b of m.content) {
      if (b.type === 'text') content.push({ type: 'text', text: b.text });
      else if (b.type === 'thinking') {
        content.push({ type: 'thinking', thinking: b.text, ...(b.signature !== undefined ? { signature: b.signature } : {}) });
      } else if (b.type === 'tool_use') {
        content.push({ type: 'tool_use', id: b.id, name: b.name, input: b.input ?? {} });
      } else if (b.type === 'tool_result') {
        content.push({
          type: 'tool_result',
          tool_use_id: b.toolUseId,
          content: b.content
            .filter((c): c is Extract<ContentBlock, { type: 'text' }> => c.type === 'text')
            .map((c) => ({ type: 'text', text: c.text })),
          ...(b.isError === true ? { is_error: true } : {}),
        });
      }
      // image blocks pass through
      else if (b.type === 'image') {
        content.push(b.type === 'image' && b.source.type === 'base64'
          ? { type: 'image', source: { type: 'base64', media_type: b.source.mediaType, data: b.source.data } }
          : { type: 'image', source: { type: 'url', url: b.source.type === 'url' ? b.source.url : '' } });
      }
    }
    messages.push({ role: m.role, content });
  }
  return {
    model: req.model,
    ...(req.system !== undefined ? { system: req.system } : {}),
    messages,
    ...(req.tools !== undefined && req.tools.length > 0
      ? {
          tools: req.tools.map((t) => ({
            name: t.name,
            description: t.description,
            input_schema: t.inputSchema,
          })),
        }
      : {}),
    ...(req.maxOutputTokens !== undefined ? { max_tokens: req.maxOutputTokens } : {}),
    ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
    ...(req.thinkingBudget !== undefined ? { thinking: { type: 'enabled', budget_tokens: req.thinkingBudget } } : {}),
    stream: true,
  };
}
