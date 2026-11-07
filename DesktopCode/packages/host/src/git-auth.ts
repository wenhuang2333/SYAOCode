/**
 * 凭据与登录方式（`27` §10.7 / §10.7.4 生命周期 / §10.7.5 联网状态 / §10.7.6 `client_id` 三条路线）。
 *
 * 本模块是 Host 侧"登录方式"的唯一实现，覆盖规格里的六种方式里 Host 能自己做的五种：
 *   A 浏览器授权（OAuth Device Flow，公共客户端，**不带** `client_secret`）
 *   B SSH 密钥 · 用系统 agent（只读公钥，不碰私钥）           → `useSshAgent`
 *   C SSH 密钥 · 导入已有私钥（经 `CredentialBridge`，私钥不留在 Host） → `importSshKey`
 *   D SSH 密钥 · 生成新密钥（ed25519，**只返回公钥与指纹**）   → `generateSshKey`
 *   E 访问令牌（PAT，写进钥匙串，不返回）                      → `setToken`
 *   F 复用 `gh` CLI 登录 —— 由主进程/上传路径实现，本模块不涉及
 *
 * 另外提供 `hydrate`：把 `state-v2.json` 里 `gitAuth` 的**元信息**灌回内存
 * （重启后恢复"账号 / scope / 指纹"展示用），**不恢复任何凭据值**。
 *
 * 红线（`27` §12）：
 *  1. **凭据不走 DHP**：本服务只返回元信息（方式 / 账号 / scope / 指纹 / 是否就绪），
 *     绝不返回令牌或私钥内容；返回值与错误消息里也不出现令牌片段或长度
 *     （消息一律过 `redactSecret`）。
 *  2. **device_code 不出 Host**：`startOauth` 只给 `userCode` 与 `verificationUri`
 *     （TC-N-039），`device_code` 只保存在服务内存里。
 *  3. **拒绝 / 过期不留半成品**：授权被拒或设备码过期时删除钥匙串条目，
 *     状态回到 `none`（TC-N-040 / TC-N-041）。
 *  4. **清除后立刻是 `none`**：`clear` 删条目 + 清内存副本，`status` 随即显示
 *     `method='none'`、`configured=false`（TC-N-042 / TC-N-043）。
 *  5. **最小 scope**：默认只申请 `repo`，绝不申请 `admin:*` 之类。
 *
 * 网络访问全部走注入的 `fetchImpl`（默认 `globalThis.fetch`），超时
 * `AbortSignal.timeout(10s)`；测试用本地模拟授权服务器即可跑通全链路。
 *
 * 状态持久化（`state-v2.json` 的 `gitAuth`）由 `host.ts` 负责；本服务只**计算**并返回
 * `GitAuthInfo`，自己不落盘。
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, type JsonWebKey, type KeyObject } from 'node:crypto';
import type {
  GitAuthInfo,
  GitAuthMethod,
  GitAuthOauthPollResult,
  GitAuthOauthStartResult,
  GitAuthSshGenerateResult,
  GitAuthStatusResult,
  GitOauthProvider,
  GitRemoteInfo,
} from '@syaocode/dhp';
import {
  keychainEntryFor,
  nonce,
  redactSecret,
  type CredentialBridge,
  type CredentialProvider,
} from './credentials.ts';
import { sanitizeRemoteUrl } from './git-run.ts';

// ── 错误 ────────────────────────────────────────────────────────────────

/**
 * 认证类错误的 kind —— 全部取自 DHP 的 L2 码表（`27` §5.2）。
 *
 * 为什么不复用 `git-run.ts` 的 `GitError`：`GitFailureKind` 只覆盖执行层失败
 * （`git_unavailable` / `git_not_repo` / `git_command_failed` / `git_unsafe` /
 * `git_offline` / `timed_out`），**不含**凭据 / OAuth / SSH 这几类。本类的
 * `kind` 直接是 DHP 的 kind 串，Host 侧用
 * `new DhpProtocolError(err.kind, err.message)`（或 `codeForKind(err.kind)`）映射即可。
 */
export const GIT_AUTH_FAILURE_KINDS = [
  'git_auth_required',
  'git_auth_failed',
  'git_credential_unavailable',
  'git_oauth_pending',
  'git_oauth_denied',
  'git_oauth_unavailable',
  'git_ssh_key_invalid',
  'git_host_key_unverified',
] as const;

export type GitAuthFailureKind = (typeof GIT_AUTH_FAILURE_KINDS)[number];

/**
 * 认证类错误。
 *
 * 消息**一律**经过 `redactSecret`：错误消息会进日志与诊断包，
 * 不得回显令牌、口令或私钥片段（TC-N-028）。
 */
export class GitAuthError extends Error {
  readonly kind: GitAuthFailureKind;

  constructor(kind: GitAuthFailureKind, message: string) {
    super(redactSecret(message));
    this.name = 'GitAuthError';
    this.kind = kind;
  }
}

/** 判定一个错误是不是本模块抛出的认证错误。 */
export function isGitAuthError(value: unknown): value is GitAuthError {
  return value instanceof GitAuthError;
}

/** 与 DHP 的 `GitAuthMethod` 同义；保留别名便于 `host.ts` 引用。 */
export type GitAuthMethodName = GitAuthMethod;

// ── 常量 ────────────────────────────────────────────────────────────────

/** 默认授权范围：只读场景可降到 `public_repo`；**不申请** `admin:*`。 */
const DEFAULT_SCOPE = 'repo';

/** 默认厂商。 */
const DEFAULT_PROVIDER = 'github';

/** 网络请求超时（毫秒）。 */
const REQUEST_TIMEOUT_MS = 10_000;

/** `ssh-add` 探测超时（毫秒）。 */
const SSH_ADD_TIMEOUT_MS = 5_000;

