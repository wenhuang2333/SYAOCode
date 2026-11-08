/**
 * 主进程凭据存储（`27` §10.7.4）。
 *
 * 位置：主进程。理由只有一条——**钥匙串只有主进程能碰**。
 *
 * 实现选择：Electron `safeStorage`（macOS 背后就是 Keychain，Windows 是 DPAPI，
 * Linux 是 libsecret/kwallet）。不引入 `keytar` 这类原生模块，避免 asarUnpack
 * 与平台重编译的额外风险。
 *
 * 红线（不可放宽）：
 *  - 加密后的密文落盘；**明文永远不落盘**；
 *  - 任何日志、错误消息、诊断包都不得包含凭据值或长度；
 *  - 渲染层只能"写入/清除/查询是否存在"，不能读回值——读取只发生在
 *    Host 执行 git 命令前的私有 IPC 请求里。
 */

import { app, safeStorage } from 'electron';
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

interface CredentialFile {
  /** entry → base64(encrypted) */
  readonly entries: Record<string, string>;
  /** entry → SSH 公钥（公开值，可直接展示/复制给托管方） */
  readonly sshPublicKeys: Record<string, string>;
}

const EMPTY: CredentialFile = { entries: {}, sshPublicKeys: {} };

export class KeychainStore {
  private readonly file: string;
  private cache: CredentialFile | undefined;

  constructor(directory = app.getPath('userData')) {
    this.file = path.join(directory, 'credentials.json');
  }

  /** `safeStorage` 是否可用；不可用时界面必须提示"本次不持久化"。 */
  available(): boolean {
    try {
      return safeStorage.isEncryptionAvailable();
    } catch {
      return false;
    }
  }

