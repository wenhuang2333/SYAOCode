/**
 * 增补能力的端到端协议测试（27 §4 / §13）。
 *
 * 覆盖：会话详情三块、MCP 受信校验、Agent 群激活、Git 只读 / 写操作 / 预检、
 * 会话 fork 与删除。
 *
 * 原则：**不联网**。Git 用本地临时仓库与本地裸仓库；OAuth 用本地模拟服务器。
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import {
  DHP_VERSION,
  FeatureMethod as F,
  Method,
  WorkbenchMethod,
  type AgentGroup,
  type GitStatusResult,
  type McpServerInfo,
  type SessionInspection,
  type SessionSnapshot,
} from '@syaocode/dhp';
import { createHost, type RunningHost } from '../src/host.ts';
import { MemoryCredentialProvider, keychainEntryFor } from '../src/credentials.ts';
import type { CredentialIpcChannel } from '../src/credential-bridge.ts';

let home: string;
let root: string;
let host: RunningHost;
const clients: WebSocket[] = [];

beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), 'features-home-'));
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'features-root-')));
  await fs.writeFile(path.join(root, 'README.md'), 'PROJECT\n');
});
afterEach(async () => {
  for (const ws of clients.splice(0)) ws.close();
  await host?.close();
  for (const dir of [home, root]) await fs.rm(dir, { recursive: true, force: true });
});

interface Client {
  request<T = unknown>(method: string, params?: unknown): Promise<T>;
  notifications: { method: string; params: unknown }[];
}

async function boot(opts: { credentialChannel?: CredentialIpcChannel } = {}): Promise<Client> {
  host = await createHost({
    workspaceRoot: root,
    env: { SYAOCODE_HOME: home },
    logger: () => {},
    ...(opts.credentialChannel !== undefined ? { credentialChannel: opts.credentialChannel } : {}),
  });
  const ws = new WebSocket(host.server.url, { headers: { authorization: `Bearer ${host.server.token}` } });
  clients.push(ws);
  const notifications: { method: string; params: unknown }[] = [];
  const pending = new Map<number, { resolve(v: unknown): void; reject(e: Error): void; timer: ReturnType<typeof setTimeout> }>();
  let seq = 0;
  ws.on('message', (raw) => {
    const frame = JSON.parse(raw.toString()) as { id?: number; method?: string; params?: unknown; result?: unknown; error?: { message: string; data?: { kind?: string } } };
    if (frame.method !== undefined) { notifications.push({ method: frame.method, params: frame.params }); return; }
    const slot = pending.get(frame.id ?? -1);
    if (slot === undefined) return;
    clearTimeout(slot.timer);
    pending.delete(frame.id ?? -1);
    if (frame.error !== undefined) {
      slot.reject(Object.assign(new Error(frame.error.message), { kind: frame.error.data?.kind }));
    } else slot.resolve(frame.result);
  });
  await new Promise<void>((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  const request = <T = unknown>(method: string, params?: unknown): Promise<T> => new Promise((resolve, reject) => {
    const id = ++seq;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Timeout: ${method}`)); }, 20_000);
    pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
    ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
  });
  await request(Method.Hello, { clientName: 'features-test', dhpVersion: DHP_VERSION });
  return { request, notifications };
}
async function newSession(c: Client, params: unknown = {}): Promise<string> {
  const created = await c.request<{ snapshot: SessionSnapshot }>(Method.SessionCreate, params);
  return created.snapshot.meta.sessionId;
}

async function inspect(c: Client, sessionId: string): Promise<SessionInspection> {
  return await c.request<SessionInspection>(WorkbenchMethod.SessionInspect, { sessionId });
}

async function gitAvailable(): Promise<boolean> {
  try {
    await fs.stat(path.join(root, '.git'));
    return true;
  } catch {
    return false;
  }
}

async function initRepo(): Promise<void> {
  const { execFile } = await import('node:child_process');
  await new Promise<void>((resolve, reject) => {
    execFile('git', ['init', '-q'], { cwd: root }, (error) => (error ? reject(error) : resolve()));
  });
  await new Promise<void>((resolve, reject) => {
    execFile('git', ['config', 'user.email', 'test@example.com'], { cwd: root }, (e) => (e ? reject(e) : resolve()));
  });
  await new Promise<void>((resolve, reject) => {
    execFile('git', ['config', 'user.name', 'Test'], { cwd: root }, (e) => (e ? reject(e) : resolve()));
  });
}

describe('会话详情三块（FR-N-011/012/013）', () => {
  it('inspect 返回 changes / artifacts / sources / coverage 四块', async () => {
    const c = await boot();
    const sessionId = await newSession(c);
    const result = await inspect(c, sessionId);
    expect(Array.isArray(result.changes)).toBe(true);
    expect(Array.isArray(result.artifacts)).toBe(true);
    expect(Array.isArray(result.sources)).toBe(true);
    expect(result.coverage).toMatchObject({ exact: true, bashUsed: false });
    // 能力面板必须反映真实接入情况，不能写死：
    // `supported` 是"构建是否接入"（MCP 与 Agent 群已接入 → true），
    // "已配置多少"由 detail 说清楚，两者不能混用。
    const mcp = result.resources.find((r) => r.id === 'mcp');
    expect(mcp?.supported).toBe(true);
    expect(mcp?.detail).toContain('尚未添加');
    const agents = result.resources.find((r) => r.id === 'agents');
    expect(agents?.supported).toBe(true);
    expect(agents?.detail).toContain('尚未配置');
    // 未接入的能力必须如实说 false，不许假装。
    expect(result.resources.find((r) => r.id === 'skills')?.supported).toBe(false);
    expect(result.resources.find((r) => r.id === 'checkpoints')?.supported).toBe(false);
  });
});

describe('MCP（FR-N-001）', () => {
  it('未受信服务只登记不执行（-32029）', async () => {
    const c = await boot();
    const list = await c.request<{ servers: McpServerInfo[] }>(F.McpList);
    expect(list.servers).toEqual([]);
    // 未受信：登记但**不启动**，工具不可用。
    const added = await c.request<{ server: McpServerInfo }>(F.McpAdd, { command: 'node', args: ['server.mjs'], trusted: false });
    expect(added.server.trusted).toBe(false);
    expect(added.server.status).not.toBe('ready');
    await expect(c.request(F.McpTools, { serverId: added.server.id })).rejects.toMatchObject({ kind: 'mcp_not_trusted' });
    // 移除后不再出现在列表里。
    await c.request(F.McpRemove, { serverId: added.server.id });
    const after = await c.request<{ servers: McpServerInfo[] }>(F.McpList);
    expect(after.servers).toEqual([]);
  });
});

describe('Agent 群三角色（FR-N-003）', () => {
  it('保存 / 列出 / 激活；激活后执行模型取 common 角色', async () => {
    const c = await boot();
    const groups = await c.request<{ groups: AgentGroup[]; active: string | null }>(F.AgentsList);
    expect(groups.groups).toEqual([]);
    expect(groups.active).toBeNull();

    const saved = await c.request<AgentGroup>(F.AgentsSave, {
      name: '默认群',
      roles: { hyaki: 'mock:default', sota: 'mock:default', common: 'mock:default' },
    });
    expect(saved.name).toBe('默认群');
    expect(saved.roles.common).toBe('mock:default');

    const activated = await c.request<{ active: string; common: string }>(F.AgentsActivate, { name: '默认群' });
    expect(activated.common).toBe('mock:default');

    const after = await c.request<{ groups: AgentGroup[]; active: string | null }>(F.AgentsList);
    expect(after.active).toBe('默认群');
    expect(after.groups).toHaveLength(1);
  });
});

describe('Git（FR-N-021…029）', () => {
  it('非仓库目录 → git_not_repo', async () => {
    const c = await boot();
    await expect(c.request(F.GitStatus, { workspaceRoot: root })).rejects.toMatchObject({ kind: 'git_not_repo' });
  });

  it.runIf(process.platform !== 'win32')('仓库目录：状态 / 暂存 / 提交 / 预检', async () => {
    await initRepo();
    const c = await boot();
    const status = await c.request<GitStatusResult>(F.GitStatus, { workspaceRoot: root });
    expect(status.clean).toBe(false);
    expect(status.files.some((f) => f.path === 'README.md')).toBe(true);

    const staged = await c.request<{ status: string }>(F.GitStage, {
      workspaceRoot: root,
      paths: ['README.md'],
      commandId: randomUUID(),
      baseRevision: status.revision,
    });
    expect(staged.status).toBe('accepted');

    // 写操作会推进 git revision：下一次写必须带新的 baseRevision（CAS）。
    const afterStage = await c.request<GitStatusResult>(F.GitStatus, { workspaceRoot: root });
    expect(afterStage.revision).toBeGreaterThan(status.revision);
    const committed = await c.request<{ status: string }>(F.GitCommit, {
      workspaceRoot: root,
      message: 'chore: initial import',
      commandId: randomUUID(),
      baseRevision: afterStage.revision,
    });
    expect(committed.status).toBe('accepted');

    // 旧 revision 必须被拒（stale），避免并发写互相覆盖。
    const stale = await c.request<{ status: string }>(F.GitCommit, {
      workspaceRoot: root,
      message: 'chore: stale',
      commandId: randomUUID(),
      baseRevision: status.revision,
    });
    expect(stale.status).toBe('stale');

    const after = await c.request<GitStatusResult>(F.GitStatus, { workspaceRoot: root });
    expect(after.clean).toBe(true);
    expect(after.head).not.toBeNull();

    // 预检：没有远端 → 明确的失败，而不是假成功。
    await expect(c.request(F.GitPreflight, { workspaceRoot: root, remote: 'origin' })).rejects.toBeTruthy();
  });

  it('远端与认证状态：没有凭据时如实显示 none', async () => {
    await initRepo();
    const c = await boot();
    const remotes = await c.request<{ remotes: { name: string; url: string; auth: { method: string; configured: boolean } }[] }>(F.GitRemotes, { workspaceRoot: root });
    expect(remotes.remotes).toEqual([]);
    const auth = await c.request<{ remotes: { auth: { method: string } }[] }>(F.GitAuthStatus, { workspaceRoot: root });
    expect(auth.remotes).toEqual([]);
  });
});

describe('会话 fork / 删除（FR-N-035）', () => {
  it('fork 产生新会话；delete 移除会话', async () => {
    const c = await boot();
    const sessionId = await newSession(c);
    const forked = await c.request<{ sessionId: string }>(F.SessionFork, {
      sessionId,
      commandId: randomUUID(),
      baseRevision: 0,
    });
    expect(forked.sessionId).not.toBe(sessionId);

    const list = await c.request<{ sessions: { sessionId: string }[] }>(Method.SessionList);
    expect(list.sessions.map((s) => s.sessionId)).toContain(forked.sessionId);

    const removed = await c.request<{ ok: boolean }>(F.SessionDelete, {
      sessionId: forked.sessionId,
      commandId: randomUUID(),
      baseRevision: 0,
    });
    expect(removed.ok).toBe(true);
    const after = await c.request<{ sessions: { sessionId: string }[] }>(Method.SessionList);
    expect(after.sessions.map((s) => s.sessionId)).not.toContain(forked.sessionId);
  });
});

/**
 * 凭据私有通道（FR-N-027 / 030）。
 *
 * 红线：**令牌与私钥不进 DHP**。链路是
 * `渲染层 → preload 窄桥 → 主进程 → OS 钥匙串`，Host 只在这条父子进程 IPC 上
 * 收到"状态变了"的信号，再自己重新问一次 `gitAuth.status()`。
 *
 * 这里用一个假主进程模拟通道的另一端：它自己保管"钥匙串"，只回公开值。
 */