/** SSH 公钥类型。 */
const SSH_KEY_TYPE = 'ssh-ed25519';

/** 各厂商默认实例域名（GHES 等自建实例由用户填 `domain`）。 */
const PROVIDER_DOMAINS: Readonly<Record<string, string>> = {
  github: 'github.com',
  gitlab: 'gitlab.com',
  gitee: 'gitee.com',
};

/** 已接入 Device Flow 的厂商（GitHub 先做，GitLab / Gitee 走同一适配器占位）。 */
const DEVICE_FLOW_PROVIDERS: ReadonlySet<string> = new Set(['github']);

/** `providers()` 的静态骨架；`builtinClientId` 随配置动态计算。 */
const PROVIDER_CATALOG: readonly { readonly id: string; readonly label: string; readonly deviceFlow: boolean }[] = [
  { id: 'github', label: 'GitHub', deviceFlow: true },
  { id: 'gitlab', label: 'GitLab', deviceFlow: false },
  { id: 'gitee', label: 'Gitee', deviceFlow: false },
];

/** `status()` 里探测凭据条目的顺序（条目名自带方式，先到先得）。 */
const PROBE_ORDER = ['oauth', 'token', 'ssh-key'] as const;

/** 清除时需要尝试删除的条目方式。 */
const CLEAR_METHODS = ['oauth', 'token', 'ssh-key', 'ssh-agent'] as const;

/** 可落库的认证方式（`ssh-agent` 不落凭据，只用系统 agent）。 */
type StoredMethod = 'oauth' | 'ssh-agent' | 'ssh-key' | 'token';

// ── 内部结构 ────────────────────────────────────────────────────────────

/** 一条远端的认证元信息。**只含公开元信息**，没有令牌 / 私钥。 */
interface AuthRecord {
  /** 凭据条目归属的主机名。 */
  readonly host: string;
  readonly method: StoredMethod;
  readonly account: string | null;
  readonly scope: readonly string[];
  readonly keyFingerprint: string | null;
  readonly updatedAt: number;
}

/** 一次设备码授权流程。`device_code` 只存在这里，绝不外泄（TC-N-039）。 */
interface OauthFlow {
  readonly id: string;
  readonly provider: string;
  /** 授权服务器域名；同时决定钥匙串条目归属。 */
  readonly domain: string;
  readonly clientId: string;
  /** 设备码：只在服务内存里，状态终结后立刻抹掉。 */
  deviceCode: string;
  readonly scope: string;
  /** 轮询间隔（秒）。 */
  interval: number;
  /** 设备码过期时刻（毫秒）。 */
  readonly expiresAt: number;
  readonly workspaceRoot: string;
  readonly remote: string;
  lastPollAt: number;
  state: 'pending' | 'ready' | 'denied' | 'expired';
}

// ── 小工具 ──────────────────────────────────────────────────────────────

/** `(工作区, 远端名)` → 内部键。 */
function recordKey(workspaceRoot: string, remote: string): string {
  return `${workspaceRoot}\u0000${remote}`;
}

/**
 * 状态文件元信息的索引键。
 *
 * 三种粒度（从精确到宽泛）：`host:<主机>|<方式>` → `remote:<工作区+远端>|<方式>`
 * → `method:<方式>`；查找时按同样顺序回退。
 */
function hydratedKeyFor(record: GitAuthHydrateRecord): string {
  if (record.host !== undefined && record.host !== '') return `host:${record.host.toLowerCase()}|${record.method}`;
  if (record.remote !== undefined && record.remote !== '' && record.workspaceRoot !== undefined) {
    return `remote:${recordKey(record.workspaceRoot, record.remote)}|${record.method}`;
  }
  return `method:${record.method}`;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** scope 串（`repo,public_repo` 或空格分隔）→ 数组。 */
function parseScope(value: unknown): string[] {
  if (typeof value !== 'string') return [];
  return value
    .split(/[,\s]+/)
    .map((item) => item.trim())
    .filter((item) => item !== '');
}

/** 从远端 URL 取主机名（`https://` / `ssh://` / scp 风格 `git@host:path`）。 */
export function hostFromRemoteUrl(url: string): string | undefined {
  const value = url.trim();
  if (value === '') return undefined;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
    try {
      const parsed = new URL(value);
      return parsed.hostname === '' ? undefined : parsed.hostname.toLowerCase();
    } catch {
      return undefined;
    }
  }
  // scp 风格：`git@host:path` / `host:path`
  const scp = /^(?:[^@/\s]+@)?([A-Za-z0-9._-]+):[^/\s]/.exec(value);
  return scp?.[1]?.toLowerCase();
}

/** 授权服务器域名：只接受主机名，拒绝协议、路径、端口与空白。 */
function normalizeDomain(raw: string | undefined, provider: string): string {
  const fallback = PROVIDER_DOMAINS[provider] ?? PROVIDER_DOMAINS[DEFAULT_PROVIDER] ?? 'github.com';
  const value = (raw ?? '').trim();
  if (value === '') return fallback;
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/.test(value)) {
    throw new GitAuthError('git_oauth_unavailable', `invalid authorization domain: ${value}`);
  }
  return value.toLowerCase();
}

/** 注释：去掉换行与控制字符，长度受限（公钥行要贴到 GitHub 设置页）。 */
function sanitizeComment(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const value = raw.replace(/[\r\n\t\0]/g, ' ').trim();
  if (value === '') return undefined;
  return value.slice(0, 200);
}

/** SSH wire 格式里的长度前缀字符串。 */
function sshString(value: string | Buffer): Buffer {
  const body = typeof value === 'string' ? Buffer.from(value, 'utf8') : value;
  const length = Buffer.alloc(4);
  length.writeUInt32BE(body.length, 0);
  return Buffer.concat([length, body]);
}

