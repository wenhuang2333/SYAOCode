/**
 * 凭据桥（Host 侧）：Host ↔ 主进程 的**私有**通道。
 *
 * 为什么要有这条通道：凭据**不进 DHP**（不进 WebSocket、不进投影、不落状态文件）。
 * 链路是：
 *
 *   渲染层受控输入 → preload 窄桥 → 主进程 → OS 钥匙串
 *                                        ↕（私有 IPC）
 *                                     Host（只在执行 git 前取一次）
 *
 * 本模块只做一件事：把"取/存/删凭据"翻译成主进程 IPC 请求。
 * 它**不**接触 DHP，**不**把凭据写进任何返回值或日志。
 *
 * 独立运行（`liwen host`，没有 Electron 父进程）时通道不存在 →
 * {@link IpcCredentialBridge.available} 返回 false，界面必须提示
 * "本次不持久化"（`27` Q9 的降级策略）。
 */

import type { CredentialBridge, CredentialProvider } from './credentials.ts';

export interface CredentialIpcChannel {
  send(message: Record<string, unknown>): void;
  subscribe(handler: (message: Record<string, unknown>) => void): () => void;
}

export type CredentialIpcOp =
  | 'available'
  | 'get'
  | 'set'
  | 'delete'
  | 'import-ssh'
  | 'generate-ssh'
  | 'materialize-ssh'
  | 'dispose-ssh';

export interface CredentialIpcResponse {
  readonly type: 'cred:response';
  readonly id: string;
  readonly ok: boolean;
  readonly value?: unknown;
  readonly error?: string;
}

/**
 * 用 Node 的父子进程 IPC 构造通道（Host 是主进程的子进程）。
 *
 * 独立运行时 `process.send` 不存在 → 返回 `undefined`。
 */
export function processCredentialChannel(): CredentialIpcChannel | undefined {
  if (typeof process.send !== 'function') return undefined;
  return {
    send(message) {
      process.send?.(message as unknown as Record<string, unknown>);
    },
    subscribe(handler) {
      const listener = (msg: unknown): void => {
        handler((msg ?? {}) as Record<string, unknown>);
      };
      process.on('message', listener);
      return () => {
        process.off('message', listener);
      };
    },
  };
}

export interface IpcCredentialBridgeOptions {
  readonly timeoutMs?: number;
}

/**
 * 通过主进程 IPC 实现的 {@link CredentialBridge}。
 *
 * 失败模式：主进程不可用（钥匙串不可用 / Electron 未启动）→
 *  - `available()` → false
 *  - `get/set/delete` → 抛错，调用方必须降级（不持久化）或拒绝操作
 */
export class IpcCredentialBridge implements CredentialBridge {
  private readonly pending = new Map<string, { resolve(v: unknown): void; reject(e: Error): void; timer: ReturnType<typeof setTimeout> }>();
  private seq = 0;
  private readonly unsubscribe: () => void;

  constructor(private readonly channel: CredentialIpcChannel, private readonly opts: IpcCredentialBridgeOptions = {}) {
    this.unsubscribe = channel.subscribe((message) => {
      if (message['type'] !== 'cred:response') return;
      const response = message as unknown as CredentialIpcResponse;
      const entry = this.pending.get(response.id);
      if (entry === undefined) return;
      this.pending.delete(response.id);
      clearTimeout(entry.timer);
      if (response.ok) entry.resolve(response.value);
      else entry.reject(new Error(response.error ?? 'credential request failed'));
    });
  }

  /** 关闭通道（Host 退出时调用，避免残留监听器）。 */
  close(): void {
    this.unsubscribe();
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(new Error('credential bridge closed'));
    }
    this.pending.clear();
  }

  private request(op: CredentialIpcOp, payload: Record<string, unknown> = {}): Promise<unknown> {
    const id = `cred_${++this.seq}_${Date.now().toString(36)}`;
    const timeoutMs = this.opts.timeoutMs ?? 15_000;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`credential request timed out: ${op}`));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.channel.send({ type: 'cred:request', id, op, ...payload });
      } catch (error) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(new Error(`credential request failed: ${(error as Error).message}`));
      }
    });
  }

  async available(): Promise<boolean> {
    try {
      return (await this.request('available')) === true;
    } catch {
      return false;
    }
  }

  async get(entry: string): Promise<string | undefined> {
    const value = await this.request('get', { entry });
    return typeof value === 'string' ? value : undefined;
  }

  async set(entry: string, value: string): Promise<void> {
    await this.request('set', { entry, value });
  }

  async delete(entry: string): Promise<void> {
    await this.request('delete', { entry });
  }

  async importSshKey(entry: string, privateKey: string, passphrase?: string): Promise<{ fingerprint: string; keyType: string }> {
    const value = await this.request('import-ssh', { entry, privateKey, ...(passphrase !== undefined ? { passphrase } : {}) });
    const result = value as { fingerprint?: unknown; keyType?: unknown } | undefined;
    if (result === undefined || typeof result.fingerprint !== 'string') throw new Error('invalid ssh key response');
    return { fingerprint: result.fingerprint, keyType: typeof result.keyType === 'string' ? result.keyType : 'ed25519' };
  }

  async generateSshKey(entry: string, comment?: string): Promise<{ publicKey: string; fingerprint: string; keyType: 'ed25519' }> {
    const value = await this.request('generate-ssh', { entry, ...(comment !== undefined ? { comment } : {}) });
    const result = value as { publicKey?: unknown; fingerprint?: unknown; keyType?: unknown } | undefined;
    if (result === undefined || typeof result.publicKey !== 'string' || typeof result.fingerprint !== 'string') {
      throw new Error('invalid ssh key response');
    }
    return { publicKey: result.publicKey, fingerprint: result.fingerprint, keyType: 'ed25519' };
  }

  async materializeSshKeyFile(entry: string): Promise<string | undefined> {
    const value = await this.request('materialize-ssh', { entry });
    return typeof value === 'string' ? value : undefined;
  }

  async disposeSshKeyFile(filePath: string): Promise<void> {
    await this.request('dispose-ssh', { filePath });
  }
}

/** 无凭据通道时的降级实现：一切写入都失败，读取一律 undefined。 */
export class UnavailableCredentialProvider implements CredentialProvider {
  async available(): Promise<boolean> { return false; }
  async get(): Promise<string | undefined> { return undefined; }
  async set(): Promise<void> { throw new Error('credential store is unavailable'); }
  async delete(): Promise<void> { /* 无事可做 */ }
}
