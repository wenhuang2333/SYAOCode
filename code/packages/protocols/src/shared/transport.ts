/**
 * Duplex transports for the protocol edges.
 *
 * HARD RULE (03 §7.3, purity): this package never imports `node:`. Every
 * transport is built on the injected `@syaocode/core` Runtime:
 *   - stdio  → `Runtime.shell.spawn` (child process stdout/stderr/stdin)
 *   - HTTP   → `Runtime.http.fetch` (Streamable HTTP + SSE)
 *   - tests  → {@link createLoopbackPair}, a pure in-process duplex pair
 *
 * `ProcessHandle.stdin` is optional in the core contract (a child only gets a
 * pipe when the host asks for one with `ShellSpawnOptions.stdin`). A stdio edge
 * therefore requests a pipe by default, accepts an explicitly injected writer
 * as an override, and fails closed with an honest `internal` error instead of
 * silently degrading to a read-only channel.
 */

import { decodeChunkStream } from '@syaocode/core';
import type { HttpClient, Logger, ProcessHandle, Runtime, ShellSpawnOptions } from '@syaocode/core';
import { CanonicalError } from '@syaocode/rpc';
import type { Framing } from './jsonrpc.js';

/** How long a stdio frame may be before we treat the peer as broken. */
export const MAX_FRAME_CHARS = 8 * 1024 * 1024;

export interface DuplexChannel {
  /** Write one chunk (a framed or unframed JSON-RPC message). */
  send(chunk: string): Promise<void>;
  /** Raw chunks from the peer until EOF; the channel ends when the peer closes. */
  receive(): AsyncIterable<string>;
  /** Close the channel; `reason` is for logs and close observers only. */
  close(reason?: string): Promise<void>;
  readonly closed: boolean;
  /** Framing the connection should use when writing (transport hint). */
  readonly framing?: Framing;
  /** Observe channel closure (peer EOF or explicit close). */
  onClose(handler: (reason?: string) => void): () => void;
  /** Human-readable transport description for logs/receipts. Never secrets. */
  describe(): string;
}

// ── in-process loopback (tests, embedding, `syao call --in-process`) ──────

class QueueChannel implements DuplexChannel {
  private queue: string[] = [];
  private waiter: ((result: IteratorResult<string>) => void) | undefined;
  private closedFlag = false;
  private readonly closeHandlers: ((reason?: string) => void)[] = [];
  private peer: QueueChannel | undefined;

  constructor(private readonly label: string) {}

  link(peer: QueueChannel): void {
    this.peer = peer;
  }

  get closed(): boolean {
    return this.closedFlag;
  }

  describe(): string {
    return `loopback:${this.label}`;
  }

  async send(chunk: string): Promise<void> {
    if (this.closedFlag) throw new Error(`channel ${this.label} is closed`);
    if (chunk.length > MAX_FRAME_CHARS) throw new Error(`frame too large on ${this.label}`);
    const target = this.peer;
    if (target === undefined) throw new Error(`channel ${this.label} has no peer`);
    target.deliver(chunk);
  }

  receive(): AsyncIterable<string> {
    return {
      [Symbol.asyncIterator]: (): AsyncIterator<string> => ({
        next: (): Promise<IteratorResult<string>> => this.nextChunk(),
        return: async (): Promise<IteratorResult<string>> => ({ value: undefined as never, done: true }),
      }),
    };
  }

  onClose(handler: (reason?: string) => void): () => void {
    this.closeHandlers.push(handler);
    return () => {
      const i = this.closeHandlers.indexOf(handler);
      if (i >= 0) this.closeHandlers.splice(i, 1);
    };
  }

  async close(reason = 'closed'): Promise<void> {
    if (this.closedFlag) return;
    this.closedFlag = true;
    const waiter = this.waiter;
    this.waiter = undefined;
    waiter?.({ value: undefined as never, done: true });
    for (const handler of [...this.closeHandlers]) handler(reason);
  }

  private deliver(chunk: string): void {
    if (this.closedFlag) return;
    const waiter = this.waiter;
    if (waiter !== undefined) {
      this.waiter = undefined;
      waiter({ value: chunk, done: false });
      return;
    }
    this.queue.push(chunk);
  }

