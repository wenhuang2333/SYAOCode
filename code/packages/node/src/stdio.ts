import type { ProcessChunkStream, Runtime } from '@syaocode/core';

/**
 * stdio duplex transport (03 §3.5).
 *
 * A protocol edge (MCP/ACP) speaks JSON-RPC over a child's stdin/stdout.
 * MCP's stdio transport frames each message as
 * `Content-Length: N\r\n\r\n<body>`; a newline-delimited stream cannot carry
 * that framing, so this helper reads the child's **raw byte chunks**
 * (`ProcessHandle.stdoutChunks`) rather than its line-split `stdout`.
 *
 * Fail closed: when the host provides no raw stream and the peer needs
 * header framing, `open()` rejects with `SY-SRV-004`. It never silently
 * degrades to a mis-framed channel.
 */

/** Wire framing used by a stdio peer. */
export type StdioFraming = 'auto' | 'content-length' | 'json-lines';

export interface StdioFrame {
  /** One decoded JSON-RPC frame. */
  json: unknown;
  /** The raw body text the frame came from. */
  raw: string;
  /** Framing that produced this frame. */
  framing: 'content-length' | 'json-lines';
}

export interface StdioTransportOptions {
  runtime: Runtime;
  /** Child executable (e.g. `npx`, `node`). */
  command: string;
  args: string[];
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  signal?: AbortSignal;
  /**
   * Framing for both directions. Defaults to `'content-length'` because that
   * is what MCP and ACP stdio peers speak; `'json-lines'` is the
   * newline-delimited fallback and `'auto'` sniffs the inbound stream.
   */
  framing?: StdioFraming;
}

export interface StdioTransport {
  /** Start the child and return a frame reader. */
  open(): Promise<AsyncIterable<StdioFrame>>;
  /** Send one frame using the configured framing. */
  send(payload: unknown): void;
  /** Close stdin and wait for the child to exit. */
  close(): Promise<number>;
  /** Exit code of the child (resolves when it exits). */
  readonly exited: Promise<number>;
}

export function createStdioTransport(opts: StdioTransportOptions): StdioTransport {
  const framing: StdioFraming = opts.framing ?? 'content-length';
  let write: ((data: string) => void) | undefined;
  let end: (() => void) | undefined;
  let exited: Promise<number> = Promise.resolve(0);

  const transport: StdioTransport = {
    async open(): Promise<AsyncIterable<StdioFrame>> {
      const handle = opts.runtime.shell.spawn(opts.command, opts.args, {
        ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
        ...(opts.env !== undefined ? { env: opts.env } : {}),
        ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
        ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
        stdin: true,
      });
      exited = handle.exited;
      if (handle.stdin === undefined) {
        throw new StdioTransportError(
          'SY-SRV-004',
          `Child '${opts.command}' was spawned without a stdin pipe; the stdio channel is unavailable.`,
        );
      }
      write = handle.stdin.write;
      end = handle.stdin.end;

      if (handle.stdoutChunks !== undefined) {
        return decodeJsonRpcFrames(handle.stdoutChunks, framing);
      }
      // Line iteration eats the newlines, so header/body framing is
      // impossible on this path.
      if (framing === 'content-length') {
        throw new StdioTransportError(
          'SY-SRV-004',
          `Child '${opts.command}' exposes no ProcessHandle.stdoutChunks, so 'content-length' framing cannot be honoured. ` +
            'Use a host runtime that provides raw chunk streams (e.g. @syaocode/node nodeRuntime()).',
        );
      }
      if (framing === 'json-lines') return lineFrames(handle.stdout);
      return guardedLineFrames(handle.stdout);
    },
    send(payload: unknown): void {
      if (write === undefined) {
        throw new StdioTransportError('SY-SRV-004', 'The stdio channel is not open; cannot send a frame.');
      }
      write(encodeFrame(payload, framing === 'json-lines' ? 'json-lines' : 'content-length'));
    },
    async close(): Promise<number> {
      end?.();
      return exited;
    },
    get exited(): Promise<number> {
      return exited;
    },
  };
  return transport;
}

/** Serialize one JSON-RPC payload with the given framing. */
export function encodeFrame(payload: unknown, framing: 'content-length' | 'json-lines'): string {
  const body = JSON.stringify(payload);
  if (framing === 'json-lines') return `${body}\n`;
  return `Content-Length: ${Buffer.byteLength(body, 'utf8')}\r\n\r\n${body}`;
}

/**
 * Decode JSON-RPC frames from raw byte chunks.
 *
 * Exported so a protocol edge can reuse the byte-accurate decoder instead of
 * re-implementing it against a line stream. `Content-Length` counts **bytes**,
 * so the buffer stays binary and the body is sliced by length, never by
 * character count — a pretty-printed body (real newlines) or a multi-byte
 * UTF-8 body both round-trip exactly.
 */
