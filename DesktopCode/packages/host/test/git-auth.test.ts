/**
 * 凭据与登录方式（`27` §10.7 / TC-N-027、028、039…045）的单元测试。
 *
 * 不联网：
 *  - 设备码授权用 `node:http` 启的**本地模拟授权服务器**（通过注入 `fetchImpl`
 *    把 `https://github.test` 改写到本地回环）；
 *  - SSH agent 用 PATH 里的假 `ssh-add` 脚本（不依赖本机真的跑着 ssh-agent）。
 *
 * 所有断言都围绕两条红线：**凭据不出返回值**、**device_code 不出 Host**。
 */

import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { createServer, type IncomingMessage } from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MemoryCredentialProvider, keychainEntryFor, type CredentialBridge } from '../src/credentials.ts';
import { GitAuthError, GitAuthService, hostFromRemoteUrl } from '../src/git-auth.ts';

// ── 本地模拟授权服务器 ───────────────────────────────────────────────────

interface RecordedRequest {
  readonly path: string;
  readonly body: string;
}

interface MockAuthServer {
  readonly base: string;
  readonly requests: RecordedRequest[];
  readonly deviceCode: string;
  readonly token: string;
  close(): Promise<void>;
}

/** 假令牌：形态与 GitHub 令牌一致，便于断言脱敏。 */
const TOKEN = `gho_${'A'.repeat(36)}`;
/** 假设备码：任何返回值里都不允许出现它。 */
const DEVICE_CODE = 'device-code-5ecret-value';

interface MockServerOptions {
  /** 按调用次数依次返回的令牌端点响应；用完后一直返回 `authorization_pending`。 */
  readonly poll: readonly Record<string, unknown>[];
  /** `/user` 的行为：登录名，或 `'fail'`（模拟查不到账号）。 */
  readonly user?: string | 'fail';
  /** 设备码有效期（秒），用于本地过期用例。 */
  readonly expiresIn?: number;
}

async function startAuthServer(opts: MockServerOptions): Promise<MockAuthServer> {
  const requests: RecordedRequest[] = [];
  let pollIndex = 0;
  const server = createServer((req: IncomingMessage, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      const requestPath = (req.url ?? '').split('?')[0] ?? '';
      requests.push({ path: requestPath, body });
      const json = (status: number, payload: unknown): void => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(payload));
      };
      if (requestPath === '/login/device/code') {
        json(200, {
          device_code: DEVICE_CODE,
          user_code: 'ABCD-1234',
          verification_uri: 'https://github.test/login/device',
          expires_in: opts.expiresIn ?? 900,
          interval: 0,
        });
        return;
      }
      if (requestPath === '/login/oauth/access_token') {
        const next = opts.poll[pollIndex] ?? { error: 'authorization_pending' };
        pollIndex += 1;
        json(200, next);
        return;
      }
      if (requestPath === '/api/v3/user') {
        if (opts.user === 'fail') {
          json(500, { message: 'boom' });
          return;
        }
        json(200, { login: opts.user ?? 'octocat' });
        return;
      }
      json(404, { error: 'not_found' });
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  return {
    base: `http://127.0.0.1:${port}`,
    requests,
    deviceCode: DEVICE_CODE,
    token: TOKEN,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error === undefined ? resolve() : reject(error)));
      }),
  };
}

/** 把 `https://github.test/...` 改写到本地模拟服务器的 fetch。 */
function serverFetch(mock: MockAuthServer): typeof fetch {
  return async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    return await fetch(url.replace(/^https:\/\/github\.test/, mock.base), init);
  };
}

/** 按公钥行（`ssh-ed25519 AAAA... comment`）算 OpenSSH 风格 SHA256 指纹。 */
function fingerprintOf(publicKeyLine: string): string {
  const blob = Buffer.from(publicKeyLine.trim().split(/\s+/)[1] ?? '', 'base64');
  return `SHA256:${createHash('sha256').update(blob).digest('base64').replace(/=+$/, '')}`;
}

const PUBLIC_KEY = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl test@example';

const servers: MockAuthServer[] = [];
const tempDirs: string[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
  for (const dir of tempDirs.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

async function mockServer(opts: MockServerOptions): Promise<MockAuthServer> {
  const server = await startAuthServer(opts);
  servers.push(server);
  return server;
}

/** 在 PATH 前面放一个假 `ssh-add`，跑完恢复。 */
async function withFakeSshAdd(script: string, run: () => Promise<void>): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'liwen-fake-ssh-'));
  tempDirs.push(dir);
  await fs.writeFile(path.join(dir, 'ssh-add'), script, { mode: 0o755 });
  const original = process.env['PATH'];
  process.env['PATH'] = `${dir}${path.delimiter}${original ?? ''}`;
  try {
    await run();
  } finally {
    if (original === undefined) delete process.env['PATH'];
    else process.env['PATH'] = original;
  }
}

