/**
 * DHP 服务端（`06` §2–§4、§10–§11）
 *
 * 安全姿态（硬约束，不可放宽）：
 *  - 只绑回环地址；非回环必须显式配置 + 令牌，否则**拒启**（复用 `SY-SRV-002` 语义）
 *  - 令牌在**握手期**校验（`Authorization: Bearer`），不走 query string
 *  - 校验失败直接 401 并断开，**不回**业务错误、**不**泄漏原因
 *  - Origin 必须在允许列表内（打包态是 `syao-app://app`；开发态是 dev server）
 */

import { createServer, type IncomingMessage, type Server } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { WebSocketServer, type WebSocket } from 'ws';
import {
  DHP_CAPABILITIES,
  DHP_SCHEMA_HASH,
  DHP_VERSION,
  Method,
  Notification,
  codeForKind,
  decodeFrame,
  encodeFrame,
  failure,
  isAutoRetryableStatus,
  isDhpErrorCode,
  JsonRpcErrorSchema,
  negotiate,
  success,
  type DhpCapability,
  type JsonRpcFrame,
  type JsonRpcRequest,
} from '@syaocode/dhp';

export interface DhpHandlerContext {
  readonly connectionId: string;
  /** Register one connection cleanup; returned function removes it. */
  onDisconnect(cleanup: () => void): () => void;
  /** 该连接已协商的能力位。处理函数**必须**据此判断是否支持。 */
  readonly capabilities: readonly DhpCapability[];
  /** 向该连接推送通知。 */
  notify(method: string, params: unknown): void;
}

export type DhpHandler = (params: unknown, ctx: DhpHandlerContext) => Promise<unknown>;

/** Host 版本（与 package.json 保持一致；`app/info` 也用它）。 */
export const HOST_VERSION = '0.1.0';

export interface DhpServerOptions {
  readonly host?: string;
  readonly port?: number;
  readonly token?: string;
  /** 允许的 Origin 列表。空数组 = 不校验（仅限回环开发态）。 */
  readonly allowedOrigins?: readonly string[];
  readonly maxSubscriptionsPerConnection?: number;
  readonly logger?: (level: 'info' | 'warn' | 'error', msg: string, meta?: unknown) => void;
  /** 工作区根（`hello-ack` 与 `app/info` 会回报）。默认 `process.cwd()`。 */
  readonly workspaceRoot?: string;
}

export interface DhpServerHandle {
  readonly url: string;
  readonly port: number;
  readonly token: string;
  /** 注册一个方法处理函数。重复注册会被拒绝（防止静默覆盖）。 */
  register(method: string, handler: DhpHandler): void;
  /** 向所有连接广播通知（用于会话列表变化这类全局事件）。 */
  broadcast(method: string, params: unknown): void;
  close(): Promise<void>;
}

export class DhpServerError extends Error {
  constructor(
    message: string,
    readonly code: 'unsafe_bind' | 'already_started' | 'duplicate_method' | 'not_found',
  ) {
    super(message);
    this.name = 'DhpServerError';
  }
}

const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost', '0:0:0:0:0:0:0:1']);

export function isLoopback(host: string): boolean {
  return LOOPBACK.has(host);
}

/** 生成一次性令牌（每次启动都换）。 */
export function newToken(): string {
  return randomBytes(32).toString('hex');
}

