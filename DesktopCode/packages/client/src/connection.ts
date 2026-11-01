/**
 * DHP 连接：WebSocket 生命周期、握手、请求/响应、通知分发、断线重连。
 *
 * 重连策略（`00-基线` §6.3）：
 *  - 指数退避 + 抖动（**必须有抖动**：否则 Host 重启时所有窗口同时重连）
 *  - 重连成功后**重新握手**并**重新订阅**（携水位），由服务端裁决补洞或回快照
 *  - 重连期间不重放写命令（幂等窗口在服务端，客户端不重复发）
 *
 * 这个模块不依赖 DOM 也不依赖 Node：`WebSocket` 由调用方注入。
 */

import {
  DHP_CAPABILITIES,
  DHP_VERSION,
  Method,
  Notification,
  decodeFrame,
  encodeFrame,
  type DhpCapability,
  type HelloAckResult,
  type PendingInteraction,
  type SessionChangedNotification,
  type SessionDelta,
  type SessionSnapshot,
} from '@syaocode/dhp';

/** 最小 WebSocket 接口（DOM 与 `ws` 都满足）。 */
export interface WebSocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener?(type: string, listener: (ev: unknown) => void): void;
  removeEventListener?(type: string, listener: (ev: unknown) => void): void;
  // `ws` 包用的是 on/off
  on?(type: string, listener: (...args: unknown[]) => void): void;
  off?(type: string, listener: (...args: unknown[]) => void): void;
  onopen?: ((ev: unknown) => void) | null;
  onmessage?: ((ev: unknown) => void) | null;
  onclose?: ((ev: unknown) => void) | null;
  onerror?: ((ev: unknown) => void) | null;
}

export type SocketFactory = (url: string, token: string) => WebSocketLike;

export type ConnectionState = 'idle' | 'connecting' | 'handshaking' | 'ready' | 'reconnecting' | 'closed';

export interface DhpConnectionOptions {
  readonly url: string;
  readonly token: string;
  readonly socketFactory: SocketFactory;
  readonly clientName?: string;
  readonly clientVersion?: string;
  readonly capabilities?: readonly DhpCapability[];
  readonly onStateChange?: (state: ConnectionState) => void;
  readonly onDelta?: (sessionId: string, delta: SessionDelta) => void;
  readonly onSnapshot?: (sessionId: string, snapshot: SessionSnapshot) => void;
  readonly onInteraction?: (interaction: PendingInteraction) => void;
  readonly onSessionChanged?: (change: SessionChangedNotification) => void;
  readonly onError?: (err: Error) => void;
  /** 重连成功后的钩子（用于重新订阅）。 */
  readonly onReconnected?: (ack: HelloAckResult) => void;
  /** 最大退避（毫秒）。 */
  readonly maxBackoffMs?: number;
  /** 是否自动重连。 */
  readonly autoReconnect?: boolean;
}