// ── 设备码授权 ──────────────────────────────────────────────────────────

describe('OAuth 设备码流程（TC-N-039 / TC-N-040 / TC-N-041）', () => {
  it('start 只给用户码与授权页；poll 依次 pending → ready；令牌只进钥匙串', async () => {
    const mock = await mockServer({
      poll: [{ error: 'authorization_pending' }, { access_token: TOKEN, token_type: 'bearer', scope: 'repo' }],
      user: 'octocat',
    });
    const credentials = new MemoryCredentialProvider();
    const service = new GitAuthService({ credentials, fetchImpl: serverFetch(mock), builtinClientIds: { github: 'test-client' } });

    const started = await service.startOauth({ workspaceRoot: '/w', remote: 'origin', provider: 'github', domain: 'github.test' });

    // TC-N-039：返回里**没有 deviceCode**，只有用户码与授权页地址。
    expect(Object.keys(started).sort()).toEqual(['expiresIn', 'flowId', 'interval', 'userCode', 'verificationUri']);
    expect(started.userCode).toBe('ABCD-1234');
    expect(started.verificationUri).toBe('https://github.test/login/device');
    expect(started.expiresIn).toBe(900);
    expect(JSON.stringify(started)).not.toContain(DEVICE_CODE);

    // 公共客户端：设备码请求只带 client_id + 最小 scope，**没有 client_secret**。
    const deviceRequest = mock.requests.find((request) => request.path === '/login/device/code');
    expect(deviceRequest?.body).toContain('client_id=test-client');
    expect(deviceRequest?.body).toContain('scope=repo');
    expect(deviceRequest?.body).not.toContain('client_secret');
    expect(deviceRequest?.body).not.toContain('admin');

    // 授权进行中：状态是 oauth 但还没就绪（configured=false）。
    const pendingStatus = await service.status('/w', [{ name: 'origin', url: 'https://github.test/o/r.git' }]);
    expect(pendingStatus.remotes[0]?.auth).toMatchObject({ method: 'oauth', configured: false, ready: false });

    const first = await service.pollOauth(started.flowId);
    expect(first).toEqual({ status: 'pending', account: null, scope: [] });

    const second = await service.pollOauth(started.flowId);
    expect(second).toEqual({ status: 'ready', account: 'octocat', scope: ['repo'] });

    // 令牌只进凭据通道：返回值里没有令牌，钥匙串里是它。
    expect(JSON.stringify([first, second])).not.toContain(TOKEN);
    expect(await credentials.get(keychainEntryFor('github.test', 'oauth'))).toBe(TOKEN);

    // 轮询请求同样不带 client_secret，且用 device_code + grant_type。
    const pollRequest = mock.requests.find((request) => request.path === '/login/oauth/access_token');
    expect(pollRequest?.body).toContain('grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Adevice_code');
    expect(pollRequest?.body).toContain(`device_code=${encodeURIComponent(DEVICE_CODE)}`);
    expect(pollRequest?.body).not.toContain('client_secret');

    // 就绪后 status 显示已配置，但**没有令牌**。
    const readyStatus = await service.status('/w', [{ name: 'origin', url: 'https://github.test/o/r.git' }]);
    expect(readyStatus.remotes[0]?.auth).toMatchObject({
      method: 'oauth',
      configured: true,
      ready: true,
      account: 'octocat',
      scope: ['repo'],
    });
    expect(JSON.stringify(readyStatus)).not.toContain(TOKEN);
  });

  it('用户在浏览器拒绝 → denied，条目清空、状态回到 none（TC-N-040）', async () => {
    const mock = await mockServer({ poll: [{ error: 'access_denied' }] });
    const credentials = new MemoryCredentialProvider();
    const service = new GitAuthService({ credentials, fetchImpl: serverFetch(mock), builtinClientIds: { github: 'test-client' } });

    const started = await service.startOauth({ workspaceRoot: '/w', remote: 'origin', provider: 'github', domain: 'github.test' });
    expect(await service.pollOauth(started.flowId)).toEqual({ status: 'denied', account: null, scope: [] });

    // 不残留半成品条目。
    expect(await credentials.get(keychainEntryFor('github.test', 'oauth'))).toBeUndefined();
    const status = await service.status('/w', [{ name: 'origin', url: 'https://github.test/o/r.git' }]);
    expect(status.remotes[0]?.auth).toMatchObject({ method: 'none', configured: false, ready: false, account: null });

    // 再 poll 仍是终态，不会重新开始。
    expect((await service.pollOauth(started.flowId)).status).toBe('denied');
  });

  it('设备码过期 → expired，不残留条目（TC-N-041）', async () => {
    const mock = await mockServer({ poll: [{ error: 'expired_token' }] });
    const credentials = new MemoryCredentialProvider();
    const service = new GitAuthService({ credentials, fetchImpl: serverFetch(mock), builtinClientIds: { github: 'test-client' } });

    const started = await service.startOauth({ workspaceRoot: '/w', remote: 'origin', provider: 'github', domain: 'github.test' });
    expect(await service.pollOauth(started.flowId)).toEqual({ status: 'expired', account: null, scope: [] });
    expect(await credentials.get(keychainEntryFor('github.test', 'oauth'))).toBeUndefined();
    const status = await service.status('/w', [{ name: 'origin', url: 'https://github.test/o/r.git' }]);
    expect(status.remotes[0]?.auth.method).toBe('none');
  });

  it('本地判定过期：不再打授权服务器，直接 expired', async () => {
    const mock = await mockServer({ poll: [], expiresIn: 0 });
    const service = new GitAuthService({
      credentials: new MemoryCredentialProvider(),
      fetchImpl: serverFetch(mock),
      builtinClientIds: { github: 'test-client' },
    });

    const started = await service.startOauth({ workspaceRoot: '/w', remote: 'origin', provider: 'github', domain: 'github.test' });
    expect(await service.pollOauth(started.flowId)).toEqual({ status: 'expired', account: null, scope: [] });
    expect(mock.requests.some((request) => request.path === '/login/oauth/access_token')).toBe(false);
  });

  it('slow_down 原样返回，并要求放慢轮询', async () => {
    const mock = await mockServer({ poll: [{ error: 'slow_down' }] });
    const service = new GitAuthService({
      credentials: new MemoryCredentialProvider(),
      fetchImpl: serverFetch(mock),
      builtinClientIds: { github: 'test-client' },
    });
    const started = await service.startOauth({ workspaceRoot: '/w', remote: 'origin', provider: 'github', domain: 'github.test' });
    expect((await service.pollOauth(started.flowId)).status).toBe('slow_down');
  });

  it('查不到账号时返回 null，不伪造账号', async () => {
    const mock = await mockServer({
      poll: [{ access_token: TOKEN, token_type: 'bearer', scope: 'repo' }],
      user: 'fail',
    });
    const service = new GitAuthService({
      credentials: new MemoryCredentialProvider(),
      fetchImpl: serverFetch(mock),
      builtinClientIds: { github: 'test-client' },
    });
    const started = await service.startOauth({ workspaceRoot: '/w', remote: 'origin', provider: 'github', domain: 'github.test' });
    expect(await service.pollOauth(started.flowId)).toEqual({ status: 'ready', account: null, scope: ['repo'] });
  });

  it('cancelOauth 之后流程不可再轮询', async () => {
    const mock = await mockServer({ poll: [{ error: 'authorization_pending' }] });
    const service = new GitAuthService({
      credentials: new MemoryCredentialProvider(),
      fetchImpl: serverFetch(mock),
      builtinClientIds: { github: 'test-client' },
    });
    const started = await service.startOauth({ workspaceRoot: '/w', remote: 'origin', provider: 'github', domain: 'github.test' });
    expect(await service.cancelOauth(started.flowId)).toEqual({ cancelled: true });

    const error = await service.pollOauth(started.flowId).catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(GitAuthError);
    expect((error as GitAuthError).kind).toBe('git_oauth_unavailable');
  });
});