/** 常量时间比较，避免时序侧信道。 */
export function tokenMatches(expected: string, presented: string | undefined): boolean {
  if (presented === undefined || presented === '') return false;
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(presented, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

interface Conn {
  readonly ws: WebSocket;
  readonly id: string;
  /** 握手完成前为 false：此时除 `hello` 外一律 `not_ready`。 */
  ready: boolean;
  capabilities: readonly DhpCapability[];
  /** 每连接一份订阅清理函数。 */
  readonly cleanups: Set<() => void>;
  inflight: number;
}

/**
 * 启动 DHP 服务端。
 *
 * `port: 0` 让 OS 分配端口（避免与 CLI 的 `serve` 默认端口冲突）。
 */
export async function startDhpServer(opts: DhpServerOptions = {}): Promise<DhpServerHandle> {
  const host = opts.host ?? '127.0.0.1';
  const token = opts.token ?? newToken();
  const log = opts.logger ?? ((): void => {});
  const maxSubs = opts.maxSubscriptionsPerConnection ?? 8;

  // 硬约束：非回环 + 无令牌 → 拒启。
  if (!isLoopback(host) && token === '') {
    throw new DhpServerError(
      `refusing to bind ${host} without a token (SY-SRV-002: unsafe listen address)`,
      'unsafe_bind',
    );
  }

  const workspaceRootProvider = (): string => opts.workspaceRoot ?? process.cwd();
  const handlers = new Map<string, DhpHandler>();
  const conns = new Set<Conn>();
  let connSeq = 0;
  let closed = false;

  const httpServer: Server = createServer((req, res) => {
    // 只提供两个只读端点；业务一律走 WebSocket。
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, uptime: process.uptime() }));
      return;
    }
    if (req.method === 'GET' && req.url === '/version') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          dhpVersion: DHP_VERSION,
          schemaHash: DHP_SCHEMA_HASH,
          capabilities: DHP_CAPABILITIES,
        }),
      );
      return;
    }
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
  });

  const wss = new WebSocketServer({ noServer: true, maxPayload: 8 * 1024 * 1024 });

  // 握手期鉴权：在 upgrade 阶段就拒掉，不进 WebSocket 层。
  httpServer.on('upgrade', (req: IncomingMessage, socket, head) => {
    const origin = req.headers.origin;
    if (opts.allowedOrigins !== undefined && opts.allowedOrigins.length > 0) {
      if (origin === undefined || !opts.allowedOrigins.includes(origin)) {
        log('warn', 'dhp: origin rejected', { origin });
        socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
        socket.destroy();
        return;
      }
    }

    const auth = req.headers.authorization;
    const presented = typeof auth === 'string' && auth.startsWith('Bearer ') ? auth.slice(7) : undefined;
    if (!tokenMatches(token, presented)) {
      // 不回任何细节：不告诉对方"令牌错"还是"没令牌"。
      log('warn', 'dhp: handshake auth failed');
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
    });
  });

  wss.on('connection', (ws: WebSocket) => {
    connSeq += 1;
    const conn: Conn = {
      ws,
      id: `conn_${connSeq}`,
      ready: false,
      capabilities: [],
      cleanups: new Set(),
      inflight: 0,
    };
    conns.add(conn);
    log('info', 'dhp: connection open', { conn: conn.id });

    ws.on('message', (raw) => {
      void onMessage(conn, raw.toString());
    });

    ws.on('close', () => {
      for (const fn of conn.cleanups) {
        try {
          fn();
        } catch {
          /* 清理失败不阻止断开 */
        }
      }
      conn.cleanups.clear();
      conns.delete(conn);
      log('info', 'dhp: connection closed', { conn: conn.id });
    });

    ws.on('error', (err) => {
      log('error', 'dhp: socket error', { conn: conn.id, message: (err as Error).message });
    });
  });

  async function onMessage(conn: Conn, raw: string): Promise<void> {
    const decoded = decodeFrame(raw);
    if (!decoded.ok) {
      // 解码失败也要回一个带 id=null 的错误帧（JSON-RPC 规范）。
      safeSend(conn, failure(null, decoded.code, decoded.message));
      return;
    }
    const frame = decoded.frame;

    // 客户端发来的响应（服务端反向请求的回包）——本协议 v1 未使用，忽略。
    if (!('method' in frame)) return;

    const request = frame as JsonRpcRequest;

    // `hello` 需要**直接**操作该连接（置 ready、写入协商能力），
    // 走通用派发会拿到一个不知道"是谁在问"的上下文——那是之前版本的真实缺陷。
    if (request.method === Method.Hello) {
      const p = (request.params ?? {}) as {
        clientName?: string;
        clientVersion?: string;
        dhpVersion?: { major: number; minor: number };
        capabilities?: readonly DhpCapability[];
      };
      const verdict = negotiate(
        p.dhpVersion ?? { major: 0, minor: 0 },
        DHP_VERSION,
        p.capabilities,
        DHP_CAPABILITIES,
      );
      if (!verdict.ok) {
        safeSend(
          conn,
          failure(request.id, codeForKind('version_mismatch'), verdict.reason, { kind: 'version_mismatch' }),
        );
        return;
      }
      conn.ready = true;
      conn.capabilities = verdict.capabilities;
      log('info', 'dhp: hello', {
        conn: conn.id,
        client: p.clientName ?? 'unknown',
        capabilities: verdict.capabilities.length,
      });
      safeSend(
        conn,
        success(request.id, {
          hostName: 'syaocode-desktop-host',
          hostVersion: HOST_VERSION,
          dhpVersion: verdict.negotiated,
          capabilities: verdict.capabilities,
          schemaHash: DHP_SCHEMA_HASH,
          workspaceRoot: workspaceRootProvider(),
        }),
      );
      return;
    }

    // 未握手时只允许 hello。
    if (!conn.ready) {
      safeSend(
        conn,
        failure(request.id, codeForKind('not_ready'), 'hello required before any other method', {
          kind: 'not_ready',
        }),
      );
      return;
    }

    const handler = handlers.get(request.method);
    if (handler === undefined) {
      safeSend(
        conn,
        failure(request.id, -32601, `method not found: ${request.method}`, { kind: 'invalid_request' }),
      );
      return;
    }

    conn.inflight += 1;
    try {
      const ctx: DhpHandlerContext = {
        connectionId: conn.id,
        onDisconnect(cleanup) {
          if (conn.ws.readyState !== conn.ws.OPEN) { cleanup(); return () => {}; }
          conn.cleanups.add(cleanup);
          return () => { conn.cleanups.delete(cleanup); };
        },
        capabilities: conn.capabilities,
        notify: (method, params) => safeSend(conn, { jsonrpc: '2.0', method, params } as JsonRpcFrame),
      };
      const result = await handler(request.params, ctx);
      safeSend(conn, success(request.id, result));
    } catch (err) {
      const mapped = mapError(err);
      safeSend(conn, failure(request.id, mapped.code, mapped.message, mapped.data));
    } finally {
      conn.inflight -= 1;
    }
  }

  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(opts.port ?? 0, host, () => {
      httpServer.removeListener('error', reject);
      resolve();
    });
  });

  const addr = httpServer.address();
  const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
  log('info', 'dhp: listening', { host, port });

  return {
    url: `ws://${host}:${port}`,
    port,
    token,
    register(method, handler) {
      if (handlers.has(method) && method !== Method.Hello) {
        throw new DhpServerError(`method already registered: ${method}`, 'duplicate_method');
      }
      handlers.set(method, handler);
    },
    broadcast(method, params) {
      for (const c of conns) {
        safeSend(c, { jsonrpc: '2.0', method, params } as JsonRpcFrame);
      }
    },
    async close() {
      if (closed) return;
      closed = true;
      for (const c of conns) {
        try {
          c.ws.close(1001, 'host shutting down');
        } catch {
          /* ignore */
        }
      }
      conns.clear();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
      void maxSubs;
    },
  };
}