/** ed25519 公钥的 SSH wire blob。 */
function sshEd25519Blob(rawKey: Buffer): Buffer {
  return Buffer.concat([sshString(SSH_KEY_TYPE), sshString(rawKey)]);
}

/** OpenSSH 风格的 SHA256 指纹（`SHA256:` + base64 无填充）。 */
function sshFingerprint(blob: Buffer): string {
  return `SHA256:${createHash('sha256').update(blob).digest('base64').replace(/=+$/, '')}`;
}

/** SSH 的 mpint 编码：去掉前导零，最高位为 1 时补一个 0x00。 */
function sshMpint(value: Buffer): Buffer {
  let start = 0;
  while (start < value.length - 1 && value[start] === 0) start += 1;
  const body = value.subarray(start);
  if (body.length === 0) return body;
  return (body[0]! & 0x80) !== 0 ? Buffer.concat([Buffer.from([0]), body]) : body;
}

/** 曲线名 → OpenSSH 曲线标识。 */
const SSH_CURVES: Readonly<Record<string, string>> = {
  'P-256': 'nistp256',
  'P-384': 'nistp384',
  'P-521': 'nistp521',
};

/**
 * 由公钥（JWK 形态）拼出 OpenSSH 公钥 blob，用于算指纹。
 *
 * 支持 ed25519 / RSA / ECDSA（P-256/384/521）——即 `ssh-keygen -lf` 会认的三类。
 * 拼不出来就返回 `undefined`（调用方按"不支持的密钥类型"处理）。
 */
function sshBlobFromJwk(jwk: JsonWebKey): Buffer | undefined {
  if (jwk.kty === 'OKP' && jwk.crv === 'Ed25519' && typeof jwk.x === 'string') {
    return sshEd25519Blob(Buffer.from(jwk.x, 'base64url'));
  }
  if (jwk.kty === 'RSA' && typeof jwk.n === 'string' && typeof jwk.e === 'string') {
    const modulus = sshMpint(Buffer.from(jwk.n, 'base64url'));
    const exponent = sshMpint(Buffer.from(jwk.e, 'base64url'));
    return Buffer.concat([sshString('ssh-rsa'), sshString(exponent), sshString(modulus)]);
  }
  if (jwk.kty === 'EC' && typeof jwk.x === 'string' && typeof jwk.y === 'string' && typeof jwk.crv === 'string') {
    const curve = SSH_CURVES[jwk.crv];
    if (curve === undefined) return undefined;
    const point = Buffer.concat([
      Buffer.from([0x04]),
      Buffer.from(jwk.x, 'base64url'),
      Buffer.from(jwk.y, 'base64url'),
    ]);
    return Buffer.concat([sshString(`ecdsa-sha2-${curve}`), sshString(curve), sshString(point)]);
  }
  return undefined;
}

/**
 * 校验私钥能否解析，并算出它的指纹。
 *
 * 私钥内容与口令都**不留在返回值里**；解析失败只给固定文案，
 * 不把 OpenSSL 的原始报错（可能带输入片段）回显（TC-N-043）。
 */
function parsePrivateKey(privateKey: string, passphrase: string | undefined): { fingerprint: string } {
  let keyObject: KeyObject;
  try {
    keyObject =
      passphrase === undefined || passphrase === ''
        ? createPrivateKey(privateKey)
        : createPrivateKey({ key: privateKey, passphrase });
  } catch {
    throw new GitAuthError(
      'git_ssh_key_invalid',
      'cannot parse the private key: the format is invalid or the passphrase is wrong',
    );
  }
  let blob: Buffer | undefined;
  try {
    blob = sshBlobFromJwk(createPublicKey(keyObject).export({ format: 'jwk' }));
  } catch {
    blob = undefined;
  }
  if (blob === undefined) {
    throw new GitAuthError(
      'git_ssh_key_invalid',
      'unsupported SSH key type: only ed25519, RSA and ECDSA keys can be imported',
    );
  }
  return { fingerprint: sshFingerprint(blob) };
}

/** 解析 `ssh-add -L` 的一行公钥，返回类型与指纹。 */
function parseAgentIdentityLine(line: string): { keyType: string; fingerprint: string } | undefined {
  const match = /^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp256|ecdsa-sha2-nistp384|ecdsa-sha2-nistp521|sk-ssh-ed25519@openssh\.com|sk-ecdsa-sha2-nistp256@openssh\.com)\s+([A-Za-z0-9+/]+={0,2})(?:\s|$)/.exec(line.trim());
  if (match === null) return undefined;
  const blob = Buffer.from(match[2] ?? '', 'base64');
  if (blob.length === 0) return undefined;
  return { keyType: match[1] ?? '', fingerprint: sshFingerprint(blob) };
}

/** 一次子进程执行的结果（只取需要的部分，输出有上限）。 */
interface CommandResult {
  readonly code: number;
  readonly stdout: string;
}

/** 执行一条命令（不经 shell），超时 SIGKILL。 */
function runCommand(command: string, args: readonly string[], timeoutMs: number): Promise<CommandResult> {
  return new Promise<CommandResult>((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn(command, [...args], { shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch {
      resolve({ code: -1, stdout: '' });
      return;
    }
    const out: Buffer[] = [];
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (code: number): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      resolve({ code, stdout: Buffer.concat(out).toString('utf8') });
    };
    timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* 已退出 */
      }
      finish(-1);
    }, timeoutMs);
    timer.unref?.();
    child.stdout?.on('data', (chunk: Buffer) => {
      if (out.length < 64) out.push(chunk);
    });
    child.on('error', () => finish(-1));
    child.on('close', (code) => finish(code ?? -1));
  });
}

/** 是否是主进程提供的凭据桥（有桥就让主进程生成密钥，私钥不经 Host）。 */
function asCredentialBridge(provider: CredentialProvider): CredentialBridge | undefined {
  const candidate = provider as Partial<CredentialBridge>;
  return typeof candidate.generateSshKey === 'function' ? (provider as CredentialBridge) : undefined;
}