  private load(): CredentialFile {
    if (this.cache !== undefined) return this.cache;
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8')) as Partial<CredentialFile>;
      this.cache = {
        entries: typeof raw.entries === 'object' && raw.entries !== null ? raw.entries : {},
        sshPublicKeys: typeof raw.sshPublicKeys === 'object' && raw.sshPublicKeys !== null ? raw.sshPublicKeys : {},
      };
    } catch {
      this.cache = { ...EMPTY };
    }
    return this.cache;
  }

  private persist(data: CredentialFile): void {
    this.cache = data;
    const dir = path.dirname(this.file);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.${randomBytes(6).toString('hex')}.tmp`;
    // 0600：只有当前用户可读写。
    fs.writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }

  get(entry: string): string | undefined {
    const stored = this.load().entries[entry];
    if (stored === undefined) return undefined;
    if (!this.available()) return undefined;
    try {
      return safeStorage.decryptString(Buffer.from(stored, 'base64'));
    } catch {
      return undefined;
    }
  }

  set(entry: string, value: string): void {
    if (!this.available()) throw new Error('credential storage is not available on this machine');
    const data = this.load();
    this.persist({
      entries: { ...data.entries, [entry]: safeStorage.encryptString(value).toString('base64') },
      sshPublicKeys: data.sshPublicKeys,
    });
  }

  delete(entry: string): void {
    const data = this.load();
    const entries = { ...data.entries };
    const sshPublicKeys = { ...data.sshPublicKeys };
    delete entries[entry];
    delete sshPublicKeys[entry];
    this.persist({ entries, sshPublicKeys });
  }

  has(entry: string): boolean {
    return this.load().entries[entry] !== undefined;
  }

  publicKey(entry: string): string | undefined {
    return this.load().sshPublicKeys[entry];
  }

  setPublicKey(entry: string, publicKey: string): void {
    const data = this.load();
    this.persist({ entries: data.entries, sshPublicKeys: { ...data.sshPublicKeys, [entry]: publicKey } });
  }

  /** 诊断用：条目名列表（不含值）。 */
  list(): string[] {
    return Object.keys(this.load().entries);
  }
}

// ── SSH 密钥（生成 / 导入 / 物化）───────────────────────────────────────

const SSH_ED25519_WIRE_PREFIX = 'ssh-ed25519';

function sshString(value: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(value.length, 0);
  return Buffer.concat([length, value]);
}

/** 把 32 字节 raw 公钥编成 OpenSSH 公钥行（`ssh-ed25519 AAAA... comment`）。 */
function openSshPublicKey(raw: Buffer, comment = 'liwencode'): string {
  const type = Buffer.from(SSH_ED25519_WIRE_PREFIX, 'utf8');
  const blob = Buffer.concat([sshString(type), sshString(raw)]);
  return `${SSH_ED25519_WIRE_PREFIX} ${blob.toString('base64')} ${comment}`.trim();
}

/** OpenSSH 指纹：`SHA256:` + base64(sha256(blob))，去掉尾部 `=`。 */
function openSshFingerprint(publicKeyLine: string): string {
  const parts = publicKeyLine.trim().split(/\s+/);
  const blob = Buffer.from(parts[1] ?? '', 'base64');
  return `SHA256:${createHash('sha256').update(blob).digest('base64').replace(/=+$/, '')}`;
}

/** 从私钥（PEM 或 OpenSSH 格式）推导公钥行。无法解析时抛错。 */
export function publicKeyFromPrivate(privateKeyPem: string, passphrase?: string): { publicKey: string; fingerprint: string } {
  const trimmed = privateKeyPem.trim();
  if (trimmed.startsWith('-----BEGIN OPENSSH PRIVATE KEY-----')) {
    const raw = parseOpenSshPrivate(trimmed);
    const line = openSshPublicKey(raw);
    return { publicKey: line, fingerprint: openSshFingerprint(line) };
  }
  const key = createPrivateKey({ key: trimmed, ...(passphrase !== undefined ? { passphrase } : {}), format: 'pem' });
  const pub = createPublicKey(key);
  const jwk = pub.export({ format: 'jwk' }) as { kty?: string; crv?: string; x?: string };
  if (jwk.kty !== 'OKP' || jwk.crv !== 'Ed25519' || typeof jwk.x !== 'string') {
    throw new Error('only ed25519 keys are supported');
  }
  const raw = Buffer.from(jwk.x, 'base64url');
  const line = openSshPublicKey(raw);
  return { publicKey: line, fingerprint: openSshFingerprint(line) };
}

/**
 * 解析 OpenSSH 私钥（`openssh-key-v1`）只取其中的公钥部分。
 *
 * 格式：magic "openssh-key-v1\0" + string cipher + string kdf + string kdfopts
 *       + uint32 nkeys + string publickey(blob) + string encrypted_private
 */
function parseOpenSshPrivate(pem: string): Buffer {
  const body = pem
    .replace('-----BEGIN OPENSSH PRIVATE KEY-----', '')
    .replace('-----END OPENSSH PRIVATE KEY-----', '')
    .replace(/\s+/g, '');
  const data = Buffer.from(body, 'base64');
  const magic = Buffer.from('openssh-key-v1\0', 'utf8');
  if (!data.subarray(0, magic.length).equals(magic)) throw new Error('invalid openssh private key');
  let offset = magic.length;
  const readString = (): Buffer => {
    const length = data.readUInt32BE(offset);
    offset += 4;
    const value = data.subarray(offset, offset + length);
    offset += length;
    return value;
  };
  const cipher = readString();
  const kdf = readString();
  readString(); // kdfoptions
  const nkeys = data.readUInt32BE(offset);
  offset += 4;
  if (nkeys < 1) throw new Error('openssh private key contains no keys');
  const pub = readString();
  if (cipher.toString() !== 'none' || kdf.toString() !== 'none') {
    // 加密的 OpenSSH 私钥：Node 无内建解密，诚实拒绝而不是假装成功。
    throw new Error('encrypted openssh private keys are not supported; export an unencrypted key or use PEM');
  }
  // pub = string("ssh-ed25519") + string(32-byte key)
  let p = 0;
  const typeLen = pub.readUInt32BE(p);
  p += 4;
  const type = pub.subarray(p, p + typeLen).toString();
  p += typeLen;
  const keyLen = pub.readUInt32BE(p);
  p += 4;
  const key = pub.subarray(p, p + keyLen);
  if (type !== SSH_ED25519_WIRE_PREFIX || key.length !== 32) throw new Error('only ed25519 keys are supported');
  return Buffer.from(key);
}

/** 生成新的 ed25519 密钥对；私钥以 PKCS#8 PEM 返回（只交给 KeychainStore）。 */
export function generateEd25519(comment = 'liwencode'): { publicKey: string; fingerprint: string; privateKeyPem: string } {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const privateKeyPem = privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
  const jwk = publicKey.export({ format: 'jwk' }) as { x?: string };
  if (typeof jwk.x !== 'string') throw new Error('cannot export ed25519 public key');
  const raw = Buffer.from(jwk.x, 'base64url');
  const line = openSshPublicKey(raw, comment);
  return { publicKey: line, fingerprint: openSshFingerprint(line), privateKeyPem };
}

/**
 * 推送期间把私钥物化成 `0600` 临时文件（`27` §10.7.4）。
 *
 * 用完必须 `disposeSshKeyFile`；Host 侧在 `finally` 里调用。
 */
export function materializeSshKeyFile(privateKeyPem: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'liwencode-ssh-'));
  const file = path.join(dir, 'id_ed25519');
  fs.writeFileSync(file, privateKeyPem, { mode: 0o600 });
  return file;
}

/** 删除临时私钥文件（含所在目录）。 */
export function disposeSshKeyFile(file: string): void {
  try {
    fs.rmSync(path.dirname(file), { recursive: true, force: true });
  } catch {
    /* 清理失败不阻断上传结果 */
  }
}

/** 脱敏：错误消息里不允许出现密钥材料。 */
export function redactKeyMaterial(message: string): string {
  return message.replace(/-----BEGIN[^-]+-----[\s\S]*?-----END[^-]+-----/g, '***').slice(0, 512);
}