// ── 厂商与前置条件 ──────────────────────────────────────────────────────

describe('厂商列表与 client_id 三条路线（§10.7.6）', () => {
  it('providers：GitHub 先做且支持设备码，GitLab / Gitee 占位', () => {
    const service = new GitAuthService({ credentials: new MemoryCredentialProvider() });
    expect(service.providers()).toEqual([
      { id: 'github', label: 'GitHub', deviceFlow: true, builtinClientId: false },
      { id: 'gitlab', label: 'GitLab', deviceFlow: false, builtinClientId: false },
      { id: 'gitee', label: 'Gitee', deviceFlow: false, builtinClientId: false },
    ]);
  });

  it('内置 client_id 决定 builtinClientId 标记', () => {
    const service = new GitAuthService({
      credentials: new MemoryCredentialProvider(),
      builtinClientIds: { github: 'builtin-client-id' },
    });
    expect(service.providers()[0]?.builtinClientId).toBe(true);
  });

  it('没有 client_id → git_oauth_unavailable，并提示改用 SSH / 令牌', async () => {
    const service = new GitAuthService({ credentials: new MemoryCredentialProvider() });
    const error = await service
      .startOauth({ workspaceRoot: '/w', remote: 'origin', provider: 'github' })
      .catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(GitAuthError);
    expect((error as GitAuthError).kind).toBe('git_oauth_unavailable');
    expect((error as GitAuthError).message).toMatch(/SSH key|access token/);
  });

  it('占位厂商不支持设备码流程', async () => {
    const service = new GitAuthService({
      credentials: new MemoryCredentialProvider(),
      builtinClientIds: { gitlab: 'x' },
    });
    const error = await service
      .startOauth({ workspaceRoot: '/w', remote: 'origin', provider: 'gitlab' })
      .catch((thrown: unknown) => thrown);
    expect((error as GitAuthError).kind).toBe('git_oauth_unavailable');
  });

  it('网络不可达 → git_oauth_unavailable，错误消息不回显令牌', async () => {
    const service = new GitAuthService({
      credentials: new MemoryCredentialProvider(),
      builtinClientIds: { github: 'test-client' },
      fetchImpl: () => Promise.reject(new Error(`boom ${TOKEN}`)),
    });
    const error = await service
      .startOauth({ workspaceRoot: '/w', remote: 'origin', provider: 'github', domain: 'github.test' })
      .catch((thrown: unknown) => thrown);
    expect((error as GitAuthError).kind).toBe('git_oauth_unavailable');
    expect((error as GitAuthError).message).not.toContain(TOKEN);
    expect((error as GitAuthError).message).toMatch(/network|authorization server/);
  });

  it('GitAuthError 的消息统一脱敏（TC-N-028）', () => {
    const error = new GitAuthError('git_auth_failed', `token=${TOKEN} rejected`);
    expect(error.message).not.toContain(TOKEN);
    expect(error.message).toContain('***');
  });
});