/** 认证信息 → DHP 的 `GitAuthInfo`（**只有元信息**）。 */
function toAuthInfo(record: AuthRecord): GitAuthInfo {
  return {
    method: record.method,
    configured: true,
    account: record.account,
    scope: record.scope,
    ready: true,
    keyFingerprint: record.keyFingerprint,
    updatedAt: record.updatedAt,
  };
}

/** 未配置任何凭据。 */
function noneInfo(): GitAuthInfo {
  return {
    method: 'none',
    configured: false,
    account: null,
    scope: [],
    ready: false,
    keyFingerprint: null,
    updatedAt: null,
  };
}

// ── 服务 ────────────────────────────────────────────────────────────────

/**
 * 从 `state-v2.json` 的 `gitAuth` 灌回来的**元信息**（`hydrate` 的入参）。
 *
 * 只恢复"方式 / 账号 / scope / 指纹 / 时间"这些公开元信息；
 * **不恢复任何凭据值**——`status()` 仍然以钥匙串条目是否存在为准。
 *
 * `host` / `remote` + `workspaceRoot` 是可选的精确匹配字段：
 * 给了就按"主机 + 方式"或"工作区 + 远端 + 方式"恢复；
 * 都没给就退化成"方式 → 元信息"，用于状态文件里没有主机信息的旧数据。
 */
export interface GitAuthHydrateRecord {
  readonly method: GitAuthMethod;
  readonly account: string | null;
  readonly scope: readonly string[];
  readonly keyFingerprint: string | null;
  readonly updatedAt: number;
  /** 可选：远端主机名。 */
  readonly host?: string;
  /** 可选：远端名（与 `workspaceRoot` 一起使用）。 */
  readonly remote?: string;
  /** 可选：工作区根。 */
  readonly workspaceRoot?: string;
}

export interface GitAuthServiceOptions {
  /** 凭据通道（主进程私有 IPC 或内存实现）。 */
  credentials: CredentialProvider;
  /** 网络实现，测试用本地模拟服务器注入。 */
  fetchImpl?: typeof fetch;
  /** 时钟（测试可注入假时钟）。 */
  now?: () => number;
  /**
   * 内置 `client_id`（`27` §10.7.6 路线 1）。
   * 开源仓库**不放**任何真实 `client_id`：没有它 `startOauth` 会提示改用 SSH / 令牌。
   */
  builtinClientIds?: Readonly<Record<string, string>>;
}

export class GitAuthService {
  private readonly credentials: CredentialProvider;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly builtinClientIds: Readonly<Record<string, string>>;
  /** `(工作区, 远端)` → 认证元信息（**不含**凭据值）。 */
  private readonly records = new Map<string, AuthRecord>();
  /** `(工作区, 远端)` → 远端主机名（由 `status()` 学习，供只带远端名的方法使用）。 */
  private readonly hosts = new Map<string, string>();
  /** `flowId` → 设备码流程。 */
  private readonly flows = new Map<string, OauthFlow>();
  /** 状态文件灌回来的元信息（按"主机 / 远端 / 方式"三种键索引，**不含凭据值**）。 */
  private readonly hydrated = new Map<string, GitAuthHydrateRecord>();

  constructor(opts: GitAuthServiceOptions) {
    this.credentials = opts.credentials;
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch;
    this.now = opts.now ?? ((): number => Date.now());
    this.builtinClientIds = opts.builtinClientIds ?? {};
  }

  /** 支持的授权厂商：GitHub 先做（Device Flow），GitLab / Gitee 占位。 */
  providers(): readonly GitOauthProvider[] {
    return PROVIDER_CATALOG.map((provider) => ({
      id: provider.id,
      label: provider.label,
      deviceFlow: provider.deviceFlow,
      builtinClientId: this.hasBuiltinClientId(provider.id),
    }));
  }

  /**
   * 登录状态。
   *
   * 只返回**元信息**：`git/auth/status` 里永远没有令牌（TC-N-027）。
   * 远端 URL 展示前先剥离内嵌凭据（`27` §12 红线 6）。
   */
  async status(root: string, remotes: readonly { name: string; url: string }[]): Promise<GitAuthStatusResult> {
    const entries: GitRemoteInfo[] = [];
    for (const remote of remotes) {
      const key = recordKey(root, remote.name);
      const urlHost = hostFromRemoteUrl(remote.url);
      if (urlHost !== undefined) this.hosts.set(key, urlHost);
      const record = this.records.get(key);
      entries.push({
        name: remote.name,
        url: sanitizeRemoteUrl(remote.url),
        auth: await this.infoFor(root, remote.name, record),
      });
    }
    return { workspaceRoot: root, remotes: entries, providers: this.providers() };
  }

