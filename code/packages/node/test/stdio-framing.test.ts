import { describe, expect, it } from 'vitest';
import {
  createStdioTransport,
  decodeJsonRpcFrames,
  encodeFrame,
  nodeRuntime,
  StdioTransportError,
  type StdioFrame,
} from '../src/index';
import type { ProcessHandle, Runtime } from '@syaocode/core';

/**
 * Regression for the MCP stdio framing bug.
 *
 * `NodeShell.stdout` is a *line* iterator: it eats the newlines, so a
 * `Content-Length: N\r\n\r\n<body>` frame can never be reassembled. Every
 * real MCP stdio server therefore timed out. The fix is
 * `ProcessHandle.stdoutChunks` (raw bytes) plus a byte-accurate framer.
 *
 * The child below writes ONE frame split across three writes, with a chunk
 * boundary **inside the header**, and a body that is pretty-printed (so it
 * contains real newlines and Content-Length != line count). That is the
 * shape that broke the line-based path.
 */

const BODY = JSON.stringify(
  { jsonrpc: '2.0', id: 1, result: { text: 'line1\nline2', nested: { a: 1, b: [1, 2] } } },
  null,
  2,
);

function frameWriterScript(body: string): string {
  const frame = `Content-Length: ${Buffer.byteLength(body, 'utf8')}\r\n\r\n${body}`;
  // Split inside "Content-Length: 123" so the header itself spans two chunks.
  const parts = [frame.slice(0, 10), frame.slice(10, 20), frame.slice(20)];
  return [
    `const parts = ${JSON.stringify(parts)};`,
    'process.stdout.write(parts[0]);',
    'setTimeout(() => process.stdout.write(parts[1]), 15);',
    'setTimeout(() => process.stdout.write(parts[2]), 30);',
    'setTimeout(() => process.exit(0), 120);',
  ].join('\n');
}

async function collect(stream: AsyncIterable<StdioFrame>): Promise<StdioFrame[]> {
  const out: StdioFrame[] = [];
  for await (const f of stream) out.push(f);
  return out;
}

describe('stdio framing (MCP Content-Length regression)', () => {
  it('reassembles a frame split across chunks, with the body containing real newlines', async () => {
    const runtime = nodeRuntime();
    const transport = createStdioTransport({
      runtime,
      command: process.execPath,
      args: ['-e', frameWriterScript(BODY)],
    });
    const frames = await transport.open();
    const decoded = await collect(frames);
    expect(decoded).toHaveLength(1);
    expect(decoded[0]?.framing).toBe('content-length');
    // The exact body round-trips, newlines and all.
    expect(decoded[0]?.raw).toBe(BODY);
    expect(decoded[0]?.json).toEqual(JSON.parse(BODY));
    await transport.close();
  });

  it('preserves the line-split stdout stream alongside the raw chunks', async () => {
    const runtime = nodeRuntime();
    const handle = runtime.shell.spawn(process.execPath, ['-e', frameWriterScript(BODY)]);
    expect(handle.stdoutChunks).toBeDefined();
    // The legacy line path still works and is still lossy (that is the point):
    // it keeps the header's trailing CR and splits the body on its newlines,
    // so the frame can never be reassembled from it.
    const lines: string[] = [];
    for await (const line of handle.stdout) lines.push(line);
    expect(lines[0]).toBe(`Content-Length: ${Buffer.byteLength(BODY, 'utf8')}\r`);
    expect(lines).not.toContain(BODY);
    expect(lines.length).toBeGreaterThan(2);
    await handle.exited;
  });

  it('decodes two consecutive frames from one chunk and a multi-byte body', async () => {
    const bodyA = JSON.stringify({ jsonrpc: '2.0', id: 1, result: { text: '你好，世界' } });
    const bodyB = JSON.stringify({ jsonrpc: '2.0', id: 2, result: { text: 'ok\nsecond' } });
    const bytes = Buffer.concat([
      Buffer.from(encodeFrame(JSON.parse(bodyA) as unknown, 'content-length'), 'utf8'),
      Buffer.from(encodeFrame(JSON.parse(bodyB) as unknown, 'content-length'), 'utf8'),
    ]);
    // One arbitrary chunk boundary in the middle of the concatenated frames.
    const cut = 12;
    const chunks = (async function* () {
      yield bytes.subarray(0, cut);
      yield bytes.subarray(cut);
    })();
    const decoded = await collect(decodeJsonRpcFrames(chunks, 'content-length'));
    expect(decoded.map((f) => f.json)).toEqual([JSON.parse(bodyA), JSON.parse(bodyB)]);
    expect(decoded[1]?.raw).toBe(bodyB);
  });

  it('auto-detects content-length framing from the inbound stream', async () => {
    const body = JSON.stringify({ jsonrpc: '2.0', id: 7, result: { ok: true } });
    const bytes = Buffer.from(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`, 'utf8');
    const chunks = (async function* () {
      yield bytes.subarray(0, 3);
      yield bytes.subarray(3, 17);
      yield bytes.subarray(17);
    })();
    const decoded = await collect(decodeJsonRpcFrames(chunks, 'auto'));
    expect(decoded).toHaveLength(1);
    expect(decoded[0]?.framing).toBe('content-length');
    expect(decoded[0]?.raw).toBe(body);
  });

  it('still decodes newline-delimited frames when the peer uses json-lines', async () => {
    const chunks = (async function* () {
      yield Buffer.from('{"id":1}\n{"id":');
      yield Buffer.from('2}\n');
    })();
    const decoded = await collect(decodeJsonRpcFrames(chunks, 'json-lines'));
    expect(decoded.map((f) => f.json)).toEqual([{ id: 1 }, { id: 2 }]);
    expect(decoded.every((f) => f.framing === 'json-lines')).toBe(true);
  });

  it('fails closed when the host has no raw chunk stream but the peer needs header framing', async () => {
    // A host that only implements line iteration — the pre-fix shape.
    const handle: ProcessHandle = {
      pid: 1,
      stdout: (async function* () {
        yield 'Content-Length: 17';
        yield '';
        yield '{"id":1}';
      })(),
      stderr: (async function* () {})(),
      exited: Promise.resolve(0),
      kill() {},
      stdin: { write() {}, end() {} },
    };
    const lineOnly: Runtime = { ...nodeRuntime(), shell: { spawn: () => handle } };

    const strict = createStdioTransport({ runtime: lineOnly, command: 'x', args: [], framing: 'content-length' });
    await expect(strict.open()).rejects.toMatchObject({ code: 'SY-SRV-004' });

    // `auto` cannot know at open() time, so it must fail on the first frame
    // that reveals header framing rather than mis-framing the session.
    const auto = createStdioTransport({ runtime: lineOnly, command: 'x', args: [], framing: 'auto' });
    const frames = await auto.open();
    await expect(collect(frames)).rejects.toBeInstanceOf(StdioTransportError);
  });

  it('round-trips a content-length frame through a real child process', async () => {
    const runtime = nodeRuntime();
    // `cat` echoes exactly what we write, so the encoder and decoder must
    // agree byte for byte.
    const transport = createStdioTransport({ runtime, command: 'cat', args: [] });
    const frames = await transport.open();
    const iterator = frames[Symbol.asyncIterator]();
    transport.send({ jsonrpc: '2.0', id: 3, method: 'tools/list' });
    const first = await iterator.next();
    expect(first.done).toBe(false);
    expect(first.value?.json).toEqual({ jsonrpc: '2.0', id: 3, method: 'tools/list' });
    await transport.close();
  });
});