export async function* decodeJsonRpcFrames(
  chunks: ProcessChunkStream,
  framing: StdioFraming = 'auto',
): AsyncGenerator<StdioFrame> {
  let buffer = Buffer.alloc(0);
  let mode: 'content-length' | 'json-lines' | undefined = framing === 'auto' ? undefined : framing;

  for await (const chunk of chunks) {
    buffer = buffer.length === 0 ? Buffer.from(chunk) : Buffer.concat([buffer, chunk]);
    for (;;) {
      if (mode === undefined) {
        mode = sniffFraming(buffer);
        if (mode === undefined) break; // not enough bytes to decide yet
      }
      if (mode === 'json-lines') {
        const nl = buffer.indexOf(0x0a);
        if (nl < 0) break;
        const line = buffer.subarray(0, nl);
        buffer = buffer.subarray(nl + 1);
        const frame = decodeBody(line, 'json-lines');
        if (frame !== undefined) yield frame;
        continue;
      }
      const headerEnd = findHeaderEnd(buffer);
      if (headerEnd === undefined) break; // headers still incomplete
      const headerText = buffer.subarray(0, headerEnd).toString('ascii');
      const match = /content-length\s*:\s*(\d+)/i.exec(headerText);
      if (match === null) {
        // A header block without Content-Length is not a frame we understand;
        // consume up to the next newline so a mislabelled peer cannot stall us.
        const nl = buffer.indexOf(0x0a);
        if (nl < 0) {
          buffer = Buffer.alloc(0);
          break;
        }
        const line = buffer.subarray(0, nl);
        buffer = buffer.subarray(nl + 1);
        const frame = decodeBody(line, 'json-lines');
        if (frame !== undefined) yield frame;
        continue;
      }
      const length = Number(match[1]);
      if (!Number.isSafeInteger(length) || length < 0) {
        const nl = buffer.indexOf(0x0a);
        if (nl < 0) {
          buffer = Buffer.alloc(0);
          break;
        }
        buffer = buffer.subarray(nl + 1);
        continue;
      }
      if (buffer.length < headerEnd + length) break; // body still incomplete
      const body = buffer.subarray(headerEnd, headerEnd + length);
      buffer = buffer.subarray(headerEnd + length);
      const frame = decodeBody(body, 'content-length');
      if (frame !== undefined) yield frame;
    }
  }

  // A peer may close without a trailing newline.
  if (mode !== 'content-length') {
    const frame = decodeBody(buffer, mode ?? 'json-lines');
    if (frame !== undefined) yield frame;
  }
}

/** `\r\n\r\n` (MCP/LSP) or a bare `\n\n`, whichever comes first. */
function findHeaderEnd(buf: Buffer): number | undefined {
  const crlf = buf.indexOf('\r\n\r\n');
  const lf = buf.indexOf('\n\n');
  if (crlf >= 0 && (lf < 0 || crlf < lf)) return crlf + 4;
  if (lf >= 0) return lf + 2;
  return undefined;
}

/** Decide the inbound framing; undefined means "need more bytes". */
function sniffFraming(buf: Buffer): 'content-length' | 'json-lines' | undefined {
  const text = buf.subarray(0, 32).toString('latin1').replace(/^[\s\r\n]+/, '').toLowerCase();
  if (text === '') return undefined;
  const target = 'content-length';
  if (target.startsWith(text) && text.length < target.length) return undefined;
  return text.startsWith(target) ? 'content-length' : 'json-lines';
}

function decodeBody(body: Buffer, framing: 'content-length' | 'json-lines'): StdioFrame | undefined {
  const raw = body.toString('utf8').replace(/\r$/, '');
  const trimmed = raw.trim();
  if (trimmed === '') return undefined;
  let json: unknown;
  try {
    json = JSON.parse(trimmed);
  } catch {
    json = undefined;
  }
  return { json, raw: framing === 'json-lines' ? trimmed : raw, framing };
}

/** Newline-delimited frames from an already line-split stream. */
function lineFrames(stream: AsyncIterable<string>): AsyncIterable<StdioFrame> {
  return (async function* () {
    for await (const line of stream) {
      const trimmed = line.trim();
      if (trimmed === '') continue;
      const frame = decodeBody(Buffer.from(trimmed, 'utf8'), 'json-lines');
      if (frame !== undefined) yield frame;
    }
  })();
}

/**
 * `auto` framing on a line-split stream: newline frames are fine, but the
 * moment a `Content-Length` header appears we know the host gave us a lossy
 * stream, so fail closed instead of mis-framing the rest of the session.
 */
function guardedLineFrames(stream: AsyncIterable<string>): AsyncIterable<StdioFrame> {
  return (async function* () {
    for await (const line of stream) {
      if (/^\s*content-length\s*:/i.test(line)) {
        throw new StdioTransportError(
          'SY-SRV-004',
          "The peer uses 'content-length' framing but ProcessHandle.stdoutChunks is absent; " +
            'the line-split stdout cannot preserve header/body framing.',
        );
      }
      const trimmed = line.trim();
      if (trimmed === '') continue;
      const frame = decodeBody(Buffer.from(trimmed, 'utf8'), 'json-lines');
      if (frame !== undefined) yield frame;
    }
  })();
}

/** Error raised by the transport; carries a registered SY- code. */
export class StdioTransportError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'StdioTransportError';
    this.code = code;
  }
}