  /**
   * 开始设备码授权（方式 A）。
   *
   * 请求 `https://<domain>/login/device/code`，**不带 `client_secret`**（公共客户端，
   * `27` §10.7.6）。返回里**没有 `deviceCode`**：它只留在服务内存里（TC-N-039）。
   */
  async startOauth(params: {
    workspaceRoot: string;
    remote: string;
    provider: string;
    clientId?: string;
    domain?: string;
  }): Promise<GitAuthOauthStartResult> {
    const provider = (params.provider ?? '').trim().toLowerCase() || DEFAULT_PROVIDER;
    if (!DEVICE_FLOW_PROVIDERS.has(provider)) {
      throw new GitAuthError(
        'git_oauth_unavailable',
        `${provider} does not support the OAuth device flow yet; use an SSH key or an access token instead`,
      );
    }

    const own = (params.clientId ?? '').trim();
    const builtin = (this.builtinClientIds[provider] ?? '').trim();
    const clientId = own !== '' ? own : builtin;
    if (clientId === '') {
      throw new GitAuthError(
        'git_oauth_unavailable',
        `no OAuth client_id is configured for ${provider}; bring your own OAuth App client_id, or use an SSH key / access token instead`,
      );
    }

    const domain = normalizeDomain(params.domain, provider);
    const response = await this.requestJson(`https://${domain}/login/device/code`, {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
      // 公共客户端：只出示 client_id + 最小 scope。
      body: new URLSearchParams({ client_id: clientId, scope: DEFAULT_SCOPE }).toString(),
    });

    const deviceCode = asString(response.body['device_code']);
    const userCode = asString(response.body['user_code']);
    const verificationUri = asString(response.body['verification_uri']);
    const expiresIn = asNumber(response.body['expires_in']);
    const interval = asNumber(response.body['interval']);

    if (!response.ok || deviceCode === undefined || userCode === undefined || verificationUri === undefined || expiresIn === undefined) {
      // 不回显响应原文（可能含敏感片段），只给状态码。
      throw new GitAuthError('git_oauth_unavailable', `the authorization server did not issue a device code (HTTP ${response.status})`);
    }
    // 主进程只用 https 打开授权页，非 https 一律拒绝。
    if (!/^https:\/\//i.test(verificationUri)) {
      throw new GitAuthError('git_oauth_unavailable', 'the authorization server returned a non-HTTPS verification URI');
    }

    this.pruneFlows();
    const flow: OauthFlow = {
      id: `flow_${nonce(8)}`,
      provider,
      domain,
      clientId,
      deviceCode,
      scope: DEFAULT_SCOPE,
      interval: interval === undefined || interval < 0 ? 5 : interval,
      expiresAt: this.now() + Math.max(0, expiresIn) * 1000,
      workspaceRoot: params.workspaceRoot,
      remote: params.remote,
      lastPollAt: 0,
      state: 'pending',
    };
    this.flows.set(flow.id, flow);

    // 只给用户码与授权页地址；设备码不出 Host。
    return {
      flowId: flow.id,
      userCode,
      verificationUri,
      expiresIn: Math.max(0, expiresIn),
      interval: flow.interval,
    };
  }