  private nextChunk(): Promise<IteratorResult<string>> {
    const head = this.queue.shift();
    if (head !== undefined) return Promise.resolve({ value: head, done: false });
    if (this.closedFlag) return Promise.resolve({ value: undefined as never, done: true });
    return new Promise<IteratorResult<string>>((resolve) => {
      this.waiter = resolve;
    });
  }
}

export interface LoopbackPair {
  a: DuplexChannel;
  b: DuplexChannel;
  /** Close both ends (idempotent). */
  close(reason?: string): Promise<void>;
}

/**
 * In-process duplex pair: `a.send()` is observed by `b.receive()` and vice
 * versa. Used by the contract suites to wire a client and a server — or a
 * client and a fake peer — without a subprocess or a socket.
 */
export function createLoopbackPair(opts?: { framing?: Framing; labels?: [string, string] }): LoopbackPair {
  const left = new QueueChannel(opts?.labels?.[0] ?? 'a');
  const right = new QueueChannel(opts?.labels?.[1] ?? 'b');
  left.link(right);
  right.link(left);
  // The loopback is newline-delimited JSON unless the caller says otherwise.
  const framing = opts?.framing ?? 'json-lines';
  const wrap = (channel: QueueChannel): DuplexChannel =>
    framing === undefined
      ? channel
      : {
          send: (chunk) => channel.send(chunk),
          receive: () => channel.receive(),
          close: () => channel.close(),
          get closed() {
            return channel.closed;
          },
          framing,
          onClose: (h) => channel.onClose(h),
          describe: () => channel.describe(),
        };
  return {
    a: wrap(left),
    b: wrap(right),
    close: async (reason = 'closed') => {
      await left.close(reason);
      await right.close(reason);
    },
  };
}

// ── stdio (Runtime.shell) ─────────────────────────────────────────────────

/**
 * Stdin writer contract, derived structurally from core's optional
 * `ProcessHandle.stdin` (`write` + `end`).
 *
 * Derived rather than imported so it can never drift from the core contract —
 * and because core's `ProcessStdin` is not (yet) re-exported from
 * `@syaocode/core`'s public index.
 */
export type StdinWriter = NonNullable<ProcessHandle['stdin']>;

/** Read a stdin writer off a host-provided process handle, when it has one. */
export function stdinOf(handle: unknown): StdinWriter | undefined {
  const candidate = (handle as { stdin?: { write?: unknown; end?: unknown } } | null)?.stdin;
  if (candidate !== undefined && typeof candidate.write === 'function' && typeof candidate.end === 'function') {
    return candidate as StdinWriter;
  }
  return undefined;
}

export interface StdioChannelOptions extends ShellSpawnOptions {
  /**
   * Explicit stdin writer; wins over the handle's own pipe. Named
   * `providedStdin` because `ShellSpawnOptions.stdin` is the boolean
   * "open a pipe" flag.
   */
  providedStdin?: StdinWriter;
  onStderr?: (chunk: string) => void;
  logger?: Logger;
}

export interface StdioChannel {
  channel: DuplexChannel;
  handle: ProcessHandle;
}

/**
 * Spawn a stdio peer through `Runtime.shell` and expose it as a duplex channel.
 * Throws `internal` when the handle exposes no stdin writer and none was
 * injected: a read-only edge must fail loudly, not half-work.
 */