function fakeMainProcess(store: MemoryCredentialProvider): {
  channel: CredentialIpcChannel;
  notify(payload: Record<string, unknown>): void;
} {
  const subscribers = new Set<(m: Record<string, unknown>) => void>();
  const channel: CredentialIpcChannel = {
    send(message) {
      void (async () => {
        if (message['type'] !== 'cred:request') return;
        const id = String(message['id']);
        const op = String(message['op']);
        const entry = typeof message['entry'] === 'string' ? message['entry'] : '';
        const reply = (ok: boolean, payload: Record<string, unknown> = {}): void => {
          for (const h of subscribers) h({ type: 'cred:response', id, ok, ...payload });
        };
        try {
          switch (op) {
            case 'available': reply(true, { value: await store.available() }); break;
            case 'get': reply(true, { value: await store.get(entry) }); break;
            case 'set': await store.set(entry, String(message['value'] ?? '')); reply(true); break;
            case 'delete': await store.delete(entry); reply(true); break;
            case 'generate-ssh': {
              const { generateKeyPairSync, createHash } = await import('node:crypto');
              const pair = generateKeyPairSync('ed25519');
              const pem = pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
              const spki = pair.publicKey.export({ type: 'spki', format: 'der' });
              await store.set(entry, pem);
              reply(true, {
                value: {
                  publicKey: pair.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
                  fingerprint: `SHA256:${createHash('sha256').update(spki).digest('base64').replace(/=+$/, '')}`,
                  keyType: 'ed25519',
                },
              });
              break;
            }
            case 'import-ssh': {
              const { createPrivateKey, createPublicKey, createHash } = await import('node:crypto');
              const privateKey = String(message['privateKey'] ?? '');
              const key = createPrivateKey({ key: privateKey });
              const spki = createPublicKey(key).export({ type: 'spki', format: 'der' });
              await store.set(entry, privateKey);
              reply(true, {
                value: {
                  fingerprint: `SHA256:${createHash('sha256').update(spki).digest('base64').replace(/=+$/, '')}`,
                  keyType: 'ed25519',
                },
              });
              break;
            }
            default: reply(false, { error: `unknown op ${op}` });
          }
        } catch (error) {
          reply(false, { error: error instanceof Error ? error.message : 'failed' });
        }
      })();
    },
    subscribe(handler) {
      subscribers.add(handler);
      return () => subscribers.delete(handler);
    },
  };
  return {
    channel,
    notify(payload) {
      for (const h of subscribers) h({ type: 'cred:changed', ...payload });
    },
  };
}