// ── SSH agent ───────────────────────────────────────────────────────────

describe('SSH agent（方式 B / TC-N-044、045）', () => {
  it.skipIf(process.platform === 'win32')('有身份时只返回指纹，不读私钥内容', async () => {
    await withFakeSshAdd(`#!/bin/sh\necho '${PUBLIC_KEY}'\n`, async () => {
      const service = new GitAuthService({ credentials: new MemoryCredentialProvider() });
      const info = await service.useSshAgent({ workspaceRoot: '/w', remote: 'origin' });
      expect(info).toMatchObject({ method: 'ssh-agent', configured: true, ready: true, account: null, scope: [] });
      expect(info.keyFingerprint).toBe(fingerprintOf(PUBLIC_KEY));
      expect(JSON.stringify(info)).not.toContain('PRIVATE KEY');
    });
  });

  it.skipIf(process.platform === 'win32')('没有可用身份 → git_ssh_key_invalid', async () => {
    await withFakeSshAdd(`#!/bin/sh\necho 'The agent has no identities.' >&2\nexit 1\n`, async () => {
      const service = new GitAuthService({ credentials: new MemoryCredentialProvider() });
      const error = await service.useSshAgent({ workspaceRoot: '/w', remote: 'origin' }).catch((thrown: unknown) => thrown);
      expect(error).toBeInstanceOf(GitAuthError);
      expect((error as GitAuthError).kind).toBe('git_ssh_key_invalid');
    });
  });

  it.skipIf(process.platform === 'win32')('agent 身份进入 status（ssh-agent 不落凭据）', async () => {
    await withFakeSshAdd(`#!/bin/sh\necho '${PUBLIC_KEY}'\n`, async () => {
      const service = new GitAuthService({ credentials: new MemoryCredentialProvider() });
      await service.useSshAgent({ workspaceRoot: '/w', remote: 'origin' });
      const status = await service.status('/w', [{ name: 'origin', url: 'https://github.com/o/r.git' }]);
      expect(status.remotes[0]?.auth).toMatchObject({ method: 'ssh-agent', configured: true, ready: true });
      expect(status.remotes[0]?.auth.keyFingerprint).toBe(fingerprintOf(PUBLIC_KEY));
    });
  });
});

// ── 生成密钥 ────────────────────────────────────────────────────────────

