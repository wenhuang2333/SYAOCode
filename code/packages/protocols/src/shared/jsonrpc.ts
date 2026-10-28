/**
 * JSON-RPC 2.0 codec, framing and request correlation.
 *
 * All three edges (MCP / A2A / ACP) speak JSON-RPC 2.0, so the codec lives in
 * `shared/` and is transport-agnostic: it only ever touches an injected
 * {@link DuplexChannel}. No `node:` imports, no IO of its own (03 §7.3 purity).
 *
 * Framing (01 §2.1 / §2.3):
 *   - stdio  → `Content-Length: N\r\n\r\n<body>` (LSP-style headers)
 *   - HTTP   → one JSON document per body / SSE `data:` payload
 * `auto` sniffs per message so a single connection can serve both.
 */

import type { IdGenerator, Logger } from '@syaocode/core';
import type { DuplexChannel } from './transport.js';

export type JsonRpcId = string | number;

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: JsonRpcId;
  method: string;
  params?: unknown;
}

export interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: unknown;
}

export interface JsonRpcErrorObject {
  code: number;
  message: string;
  data?: unknown;
}

export interface JsonRpcSuccess {
  jsonrpc: '2.0';
  id: JsonRpcId;
  result: unknown;
}

export interface JsonRpcFailure {
  jsonrpc: '2.0';
  id: JsonRpcId | null;
  error: JsonRpcErrorObject;
}

export type JsonRpcResponse = JsonRpcSuccess | JsonRpcFailure;
export type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcResponse;

/** Standard JSON-RPC 2.0 error codes (protocol-specific codes live per edge). */
export const JSONRPC_ERROR_CODES = {
  parseError: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internalError: -32603,
} as const;

export type Framing = 'auto' | 'content-length' | 'json-lines';

// ── errors ────────────────────────────────────────────────────────────────

/** The peer sent something that is not valid JSON-RPC 2.0. */
export class JsonRpcProtocolError extends Error {
  override readonly name = 'JsonRpcProtocolError';
  readonly code: number;
  readonly data: unknown;

  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.code = code;
    this.data = data;
  }
}

/** The peer answered with a JSON-RPC `error` object; `raw` is preserved. */
export class JsonRpcRemoteError extends Error {
  override readonly name = 'JsonRpcRemoteError';
  readonly code: number;
  readonly data: unknown;
  readonly raw: JsonRpcErrorObject;

  constructor(error: JsonRpcErrorObject) {
    super(error.message);
    this.code = error.code;
    this.data = error.data;
    this.raw = error;
  }
}

/**
 * The request did not complete in time. `sent` records whether the request had
 * already reached the channel — the difference between `timed_out` (never
 * dispatched) and `indeterminate` (dispatched, outcome unknown; I10 / ADR-R6).
 */
export class JsonRpcTimeoutError extends Error {
  override readonly name = 'JsonRpcTimeoutError';
  readonly method: string;
  readonly timeoutMs: number;
  readonly sent: boolean;

  constructor(method: string, timeoutMs: number, sent: boolean) {
    super(`JSON-RPC request timed out after ${timeoutMs}ms: ${method}`);
    this.method = method;
    this.timeoutMs = timeoutMs;
    this.sent = sent;
  }
}

/** The caller aborted the request (deadline signal or explicit cancel). */
export class JsonRpcAbortedError extends Error {
  override readonly name = 'JsonRpcAbortedError';
  readonly method: string;
  readonly sent: boolean;

  constructor(method: string, sent: boolean, message = `JSON-RPC request aborted: ${method}`) {
    super(message);
    this.method = method;
    this.sent = sent;
  }
}

/**
 * Returned by an inbound-request handler that took over the response itself
 * (multi-frame streaming: A2A `SendStreamingMessage`, MCP `subscriptions/listen`).
 * The connection then writes nothing further for that id.
 */
export const NO_RESPONSE: unique symbol = Symbol('jsonrpc.no-response');

export type JsonRpcHandlerResult = unknown | typeof NO_RESPONSE;