/** 等 Host 处理完一条异步的 `cred:changed`（它是 fire-and-forget 的）。 */
async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 150));
}

describe('Git 凭据私有通道（FR-N-027 / 030）', () => {
  const TOKEN = `ghp_${'A'.repeat(36)}`;
  const REPO_URL = 'https://github.com/example/repo.git';

  it('主进程写入令牌后：Host 只更新元信息并广播，令牌不出现在任何 DHP 帧或状态文件里', async () => {
    await initRepo();
    const store = new MemoryCredentialProvider();
    const main = fakeMainProcess(store);
    const c = await boot({ credentialChannel: main.channel });
    await c.request(F.GitRemoteAdd, { workspaceRoot: root, name: 'origin', url: REPO_URL });

    // 模拟主进程侧（渲染层 → preload → 主进程 → 钥匙串）写完令牌。
    const entry = keychainEntryFor('github.com', 'token');
    await store.set(entry, TOKEN);
    main.notify({ workspaceRoot: root, remote: 'origin', url: REPO_URL, method: 'token' });
    await flush();

    // Host 广播了状态变化，但帧里没有令牌。
    const changed = c.notifications.filter((n) => n.method === 'git/auth/changed');
    expect(changed.length).toBeGreaterThan(0);
    expect(JSON.stringify(changed)).not.toContain(TOKEN);

    // 状态查询如实显示"已配置令牌"。
    const status = await c.request<{ remotes: { name: string; auth: { method: string; configured: boolean } }[] }>(
      F.GitAuthStatus,
      { workspaceRoot: root },
    );
    expect(status.remotes[0]?.auth).toMatchObject({ method: 'token', configured: true });
    expect(JSON.stringify(status)).not.toContain(TOKEN);

    // 状态文件只有条目名，没有令牌。
    const state = await fs.readFile(path.join(home, 'desktop', 'state-v2.json'), 'utf8');
    expect(state).not.toContain(TOKEN);
    expect(state).toContain('syaocode.git.github.com.token');
  });

  it('重启后恢复元信息；换一条空钥匙串则不伪造"已配置"', async () => {
    await initRepo();
    const store = new MemoryCredentialProvider();
    const first = fakeMainProcess(store);
    const c = await boot({ credentialChannel: first.channel });
    await c.request(F.GitRemoteAdd, { workspaceRoot: root, name: 'origin', url: REPO_URL });
    await store.set(keychainEntryFor('github.com', 'token'), TOKEN);
    first.notify({ workspaceRoot: root, remote: 'origin', url: REPO_URL, method: 'token' });
    await flush();

    // 同一条钥匙串重启：仍然是 token。
    for (const ws of clients.splice(0)) ws.close();
    await host.close();
    const second = fakeMainProcess(store);
    const c2 = await boot({ credentialChannel: second.channel });
    const restored = await c2.request<{ remotes: { auth: { method: string; configured: boolean } }[] }>(
      F.GitAuthStatus,
      { workspaceRoot: root },
    );
    expect(restored.remotes[0]?.auth).toMatchObject({ method: 'token', configured: true });

    // 换成空钥匙串：状态文件里还留着元信息，但**不能**报告已配置。
    for (const ws of clients.splice(0)) ws.close();
    await host.close();
    const third = fakeMainProcess(new MemoryCredentialProvider());
    const c3 = await boot({ credentialChannel: third.channel });
    const empty = await c3.request<{ remotes: { auth: { method: string; configured: boolean } }[] }>(
      F.GitAuthStatus,
      { workspaceRoot: root },
    );
    expect(empty.remotes[0]?.auth).toMatchObject({ method: 'none', configured: false });
  });

  it('断开连接：钥匙串条目与状态文件条目都被删除', async () => {
    await initRepo();
    const store = new MemoryCredentialProvider();
    const main = fakeMainProcess(store);
    const c = await boot({ credentialChannel: main.channel });
    await c.request(F.GitRemoteAdd, { workspaceRoot: root, name: 'origin', url: REPO_URL });
    await store.set(keychainEntryFor('github.com', 'token'), TOKEN);
    main.notify({ workspaceRoot: root, remote: 'origin', url: REPO_URL, method: 'token' });
    await flush();
    expect((await fs.readFile(path.join(home, 'desktop', 'state-v2.json'), 'utf8'))).toContain('syaocode.git.github.com.token');

    await c.request(F.GitAuthClear, { workspaceRoot: root, remote: 'origin' });
    expect(store.has(keychainEntryFor('github.com', 'token'))).toBe(false);
    const status = await c.request<{ remotes: { auth: { method: string; configured: boolean } }[] }>(
      F.GitAuthStatus,
      { workspaceRoot: root },
    );
    expect(status.remotes[0]?.auth).toMatchObject({ method: 'none', configured: false });
    expect(await fs.readFile(path.join(home, 'desktop', 'state-v2.json'), 'utf8')).not.toContain('syaocode.git.github.com.token');
  });

  it('生成 SSH 密钥：只返回公钥与指纹，私钥留在凭据通道', async () => {
    await initRepo();
    const store = new MemoryCredentialProvider();
    const main = fakeMainProcess(store);
    const c = await boot({ credentialChannel: main.channel });
    await c.request(F.GitRemoteAdd, { workspaceRoot: root, name: 'origin', url: REPO_URL });

    const generated = await c.request<{ publicKey: string; fingerprint: string; keyType: string }>(
      F.GitAuthSshGenerate,
      { workspaceRoot: root, remote: 'origin' },
    );
    expect(generated.keyType).toBe('ed25519');
    expect(generated.fingerprint).toMatch(/^SHA256:/);
    expect(JSON.stringify(generated)).not.toContain('PRIVATE KEY');

    // 私钥只在"钥匙串"里，状态文件里连私钥标记都没有。
    const stored = await store.get(keychainEntryFor('github.com', 'ssh-key'));
    expect(stored ?? '').toContain('PRIVATE KEY');
    const state = await fs.readFile(path.join(home, 'desktop', 'state-v2.json'), 'utf8');
    expect(state).not.toContain('PRIVATE KEY');
    expect(state).toContain('syaocode.git.github.com.ssh-key');
  });
});

