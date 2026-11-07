import type { Runtime } from '@syaocode/core';
import type { ChannelProtocol } from '@syaocode/dhp';
import type { ObservedUsage } from './usage.ts';

/** Observe only usage fields; never store wire bodies, headers, keys or URLs. */
export function wireUsageRuntime(runtime: Runtime, protocol: ChannelProtocol): {
  runtime: Runtime; reset(): void; usage(): ObservedUsage;
} {
  let input: number | null = null;
  let output: number | null = null;
  let read: number | null = null;
  let write: number | null = null;
  let cost: number | null = null;
  const number = (n: unknown): number | null => typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : null;
  const object = (v: unknown): Record<string, unknown> => v !== null && typeof v === 'object' ? v as Record<string, unknown> : {};
  const update = (raw: string): void => {
    try {
      const e = object(JSON.parse(raw));
      const u = object(protocol === 'anthropic' && e['type'] === 'message_start' ? object(e['message'])['usage'] : e['usage']);
      if (protocol === 'anthropic') {
        input = number(u['input_tokens']) ?? input;
        output = number(u['output_tokens']) ?? output;
        read = number(u['cache_read_input_tokens']) ?? read;
        write = number(u['cache_creation_input_tokens']) ?? write;
      } else {
        input = number(u['prompt_tokens']) ?? input;
        output = number(u['completion_tokens']) ?? output;
        read = number(u['prompt_cache_hit_tokens']) ?? number(object(u['prompt_tokens_details'])['cached_tokens']) ?? read;
        cost = number(u['cost']) ?? number(u['gateway_cost']) ?? cost;
      }
    } catch { /* The adapter owns malformed SSE errors. */ }
  };
  return {
    reset() { input = output = read = write = cost = null; },
    usage() {
      // Anthropic input_tokens excludes cache. Missing cache fields are unknown, not zero.
      const totalInput = protocol === 'anthropic'
        ? input !== null && read !== null && write !== null ? input + read + write : null
        : input;
      return { inputTokens: totalInput, outputTokens: output, cacheReadTokens: read, cacheWriteTokens: write, costUsd: cost };
    },
    runtime: {
      ...runtime,
      http: {
        async fetch(url, init) {
          const response = await runtime.http.fetch(url, init);
          if (response.status !== 200) return response;
          let buffer = '';
          let data: string[] = [];
          const scan = (chunk: string, final = false): void => {
            buffer += chunk;
            let end: number;
            while ((end = buffer.indexOf('\n')) >= 0) {
              const line = buffer.slice(0, end).replace(/\r$/, ''); buffer = buffer.slice(end + 1);
              if (line === '') { if (data.length) update(data.join('\n')); data = []; }
              else if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
            }
            // Bound malformed/unframed upstream memory; adapter will reject its content.
            if (buffer.length > 4 * 1024 * 1024 || data.reduce((n, s) => n + s.length, 0) > 4 * 1024 * 1024) { buffer = ''; data = []; }
            if (final) {
              if (buffer.startsWith('data:')) data.push(buffer.slice(5).trimStart());
              if (data.length) update(data.join('\n'));
            }
          };
          const body = response.body;
          if (!body) return { ...response, async text() { const text = await response.text(); scan(text, true); return text; } };
          const decoder = new TextDecoder();
          return {
            ...response,
            body: body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
              transform(chunk, controller) { scan(decoder.decode(chunk, { stream: true })); controller.enqueue(chunk); },
              flush() { scan(decoder.decode(), true); },
            })),
          };
        },
      },
    },
  };
}