/** Coerce any thrown value into a JSON-RPC error object (never loses `data`). */
export function toJsonRpcErrorObject(error: unknown): JsonRpcErrorObject {
  if (error instanceof JsonRpcRemoteError) return error.raw;
  // A thrown `{ code, message }` object is already a JSON-RPC error (adapters
  // use this to answer with protocol-specific codes such as -32021).
  if (error !== null && typeof error === 'object' && !Array.isArray(error)) {
    const candidate = error as { code?: unknown; message?: unknown; data?: unknown };
    if (typeof candidate.code === 'number' && typeof candidate.message === 'string') {
      return candidate.data !== undefined
        ? { code: candidate.code, message: candidate.message, data: candidate.data }
        : { code: candidate.code, message: candidate.message };
    }
  }
  if (error instanceof JsonRpcProtocolError) {
    return error.data !== undefined
      ? { code: error.code, message: error.message, data: error.data }
      : { code: error.code, message: error.message };
  }
  const message = error instanceof Error ? error.message : String(error);
  return { code: JSONRPC_ERROR_CODES.internalError, message };
}

// ── codec ─────────────────────────────────────────────────────────────────

export function isJsonRpcRequest(message: JsonRpcMessage): message is JsonRpcRequest {
  const m = message as { method?: unknown; id?: unknown; result?: unknown; error?: unknown };
  return typeof m.method === 'string' && m.id !== undefined && m.result === undefined && m.error === undefined;
}

export function isJsonRpcNotification(message: JsonRpcMessage): message is JsonRpcNotification {
  const m = message as { method?: unknown; id?: unknown; result?: unknown; error?: unknown };
  return typeof m.method === 'string' && m.id === undefined && m.result === undefined && m.error === undefined;
}

export function isJsonRpcResponse(message: JsonRpcMessage): message is JsonRpcResponse {
  const m = message as { method?: unknown; id?: unknown; result?: unknown; error?: unknown };
  return m.method === undefined && m.id !== undefined && (m.result !== undefined || m.error !== undefined);
}

/** Serialize one message to its JSON body (no framing applied). */
export function encodeMessage(message: JsonRpcMessage): string {
  return JSON.stringify(message);
}

/**
 * Wrap a JSON body in LSP-style `Content-Length` framing (stdio transports).
 *
 * `Content-Length` counts **bytes**, not characters: a body with a multi-byte
 * UTF-8 character (Chinese text, an emoji) is longer in bytes than in JS
 * string length. Framing with `body.length` would make the peer wait for
 * bytes that never arrive — so the byte length is computed here.
 */
export function frameContentLength(body: string): string {
  return `Content-Length: ${byteLength(body)}\r\n\r\n${body}`;
}

/** UTF-8 byte length of a string (no `node:buffer` needed). */
export function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

/** Parse one JSON body into a single message (rejects batches). */
export function decodeMessage(text: string): JsonRpcMessage {
  const parsed: unknown = JSON.parse(text);
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new JsonRpcProtocolError(JSONRPC_ERROR_CODES.invalidRequest, 'JSON-RPC message must be an object');
  }
  const m = parsed as { jsonrpc?: unknown; method?: unknown; id?: unknown };
  if (m.jsonrpc !== '2.0') {
    throw new JsonRpcProtocolError(JSONRPC_ERROR_CODES.invalidRequest, 'jsonrpc must be "2.0"');
  }
  if (m.method !== undefined && typeof m.method !== 'string') {
    throw new JsonRpcProtocolError(JSONRPC_ERROR_CODES.invalidRequest, 'method must be a string');
  }
  return parsed as JsonRpcMessage;
}

/** Parse a JSON body that may be a JSON-RPC 2.0 batch (arrays are flattened). */
export function decodeMessages(text: string): JsonRpcMessage[] {
  const parsed: unknown = JSON.parse(text);
  if (Array.isArray(parsed)) return parsed.map((entry) => decodeMessage(JSON.stringify(entry)));
  return [decodeMessage(text)];
}

// ── incremental framing ───────────────────────────────────────────────────

interface HeaderBlock {
  /** index of the first byte of the body separator */
  end: number;
  /** length of the separator */
  skip: number;
  /** raw header bytes */
  headers: Uint8Array;
}

