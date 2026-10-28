/**
 * Scriptable JSON-RPC peer for the adapter contract suites.
 *
 * It stands in for the *remote* side of an edge (an MCP server, an A2A agent, an
 * ACP editor). Handlers are per wire method; the peer records how many times each
 * method was invoked — that counter is how the contract suite proves that a
 * denied invocation never reached the peer.
 */

import { JsonRpcConnection, type JsonRpcHandlerResult } from '../../src/shared/jsonrpc.js';
import type { DuplexChannel } from '../../src/shared/transport.js';

export type FakePeerHandler = (params: unknown) => Promise<unknown> | unknown;

export interface FakePeerNotification {
  method: string;
  params?: unknown;
}

export class FakePeer {
  readonly connection: JsonRpcConnection;
  private readonly handlers = new Map<string, FakePeerHandler>();
  private readonly counts = new Map<string, number>();
  private readonly notes: FakePeerNotification[] = [];
  private dropped = new Set<string>();
  private delayMs = 0;
  private closeHandlers: (() => void)[] = [];

  constructor(channel: DuplexChannel) {
    this.connection = new JsonRpcConnection({
      channel,
      framing: 'auto',
      handlers: {
        request: (method, params) => this.dispatch(method, params),
        notification: (method, params) => {
          this.notes.push({ method, ...(params !== undefined ? { params } : {}) });
        },
      },
    });
    this.connection.start();
    this.connection.onClose(() => {
      for (const handler of this.closeHandlers.splice(0)) handler();
    });
  }

  on(method: string, handler: FakePeerHandler): this {
    this.handlers.set(method, handler);
    return this;
  }

  /** Stop answering `method` (the caller will time out). */
  drop(method: string): this {
    this.dropped.add(method);
    return this;
  }

  /** Resume answering a dropped method. */
  resume(method: string): this {
    this.dropped.delete(method);
    return this;
  }

  setDelay(ms: number): this {
    this.delayMs = ms;
    return this;
  }

  onClose(handler: () => void): void {
    this.closeHandlers.push(handler);
  }

  calls(method?: string): number {
    if (method === undefined) {
      let total = 0;
      for (const count of this.counts.values()) total += count;
      return total;
    }
    return this.counts.get(method) ?? 0;
  }

  methods(): Record<string, number> {
    return Object.fromEntries(this.counts.entries());
  }

  notifications(): FakePeerNotification[] {
    return [...this.notes];
  }

  async send(method: string, params?: unknown): Promise<unknown> {
    return this.connection.request(method, params);
  }

  async notify(method: string, params?: unknown): Promise<void> {
    await this.connection.notify(method, params);
  }

  async close(): Promise<void> {
    await this.connection.close('peer-close');
  }

  private async dispatch(method: string, params: unknown): Promise<JsonRpcHandlerResult> {
    this.counts.set(method, (this.counts.get(method) ?? 0) + 1);
    if (this.delayMs > 0) await new Promise<void>((resolve) => setTimeout(resolve, this.delayMs));
    if (this.dropped.has(method)) {
      // Never settles: the caller must time out (and must not retry).
      return new Promise<never>(() => {
        /* intentionally pending */
      });
    }
    const handler = this.handlers.get(method);
    if (handler === undefined) {
      throw { code: -32601, message: `fake peer has no handler for ${method}` };
    }
    return handler(params);
  }
}

/** Build a peer bound to `channel`. */
export function createFakePeer(channel: DuplexChannel): FakePeer {
  return new FakePeer(channel);
}