export function createStdioChannel(runtime: Runtime, command: string, args: string[], opts?: StdioChannelOptions): StdioChannel {
  const spawnOpts: ShellSpawnOptions = {};
  // A stdio protocol edge always needs a writable pipe unless the host opts out.
  spawnOpts.stdin = opts?.stdin ?? true;
  if (opts?.cwd !== undefined) spawnOpts.cwd = opts.cwd;
  if (opts?.env !== undefined) spawnOpts.env = opts.env;
  if (opts?.timeoutMs !== undefined) spawnOpts.timeoutMs = opts.timeoutMs;
  if (opts?.signal !== undefined) spawnOpts.signal = opts.signal;
  if (opts?.detached !== undefined) spawnOpts.detached = opts.detached;

  const handle = runtime.shell.spawn(command, args, spawnOpts);
  const stdin = opts?.providedStdin ?? stdinOf(handle);
  // `ProcessHandle.stdout` is a LINE iterator: it strips the newlines, so a
  // `Content-Length: N\r\n\r\n<body>` frame can never be reassembled from it.
  // Prefer the raw byte stream whenever the host provides one; the line path
  // stays as the fallback for minimal embedders.
  const stdout = handle.stdoutChunks !== undefined ? decodeChunkStream(handle.stdoutChunks) : handle.stdout;
  const stderr = handle.stderrChunks !== undefined ? decodeChunkStream(handle.stderrChunks) : handle.stderr;
  const closeHandlers: ((reason?: string) => void)[] = [];
  let closed = false;

  void (async () => {
    try {
      for await (const chunk of stderr) opts?.onStderr?.(chunk);
    } catch {
      /* stderr draining must never take the edge down */
    }
  })();

  const channel: DuplexChannel = {
    framing: 'content-length',
    get closed() {
      return closed;
    },
    describe: () => `stdio:${command} ${args.join(' ')}`.trim(),
    send: async (chunk) => {
      if (closed) throw new Error(`stdio channel for ${command} is closed`);
      if (stdin === undefined) {
        throw new CanonicalError({
          kind: 'internal',
          message:
            'Runtime.shell.ProcessHandle exposes no stdin writer; spawn with stdin: true or inject StdioChannelOptions.providedStdin',
          details: { command },
        });
      }
      stdin.write(chunk);
    },
    receive: () => stdout,
    onClose: (handler) => {
      closeHandlers.push(handler);
      return () => {
        const i = closeHandlers.indexOf(handler);
        if (i >= 0) closeHandlers.splice(i, 1);
      };
    },
    close: async (reason = 'closed') => {
      if (closed) return;
      closed = true;
      try {
        stdin?.end();
      } catch {
        /* the child may already be gone */
      }
      try {
        handle.kill('SIGTERM');
      } catch (error) {
        opts?.logger?.log('debug', 'stdio channel kill failed', { error: String(error) });
      }
      for (const handler of [...closeHandlers]) handler(reason);
    },
  };

  void handle.exited.then(() => {
    void channel.close('process-exit');
  });

  return { channel, handle };
}

// ── HTTP / SSE (Runtime.http) ─────────────────────────────────────────────

const decoder = new TextDecoder();

function decodeChunk(bytes: Uint8Array): string {
  return decoder.decode(bytes, { stream: true });
}

/** Split an SSE byte stream into `data:` payloads (comments/ids ignored). */
async function* ssePayloads(body: ReadableStream<Uint8Array>): AsyncIterable<string> {
  const reader = body.getReader();
  let buffer = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += value === undefined ? '' : decodeChunk(value);
      for (;;) {
        const nl = buffer.indexOf('\n');
        if (nl === -1) break;
        const line = buffer.slice(0, nl).replace(/\r$/, '');
        buffer = buffer.slice(nl + 1);
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (payload.length > 0) yield payload;
      }
    }
    buffer += decoder.decode();
    const tail = buffer.trim();
    if (tail.startsWith('data:')) {
      const payload = tail.slice(5).trim();
      if (payload.length > 0) yield payload;
    }
  } finally {
    reader.releaseLock();
  }
}

export interface HttpChannelOptions {
  headers?: Record<string, string>;
  signal?: AbortSignal;
  /** Extra query string appended to the URL (e.g. A2A `A2A-Version`). */
  query?: Record<string, string>;
  label?: string;
  logger?: Logger;
}

/**
 * Streamable HTTP channel (MCP 2026-07-28 §2.1 / A2A JSON-RPC binding).
 *
 * `send()` performs one POST; the response is either a single JSON body or an
 * SSE stream whose `data:` payloads are queued for `receive()`.
 */