describe('生成 SSH 密钥（方式 D / TC-N-045）', () => {
  it('只返回公钥与指纹，私钥进钥匙串', async () => {
    const credentials = new MemoryCredentialProvider();
    const service = new GitAuthService({ credentials });
    const result = await service.generateSshKey({ workspaceRoot: '/w', remote: 'origin', comment: 'liwencode-test' });

    expect(result.keyType).toBe('ed25519');
    expect(result.publicKey.startsWith('ssh-ed25519 ')).toBe(true);
    expect(result.publicKey.endsWith(' liwencode-test')).toBe(true);
    expect(result.fingerprint).toBe(fingerprintOf(result.publicKey));
    expect(Object.keys(result).sort()).toEqual(['fingerprint', 'keyType', 'publicKey']);
    expect(JSON.stringify(result)).not.toContain('PRIVATE KEY');

    // 私钥确实写进了凭据通道，但没有出现在返回值里。
    const stored = await credentials.get(keychainEntryFor('github.com', 'ssh-key'));
    expect(stored).toContain('BEGIN PRIVATE KEY');
    expect(JSON.stringify(result)).not.toContain(stored ?? '');

    // 状态显示 ssh-key + 指纹。
    const status = await service.status('/w', [{ name: 'origin', url: 'https://github.com/o/r.git' }]);
    expect(status.remotes[0]?.auth).toMatchObject({
      method: 'ssh-key',
      configured: true,
      ready: true,
      keyFingerprint: result.fingerprint,
    });
    expect(JSON.stringify(status)).not.toContain('PRIVATE KEY');
  });

  it('钥匙串不可用 → git_credential_unavailable', async () => {
    const service = new GitAuthService({ credentials: new MemoryCredentialProvider({ available: false }) });
    const error = await service
      .generateSshKey({ workspaceRoot: '/w', remote: 'origin' })
      .catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(GitAuthError);
    expect((error as GitAuthError).kind).toBe('git_credential_unavailable');
  });
});

// ── 状态与清除 ──────────────────────────────────────────────────────────

// ── 导入已有私钥（方式 C）／访问令牌（方式 E）／hydrate ──────────────────

/** SSH wire 格式的长度前缀字符串（测试里独立算指纹用）。 */
function sshString(value: string | Buffer): Buffer {
  const body = typeof value === 'string' ? Buffer.from(value, 'utf8') : value;
  const length = Buffer.alloc(4);
  length.writeUInt32BE(body.length, 0);
  return Buffer.concat([length, body]);
}

/** 由私钥（可带口令）算 OpenSSH 指纹：测试侧独立实现，避免与被测代码共用逻辑。 */
function fingerprintFromPrivateKey(privateKeyPem: string, passphrase?: string): string {
  const keyObject =
    passphrase === undefined
      ? createPrivateKey(privateKeyPem)
      : createPrivateKey({ key: privateKeyPem, passphrase });
  const jwk = createPublicKey(keyObject).export({ format: 'jwk' });
  const blob = Buffer.concat([sshString('ssh-ed25519'), sshString(Buffer.from(jwk.x ?? '', 'base64url'))]);
  return `SHA256:${createHash('sha256').update(blob).digest('base64').replace(/=+$/, '')}`;
}

/** 造一把 ed25519 私钥（PKCS8 PEM），可带口令。 */
function makePrivateKeyPem(passphrase?: string): string {
  const { privateKey } = generateKeyPairSync('ed25519');
  const exported =
    passphrase === undefined
      ? privateKey.export({ type: 'pkcs8', format: 'pem' })
      : privateKey.export({ type: 'pkcs8', format: 'pem', cipher: 'aes-256-cbc', passphrase });
  return typeof exported === 'string' ? exported : exported.toString('utf8');
}

/** 假的主进程凭据桥：私钥只经它走，Host 不该自己落盘。 */
class FakeCredentialBridge extends MemoryCredentialProvider implements CredentialBridge {
  readonly imported: { entry: string; privateKey: string; passphrase: string | undefined }[] = [];

  async importSshKey(
    entry: string,
    privateKey: string,
    passphrase?: string,
  ): Promise<{ fingerprint: string; keyType: string }> {
    this.imported.push({ entry, privateKey, passphrase });
    return { fingerprint: 'SHA256:bridge-fingerprint', keyType: 'ssh-ed25519' };
  }

  async generateSshKey(): Promise<{ publicKey: string; fingerprint: string; keyType: 'ed25519' }> {
    return { publicKey: 'ssh-ed25519 AAAA bridge', fingerprint: 'SHA256:bridge-generated', keyType: 'ed25519' };
  }

  async materializeSshKeyFile(): Promise<string | undefined> {
    return undefined;
  }

  async disposeSshKeyFile(): Promise<void> {
    /* 测试桩 */
  }
}

