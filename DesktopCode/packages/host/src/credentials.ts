/**
 * 凭据通道（`27` §10.7.4 / §10.8.4）。
 *
 * 分层（**不可颠倒**）：
 *   渲染层受控输入 → preload 窄桥 → 主进程 → OS 钥匙串
 *                                            ↘ 主进程 ↔ Host 私有通道（按需下发）
 *
 * 因此本文件在 Host 侧只定义**接口**与内存实现：
 *  - Host 从不直接访问钥匙串（钥匙串在主进程）；
 *  - Host 只在需要执行 `git ls-remote` / `git push` 时，向主进程要一次凭据；
 *  - 凭据**不进 DHP、不进投影、不落状态文件、不进日志**。
 *
 * 红线（`27` §12）：
 *  1. 令牌与私钥只写不读：可以写入钥匙串，不能被任何界面/日志/诊断包读回；
 *  2. 私钥不以明文落盘（推送期间物化的 `0600` 临时文件除外，用完立即删除）；
 *  3. 远端 URL 展示前必须剥离内嵌凭据（见 `git-run.ts` 的 `sanitizeRemoteUrl`）。
 */

import { createHash, randomBytes } from 'node:crypto';

/** 钥匙串条目标识名：`liwencode.git.<host>.<method>`。 */
export function keychainEntryFor(host: string, method: string): string {
  const safeHost = host.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120) || 'unknown';
  return `liwencode.git.${safeHost}.${method}`;
}

/**
 * 凭据存储端口。
 *
 * 生产实现由 Electron 主进程通过私有 IPC 提供（`safeStorage` / `keytar` 等价物）；
 * 测试用 {@link MemoryCredentialProvider}。Host **不实现**它，只消费它。
 */
export interface CredentialProvider {
  /** 系统钥匙串是否可用；不可用时界面必须提示"本次不持久化"（`27` Q9）。 */
  available(): Promise<boolean>;
  /** 读取凭据值。**只在执行 git 命令前调用一次**，不得缓存到状态或日志。 */
  get(entry: string): Promise<string | undefined>;
  /** 写入 / 覆盖凭据值。 */
  set(entry: string, value: string): Promise<void>;
  /** 删除凭据（"断开连接"）。 */
  delete(entry: string): Promise<void>;
}

/** 内存实现：仅测试与"钥匙串不可用"降级路径使用。 */
export class MemoryCredentialProvider implements CredentialProvider {
  private readonly values = new Map<string, string>();
  private readonly isAvailable: boolean;
  constructor(opts: { available?: boolean; seed?: Record<string, string> } = {}) {
    this.isAvailable = opts.available ?? true;
    for (const [k, v] of Object.entries(opts.seed ?? {})) this.values.set(k, v);
  }
  async available(): Promise<boolean> { return this.isAvailable; }
  async get(entry: string): Promise<string | undefined> { return this.values.get(entry); }
  async set(entry: string, value: string): Promise<void> {
    if (!this.isAvailable) throw new Error('credential store is not available');
    this.values.set(entry, value);
  }
  async delete(entry: string): Promise<void> { this.values.delete(entry); }
  /** 测试断言用：条目的存在性（不暴露值）。 */
  has(entry: string): boolean { return this.values.has(entry); }
}

/** 主进程 ↔ Host 的私有凭据通道（由 `main.ts` 通过 IPC 实现，Host 只依赖这个接口）。 */
export interface CredentialBridge extends CredentialProvider {
  /**
   * 导入 SSH 私钥（含可选口令）。私钥**只经这条通道**，不经 DHP。
   * 返回指纹（公开值），私钥本身不返回。
   */
  importSshKey(entry: string, privateKey: string, passphrase?: string): Promise<{ fingerprint: string; keyType: string }>;
  /** 生成新 ed25519 密钥：私钥留在主进程/钥匙串，只返回公钥与指纹。 */
  generateSshKey(entry: string, comment?: string): Promise<{ publicKey: string; fingerprint: string; keyType: 'ed25519' }>;
  /** 推送期间物化临时密钥文件（`0600`），返回路径；用完必须 `disposeSshKeyFile`。 */
  materializeSshKeyFile(entry: string): Promise<string | undefined>;
  disposeSshKeyFile(filePath: string): Promise<void>;
}

/** 敏感值形态的脱敏（用于错误消息 / 日志 / 诊断包）。 */
export function redactSecret(value: string): string {
  return value
    .replace(/\b(gh[pousr]_[A-Za-z0-9]{16,})\b/g, '***')
    .replace(/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, '***')
    .replace(/\b(Bearer|token|authorization)\s*[:=]\s*\S+/gi, '$1: ***')
    .slice(0, 2048);
}

/** 凭据值的**不可逆指纹**：只用于"值变没变"的比较，不能还原原文。 */
export function secretFingerprint(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 16);
}

/** 一次性随机串（临时密钥文件名、OAuth state 等）。 */
export function nonce(bytes = 16): string {
  return randomBytes(bytes).toString('hex');
}