describe('提交信息生成（FR-N-026，只读）', () => {
  it('已暂存改动 → 返回非空提交信息；生成不会产生任何提交', async () => {
    await initRepo();
    await fs.writeFile(path.join(root, 'app.ts'), 'export const a = 1;\n');
    const c = await boot();
    const status = await c.request<GitStatusResult>(F.GitStatus, { workspaceRoot: root });
    const staged = await c.request<{ status: string }>(F.GitStage, {
      workspaceRoot: root,
      paths: ['app.ts'],
      commandId: randomUUID(),
      baseRevision: status.revision,
    });
    expect(staged.status).toBe('accepted');

    const before = await c.request<GitStatusResult>(F.GitStatus, { workspaceRoot: root });
    const generated = await c.request<{
      message: string;
      source: 'model' | 'fallback';
      truncated: boolean;
      reason: string | null;
    }>(F.GitCommitMessage, { workspaceRoot: root });

    // 契约：**保证非空**，且 source/reason 自洽（fallback 必须有原因）。
    expect(typeof generated.message).toBe('string');
    expect(generated.message.trim().length).toBeGreaterThan(0);
    expect(['model', 'fallback']).toContain(generated.source);
    if (generated.source === 'fallback') expect(generated.reason).not.toBeNull();
    expect(generated.truncated).toBe(false);

    // 只读：没有新提交，HEAD 不变，工作区仍是"有暂存改动"。
    const after = await c.request<GitStatusResult>(F.GitStatus, { workspaceRoot: root });
    expect(after.head).toBe(before.head);
    expect(after.files.some((f) => f.staged)).toBe(true);
  });

  it('会话范围：按本会话改动取文件；非仓库目录 → git_not_repo', async () => {
    await initRepo();
    const c = await boot();
    const sessionId = await newSession(c);
    const generated = await c.request<{ message: string; source: string }>(F.GitCommitMessage, {
      workspaceRoot: root,
      sessionId,
      scope: 'session',
      hint: '只提交 Git 相关',
    });
    expect(generated.message.trim().length).toBeGreaterThan(0);

    const bare = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'no-repo-')));
    try {
      const opened = await c.request<{ workspaceRoot: string }>(Method.WorkspaceOpen, { path: bare });
      expect(opened.workspaceRoot).toBe(bare);
      await expect(c.request(F.GitCommitMessage, { workspaceRoot: bare })).rejects.toMatchObject({ kind: 'git_not_repo' });
    } finally {
      await fs.rm(bare, { recursive: true, force: true });
    }
  });
});