describe('导入已有私钥（方式 C / TC-N-042、043）', () => {
  it('无桥时：Host 校验格式并写凭据，只返回方式与指纹', async () => {
    const privateKeyPem = makePrivateKeyPem();
    const credentials = new MemoryCredentialProvider();
    const service = new GitAuthService({ credentials });

    const info = await service.importSshKey({ workspaceRoot: '/w', remote: 'origin', privateKey: privateKeyPem });

    expect(info).toMatchObject({ method: 'ssh-key', configured: true, ready: true, account: null });
    expect(info.keyFingerprint).toBe(fingerprintFromPrivateKey(privateKeyPem));
    // 返回值里没有私钥；私钥只在凭据通道里。
    expect(JSON.stringify(info)).not.toContain('PRIVATE KEY');
    expect(await credentials.get(keychainEntryFor('github.com', 'ssh-key'))).toBe(privateKeyPem);

    const status = await service.status('/w', [{ name: 'origin', url: 'https://github.com/o/r.git' }]);
    expect(status.remotes[0]?.auth).toMatchObject({ method: 'ssh-key', keyFingerprint: info.keyFingerprint });
    expect(JSON.stringify(status)).not.toContain('PRIVATE KEY');
  });

  it('带口令私钥：口令正确可导入，错误口令只报 git_ssh_key_invalid', async () => {
    const passphrase = 'correct horse battery staple';
    const privateKeyPem = makePrivateKeyPem(passphrase);
    const credentials = new MemoryCredentialProvider();
    const service = new GitAuthService({ credentials });

    const ok = await service.importSshKey({ workspaceRoot: '/w', remote: 'origin', privateKey: privateKeyPem, passphrase });
    expect(ok.keyFingerprint).toBe(fingerprintFromPrivateKey(privateKeyPem, passphrase));

    const other = new GitAuthService({ credentials: new MemoryCredentialProvider() });
    const error = await other
      .importSshKey({ workspaceRoot: '/w', remote: 'origin', privateKey: privateKeyPem, passphrase: 'wrong-passphrase-xyz' })
      .catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(GitAuthError);
    expect((error as GitAuthError).kind).toBe('git_ssh_key_invalid');
    // 口令与私钥都不得出现在错误消息里。
    expect((error as GitAuthError).message).not.toContain('wrong-passphrase-xyz');
    expect((error as GitAuthError).message).not.toContain('PRIVATE KEY');
  });

  it('无法解析的私钥 → git_ssh_key_invalid', async () => {
    const service = new GitAuthService({ credentials: new MemoryCredentialProvider() });
    const error = await service
      .importSshKey({ workspaceRoot: '/w', remote: 'origin', privateKey: 'not-a-private-key' })
      .catch((thrown: unknown) => thrown);
    expect((error as GitAuthError).kind).toBe('git_ssh_key_invalid');
  });

  it('有主进程桥时：私钥与口令只交给桥，Host 不自己写凭据', async () => {
    const bridge = new FakeCredentialBridge();
    const service = new GitAuthService({ credentials: bridge });
    const privateKeyPem = makePrivateKeyPem();

    const info = await service.importSshKey({
      workspaceRoot: '/w',
      remote: 'origin',
      privateKey: privateKeyPem,
      passphrase: 'secret-pass',
    });

    expect(info.keyFingerprint).toBe('SHA256:bridge-fingerprint');
    expect(info.method).toBe('ssh-key');
    expect(bridge.imported).toHaveLength(1);
    expect(bridge.imported[0]?.entry).toBe(keychainEntryFor('github.com', 'ssh-key'));
    expect(bridge.imported[0]?.passphrase).toBe('secret-pass');
    // Host 没有自己写 ssh-key 条目（私钥留在主进程）。
    expect(await bridge.get(keychainEntryFor('github.com', 'ssh-key'))).toBeUndefined();
    expect(JSON.stringify(info)).not.toContain('PRIVATE KEY');
  });
});

describe('粘贴访问令牌（方式 E / TC-N-027）', () => {
  it('令牌只进凭据通道，返回值只有"已配置"', async () => {
    const token = `github_pat_${'D'.repeat(30)}`;
    const credentials = new MemoryCredentialProvider();
    const service = new GitAuthService({ credentials });

    const info = await service.setToken({ workspaceRoot: '/w', remote: 'origin', token });

    expect(info).toMatchObject({ method: 'token', configured: true, ready: true, account: null, scope: [] });
    expect(info.keyFingerprint).toBeNull();
    expect(JSON.stringify(info)).not.toContain(token);
    expect(await credentials.get(keychainEntryFor('github.com', 'token'))).toBe(token);

    const status = await service.status('/w', [{ name: 'origin', url: 'https://github.com/o/r.git' }]);
    expect(status.remotes[0]?.auth.method).toBe('token');
    expect(JSON.stringify(status)).not.toContain(token);
  });

  it('空令牌 / 含换行的令牌 → git_auth_required，不写任何条目', async () => {
    const credentials = new MemoryCredentialProvider();
    const service = new GitAuthService({ credentials });
    for (const token of ['   ', 'abc\ndef']) {
      const error = await service.setToken({ workspaceRoot: '/w', remote: 'origin', token }).catch((thrown: unknown) => thrown);
      expect((error as GitAuthError).kind).toBe('git_auth_required');
    }
    expect(await credentials.get(keychainEntryFor('github.com', 'token'))).toBeUndefined();
  });

  it('凭据通道不可用 → git_credential_unavailable', async () => {
    const service = new GitAuthService({ credentials: new MemoryCredentialProvider({ available: false }) });
    const error = await service
      .setToken({ workspaceRoot: '/w', remote: 'origin', token: 'ghp_validtoken' })
      .catch((thrown: unknown) => thrown);
    expect((error as GitAuthError).kind).toBe('git_credential_unavailable');
  });
});