/** Find `\r\n\r\n` (preferred) or `\n\n` in a byte buffer. */
function findHeaderEnd(buf: Uint8Array): HeaderBlock | undefined {
  let crlf = -1;
  let lf = -1;
  for (let i = 0; i < buf.length - 1; i += 1) {
    if (buf[i] === 0x0a && buf[i + 1] === 0x0a && lf === -1) lf = i;
    if (i < buf.length - 3 && buf[i] === 0x0d && buf[i + 1] === 0x0a && buf[i + 2] === 0x0d && buf[i + 3] === 0x0a && crlf === -1) {
      crlf = i;
    }
  }
  if (crlf === -1 && lf === -1) return undefined;
  if (crlf !== -1 && (lf === -1 || crlf <= lf)) {
    return { end: crlf, skip: 4, headers: buf.slice(0, crlf) };
  }
  return { end: lf, skip: 2, headers: buf.slice(0, lf) };
}

function parseContentLength(headerText: string): number | undefined {
  for (const line of headerText.split(/\r?\n/)) {
    const match = /^content-length\s*:\s*(\d+)\s*$/i.exec(line.trim());
    if (match !== null) {
      const raw = match[1];
      if (raw === undefined) return undefined;
      return Number.parseInt(raw, 10);
    }
  }
  return undefined;
}

function looksLikeHeaders(buf: Uint8Array): boolean {
  // A header line starts with a token followed by `:`; scan the first line.
  const limit = Math.min(buf.length, 64);
  let text = '';
  for (let i = 0; i < limit; i += 1) {
    const byte = buf[i];
    if (byte === undefined) break;
    if (byte === 0x0a) break;
    text += String.fromCharCode(byte);
  }
  return /^[A-Za-z][A-Za-z0-9-]*\s*:/.test(text);
}

function safeDecode(body: string): JsonRpcMessage[] {
  try {
    return decodeMessages(body);
  } catch {
    return [];
  }
}

/**
 * Incremental JSON-RPC framer.
 *
 * The buffer is **bytes**, not characters, because `Content-Length` is a byte
 * count: slicing a JS string by `Content-Length` mis-slices every body that
 * contains a multi-byte UTF-8 character, and the framer then waits forever for
 * bytes that already arrived. Bodies are decoded to text only after they have
 * been sliced out of the byte buffer.
 *
 * Malformed frames are dropped rather than killing the connection; a
 * `Content-Length` mismatch keeps waiting for more bytes (stream semantics).
 */
export class MessageFramer {
  private buf: Uint8Array = new Uint8Array(0);
  private decoder = new TextDecoder();

  constructor(private readonly mode: Framing = 'auto') {}

  /** Feed a text chunk (the byte length is computed from its UTF-8 encoding). */
  push(chunk: string): JsonRpcMessage[] {
    return this.pushBytes(new TextEncoder().encode(chunk));
  }

  /** Feed raw bytes (the byte-exact path used by stdio transports). */
  pushBytes(chunk: Uint8Array): JsonRpcMessage[] {
    if (chunk.length === 0) return [];
    const merged = new Uint8Array(this.buf.length + chunk.length);
    merged.set(this.buf, 0);
    merged.set(chunk, this.buf.length);
    this.buf = merged;
    return this.drain(false);
  }

  /** Call when the channel reached EOF: parse any trailing unframed message. */
  flush(): JsonRpcMessage[] {
    return this.drain(true);
  }