export function createHttpChannel(runtime: Runtime, url: string, opts?: HttpChannelOptions): DuplexChannel {
  const queue: string[] = [];
  const waiters: ((result: IteratorResult<string>) => void)[] = [];
  const closeHandlers: ((reason?: string) => void)[] = [];
  let closed = false;
  let pending = 0;

  const deliver = (chunk: string): void => {
    if (closed) return;
    const waiter = waiters.shift();
    if (waiter !== undefined) waiter({ value: `${chunk}\n`, done: false });
    else queue.push(chunk);
  };

  const finish = (): void => {
    if (pending > 0 || queue.length > 0) return;
    void channel.close('http-idle');
  };

  const target = (): string => {
    if (opts?.query === undefined) return url;
    const pairs = Object.entries(opts.query).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`);
    if (pairs.length === 0) return url;
    return `${url}${url.includes('?') ? '&' : '?'}${pairs.join('&')}`;
  };

  const channel: DuplexChannel = {
    framing: 'json-lines',
    get closed() {
      return closed;
    },
    describe: () => opts?.label ?? `http:${url}`,
    send: async (chunk) => {
      if (closed) throw new Error(`http channel ${url} is closed`);
      pending += 1;
      try {
        const init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal } = {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(opts?.headers ?? {}) },
          body: chunk,
        };
        if (opts?.signal !== undefined) init.signal = opts.signal;
        const response = await runtime.http.fetch(target(), init);
        if (response.status >= 400) {
          const text = await response.text();
          throw new CanonicalError({
            kind: 'remote_error',
            message: `HTTP ${response.status} from ${url}`,
            protocolError: { status: response.status, body: text },
          });
        }
        const contentType = response.headers['content-type'] ?? response.headers['Content-Type'] ?? '';
        if (contentType.includes('text/event-stream') && response.body !== undefined) {
          for await (const payload of ssePayloads(response.body)) deliver(payload);
        } else {
          const text = await response.text();
          if (text.trim().length > 0) deliver(text.trim());
        }
      } finally {
        pending -= 1;
        finish();
      }
    },
    receive: () => ({
      [Symbol.asyncIterator]: (): AsyncIterator<string> => ({
        next: (): Promise<IteratorResult<string>> => {
          const head = queue.shift();
          if (head !== undefined) return Promise.resolve({ value: `${head}\n`, done: false });
          if (closed) return Promise.resolve({ value: undefined as never, done: true });
          return new Promise<IteratorResult<string>>((resolve) => {
            waiters.push(resolve);
          });
        },
        return: async (): Promise<IteratorResult<string>> => ({ value: undefined as never, done: true }),
      }),
    }),
    onClose: (handler) => {
      closeHandlers.push(handler);
      return () => {
        const i = closeHandlers.indexOf(handler);
        if (i >= 0) closeHandlers.splice(i, 1);
      };
    },
    close: async (reason = 'closed') => {
      if (closed) return;
      closed = true;
      for (const waiter of waiters.splice(0)) waiter({ value: undefined as never, done: true });
      for (const handler of [...closeHandlers]) handler(reason);
    },
  };

  return channel;
}

export interface SseChannelOptions extends HttpChannelOptions {
  /** HTTP method for the stream; MCP subscriptions use POST, A2A GET. */
  method?: 'GET' | 'POST';
  /** Body for a POST stream (e.g. MCP `subscriptions/listen`). */
  body?: string;
}

/**
 * Server→client stream (A2A `SubscribeToTask`, MCP `subscriptions/listen`).
 * Yields SSE `data:` payloads until the stream ends or the signal aborts.
 */
export function createSseChannel(runtime: Runtime, url: string, opts?: SseChannelOptions): DuplexChannel {
  const queue: string[] = [];
  const waiters: ((result: IteratorResult<string>) => void)[] = [];
  const closeHandlers: ((reason?: string) => void)[] = [];
  let closed = false;
  let pump: Promise<void> | undefined;

  const deliver = (chunk: string): void => {
    if (closed) return;
    const waiter = waiters.shift();
    if (waiter !== undefined) waiter({ value: `${chunk}\n`, done: false });
    else queue.push(chunk);
  };

  const channel: DuplexChannel = {
    framing: 'json-lines',
    get closed() {
      return closed;
    },
    describe: () => opts?.label ?? `sse:${url}`,
    send: async (chunk) => {
      // A stream channel is read-only for the peer side; a POST body is fixed at
      // open time (`opts.body`) because the SSE binding takes no mid-stream write.
      if (!closed && chunk.length > 0) void chunk;
      throw new CanonicalError({
        kind: 'internal',
        message: 'SSE channels are receive-only; use createHttpChannel for request/response',
      });
    },
    receive: () => ({
      [Symbol.asyncIterator]: (): AsyncIterator<string> => ({
        next: (): Promise<IteratorResult<string>> => {
          if (pump === undefined) pump = start();
          const head = queue.shift();
          if (head !== undefined) return Promise.resolve({ value: `${head}\n`, done: false });
          if (closed) return Promise.resolve({ value: undefined as never, done: true });
          return new Promise<IteratorResult<string>>((resolve) => {
            waiters.push(resolve);
          });
        },
        return: async (): Promise<IteratorResult<string>> => ({ value: undefined as never, done: true }),
      }),
    }),
    onClose: (handler) => {
      closeHandlers.push(handler);
      return () => {
        const i = closeHandlers.indexOf(handler);
        if (i >= 0) closeHandlers.splice(i, 1);
      };
    },
    close: async (reason = 'closed') => {
      if (closed) return;
      closed = true;
      for (const waiter of waiters.splice(0)) waiter({ value: undefined as never, done: true });
      for (const handler of [...closeHandlers]) handler(reason);
    },
  };

  async function start(): Promise<void> {
    try {
      const init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal } = {
        method: opts?.method ?? 'GET',
        headers: { accept: 'text/event-stream', ...(opts?.headers ?? {}) },
      };
      if (opts?.body !== undefined) {
        init.body = opts.body;
        init.headers['content-type'] = 'application/json';
      }
      if (opts?.signal !== undefined) init.signal = opts.signal;
      const response = await runtime.http.fetch(url, init);
      if (response.body === undefined) throw new CanonicalError({ kind: 'unsupported_capability', message: 'peer sent no SSE body' });
      for await (const payload of ssePayloads(response.body)) deliver(payload);
    } catch (error) {
      opts?.logger?.log('debug', 'sse stream ended', { url, error: String(error) });
    } finally {
      await channel.close('stream-end');
    }
  }

  return channel;
}

// ── helpers ───────────────────────────────────────────────────────────────

/** A channel over an already-decoded pair of callbacks (embedding scenarios). */
export function createCallbackChannel(handlers: {
  onSend: (chunk: string) => void | Promise<void>;
  describe?: string;
  framing?: Framing;
}): { channel: DuplexChannel; push: (chunk: string) => void; end: () => void } {
  const queue: string[] = [];
  const waiters: ((result: IteratorResult<string>) => void)[] = [];
  const closeHandlers: ((reason?: string) => void)[] = [];
  let closed = false;

  const channel: DuplexChannel = {
    framing: handlers.framing ?? 'json-lines',
    get closed() {
      return closed;
    },
    describe: () => handlers.describe ?? 'callback',
    send: async (chunk) => {
      await handlers.onSend(chunk);
    },
    receive: () => ({
      [Symbol.asyncIterator]: (): AsyncIterator<string> => ({
        next: (): Promise<IteratorResult<string>> => {
          const head = queue.shift();
          if (head !== undefined) return Promise.resolve({ value: head, done: false });
          if (closed) return Promise.resolve({ value: undefined as never, done: true });
          return new Promise<IteratorResult<string>>((resolve) => {
            waiters.push(resolve);
          });
        },
        return: async (): Promise<IteratorResult<string>> => ({ value: undefined as never, done: true }),
      }),
    }),
    onClose: (handler) => {
      closeHandlers.push(handler);
      return () => {
        const i = closeHandlers.indexOf(handler);
        if (i >= 0) closeHandlers.splice(i, 1);
      };
    },
    close: async (reason = 'closed') => {
      if (closed) return;
      closed = true;
      for (const waiter of waiters.splice(0)) waiter({ value: undefined as never, done: true });
      for (const handler of [...closeHandlers]) handler(reason);
    },
  };

  return {
    channel,
    push: (chunk) => {
      const waiter = waiters.shift();
      if (waiter !== undefined) waiter({ value: chunk, done: false });
      else if (!closed) queue.push(chunk);
    },
    end: () => {
      void channel.close('eof');
    },
  };
}

export type { HttpClient };
