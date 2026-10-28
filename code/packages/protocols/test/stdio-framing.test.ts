/**
 * Regression: MCP/ACP stdio framing over a REAL child process.
 *
 * The bug this locks down: `ProcessHandle.stdout` is a *line* iterator, so
 * `Content-Length: N\r\n\r\n<body>` can never be reassembled from it — every
 * real stdio peer timed out. Two things had to be true for the fix:
 *
 *   1. the channel consumes `ProcessHandle.stdoutChunks` (raw bytes) when the
 *      host provides them, not `stdout`;
 *   2. `MessageFramer` slices by **bytes**, because `Content-Length` counts
 *      bytes while a JS string index counts UTF-16 code units — a body with a
 *      Chinese character or an emoji otherwise never completes.
 *
 * The child below writes ONE frame split across several chunks, with a chunk
 * boundary *inside the header*, and a pretty-printed body containing
 * multi-byte UTF-8. That is exactly the shape that broke the line path.
 */

import { spawn } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { MessageFramer, byteLength, frameContentLength } from '../src/shared/jsonrpc.js';
import { createStdioChannel } from '../src/shared/transport.js';
import { createFakeRuntime } from './helpers/fake-runtime.js';
import type { ProcessHandle, Runtime, ShellSpawnOptions } from '@syaocode/core';

// ── a real Shell over node:child_process (test-only; mirrors NodeShell) ────

async function* lineStream(stream: NodeJS.ReadableStream | null): AsyncIterable<string> {
  if (stream === null) return;
  let buffer = '';
  for await (const chunk of stream) {
    buffer += String(chunk);
    for (;;) {
      const nl = buffer.indexOf('\n');
      if (nl === -1) break;
      const line = buffer.slice(0, nl).replace(/\r$/, '');
      buffer = buffer.slice(nl + 1);
      yield line;
    }
  }
  if (buffer.length > 0) yield buffer;
}

async function* chunkStream(stream: NodeJS.ReadableStream | null): AsyncIterable<Uint8Array> {
  if (stream === null) return;
  for await (const chunk of stream) yield chunk as Uint8Array;
}

/** A Runtime whose `shell` spawns real children (line stream + raw chunks). */
function realShellRuntime(): Runtime {
  const base = createFakeRuntime();
  return {
    ...base,
    shell: {
      spawn(command: string, args: string[], opts?: ShellSpawnOptions): ProcessHandle {
        const child = spawn(command, args, {
          ...(opts?.cwd !== undefined ? { cwd: opts.cwd } : {}),
          ...(opts?.env !== undefined ? { env: opts.env } : {}),
          stdio: [opts?.stdin === false ? 'ignore' : 'pipe', 'pipe', 'pipe'],
        });
        return {
          pid: child.pid,
          stdout: lineStream(child.stdout),
          stderr: lineStream(child.stderr),
          stdoutChunks: chunkStream(child.stdout),
          stderrChunks: chunkStream(child.stderr),
          exited: new Promise<number>((resolve) => child.on('close', (code) => resolve(code ?? 0))),
          kill(signal?: 'SIGTERM' | 'SIGKILL') {
            child.kill(signal ?? 'SIGTERM');
          },
          ...(child.stdin !== null
            ? {
                stdin: {
                  write(data: string) {
                    child.stdin?.write(data);
                  },
                  end() {
                    child.stdin?.end();
                  },
                },
              }
            : {}),
        };
      },
    },
  };
}

/**
 * A child that writes ONE `Content-Length` frame in several `write()` calls.
 * The split points deliberately land inside the header *and* inside the
 * multi-byte body.
 */
function frameWriterScript(body: string): string {
  const frame = `Content-Length: ${byteLength(body)}\r\n\r\n${body}`;
  // Split by BYTES so a boundary can fall inside a multi-byte character.
  const bytes = new TextEncoder().encode(frame);
  const cuts = [9, 21, 27, Math.floor(bytes.length * 0.6)];
  const parts: Uint8Array[] = [];
  let cursor = 0;
  for (const cut of cuts) {
    if (cut <= cursor || cut >= bytes.length) continue;
    parts.push(bytes.slice(cursor, cut));
    cursor = cut;
  }
  parts.push(bytes.slice(cursor));
  const literal = parts.map((part) => Array.from(part));
  return [
    `const parts = ${JSON.stringify(literal)}.map((a) => Uint8Array.from(a));`,
    'let i = 0;',
    'const tick = () => {',
    '  if (i >= parts.length) { setTimeout(() => process.exit(0), 30); return; }',
    '  process.stdout.write(parts[i++]);',
    '  setTimeout(tick, 8);',
    '};',
    'tick();',
  ].join('\n');
}

const BODY = JSON.stringify(
  {
    jsonrpc: '2.0',
    id: 1,
    result: {
      // Multi-byte UTF-8: 3-byte CJK and a 4-byte emoji.
      text: '中文结果 🚀\n第二行',
      nested: { path: '/repo/文件.txt', ok: true },
    },
  },
  null,
  2,
);

/**
 * The real host combination: `@syaocode/node`'s `nodeRuntime()` + the protocol
 * edge's own `createStdioChannel`. This is the case that used to time out.
 *
 * `@syaocode/node` is not a declared dependency of this package (the edges
 * must stay host-agnostic), so it is imported dynamically and the case is
 * skipped when the host package is not installed.
 */