  private drain(final: boolean): JsonRpcMessage[] {
    const out: JsonRpcMessage[] = [];
    for (;;) {
      this.trimLeadingWhitespace();
      if (this.buf.length === 0) break;

      const framed =
        this.mode === 'auto'
          ? looksLikeHeaders(this.buf)
            ? 'headers'
            : 'lines'
          : this.mode === 'content-length'
            ? 'headers'
            : 'lines';

      if (framed === 'headers') {
        const block = findHeaderEnd(this.buf);
        if (block === undefined) {
          if (final) {
            const leftover = this.buf;
            this.buf = new Uint8Array(0);
            out.push(...safeDecode(this.decoder.decode(leftover)));
          }
          break;
        }
        const length = parseContentLength(this.decoder.decode(block.headers));
        const bodyStart = block.end + block.skip;
        if (length === undefined) {
          // A header block without Content-Length is not a frame; skip it.
          this.buf = this.buf.slice(bodyStart);
          continue;
        }
        // BYTE count: wait for `length` bytes, not `length` characters.
        if (this.buf.length < bodyStart + length) break;
        const body = this.buf.slice(bodyStart, bodyStart + length);
        this.buf = this.buf.slice(bodyStart + length);
        out.push(...safeDecode(this.decoder.decode(body)));
        continue;
      }

      const nl = indexOfByte(this.buf, 0x0a);
      if (nl === -1) {
        if (final) {
          const leftover = this.decoder.decode(this.buf).trim();
          this.buf = new Uint8Array(0);
          if (leftover.length > 0) out.push(...safeDecode(leftover));
        }
        break;
      }
      const line = this.decoder.decode(this.buf.slice(0, nl)).trim();
      this.buf = this.buf.slice(nl + 1);
      if (line.length === 0) continue;
      out.push(...safeDecode(line));
    }
    return out;
  }

  private trimLeadingWhitespace(): void {
    let index = 0;
    while (index < this.buf.length) {
      const byte = this.buf[index];
      if (byte === undefined) break;
      if (byte === 0x20 || byte === 0x09 || byte === 0x0a || byte === 0x0d || byte === 0x00) index += 1;
      else break;
    }
    if (index > 0) this.buf = this.buf.slice(index);
  }
}

function indexOfByte(buf: Uint8Array, byte: number): number {
  for (let i = 0; i < buf.length; i += 1) {
    if (buf[i] === byte) return i;
  }
  return -1;
}

// ── correlation / dispatch ────────────────────────────────────────────────

export interface JsonRpcRequestContext {
  id: JsonRpcId;
  raw: JsonRpcRequest;
}

export interface JsonRpcPeerHandlers {
  /** Inbound requests (reverse calls: ACP `fs/*`, `session/request_permission`). */
  request?: (method: string, params: unknown, ctx: JsonRpcRequestContext) => Promise<JsonRpcHandlerResult> | JsonRpcHandlerResult;
  /** Inbound notifications (`session/cancel`, `notifications/cancelled`). */
  notification?: (method: string, params: unknown) => void;
  /**
   * Inbound stream events. A2A streaming is modelled as notifications that
   * carry the originating request id (`{ id, event }`); returning `true` marks
   * the event as consumed by a pending stream.
   */
  streamEvent?: (id: JsonRpcId, event: unknown) => boolean;
}

export interface JsonRpcConnectionOptions {
  channel: DuplexChannel;
  framing?: Framing;
  handlers?: JsonRpcPeerHandlers;
  /** Default per-request timeout; 0 disables. */
  requestTimeoutMs?: number;
  ids?: IdGenerator;
  logger?: Logger;
}

interface PendingEntry {
  method: string;
  sent: boolean;
  settle: (outcome: { ok: true; value: unknown } | { ok: false; error: unknown }) => void;
  timer?: ReturnType<typeof setTimeout>;
  detach?: () => void;
}

/**
 * A bidirectional JSON-RPC endpoint over one {@link DuplexChannel}.
 *
 * Correlation is by request id; notifications are dispatched to `handlers`;
 * inbound requests (peer → us) are answered from `handlers.request`. The class
 * never retries: a timeout is reported to the caller so the governance layer can
 * apply `retryVerdict` (I10: no automatic retry after dispatch).
 */
export class JsonRpcConnection {
  readonly stats = { sent: 0, received: 0, notificationsSent: 0, notificationsReceived: 0 };

  private readonly channel: DuplexChannel;
  private readonly framer: MessageFramer;
  private readonly handlers: JsonRpcPeerHandlers;
  private readonly defaultTimeoutMs: number;
  private readonly ids: IdGenerator | undefined;
  private readonly logger: Logger | undefined;
  private readonly pending = new Map<JsonRpcId, PendingEntry>();
  private readonly closeHandlers: ((reason?: string) => void)[] = [];
  private counter = 0;
  private pumpPromise: Promise<void> | undefined;
  private closedFlag = false;