describe('hydrate：重启后恢复元信息（不恢复凭据）', () => {
  it('补全账号 / scope / 时间，但"已配置"仍看钥匙串条目', async () => {
    const token = `gho_${'E'.repeat(36)}`;
    const credentials = new MemoryCredentialProvider({ seed: { [keychainEntryFor('github.com', 'oauth')]: token } });
    const service = new GitAuthService({ credentials });

    service.hydrate([{ method: 'oauth', account: 'octocat', scope: ['repo'], keyFingerprint: null, updatedAt: 1234 }]);

    const status = await service.status('/w', [{ name: 'origin', url: 'https://github.com/o/r.git' }]);
    expect(status.remotes[0]?.auth).toMatchObject({
      method: 'oauth',
      configured: true,
      ready: true,
      account: 'octocat',
      scope: ['repo'],
      updatedAt: 1234,
    });
    expect(JSON.stringify(status)).not.toContain(token);

    // 没有钥匙串条目时，hydrate 不会把状态伪造成"已配置"。
    const emptyService = new GitAuthService({ credentials: new MemoryCredentialProvider() });
    emptyService.hydrate([{ method: 'oauth', account: 'octocat', scope: ['repo'], keyFingerprint: null, updatedAt: 1234 }]);
    const emptyStatus = await emptyService.status('/w', [{ name: 'origin', url: 'https://github.com/o/r.git' }]);
    expect(emptyStatus.remotes[0]?.auth).toMatchObject({ method: 'none', configured: false, account: null });
  });

  it('按主机精确恢复：两个主机各自的账号不串', async () => {
    const credentials = new MemoryCredentialProvider({
      seed: {
        [keychainEntryFor('github.com', 'oauth')]: 'token-github',
        [keychainEntryFor('gitlab.com', 'oauth')]: 'token-gitlab',
      },
    });
    const service = new GitAuthService({ credentials });
    service.hydrate([
      { method: 'oauth', account: 'github-user', scope: ['repo'], keyFingerprint: null, updatedAt: 1, host: 'github.com' },
      { method: 'oauth', account: 'gitlab-user', scope: ['read_repository'], keyFingerprint: null, updatedAt: 2, host: 'gitlab.com' },
    ]);

    const status = await service.status('/w', [
      { name: 'origin', url: 'https://github.com/o/r.git' },
      { name: 'gl', url: 'https://gitlab.com/o/r.git' },
    ]);
    expect(status.remotes[0]?.auth.account).toBe('github-user');
    expect(status.remotes[1]?.auth.account).toBe('gitlab-user');
    expect(status.remotes[1]?.auth.scope).toEqual(['read_repository']);
  });

  it('按工作区 + 远端精确恢复，且 clear 会清掉灌回来的元信息', async () => {
    const credentials = new MemoryCredentialProvider({ seed: { [keychainEntryFor('github.com', 'token')]: 'ghp_x' } });
    const service = new GitAuthService({ credentials });
    service.hydrate([
      { method: 'token', account: 'work-account', scope: [], keyFingerprint: null, updatedAt: 9, workspaceRoot: '/w', remote: 'origin' },
    ]);

    const status = await service.status('/w', [{ name: 'origin', url: 'https://github.com/o/r.git' }]);
    expect(status.remotes[0]?.auth.account).toBe('work-account');

    await service.clear({ workspaceRoot: '/w', remote: 'origin' });
    await credentials.set(keychainEntryFor('github.com', 'token'), 'ghp_y');
    const after = await service.status('/w', [{ name: 'origin', url: 'https://github.com/o/r.git' }]);
    expect(after.remotes[0]?.auth.account).toBeNull();
  });

  it('method=none 的灌入被忽略', async () => {
    const credentials = new MemoryCredentialProvider({ seed: { [keychainEntryFor('github.com', 'token')]: 'ghp_x' } });
    const service = new GitAuthService({ credentials });
    service.hydrate([{ method: 'none', account: 'ghost', scope: [], keyFingerprint: null, updatedAt: 1 }]);
    const status = await service.status('/w', [{ name: 'origin', url: 'https://github.com/o/r.git' }]);
    expect(status.remotes[0]?.auth.account).toBeNull();
    expect(status.remotes[0]?.auth.method).toBe('token');
  });
});

