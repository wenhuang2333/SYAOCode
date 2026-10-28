import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Runtime } from '@syaocode/core';

/**
 * Minimal HTTP server + SSE helper (03 §3.5).
 *
 * The Agent RPC fabric needs an HTTP edge (native JSON-RPC binding, MCP
 * streamable HTTP, SSE event streams) but not a web framework. This is a
 * deliberately small, dependency-free surface:
 *
 *   POST /rpc   → JSON request/response
 *   GET  /events→ text/event-stream
 *
 * Safety default: bind to loopback. A remote listen address requires an
 * explicit `host` plus a bearer token, mirroring BR-041.
 */

export interface HttpRequestLike {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: string;
}

export interface HttpResponseLike {
  status?: number;
  headers?: Record<string, string>;
  body?: string;
}

export interface SseChannel {
  /** Send one `data:` frame; `event`/`id` are optional SSE fields. */
  send(payload: unknown, opts?: { event?: string; id?: string }): void;
  /** SSE comment line (`: keep-alive`), useful as a heartbeat. */
  comment(text: string): void;
  close(): void;
}

export interface HttpServerOptions {
  runtime: Runtime;
  host?: string;
  port?: number;
  /** Bearer token; when set, every request must present it. */
  token?: string;
  handler: (req: HttpRequestLike) => Promise<HttpResponseLike> | HttpResponseLike;
  /** Called for `GET <ssePath>`; the channel stays open until closed. */
  onSse?: (channel: SseChannel, req: HttpRequestLike) => void | Promise<void>;
  ssePath?: string;
  maxBodyBytes?: number;
}

export interface HttpServerHandle {
  readonly port: number;
  readonly host: string;
  readonly url: string;
  listen(): Promise<void>;
  close(): Promise<void>;
}

export function createHttpServer(opts: HttpServerOptions): HttpServerHandle {
  const host = opts.host ?? '127.0.0.1';
  const ssePath = opts.ssePath ?? '/events';
  const maxBody = opts.maxBodyBytes ?? 8 * 1024 * 1024;
  const channels = new Set<SseChannel>();
  let server: Server | undefined;
  let port = opts.port ?? 0;

  const readBody = async (req: IncomingMessage): Promise<string> => {
    let size = 0;
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      const buf = chunk as Buffer;
      size += buf.length;
      if (size > maxBody) throw new Error('request body too large');
      chunks.push(buf);
    }
    return Buffer.concat(chunks).toString('utf8');
  };

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const method = req.method ?? 'GET';
    const path = (req.url ?? '/').split('?')[0] ?? '/';
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (typeof v === 'string') headers[k] = v;
      else if (Array.isArray(v)) headers[k] = v.join(', ');
    }
    if (opts.token !== undefined && headers.authorization !== `Bearer ${opts.token}`) {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'unauthorized', code: 'SY-SRV-001' }));
      return;
    }
    if (method === 'GET' && path === ssePath && opts.onSse !== undefined) {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      const channel = sseChannel(res);
      channels.add(channel);
      res.on('close', () => channels.delete(channel));
      await opts.onSse(channel, { method, path, headers, body: '' });
      return;
    }
    let body = '';
    try {
      body = await readBody(req);
    } catch {
      res.writeHead(413, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'payload too large', code: 'SY-SRV-004' }));
      return;
    }
    const result = await opts.handler({ method, path, headers, body });
    res.writeHead(result.status ?? 200, { 'content-type': 'application/json', ...(result.headers ?? {}) });
    res.end(result.body ?? '');
  };

  return {
    get port(): number {
      return port;
    },
    get host(): string {
      return host;
    },
    get url(): string {
      return `http://${host}:${port}`;
    },
    async listen(): Promise<void> {
      server = createServer((req, res) => {
        void handle(req, res).catch((e: unknown) => {
          opts.runtime.logger.log('error', 'http server handler failed', {
            error: e instanceof Error ? e.message : String(e),
          });
          if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'internal', code: 'SY-INT-001' }));
        });
      });
      await new Promise<void>((resolve, reject) => {
        server?.once('error', reject);
        server?.listen(port, host, () => resolve());
      });
      const address = server.address();
      if (address !== null && typeof address === 'object') port = address.port;
    },
    async close(): Promise<void> {
      for (const c of channels) c.close();
      channels.clear();
      if (server === undefined) return;
      await new Promise<void>((resolve) => server?.close(() => resolve()));
      server = undefined;
    },
  };
}

/** Wrap a raw response as an SSE channel. */
export function sseChannel(res: ServerResponse): SseChannel {
  let open = true;
  return {
    send(payload: unknown, opts?: { event?: string; id?: string }): void {
      if (!open) return;
      let frame = '';
      if (opts?.event !== undefined) frame += `event: ${opts.event}\n`;
      if (opts?.id !== undefined) frame += `id: ${opts.id}\n`;
      frame += `data: ${typeof payload === 'string' ? payload : JSON.stringify(payload)}\n\n`;
      res.write(frame);
    },
    comment(text: string): void {
      if (!open) return;
      res.write(`: ${text}\n\n`);
    },
    close(): void {
      if (!open) return;
      open = false;
      res.end();
    },
  };
}