  constructor(options: JsonRpcConnectionOptions) {
    this.channel = options.channel;
    this.framer = new MessageFramer(options.framing ?? 'auto');
    this.handlers = options.handlers ?? {};
    this.defaultTimeoutMs = options.requestTimeoutMs ?? 30_000;
    this.ids = options.ids;
    this.logger = options.logger;
  }

  get closed(): boolean {
    return this.closedFlag;
  }

  /** Start reading from the channel. Idempotent. */
  start(): void {
    if (this.pumpPromise !== undefined) return;
    this.pumpPromise = this.pump();
  }

  onClose(handler: (reason?: string) => void): () => void {
    this.closeHandlers.push(handler);
    return () => {
      const i = this.closeHandlers.indexOf(handler);
      if (i >= 0) this.closeHandlers.splice(i, 1);
    };
  }

  /** Number of requests still awaiting a response. */
  get pendingCount(): number {
    return this.pending.size;
  }

  async request<T>(
    method: string,
    params?: unknown,
    opts?: { timeoutMs?: number; signal?: AbortSignal; onId?: (id: JsonRpcId) => void },
  ): Promise<T> {
    if (this.closedFlag) {
      throw new JsonRpcProtocolError(JSONRPC_ERROR_CODES.internalError, `connection closed before ${method}`);
    }
    const id = this.allocateId();
    opts?.onId?.(id);
    const entry: PendingEntry = {
      method,
      sent: false,
      settle: () => {
        /* replaced below */
      },
    };
    const promise = new Promise<unknown>((resolve, reject) => {
      entry.settle = (outcome) => {
        if (outcome.ok) resolve(outcome.value);
        else reject(outcome.error);
      };
    });
    this.pending.set(id, entry);

    const timeoutMs = opts?.timeoutMs ?? this.defaultTimeoutMs;
    if (timeoutMs > 0) {
      entry.timer = setTimeout(() => {
        if (!this.pending.delete(id)) return;
        entry.settle({ ok: false, error: new JsonRpcTimeoutError(method, timeoutMs, entry.sent) });
      }, timeoutMs);
    }
    const signal = opts?.signal;
    if (signal !== undefined) {
      const onAbort = (): void => {
        if (!this.pending.delete(id)) return;
        entry.settle({ ok: false, error: new JsonRpcAbortedError(method, entry.sent) });
      };
      if (signal.aborted) onAbort();
      else {
        signal.addEventListener('abort', onAbort, { once: true });
        entry.detach = () => signal.removeEventListener('abort', onAbort);
      }
    }

    const message: JsonRpcRequest = { jsonrpc: '2.0', id, method, ...(params !== undefined ? { params } : {}) };
    try {
      await this.write(message);
      entry.sent = true;
    } catch (error) {
      this.release(id);
      throw error;
    }
    return (await promise) as T;
  }

  async notify(method: string, params?: unknown): Promise<void> {
    const message: JsonRpcNotification = { jsonrpc: '2.0', method, ...(params !== undefined ? { params } : {}) };
    await this.write(message);
  }

  /** Send one stream event correlated to `id` (see `handlers.streamEvent`). */
  async notifyStream(id: JsonRpcId, event: unknown): Promise<void> {
    await this.notify('notifications/stream', { id, event });
  }

  /** Write a response frame directly (used by `NO_RESPONSE` handlers). */
  async respond(id: JsonRpcId, result: unknown): Promise<void> {
    await this.write({ jsonrpc: '2.0', id, result: result ?? null });
  }

  /** Write an error frame directly (used by `NO_RESPONSE` handlers). */
  async respondError(id: JsonRpcId, error: unknown): Promise<void> {
    await this.write({ jsonrpc: '2.0', id, error: toJsonRpcErrorObject(error) });
  }

  async close(reason?: string): Promise<void> {
    if (this.closedFlag) return;
    this.closedFlag = true;
    for (const [id, entry] of [...this.pending.entries()]) {
      this.release(id);
      entry.settle({ ok: false, error: new JsonRpcProtocolError(JSONRPC_ERROR_CODES.internalError, `connection closed: ${reason ?? 'closed'}`) });
    }
    try {
      await this.channel.close();
    } catch {
      /* closing an already broken channel is not an error */
    }
    for (const handler of [...this.closeHandlers]) {
      try {
        handler(reason);
      } catch (error) {
        this.logger?.log('warn', 'jsonrpc close handler threw', { error: String(error) });
      }
    }
  }