describe('stdio framing with the real @syaocode/node host', () => {
  it('reassembles a Content-Length frame through nodeRuntime()', async () => {
    let nodeRuntime: (() => Runtime) | undefined;
    try {
      const node = (await import('@syaocode/node')) as { nodeRuntime?: () => Runtime };
      nodeRuntime = node.nodeRuntime;
    } catch {
      nodeRuntime = undefined;
    }
    if (nodeRuntime === undefined) return; // host package absent: nothing to prove

    const runtime = nodeRuntime();
    const { channel } = createStdioChannel(runtime, process.execPath, ['-e', frameWriterScript(BODY)]);

    const framer = new MessageFramer('content-length');
    const messages = [];
    for await (const chunk of channel.receive()) messages.push(...framer.push(chunk));
    messages.push(...framer.flush());

    expect(messages).toHaveLength(1);
    expect(messages[0]).toEqual(JSON.parse(BODY));
    await channel.close();
  });
});

describe('stdio framing over a real child (Content-Length regression)', () => {
  it('reassembles a frame whose header and multi-byte body span several chunks', async () => {
    const runtime = realShellRuntime();
    const { channel } = createStdioChannel(runtime, process.execPath, ['-e', frameWriterScript(BODY)]);

    const framer = new MessageFramer('content-length');
    const messages = [];
    for await (const chunk of channel.receive()) messages.push(...framer.push(chunk));
    messages.push(...framer.flush());

    expect(messages).toHaveLength(1);
    expect(messages[0]).toEqual(JSON.parse(BODY));
    // The exact body (newlines, CJK and emoji included) round-trips.
    expect(JSON.stringify(messages[0])).toBe(JSON.stringify(JSON.parse(BODY)));
    await channel.close();
  });

  it('would NOT have worked from the line-split stdout stream (the original bug)', async () => {
    const runtime = realShellRuntime();
    const expectedFrame = `Content-Length: ${byteLength(BODY)}\r\n\r\n${BODY}`;

    // One child per view: a child's stdout can only be consumed once.
    const rawHandle = runtime.shell.spawn(process.execPath, ['-e', frameWriterScript(BODY)]);
    // The raw byte stream is present...
    expect(rawHandle.stdoutChunks).toBeDefined();
    const raw: Uint8Array[] = [];
    for await (const chunk of rawHandle.stdoutChunks ?? []) raw.push(chunk);
    const rawText = new TextDecoder().decode(Buffer.concat(raw.map((c) => Buffer.from(c))));
    // ...and it carries the frame byte-for-byte, separator included.
    expect(rawText).toBe(expectedFrame);

    // The line iterator, by contrast, has eaten every newline AND every CR, so
    // the `\r\n\r\n` separator is gone and the bytes are not recoverable.
    // This is precisely why the raw stream exists.
    const lineHandle = runtime.shell.spawn(process.execPath, ['-e', frameWriterScript(BODY)]);
    const lines: string[] = [];
    for await (const line of lineHandle.stdout) lines.push(line);
    expect(lines[0]).toBe(`Content-Length: ${byteLength(BODY)}`);
    expect(lines[1]).toBe('');
    expect(lines.length).toBeGreaterThan(2);
    const rejoined = lines.join('\n');
    expect(rejoined).not.toBe(expectedFrame);
    expect(rejoined.includes('\r')).toBe(false);
    // A consumer cannot tell where the header ends and the body begins.
    expect(rejoined.startsWith('Content-Length: ')).toBe(true);
    expect(byteLength(rejoined)).not.toBe(byteLength(expectedFrame));
  });

  it('frames the request side by bytes too', () => {
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'x', params: { text: '中文🚀' } });
    const framed = frameContentLength(body);
    expect(byteLength(body)).toBeGreaterThan(body.length);
    expect(framed).toBe(`Content-Length: ${byteLength(body)}\r\n\r\n${body}`);
    // A framer reading it back gets the same message.
    const messages = new MessageFramer('content-length').push(framed);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toEqual(JSON.parse(body));
  });

  it('slices a multi-byte body by Content-Length bytes, not characters', () => {
    const body = JSON.stringify({ jsonrpc: '2.0', id: 7, result: '中文🚀中文' }, null, 2);
    const framed = frameContentLength(body);
    const framer = new MessageFramer('content-length');

    // Feed the frame one byte at a time: nothing may be emitted early and the
    // body must come out whole.
    const bytes = new TextEncoder().encode(framed);
    const emitted = [];
    for (const byte of bytes) emitted.push(...framer.pushBytes(Uint8Array.from([byte])));
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toEqual(JSON.parse(body));
  });

  it('handles a chunk boundary inside a multi-byte character', () => {
    const body = JSON.stringify({ jsonrpc: '2.0', id: 9, result: '🚀' });
    const framed = frameContentLength(body);
    const bytes = new TextEncoder().encode(framed);
    const framer = new MessageFramer('content-length');
    // Split inside the 4-byte emoji.
    const emojiAt = framed.indexOf('🚀');
    const byteOffset = byteLength(framed.slice(0, emojiAt)) + 2;
    const messages = [...framer.pushBytes(bytes.slice(0, byteOffset)), ...framer.pushBytes(bytes.slice(byteOffset))];
    expect(messages).toHaveLength(1);
    expect(messages[0]).toEqual(JSON.parse(body));
  });
});