  /**
   * 轮询授权结果。
   *
   * 状态机：`pending` → `ready` / `denied` / `expired`（另有 `slow_down`）。
   * `ready` 时令牌**只**写进凭据通道，返回值里只有账号与 scope（TC-N-039）。
   */
  async pollOauth(flowId: string): Promise<GitAuthOauthPollResult> {
    const flow = this.flows.get(flowId);
    if (flow === undefined) {
      throw new GitAuthError('git_oauth_unavailable', 'unknown or cancelled authorization flow; start the authorization again');
    }
    if (flow.state === 'ready') {
      const record = this.records.get(recordKey(flow.workspaceRoot, flow.remote));
      return { status: 'ready', account: record?.account ?? null, scope: record?.scope ?? [] };
    }
    if (flow.state === 'denied' || flow.state === 'expired') {
      return { status: flow.state, account: null, scope: [] };
    }

    // 本地过期判定：不依赖服务器（TC-N-041）。
    if (this.now() >= flow.expiresAt) {
      await this.abandonFlow(flow, 'expired');
      return { status: 'expired', account: null, scope: [] };
    }

    // 按 interval 节流：没到下一次轮询时间先回 pending，避免打爆授权服务器。
    if (flow.interval > 0 && flow.lastPollAt !== 0 && this.now() - flow.lastPollAt < flow.interval * 1000) {
      return { status: 'pending', account: null, scope: [] };
    }
    flow.lastPollAt = this.now();

    const response = await this.requestJson(`https://${flow.domain}/login/oauth/access_token`, {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: flow.clientId,
        device_code: flow.deviceCode,
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      }).toString(),
    });

    const token = asString(response.body['access_token']);
    if (response.ok && token !== undefined) {
      return await this.completeFlow(flow, token, response.body['scope']);
    }

    const error = asString(response.body['error']);
    switch (error) {
      case 'authorization_pending':
        return { status: 'pending', account: null, scope: [] };
      case 'slow_down':
        // 厂商让我们放慢：间隔 +5 秒。
        flow.interval += 5;
        return { status: 'slow_down', account: null, scope: [] };
      case 'access_denied':
        await this.abandonFlow(flow, 'denied');
        return { status: 'denied', account: null, scope: [] };
      case 'expired_token':
        await this.abandonFlow(flow, 'expired');
        return { status: 'expired', account: null, scope: [] };
      default:
        throw new GitAuthError('git_oauth_unavailable', `the authorization server returned an unexpected response (HTTP ${response.status})`);
    }
  }

  /** 取消一次授权流程（幂等）。 */
  async cancelOauth(flowId: string): Promise<{ cancelled: true }> {
    const flow = this.flows.get(flowId);
    if (flow !== undefined) {
      flow.deviceCode = '';
      this.flows.delete(flowId);
    }
    return { cancelled: true };
  }

  /**
   * 方式 B：使用本机 SSH agent。
   *
   * 只读 `ssh-add -L` 的**公钥**算指纹，不读任何私钥内容；
   * agent 里没有可用身份 → `git_ssh_key_invalid`（-32044）。
   */
  async useSshAgent(params: { workspaceRoot: string; remote: string }): Promise<GitAuthInfo> {
    const key = recordKey(params.workspaceRoot, params.remote);
    const host = this.resolveHost(key, params.remote);
    const identities = await this.agentIdentities();
    const chosen = identities.find((identity) => identity.keyType === SSH_KEY_TYPE) ?? identities[0];
    if (chosen === undefined) {
      throw new GitAuthError(
        'git_ssh_key_invalid',
        'ssh-add reports no usable identity; start ssh-agent and add a key, or import / generate a key instead',
      );
    }
    const record: AuthRecord = {
      host,
      method: 'ssh-agent',
      account: null,
      scope: [],
      keyFingerprint: chosen.fingerprint,
      updatedAt: this.now(),
    };
    this.records.set(key, record);
    this.hosts.set(key, host);
    return toAuthInfo(record);
  }

  /**
   * 方式 D：生成 ed25519 密钥对。
   *
   * **只返回公钥与指纹**；私钥进凭据通道，永不返回（TC-N-045）。
   * 走主进程凭据桥时由主进程生成并保存（私钥不经 Host）。
   */
  async generateSshKey(params: {
    workspaceRoot: string;
    remote: string;
    comment?: string;
  }): Promise<GitAuthSshGenerateResult> {
    const key = recordKey(params.workspaceRoot, params.remote);
    const host = this.resolveHost(key, params.remote);
    const entry = keychainEntryFor(host, 'ssh-key');
    const comment = sanitizeComment(params.comment);

    let publicKey: string;
    let fingerprint: string;

    const bridge = asCredentialBridge(this.credentials);
    if (bridge !== undefined) {
      // 主进程生成：私钥直接进主进程的钥匙串，Host 只拿到公钥与指纹。
      try {
        const generated = await bridge.generateSshKey(entry, comment);
        publicKey = generated.publicKey;
        fingerprint = generated.fingerprint;
      } catch (error) {
        throw new GitAuthError('git_credential_unavailable', `cannot generate or store the SSH key: ${(error as Error).message}`);
      }
    } else {
      if (!(await this.credentials.available().catch(() => false))) {
        throw new GitAuthError(
          'git_credential_unavailable',
          'the system keychain is not available, so the private key cannot be stored; no key was generated',
        );
      }
      const pair = generateKeyPairSync('ed25519');
      const jwk = pair.publicKey.export({ format: 'jwk' });
      const raw = typeof jwk.x === 'string' ? Buffer.from(jwk.x, 'base64url') : Buffer.alloc(0);
      if (raw.length !== 32) {
        throw new GitAuthError('git_ssh_key_invalid', 'cannot export the generated public key');
      }
      const blob = sshEd25519Blob(raw);
      publicKey = `${SSH_KEY_TYPE} ${blob.toString('base64')}${comment === undefined ? '' : ` ${comment}`}`;
      fingerprint = sshFingerprint(blob);
      const pem = pair.privateKey.export({ type: 'pkcs8', format: 'pem' });
      const privateKey = typeof pem === 'string' ? pem : pem.toString('utf8');
      try {
        // 私钥只写不读：写完即丢，不进返回值、不进日志。
        await this.credentials.set(entry, privateKey);
      } catch (error) {
        throw new GitAuthError('git_credential_unavailable', `cannot store the generated private key: ${(error as Error).message}`);
      }
    }

    const record: AuthRecord = {
      host,
      method: 'ssh-key',
      account: null,
      scope: [],
      keyFingerprint: fingerprint,
      updatedAt: this.now(),
    };
    this.records.set(key, record);
    this.hosts.set(key, host);
    return { publicKey, fingerprint, keyType: 'ed25519' };
  }

  /**
   * 方式 C：导入已有私钥。
   *
   * 私钥与口令**只**经凭据通道：注入的是 {@link CredentialBridge}（主进程）时
   * 用桥自带的 `importSshKey`，私钥不留在 Host 内存里；否则 Host 自己校验格式
   * 并把私钥写进凭据通道。返回值只含方式与指纹，**不含私钥**（TC-N-042 / TC-N-043）。
   */
  async importSshKey(params: {
    workspaceRoot: string;
    remote: string;
    privateKey: string;
    passphrase?: string;
  }): Promise<GitAuthInfo> {
    const key = recordKey(params.workspaceRoot, params.remote);
    const host = this.resolveHost(key, params.remote);
    const entry = keychainEntryFor(host, 'ssh-key');

    let fingerprint: string;
    const bridge = asCredentialBridge(this.credentials);
    if (bridge !== undefined) {
      // 主进程解析并保存私钥（口令一起交给它），Host 只拿到公开的指纹。
      try {
        const imported = await bridge.importSshKey(entry, params.privateKey, params.passphrase);
        fingerprint = imported.fingerprint;
      } catch {
        throw new GitAuthError(
          'git_ssh_key_invalid',
          'cannot import the private key: the format is invalid or the passphrase is wrong',
        );
      }
    } else {
      // 没有主进程桥：Host 自己校验格式（顺带算指纹），再把私钥写进凭据通道。
      fingerprint = parsePrivateKey(params.privateKey, params.passphrase).fingerprint;
      try {
        await this.credentials.set(entry, params.privateKey);
      } catch {
        throw new GitAuthError('git_credential_unavailable', 'cannot store the imported private key');
      }
    }

    const record: AuthRecord = {
      host,
      method: 'ssh-key',
      account: null,
      scope: [],
      keyFingerprint: fingerprint,
      updatedAt: this.now(),
    };
    this.records.set(key, record);
    this.hosts.set(key, host);
    return toAuthInfo(record);
  }

  /**
   * 方式 E：粘贴访问令牌（PAT）。
   *
   * 令牌只写进凭据通道；返回值只有"已配置"这一件事，**账号不猜**（`account=null`）。
   */
  async setToken(params: { workspaceRoot: string; remote: string; token: string }): Promise<GitAuthInfo> {
    const token = params.token.trim();
    if (token === '' || /[\0\r\n]/.test(token)) {
      throw new GitAuthError('git_auth_required', 'the token is empty or malformed; no credential was stored');
    }
    const key = recordKey(params.workspaceRoot, params.remote);
    const host = this.resolveHost(key, params.remote);
    try {
      await this.credentials.set(keychainEntryFor(host, 'token'), token);
    } catch {
      throw new GitAuthError('git_credential_unavailable', 'cannot store the access token in the credential store');
    }
    const record: AuthRecord = {
      host,
      method: 'token',
      account: null,
      scope: [],
      keyFingerprint: null,
      updatedAt: this.now(),
    };
    this.records.set(key, record);
    this.hosts.set(key, host);
    return toAuthInfo(record);
  }

  /**
   * 把状态文件里的元信息灌回内存（重启后恢复展示用）。
   *
   * **不恢复任何凭据值**：`status()` 仍然以钥匙串条目是否存在为准；
   * 这里只补 `account` / `scope` / `keyFingerprint` / `updatedAt` 这些公开元信息。
   * 合并语义：同一个键（主机 / 远端 / 方式）会被新值覆盖，其余保留。
   */
  hydrate(records: readonly GitAuthHydrateRecord[]): void {
    for (const record of records) {
      if (record.method === 'none') continue;
      this.hydrated.set(hydratedKeyFor(record), record);
    }
  }

  /**
   * 断开连接：删除钥匙串条目并清空内存副本。
   *
   * 返回后 `status` 必须是 `method='none'`、`configured=false`（TC-N-042 / TC-N-043）。
   */
  async clear(params: { workspaceRoot: string; remote: string }): Promise<{ cleared: true }> {
    const key = recordKey(params.workspaceRoot, params.remote);
    const record = this.records.get(key);
    const hosts = new Set<string>();
    const learned = this.hosts.get(key);
    if (learned !== undefined) hosts.add(learned);
    if (record !== undefined) hosts.add(record.host);
    const fromRemote = hostFromRemoteUrl(params.remote);
    if (fromRemote !== undefined) hosts.add(fromRemote);
    if (hosts.size === 0) hosts.add(PROVIDER_DOMAINS[DEFAULT_PROVIDER] ?? 'github.com');

    for (const host of hosts) {
      for (const method of CLEAR_METHODS) {
        try {
          await this.credentials.delete(keychainEntryFor(host, method));
        } catch {
          // 条目不存在 / 通道不可用：清除仍算成功，内存副本必须清掉。
        }
        // 状态文件灌回来的元信息也一并清掉，避免下次配置时套用旧账号。
        this.hydrated.delete(`host:${host.toLowerCase()}|${method}`);
      }
    }
    for (const method of CLEAR_METHODS) {
      this.hydrated.delete(`remote:${recordKey(params.workspaceRoot, params.remote)}|${method}`);
    }

    this.records.delete(key);
    this.hosts.delete(key);
    for (const [flowId, flow] of this.flows) {
      if (flow.workspaceRoot === params.workspaceRoot && flow.remote === params.remote) {
        flow.deviceCode = '';
        this.flows.delete(flowId);
      }
    }
    return { cleared: true };
  }

  // ── 内部实现 ──────────────────────────────────────────────────────────

  /** 计算一条远端的认证信息。 */
  private async infoFor(root: string, remote: string, record: AuthRecord | undefined): Promise<GitAuthInfo> {
    const key = recordKey(root, remote);
    if (record !== undefined) {
      if (await this.recordStillValid(record)) return toAuthInfo(record);
      // 凭据被外部删除（用户清了钥匙串）→ 状态必须回到 none，不谎报"已配置"。
      this.records.delete(key);
    }

    const host = this.hosts.get(key) ?? PROVIDER_DOMAINS[DEFAULT_PROVIDER] ?? 'github.com';
    for (const method of PROBE_ORDER) {
      if (await this.hasEntry(host, method)) {
        // 钥匙串里有条目、但本进程还没有元信息（重启后）：用状态文件灌回来的元信息补全；
        // 补不到就只报"已配置"，账号未知写 null，绝不伪造（TC-N-027）。
        const meta = this.hydratedMeta(root, remote, host, method);
        return {
          method,
          configured: true,
          account: meta?.account ?? null,
          scope: meta?.scope ?? [],
          ready: true,
          keyFingerprint: meta?.keyFingerprint ?? null,
          updatedAt: meta?.updatedAt ?? null,
        };
      }
    }

    // 授权进行中：还没拿到令牌 → `configured=false`。
    const pending = this.pendingFlowFor(root, remote);
    if (pending !== undefined) {
      return {
        method: 'oauth',
        configured: false,
        account: null,
        scope: parseScope(pending.scope),
        ready: false,
        keyFingerprint: null,
        updatedAt: null,
      };
    }
    return noneInfo();
  }

  /** 记录是否仍然成立（凭据条目还在；系统 agent 本来就不落凭据）。 */
  private async recordStillValid(record: AuthRecord): Promise<boolean> {
    if (record.method === 'ssh-agent') return true;
    return await this.hasEntry(record.host, record.method);
  }

  /**
   * 状态文件里的元信息：先按"工作区 + 远端"，再按主机，最后按方式回退。
   *
   * 只用来补 `account` / `scope` / `keyFingerprint` / `updatedAt`；
   * 是否"已配置"始终以钥匙串条目为准。
   */
  private hydratedMeta(root: string, remote: string, host: string, method: string): GitAuthHydrateRecord | undefined {
    return (
      this.hydrated.get(`remote:${recordKey(root, remote)}|${method}`) ??
      this.hydrated.get(`host:${host.toLowerCase()}|${method}`) ??
      this.hydrated.get(`method:${method}`)
    );
  }

  /**
   * 钥匙串里是否有该条目的**非空值**。
   *
   * 取到的值立刻丢弃：只用于判断"有没有配置"，绝不返回、绝不记录（TC-N-027）。
   */
  private async hasEntry(host: string, method: string): Promise<boolean> {
    try {
      const value = await this.credentials.get(keychainEntryFor(host, method));
      return typeof value === 'string' && value !== '';
    } catch {
      return false;
    }
  }

  /** 系统 agent 里的可用身份（只有类型与指纹）。 */
  private async agentIdentities(): Promise<{ keyType: string; fingerprint: string }[]> {
    const result = await runCommand('ssh-add', ['-L'], SSH_ADD_TIMEOUT_MS);
    if (result.code !== 0) return [];
    const identities: { keyType: string; fingerprint: string }[] = [];
    for (const line of result.stdout.split('\n')) {
      const parsed = parseAgentIdentityLine(line);
      if (parsed !== undefined) identities.push(parsed);
    }
    return identities;
  }

  /** 授权成功：令牌进凭据通道，返回值里只有账号与 scope。 */
  private async completeFlow(flow: OauthFlow, token: string, rawScope: unknown): Promise<GitAuthOauthPollResult> {
    const scope = parseScope(rawScope);
    try {
      // 令牌只写不读：写进钥匙串后本函数再不碰它。
      await this.credentials.set(keychainEntryFor(flow.domain, 'oauth'), token);
    } catch (error) {
      flow.deviceCode = '';
      this.flows.delete(flow.id);
      throw new GitAuthError('git_credential_unavailable', `cannot store the access token: ${(error as Error).message}`);
    }

    const account = await this.lookupAccount(flow, token);
    const key = recordKey(flow.workspaceRoot, flow.remote);
    const record: AuthRecord = {
      host: flow.domain,
      method: 'oauth',
      account,
      scope,
      keyFingerprint: null,
      updatedAt: this.now(),
    };
    this.records.set(key, record);
    this.hosts.set(key, flow.domain);
    flow.state = 'ready';
    flow.deviceCode = ''; // 令牌已到手，设备码立刻作废
    return { status: 'ready', account, scope };
  }

  /**
   * 用令牌查一次账号名。
   *
   * 查不到就返回 `null`——**不伪造账号**。查询失败不影响授权本身。
   */
  private async lookupAccount(flow: OauthFlow, token: string): Promise<string | null> {
    const endpoint = flow.domain === 'github.com' ? 'https://api.github.com/user' : `https://${flow.domain}/api/v3/user`;
    try {
      const response = await this.fetchImpl(endpoint, {
        method: 'GET',
        headers: { accept: 'application/vnd.github+json', authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (!response.ok) return null;
      const parsed: unknown = JSON.parse(await response.text());
      if (typeof parsed !== 'object' || parsed === null) return null;
      const login = (parsed as Record<string, unknown>)['login'];
      return typeof login === 'string' && login !== '' ? login.slice(0, 200) : null;
    } catch {
      return null;
    }
  }

  /** 授权被拒 / 过期：清理半成品条目，状态回到 `none`（TC-N-040 / TC-N-041）。 */
  private async abandonFlow(flow: OauthFlow, state: 'denied' | 'expired'): Promise<void> {
    flow.state = state;
    flow.deviceCode = '';
    try {
      await this.credentials.delete(keychainEntryFor(flow.domain, 'oauth'));
    } catch {
      // 条目本来就不存在：无需处理。
    }
    this.records.delete(recordKey(flow.workspaceRoot, flow.remote));
  }

  /** 流程结束时把设备码抹掉；被拒 / 过期的流程没有保留价值，顺手清一清。 */
  private pruneFlows(): void {
    for (const [flowId, flow] of this.flows) {
      if (flow.state === 'denied' || flow.state === 'expired') this.flows.delete(flowId);
    }
  }

  /** 进行中的授权流程。 */
  private pendingFlowFor(workspaceRoot: string, remote: string): OauthFlow | undefined {
    for (const flow of this.flows.values()) {
      if (flow.state === 'pending' && flow.workspaceRoot === workspaceRoot && flow.remote === remote) return flow;
    }
    return undefined;
  }

  /** 远端主机名：先看 `status()` 学到的，再看 remote 本身像不像 URL，最后用默认域名。 */
  private resolveHost(key: string, remote: string): string {
    const learned = this.hosts.get(key);
    if (learned !== undefined) return learned;
    const fromRemote = hostFromRemoteUrl(remote);
    if (fromRemote !== undefined) return fromRemote;
    return PROVIDER_DOMAINS[DEFAULT_PROVIDER] ?? 'github.com';
  }

  /** 是否内置了该厂商的 `client_id`（`27` §10.7.6 路线 1）。 */
  private hasBuiltinClientId(provider: string): boolean {
    const value = this.builtinClientIds[provider];
    return typeof value === 'string' && value.trim() !== '';
  }

  /**
   * 发一次 JSON 请求。
   *
   * 网络错误、HTTP 错误一律转成 `git_oauth_unavailable`；
   * **响应原文不进错误消息**（可能含令牌片段）。
   */
  private async requestJson(
    url: string,
    init: { method: 'GET' | 'POST'; headers: Record<string, string>; body?: string },
  ): Promise<{ ok: boolean; status: number; body: Record<string, unknown> }> {
    const request: RequestInit = {
      method: init.method,
      headers: init.headers,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    };
    if (init.body !== undefined) request.body = init.body;

    let response: Response;
    try {
      response = await this.fetchImpl(url, request);
    } catch {
      throw new GitAuthError(
        'git_oauth_unavailable',
        'cannot reach the authorization server; check the network connection or use an SSH key / access token instead',
      );
    }

    let text = '';
    try {
      text = await response.text();
    } catch {
      text = '';
    }
    let body: Record<string, unknown> = {};
    if (text.trim() !== '') {
      try {
        const parsed: unknown = JSON.parse(text);
        if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
          body = parsed as Record<string, unknown>;
        }
      } catch {
        // 非 JSON 响应按空处理，不把原文带回调用方。
      }
    }
    return { ok: response.ok, status: response.status, body };
  }
}
