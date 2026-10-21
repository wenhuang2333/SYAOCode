import type { HttpResponse } from '@syaocode/core';

/** Parse an SSE stream into `data:` payload strings (handles CRLF and multi-line). */
export async function* sseEvents(res: HttpResponse): AsyncGenerator<string> {
  if (res.body === undefined) {
    // Memory mock path: whole body at once.
    const text = await res.text();
    for (const event of splitSse(text)) yield event;
    return;
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buffer.indexOf('\n\n')) >= 0) {
      const rawEvent = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      for (const event of splitSse(rawEvent)) yield event;
    }
  }
  buffer += decoder.decode();
  for (const event of splitSse(buffer)) yield event;
}

function splitSse(chunk: string): string[] {
  const out: string[] = [];
  for (const line of chunk.split('\n')) {
    const trimmed = line.replace(/\r$/, '');
    if (trimmed.startsWith('data:')) {
      out.push(trimmed.slice(5).trimStart());
    }
  }
  return out;
}