function safeSend(conn: Conn, frame: JsonRpcFrame): void {
  if (conn.ws.readyState !== conn.ws.OPEN) return;
  try {
    conn.ws.send(encodeFrame(frame));
  } catch {
    /* 发送失败由 close 事件处理 */
  }
}

/** 处理器可直接抛出的协议错误。 */
export class DhpProtocolError extends Error {
  readonly kind: Parameters<typeof codeForKind>[0] | 'invalid_request';
  readonly data?: Record<string, unknown>;

  constructor(kind: Parameters<typeof codeForKind>[0] | 'invalid_request', message: string, data?: Record<string, unknown>) {
    super(message);
    this.name = 'DhpProtocolError';
    this.kind = kind;
    if (data !== undefined) this.data = data;
  }
}

/**
 * 错误映射：只有一个入口。
 * **禁止**在业务代码里手写错误码——否则同一个 `SY-PERM-003` 会在两个方法上
 * 给出两个不同的 `kind`（`06` §10.4 的教训）。
 */
export function mapError(err: unknown): {
  readonly code: number;
  readonly message: string;
  readonly data: Record<string, unknown>;
} {
  if (err instanceof DhpProtocolError) {
    return {
      code: err.kind === 'invalid_request' ? -32602 : codeForKind(err.kind),
      message: err.message,
      data: { kind: err.kind, ...(err.data ?? {}) },
    };
  }

  // 内核 `SyaoError`：带 `code` 字段（`SY-<域>-<序号>`）。
  const maybe = err as { code?: unknown; message?: unknown };
  const syaoCode = typeof maybe.code === 'string' && /^SY-[A-Z]+-\d{3}$/.test(maybe.code) ? maybe.code : undefined;
  if (syaoCode !== undefined) {
    const kind = kindForSyaoCode(syaoCode);
    // `invalid_request` / `internal` 走 JSON-RPC 标准码段，不占自定义段。
    if (kind === ('invalid_request' as never)) {
      return {
        code: -32602,
        message: typeof maybe.message === 'string' ? maybe.message : 'invalid request',
        data: { kind: 'invalid_request', syaoCode },
      };
    }
    return {
      code: codeForKind(kind),
      message: typeof maybe.message === 'string' ? maybe.message : 'kernel error',
      data: { kind, syaoCode },
    };
  }

  return {
    code: -32603,
    message: typeof maybe.message === 'string' ? maybe.message : String(err),
    data: { kind: 'internal' },
  };
}

/** 内核错误码 → DHP `kind`（`06` §10.4 的映射表，只保留高频项）。 */
function kindForSyaoCode(code: string): Parameters<typeof codeForKind>[0] {
  if (code.startsWith('SY-PERM-003')) return 'outside_workspace';
  if (code.startsWith('SY-PERM-')) return 'denied';
  if (code.startsWith('SY-PRV-')) return 'remote_error';
  if (code.startsWith('SY-LOOP-003')) return 'cancelled';
  if (code.startsWith('SY-LOOP-002')) return 'budget_exceeded';
  if (code.startsWith('SY-LOOP-')) return 'timed_out';
  if (code.startsWith('SY-TOOL-004')) return 'timed_out';
  // 配置类错误：参数/配置问题 → `invalid_request`（标准码 -32602，不是自定义段）
  if (code.startsWith('SY-CFG-')) return 'invalid_request' as never;
  return 'remote_error';
}

/** 校验错误响应的形状（供测试断言）。 */
export function isWellFormedError(frame: JsonRpcFrame): boolean {
  if ('error' in frame) {
    const parsed = JsonRpcErrorSchema.safeParse(frame.error);
    if (!parsed.success) return false;
    const code = frame.error.code;
    return isDhpErrorCode(code) || code <= -32600;
  }
  return false;
}

export { isAutoRetryableStatus };