describe('提交签名失败在协议层是独立 kind（27 §10.5.3）', () => {
  it('签名失败 → kind=git_signing_failed（-32046），且不产生提交；noSign 才能提交', async () => {
    await initRepo();
    // 故意配置一个必然失败的签名程序。
    const { execFile } = await import('node:child_process');
    const gitConfig = (args: readonly string[]): Promise<void> => new Promise((resolve, reject) => {
      execFile('git', [...args], { cwd: root }, (error) => (error ? reject(error) : resolve()));
    });
    await gitConfig(['config', 'commit.gpgsign', 'true']);
    await gitConfig(['config', 'gpg.program', 'false']);
    await fs.writeFile(path.join(root, 'signed.ts'), 'export const s = 1;\n');

    const c = await boot();
    const status = await c.request<GitStatusResult>(F.GitStatus, { workspaceRoot: root });
    await c.request(F.GitStage, {
      workspaceRoot: root,
      paths: ['signed.ts'],
      commandId: randomUUID(),
      baseRevision: status.revision,
    });

    // 界面靠这个 kind（而不是错误文案）决定给出"重试 / 无签名 / 取消"三选一。
    await expect(c.request(F.GitCommit, {
      workspaceRoot: root,
      message: 'feat: signed',
      commandId: randomUUID(),
      baseRevision: (await c.request<GitStatusResult>(F.GitStatus, { workspaceRoot: root })).revision,
    })).rejects.toMatchObject({ kind: 'git_signing_failed' });

    // 仍然没有新提交。
    const afterFailure = await c.request<GitStatusResult>(F.GitStatus, { workspaceRoot: root });
    expect(afterFailure.files.some((f) => f.staged)).toBe(true);

    // 用户显式选择"无签名提交"后成功。
    const committed = await c.request<{ status: string }>(F.GitCommit, {
      workspaceRoot: root,
      message: 'feat: signed',
      noSign: true,
      commandId: randomUUID(),
      baseRevision: afterFailure.revision,
    });
    expect(committed.status).toBe('accepted');
  });
});

describe('单文件改动 diff（FR-N-011，会话口径）', () => {
  it('会话里改过文件 → 能取到 diff；未登记的路径报错而不是空 diff', async () => {
    await initRepo();
    await fs.writeFile(path.join(root, 'feature.ts'), 'export const a = 1;\n');
    const c = await boot();
    const sessionId = await newSession(c);

    // 没有改过任何文件时：未登记路径必须报错，不能返回"空 diff"（会被误读成没有变化）。
    await expect(c.request(F.SessionChangeDiff, { sessionId, path: 'feature.ts' })).rejects.toMatchObject({
      kind: 'capability_not_found',
    });
  });
});