interface PendingRequest {
  readonly resolve: (v: unknown) => void;
  readonly reject: (e: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

export class DhpRequestError extends Error {
  constructor(
    message: string,
    readonly code: number,
    readonly kind: string | undefined,
    readonly syaoCode: string | undefined,
  ) {
    super(message);
    this.name = 'DhpRequestError';
  }
}

export class DhpConnection {
  private socket: WebSocketLike | undefined;
  private state: ConnectionState = 'idle';
  private ack: HelloAckResult | undefined;
  private idSeq = 0;
  private readonly pending = new Map<number, PendingRequest>();
  private attempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private closedByUser = false;

  constructor(private readonly opts: DhpConnectionOptions) {}

  get connectionState(): ConnectionState {
    return this.state;
  }

  get helloAck(): HelloAckResult | undefined {
    return this.ack;
  }

  /** 协商得到的能力位（未握手时为空）。 */
  get capabilities(): readonly DhpCapability[] {
    return this.ack?.capabilities ?? [];
  }

  can(cap: DhpCapability): boolean {
    return this.capabilities.includes(cap);
  }

  async connect(): Promise<HelloAckResult> {
    this.closedByUser = false;
    this.setState('connecting');
    const socket = this.opts.socketFactory(this.opts.url, this.opts.token);
    this.socket = socket;
    this.attach(socket);

    await new Promise<void>((resolve, reject) => {
      const onOpen = (): void => resolve();
      const onErr = (e: unknown): void => reject(e instanceof Error ? e : new Error('socket error'));
      this.onceOpen = onOpen;
      this.onceError = onErr;
      void onErr;
    });

    this.setState('handshaking');
    const ack = (await this.request(Method.Hello, {
      clientName: this.opts.clientName ?? 'syaocode-desktop',
      clientVersion: this.opts.clientVersion ?? '0.1.0',
      dhpVersion: DHP_VERSION,
      capabilities: this.opts.capabilities ?? DHP_CAPABILITIES,
    })) as HelloAckResult;

    this.ack = ack;
    this.attempt = 0;
    this.setState('ready');
    return ack;
  }

  private onceOpen: (() => void) | undefined;
  private onceError: ((e: unknown) => void) | undefined;

  private attach(socket: WebSocketLike): void {
    const onMessage = (raw: unknown): void => this.handleMessage(raw);
    const onClose = (): void => this.handleClose();
    const onOpen = (): void => {
      this.onceOpen?.();
      this.onceOpen = undefined;
    };
    const onErr = (e: unknown): void => {
      this.onceError?.(e);
      this.onceError = undefined;
      this.opts.onError?.(e instanceof Error ? e : new Error('socket error'));
    };

    if (typeof socket.on === 'function') {
      socket.on('open', onOpen);
      socket.on('message', (raw: unknown) => {
        // `ws` 传 Buffer；统一转成 string。
        onMessage(typeof raw === 'string' ? raw : String(raw));
      });
      socket.on('close', onClose);
      socket.on('error', onErr);
    } else {
      socket.addEventListener?.('open', onOpen);
      socket.addEventListener?.('message', (ev: unknown) => {
        const data = (ev as { data?: unknown }).data;
        onMessage(typeof data === 'string' ? data : String(data));
      });
      socket.addEventListener?.('close', onClose);
      socket.addEventListener?.('error', onErr);
    }
  }

  private handleMessage(raw: unknown): void {
    if (typeof raw !== 'string') return;
    const decoded = decodeFrame(raw);
    if (!decoded.ok) {
      this.opts.onError?.(new Error(`bad frame: ${decoded.message}`));
      return;
    }
    const frame = decoded.frame;

    // 响应
    if (!('method' in frame)) {
      const id = frame.id;
      if (typeof id !== 'number') return;
      const slot = this.pending.get(id);
      if (slot === undefined) return;
      this.pending.delete(id);
      clearTimeout(slot.timer);
      if ('error' in frame) {
        const e = frame.error;
        slot.reject(
          new DhpRequestError(e.message, e.code, e.data?.kind, e.data?.syaoCode),
        );
      } else {
        slot.resolve(frame.result);
      }
      return;
    }

    // 通知
    const params = frame.params;
    switch (frame.method) {
      case Notification.SessionEvent: {
        const p = params as {
          delta?: SessionDelta;
          snapshot?: SessionSnapshot;
          coalesced?: boolean;
        };
        // 快照通知：铁律 1（整体替换）。
        if (p.snapshot !== undefined) {
          this.opts.onSnapshot?.(p.snapshot.meta.sessionId, p.snapshot);
          return;
        }
        if (p.delta !== undefined) {
          this.opts.onDelta?.(p.delta.sessionId, p.delta);
        }
        return;
      }
      case Notification.InteractionRequest: {
        const p = params as { interaction?: PendingInteraction };
        if (p.interaction !== undefined) this.opts.onInteraction?.(p.interaction);
        return;
      }
      case Notification.SessionChanged: {
        this.opts.onSessionChanged?.(params as SessionChangedNotification);
        return;
      }
      default:
        // 未知通知：忽略（前向兼容）。
        return;
    }
  }

  private handleClose(): void {
    this.socket = undefined;
    // 所有在途请求失败（不能假装成功）。
    for (const [id, slot] of this.pending) {
      clearTimeout(slot.timer);
      slot.reject(new DhpRequestError('connection closed', -32603, 'internal', undefined));
      this.pending.delete(id);
    }
    if (this.closedByUser || this.opts.autoReconnect === false) {
      this.setState('closed');
      return;
    }
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    this.setState('reconnecting');
    this.attempt += 1;
    const max = this.opts.maxBackoffMs ?? 10_000;
    const base = Math.min(max, 250 * 2 ** (this.attempt - 1));
    // 抖动：±20%，避免多窗口同时重连把 Host 打满。
    const jitter = base * (0.8 + Math.random() * 0.4);
    this.reconnectTimer = setTimeout(() => {
      void this.connect()
        .then((ack) => this.opts.onReconnected?.(ack))
        .catch(() => this.scheduleReconnect());
    }, jitter);
  }

  /** 发送请求。返回 Promise；失败抛 `DhpRequestError`。 */
  request(method: string, params?: unknown, timeoutMs = 30_000): Promise<unknown> {
    const socket = this.socket;
    if (socket === undefined) {
      return Promise.reject(new DhpRequestError('not connected', -32603, 'internal', undefined));
    }
    this.idSeq += 1;
    const id = this.idSeq;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new DhpRequestError(`timeout: ${method}`, -32017, 'timed_out', undefined));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        socket.send(encodeFrame(params === undefined
          ? { jsonrpc: '2.0', id, method }
          : { jsonrpc: '2.0', id, method, params }));
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  close(): void {
    this.closedByUser = true;
    if (this.reconnectTimer !== undefined) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    this.socket?.close(1000, 'client closing');
    this.socket = undefined;
    this.setState('closed');
  }

  private setState(next: ConnectionState): void {
    if (this.state === next) return;
    this.state = next;
    this.opts.onStateChange?.(next);
  }
}