  // ── internals ───────────────────────────────────────────────────────────

  private allocateId(): JsonRpcId {
    if (this.ids !== undefined) return this.ids.next('rpc');
    this.counter += 1;
    return this.counter;
  }

  private release(id: JsonRpcId): void {
    const entry = this.pending.get(id);
    if (entry === undefined) return;
    this.pending.delete(id);
    if (entry.timer !== undefined) clearTimeout(entry.timer);
    entry.detach?.();
  }

  private async write(message: JsonRpcMessage): Promise<void> {
    const body = encodeMessage(message);
    // stdio uses `Content-Length` headers; every other binding uses
    // newline-delimited JSON (a lone JSON body is valid with the trailing \n).
    const framed = this.channel.framing === 'content-length' ? frameContentLength(body) : `${body}\n`;
    await this.channel.send(framed);
    if (isJsonRpcRequest(message) || isJsonRpcResponse(message)) this.stats.sent += 1;
    if (isJsonRpcNotification(message)) this.stats.notificationsSent += 1;
  }

  private async pump(): Promise<void> {
    try {
      for await (const chunk of this.channel.receive()) {
        this.stats.received += 1;
        this.ingest(chunk);
      }
      for (const message of this.framer.flush()) this.dispatch(message);
    } catch (error) {
      this.failAll(error);
    } finally {
      if (!this.closedFlag) await this.close('peer-closed');
    }
  }

  private ingest(chunk: string): void {
    for (const message of this.framer.push(chunk)) this.dispatch(message);
  }

  /** Raw-byte ingest (byte-exact path; used by byte-streaming channels). */
  private ingestBytes(chunk: Uint8Array): void {
    for (const message of this.framer.pushBytes(chunk)) this.dispatch(message);
  }

  private dispatch(message: JsonRpcMessage): void {
    if (isJsonRpcResponse(message)) {
      this.settleResponse(message);
      return;
    }
    if (isJsonRpcRequest(message)) {
      void this.handleRequest(message);
      return;
    }
    this.stats.notificationsReceived += 1;
    if (this.handlers.streamEvent !== undefined && this.routeStreamEvent(message.params)) return;
    try {
      this.handlers.notification?.(message.method, message.params);
    } catch (error) {
      this.logger?.log('warn', 'notification handler threw', { method: message.method, error: String(error) });
    }
  }

  /** A stream event is `{ id, event }`; consumed by the matching pending stream. */
  private routeStreamEvent(params: unknown): boolean {
    if (params === null || typeof params !== 'object') return false;
    const record = params as { id?: unknown; event?: unknown };
    const id = record.id;
    if (typeof id !== 'string' && typeof id !== 'number') return false;
    if (!('event' in record)) return false;
    return this.handlers.streamEvent?.(id, record.event) === true;
  }

  private settleResponse(response: JsonRpcResponse): void {
    const id = response.id;
    if (id === null) return;
    const entry = this.pending.get(id);
    if (entry === undefined) return; // late response after timeout: ignored
    this.release(id);
    if ('error' in response) entry.settle({ ok: false, error: new JsonRpcRemoteError(response.error) });
    else entry.settle({ ok: true, value: response.result });
  }

  private async handleRequest(request: JsonRpcRequest): Promise<void> {
    const handler = this.handlers.request;
    if (handler === undefined) {
      await this.write({
        jsonrpc: '2.0',
        id: request.id,
        error: { code: JSONRPC_ERROR_CODES.methodNotFound, message: `method not found: ${request.method}` },
      });
      return;
    }
    try {
      const result = await handler(request.method, request.params, { id: request.id, raw: request });
      if (result === NO_RESPONSE) return; // handler owns the response frames
      await this.write({ jsonrpc: '2.0', id: request.id, result: result ?? null });
    } catch (error) {
      await this.write({ jsonrpc: '2.0', id: request.id, error: toJsonRpcErrorObject(error) });
    }
  }

  private failAll(error: unknown): void {
    for (const [id, entry] of [...this.pending.entries()]) {
      this.release(id);
      entry.settle({ ok: false, error });
    }
  }
}