describe('登录状态与断开连接（TC-N-027 / TC-N-042 / TC-N-043）', () => {
  it('status 只报"已配置"，且远端 URL 剥离内嵌凭据', async () => {
    const token = `ghp_${'B'.repeat(36)}`;
    const credentials = new MemoryCredentialProvider({ seed: { [keychainEntryFor('github.com', 'token')]: token } });
    const service = new GitAuthService({ credentials });

    const status = await service.status('/w', [
      { name: 'origin', url: 'https://user:secret@github.com/o/r.git' },
      { name: 'upstream', url: 'git@github.com:o/r.git' },
    ]);

    expect(status.remotes[0]).toMatchObject({ name: 'origin', url: 'https://github.com/o/r.git' });
    expect(status.remotes[0]?.auth).toMatchObject({
      method: 'token',
      configured: true,
      ready: true,
      account: null,
      keyFingerprint: null,
      updatedAt: null,
    });
    // 第二个远端同主机，同样显示已配置；没有任何令牌进入结果。
    expect(status.remotes[1]?.auth.method).toBe('token');
    expect(JSON.stringify(status)).not.toContain(token);
    expect(JSON.stringify(status)).not.toContain('secret');
    expect(status.workspaceRoot).toBe('/w');
    expect(status.providers.map((provider) => provider.id)).toEqual(['github', 'gitlab', 'gitee']);
  });

  it('clear 删除条目后 status 立刻回到 none', async () => {
    const token = `ghp_${'C'.repeat(36)}`;
    const credentials = new MemoryCredentialProvider({ seed: { [keychainEntryFor('github.com', 'oauth')]: token } });
    const service = new GitAuthService({ credentials });

    const before = await service.status('/w', [{ name: 'origin', url: 'https://github.com/o/r.git' }]);
    expect(before.remotes[0]?.auth.method).toBe('oauth');

    expect(await service.clear({ workspaceRoot: '/w', remote: 'origin' })).toEqual({ cleared: true });
    expect(await credentials.get(keychainEntryFor('github.com', 'oauth'))).toBeUndefined();

    const after = await service.status('/w', [{ name: 'origin', url: 'https://github.com/o/r.git' }]);
    expect(after.remotes[0]?.auth).toMatchObject({
      method: 'none',
      configured: false,
      ready: false,
      account: null,
      scope: [],
      keyFingerprint: null,
      updatedAt: null,
    });
  });

  it('授权成功后 clear 同样清掉钥匙串条目', async () => {
    const mock = await mockServer({ poll: [{ access_token: TOKEN, token_type: 'bearer', scope: 'repo' }], user: 'octocat' });
    const credentials = new MemoryCredentialProvider();
    const service = new GitAuthService({ credentials, fetchImpl: serverFetch(mock), builtinClientIds: { github: 'test-client' } });

    const started = await service.startOauth({ workspaceRoot: '/w', remote: 'origin', provider: 'github', domain: 'github.test' });
    await service.pollOauth(started.flowId);
    expect(await credentials.get(keychainEntryFor('github.test', 'oauth'))).toBe(TOKEN);

    await service.clear({ workspaceRoot: '/w', remote: 'origin' });
    expect(await credentials.get(keychainEntryFor('github.test', 'oauth'))).toBeUndefined();
    const status = await service.status('/w', [{ name: 'origin', url: 'https://github.test/o/r.git' }]);
    expect(status.remotes[0]?.auth.method).toBe('none');
  });

  it('凭据被外部删除时不谎报"已配置"', async () => {
    const credentials = new MemoryCredentialProvider();
    const service = new GitAuthService({ credentials });
    await service.generateSshKey({ workspaceRoot: '/w', remote: 'origin' });
    await credentials.delete(keychainEntryFor('github.com', 'ssh-key'));

    const status = await service.status('/w', [{ name: 'origin', url: 'https://github.com/o/r.git' }]);
    expect(status.remotes[0]?.auth.method).toBe('none');
    expect(status.remotes[0]?.auth.configured).toBe(false);
  });
});

// ── URL 主机解析 ────────────────────────────────────────────────────────

describe('远端 URL 主机解析', () => {
  it.each([
    ['https://github.com/o/r.git', 'github.com'],
    ['https://user:token@GitHub.com/o/r.git', 'github.com'],
    ['ssh://git@github.example.com:2222/o/r.git', 'github.example.com'],
    ['git@github.com:o/r.git', 'github.com'],
    ['github.com:o/r.git', 'github.com'],
    ['/tmp/local-repo', undefined],
    ['origin', undefined],
  ])('%s → %s', (url, expected) => {
    expect(hostFromRemoteUrl(url)).toBe(expected);
  });
});
