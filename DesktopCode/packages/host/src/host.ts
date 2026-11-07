/**
 * Host 装配：把 registry / broker / agent / 服务 组装成一个可运行的 DHP 服务端。
 *
 * 这是 Host 进程的**唯一**入口。职责边界：
 *  - 提供 DHP 方法实现（纯业务编排，不含 IO 细节）
 *  - 把内核事件桥接到 DHP 事件，并推进投影
 *  - **不**做 UI 决策（呈现形态、文案都在客户端）
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { DesktopStateStore, repairHistory } from './desktop-state.ts';
import { WorkbenchService } from './workbench-service.ts';
import { UNKNOWN_CONTEXT, totals } from './usage.ts';
import {
  agentGroupNameSchema,
  agentGroupSchema,
  channelSchema,
  commandSchema,
  gitBranchSchema,
  gitCommitMessageSchema,
  gitCommitSchema,
  gitDiffSchema,
  gitGraphSchema,
  gitOauthFlowSchema,
  gitOauthStartSchema,
  gitPreflightSchema,
  gitRemoteAddSchema,
  gitRemoteAuthSchema,
  gitRemoteNameSchema,
  gitStageSchema,
  gitUploadSchema,
  mcpAddSchema,
  mcpServerIdSchema,
  modelSpecSchema,
  nonnegative,
  parseInput,
  permissionSchema,
  sessionIdSchema,
  sessionChangeDiffSchema,
  titleSchema,
  usageQuerySchema,
  workspaceRootSchema,
  z,
} from './workbench-validation.ts';
import { FeatureMethod, FeatureNotification, WorkbenchMethod } from '@syaocode/dhp';
import type { Message } from '@syaocode/core';
import { randomUUID } from 'node:crypto';
import {
  Method,
  Notification,
  requestHash,
  IdempotencyStore,
  type AckResult,
  type AppInfoResult,
  type ConfigGetResult,
  type DoctorRunResult,
  type GitAuthInfo,
  type GovernancePolicyExplainResult,
  type InteractionResolveResult,
  type ModelListResult,
  type PendingInteraction,
  type SessionCreateResult,
  type SessionForkResult,
  type SessionListResult,
  type SessionSnapshotResult,
  type SessionSubscribeResult,
  type WorkspaceDiffResult,
  type WorkspaceReadFileResult,
  type WorkspaceTreeResult,
} from '@syaocode/dhp';
import type { Agent } from '@syaocode/core';
import { buildProvider, createDesktopAgent, parseModelSpec } from './agent-factory.ts';
import { AgentsService, AgentsServiceError } from './agents-service.ts';
import { CommitMessageService } from './commit-message.ts';
import { ChangesCollector, createChangeToolHooks } from './changes.ts';
import { IpcCredentialBridge, UnavailableCredentialProvider, processCredentialChannel, type CredentialIpcChannel } from './credential-bridge.ts';
import { redactSecret, keychainEntryFor, type CredentialProvider } from './credentials.ts';
import { GitAuthService, isGitAuthError, type GitAuthHydrateRecord } from './git-auth.ts';
import { GitService } from './git-service.ts';
import { GitUploadService, dhpKindForGitError } from './git-upload.ts';
import { GitWriteService } from './git-write.ts';
import { GitError, assertSafeRemoteUrl, runGit, sanitizeRemoteUrl } from './git-run.ts';
import { McpService, McpServiceError } from './mcp-service.ts';
import { ConfigService } from './config-service.ts';
import { nodeRuntime } from '@syaocode/node';
import { DhpProtocolError, startDhpServer, type DhpServerHandle } from './dhp-server.ts';
import { InteractionBroker } from './interaction-broker.ts';
import { syaoPaths, type SyaoPaths } from './paths.ts';
import { SessionRegistry, pumpAgentEvents, toSessionEvents, type SessionState } from './session-registry.ts';
import { WorkspaceService } from './workspace.ts';

export interface HostOptions {
  readonly workspaceRoot?: string;
  readonly port?: number;
  readonly host?: string;
  readonly token?: string;
  readonly env?: Record<string, string | undefined>;
  readonly logger?: (level: 'info' | 'warn' | 'error', msg: string, meta?: unknown) => void;
  /** 是否在 `app/shutdown` 后真的退出进程（测试中设为 false）。 */
  readonly exitOnShutdown?: boolean;
  /**
   * 凭据私有通道覆盖（**仅测试与嵌入式用法**）。生产环境留空，由 `process.send` 自动探测。
   */
  readonly credentialChannel?: CredentialIpcChannel;
  /**
   * 凭据通道覆盖（**仅测试与嵌入式用法**）。
   *
   * 生产环境必须留空：凭据只经主进程私有 IPC（`process.send`），
   * 由 Electron 主进程落到 OS 钥匙串。给了它意味着调用方自己承担保管责任。
   */
  readonly credentials?: CredentialProvider;
}

interface SessionRuntime {
  readonly state: SessionState;
  agent: Agent | undefined;
  broker: InteractionBroker | undefined;
  messages: Message[];
  busy: boolean;
  commandActive: boolean;
  run: Promise<void> | undefined;
}

export interface RunningHost {
  readonly server: DhpServerHandle;
  readonly paths: SyaoPaths;
  readonly workspace: WorkspaceService;
  close(): Promise<void>;
}

export async function createHost(opts: HostOptions = {}): Promise<RunningHost> {
  const env = opts.env ?? process.env;
  const log = opts.logger ?? ((level, msg, meta) => {
    const line = `[host] ${level} ${msg}${meta === undefined ? '' : ` ${JSON.stringify(meta)}`}`;
    if (level === 'error') console.error(line);
    else console.log(line);
  });

  const requestedRoot = await fs.realpath(opts.workspaceRoot ?? process.cwd());
  if (!(await fs.stat(requestedRoot)).isDirectory()) throw new Error('Workspace must be a directory');
  const workspace = new WorkspaceService({ root: requestedRoot });
  const workspaceRoot = workspace.workspaceRoot;

  let paths: SyaoPaths;
  try {
    paths = syaoPaths(env);
  } catch (err) {
    // 数据目录解析失败是**致命**的：不启动，而不是把数据写到 cwd。
    log('error', 'fatal: cannot resolve SYAOCODE_HOME', { message: (err as Error).message });
    throw err;
  }

  const store = await DesktopStateStore.open(paths.desktopDir);
  const effective = async (root = workspaceRoot) => {
    const cfg = await new ConfigService(paths, root, env).effective();
    const defaults = store.data.defaults;
    const use = (key: 'model' | 'permissionMode' | 'language'): boolean => defaults[key] !== undefined && cfg.sources[key] !== 'project' && cfg.sources[key] !== 'env';
    return { ...cfg,
      model: use('model') ? defaults.model! : cfg.model,
      permissionMode: use('permissionMode') ? defaults.permissionMode! : cfg.permissionMode,
      language: use('language') ? defaults.language! : cfg.language,
      sources: { ...cfg.sources, ...Object.fromEntries((['model', 'permissionMode', 'language'] as const).filter(use).map((k) => [k, 'desktop'])) },
    };
  };
  const idempotency = new IdempotencyStore();
  const runtimes = new Map<string, SessionRuntime>();
  let workbench: WorkbenchService;
  const registry = new SessionRegistry(Date.now, () => workbench?.scheduleSave());
  workbench = new WorkbenchService(store, registry, env, () => [...runtimes.values()].map((rt) => ({ snapshot: rt.state.snapshot, messages: rt.agent?.history ?? rt.messages, turn: rt.state.turn, archived: rt.state.archived })));
  let server: DhpServerHandle;
  try {
    for (const saved of store.data.sessions) {
      const state = registry.restore(saved);
      runtimes.set(state.sessionId, { state, agent: undefined, broker: undefined, messages: repairHistory(saved.messages), busy: false, commandActive: false, run: undefined });
    }
    workbench.initializeChannels();
    workbench.importConfiguredModel((await effective()).model);
    await workbench.openWorkspace(workspaceRoot);
    await workbench.save();
    server = await startDhpServer({ host: opts.host ?? '127.0.0.1', port: opts.port ?? 0, ...(opts.token !== undefined ? { token: opts.token } : {}), logger: log, workspaceRoot });
  } catch (e) { await store.close(); throw e; }
  let closing = false;
  const operations = new Set<Promise<unknown>>();
  const register: DhpServerHandle['register'] = (method, handler) => server.register(method, (params, ctx) => {
    if (closing) return Promise.reject(new DhpProtocolError('not_ready', 'Host is shutting down'));
    const op = handler(params, ctx);
    operations.add(op);
    void op.finally(() => operations.delete(op)).catch(() => undefined);
    return op;
  });
  const requireRuntime = (id: string): SessionRuntime => {
    const rt = runtimes.get(id);
    if (!rt) throw new DhpProtocolError('capability_not_found', 'Unknown session');
    return rt;
  };
  const mutable = (): void => { if (closing) throw new DhpProtocolError('not_ready', 'Host is shutting down'); };
  const requireIdle = (rt: SessionRuntime): void => {
    if (rt.busy || rt.state.runState !== 'idle') throw new DhpProtocolError('conflict_in_flight', 'Session is busy');
  };
  const subscriptions = new Map<string, Map<string, { unsubscribe(): void; notify(method: string, params: unknown): void }>>();
  const disconnects = new Map<string, () => void>();
  const notifySnapshot = (id: string): void => {
    const snapshot = registry.require(id).snapshot;
    for (const subs of subscriptions.values()) subs.get(id)?.notify(Notification.SessionEvent, { delta: { sessionId: id, epoch: snapshot.epoch, fromSeq: 0, toSeq: 0, events: [] }, snapshot });
  };
  const removeSubscription = (conn: string, id: string): void => {
    const subs = subscriptions.get(conn);
    subs?.get(id)?.unsubscribe(); subs?.delete(id);
    if (subs?.size === 0) { subscriptions.delete(conn); disconnects.get(conn)?.(); disconnects.delete(conn); }
  };
  const inflight = new Map<string, { hash: string; promise: Promise<AckResult> }>();

  // ── 增补能力的装配（27 §4）──────────────────────────────────────────
  //
  // 六条新链路共用两个纪律：
  //  1. **凭据不走 DHP**：`credentialProvider` 是 Host ↔ 主进程的私有通道；
  //     DHP 只能问"是否已配置 / 什么方式 / 哪个指纹"。
  //  2. **事实只有一份**：改动 / 产出 / 来源由 Host 计算并随 `session/inspect`
  //     下发；渲染层只替换不合并。

  const credentialChannel = opts.credentialChannel ?? processCredentialChannel();
  const credentialProvider: CredentialProvider = opts.credentials
    ?? (credentialChannel !== undefined ? new IpcCredentialBridge(credentialChannel) : new UnavailableCredentialProvider());

  /** 每个工作区一份采集器（多项目场景下围栏不同）。 */
  const collectors = new Map<string, ChangesCollector>();
  const collectorFor = (root: string): ChangesCollector => {
    const key = path.resolve(root);
    const existing = collectors.get(key);
    if (existing !== undefined) return existing;
    const created = new ChangesCollector({
      workspaceRoot: key,
      onChange: (sessionId) => {
        persistChanges(sessionId);
        publishChanges(sessionId);
        workbench.scheduleSave();
      },
    });
    collectors.set(key, created);
    return created;
  };

  const persistChanges = (sessionId: string): void => {
    const rt = runtimes.get(sessionId);
    if (rt === undefined) return;
    const snap = collectorFor(rt.state.snapshot.meta.workspaceRoot).snapshot(sessionId);
    store.data.changes[sessionId] = snap.changes;
    store.data.artifacts[sessionId] = snap.artifacts;
    store.data.sources[sessionId] = snap.sources;
    store.data.coverage[sessionId] = snap.coverage;
  };

  const publishChanges = (sessionId: string): void => {
    const rt = runtimes.get(sessionId);
    if (rt === undefined) return;
    const snap = collectorFor(rt.state.snapshot.meta.workspaceRoot).snapshot(sessionId);
    for (const subs of subscriptions.values()) {
      subs.get(sessionId)?.notify(FeatureNotification.SessionChanges, { sessionId, ...snap });
    }
  };

  const auditGit = (record: { action: string; workspaceRoot: string; detail: string; result: 'success' | 'failed'; code: number | null }): void => {
    store.data.gitAudit.push({
      at: Date.now(),
      workspaceRoot: record.workspaceRoot,
      action: record.action,
      detail: redactSecret(record.detail),
      result: record.result,
      code: record.code,
    });
    // 审计记录只保留最近 500 条：它是诊断材料，不是永久档案。
    if (store.data.gitAudit.length > 500) store.data.gitAudit.splice(0, store.data.gitAudit.length - 500);
    workbench.scheduleSave();
  };

  const gitService = new GitService();
  const gitAuth = new GitAuthService({ credentials: credentialProvider });
  const gitWrite = new GitWriteService({ reader: gitService, credentials: credentialProvider, audit: auditGit });
  const gitUpload = new GitUploadService({ writer: gitWrite, credentials: credentialProvider, audit: auditGit });

  // ── 凭据元信息落盘 / 恢复（FR-N-027 / 030）──────────────────────────
  //
  // 状态文件里只放**元信息**（方式 / 账号 / scope / 指纹 / 时间 / 钥匙串条目名）。
  // 令牌、口令、私钥**永不**进状态文件、日志或 DHP 帧：它们只活在主进程钥匙串里。

  /** 远端 URL → 主机名（`https://host/x.git` 与 `git@host:path` 两种写法都认）。 */
  const hostOfRemote = (url: string): string | null => {
    const trimmed = sanitizeRemoteUrl(url).trim();
    try {
      const parsed = new URL(trimmed);
      return parsed.hostname.toLowerCase() || null;
    } catch {
      const scp = /^[A-Za-z0-9._-]+@([A-Za-z0-9._-]+):/.exec(trimmed);
      return scp?.[1]?.toLowerCase() ?? null;
    }
  };

  /** `(工作区, 远端名)` → 状态文件里 `gitAuth` 的键。 */
  const authStateKey = (root: string, remote: string): string => `${root}\u0000${remote}`;

  /** 进行中的 OAuth 设备码流程：`flowId → 工作区 + 远端`（poll 成功后写元信息用）。 */
  const oauthFlows = new Map<string, { root: string; remote: string }>();

  /**
   * 记一次登录状态变化。
   *
   * `method='none'` 时删除条目（断开连接后不留"曾配置过"的假象）；
   * 其余情况只写元信息。`url` 用于推导钥匙串条目名，可以不给。
   */
  const persistGitAuth = (root: string, remote: string, auth: GitAuthInfo, url?: string): void => {
    const key = authStateKey(root, remote);
    if (auth.method === 'none') {
      delete store.data.gitAuth[key];
      workbench.scheduleSave();
      return;
    }
    // 远端 URL 优先用调用方给的，其次用登记过的远端（`git/remote/add` 写入）。
    const resolvedUrl = url ?? store.data.gitRemotes[root]?.find((r) => r.name === remote)?.url;
    const host = resolvedUrl === undefined ? null : hostOfRemote(resolvedUrl);
    store.data.gitAuth[key] = {
      method: auth.method,
      configured: auth.configured,
      account: auth.account,
      scope: [...auth.scope],
      keyFingerprint: auth.keyFingerprint,
      keychainEntry: host === null || auth.method === 'ssh-agent' ? null : keychainEntryFor(host, auth.method),
      updatedAt: auth.updatedAt ?? Date.now(),
    };
    workbench.scheduleSave();
  };

  /** 广播登录状态变化（`git/auth/changed`）。 */
  const publishGitAuth = (root: string, remote: string, auth: GitAuthInfo, url?: string): void => {
    persistGitAuth(root, remote, auth, url);
    server.broadcast(FeatureNotification.GitAuthChanged, { workspaceRoot: root, remote, auth });
  };

  /** 重启后把元信息灌回服务（凭据值仍然只以钥匙串条目是否存在为准）。 */
  {
    const records: GitAuthHydrateRecord[] = [];
    for (const [key, record] of Object.entries(store.data.gitAuth)) {
      if (record.method === 'none') continue;
      const [workspaceRoot, remote] = key.split('\u0000');
      if (workspaceRoot === undefined || remote === undefined) continue;
      records.push({
        method: record.method,
        account: record.account,
        scope: [...record.scope],
        keyFingerprint: record.keyFingerprint,
        updatedAt: record.updatedAt,
        workspaceRoot,
        remote,
      });
    }
    if (records.length > 0) gitAuth.hydrate(records);
  }

  // 主进程在渲染层写完凭据（令牌 / 私钥 / 生成的密钥）后，会在这条私有通道上
  // 发一条 `cred:changed`。Host 只拿它当"去重新问一次状态"的信号：
  // **消息里没有任何凭据值**，元信息一律由 `gitAuth.status()` 重新计算。
  if (credentialChannel !== undefined) {
    credentialChannel.subscribe((message) => {
      if (message['type'] !== 'cred:changed') return;
      const root = typeof message['workspaceRoot'] === 'string' ? message['workspaceRoot'] : undefined;
      const remote = typeof message['remote'] === 'string' ? message['remote'] : undefined;
      if (root === undefined || remote === undefined) return;
      const url = typeof message['url'] === 'string' ? message['url'] : undefined;
      void (async () => {
        try {
          const list = url !== undefined
            ? [{ name: remote, url }]
            : (await gitService.remotes(root)).remotes.map((r) => ({ name: r.name, url: r.url }));
          const info = await gitAuth.status(root, list);
          const auth = info.remotes.find((r) => r.name === remote)?.auth;
          if (auth === undefined) return;
          publishGitAuth(root, remote, auth, url);
          await workbench.save();
        } catch {
          // 刷新失败不影响凭据本身：界面下次拉状态会自愈。
        }
      })();
    });
  }

  /**
   * 一次性补全：给提交信息生成用（FR-N-026）。
   *
   * 只发一次请求、不带工具、不写任何文件；失败一律抛错，
   * 由 `CommitMessageService` 降级成 fallback（界面仍可手填）。
   */
  const completeOnce = async (
    modelSpec: string,
    req: { system: string; prompt: string; signal: AbortSignal },
  ): Promise<string> => {
    const built = buildProvider(parseModelSpec(modelSpec), nodeRuntime(), env);
    if (!built.ok) throw new Error(built.reason);
    const messages: Message[] = [{
      id: `commit_${Date.now().toString(36)}`,
      role: 'user',
      content: [{ type: 'text', text: req.prompt }],
    }];
    let text = '';
    for await (const event of built.provider.stream(
      { model: built.model, system: req.system, messages, maxOutputTokens: 512, temperature: 0.2 },
      { signal: req.signal },
    )) {
      if (event.type === 'block_delta') text += event.delta;
    }
    return text;
  };

  const mcp = new McpService({
    env,
    onChanged: (serverId, status) => {
      server.broadcast(FeatureNotification.McpChanged, { serverId, status });
    },
  });
  const agents = new AgentsService({
    groups: store.data.agentGroups,
    ...(store.data.agentActive !== null ? { active: store.data.agentActive } : {}),
    onChange: (groups, active) => {
      store.data.agentGroups = [...groups];
      store.data.agentActive = active;
      workbench.scheduleSave();
    },
  });

  // 重启后恢复每个会话的改动 / 产出 / 来源（否则界面会假装"本会话没改过东西"）。
  for (const rt of runtimes.values()) {
    const sessionId = rt.state.sessionId;
    const changes = store.data.changes[sessionId];
    const artifacts = store.data.artifacts[sessionId];
    const sources = store.data.sources[sessionId];
    const coverage = store.data.coverage[sessionId];
    if (changes === undefined && artifacts === undefined && sources === undefined) continue;
    collectorFor(rt.state.snapshot.meta.workspaceRoot).restore(sessionId, {
      changes: changes ?? [],
      artifacts: artifacts ?? [],
      sources: sources ?? [],
      coverage: coverage ?? { exact: true, bashUsed: false, note: null },
    });
  }

  /** Git / MCP / Agent 服务的错误 → DHP 错误 kind。 */
  const serviceError = (error: unknown): never => {
    // 上传专属语义（分叉 / 未配凭据 / 凭据被拒）由 git-upload 给出精确 kind。
    if (error instanceof GitError) throw new DhpProtocolError(dhpKindForGitError(error), error.message);
    if (error instanceof McpServiceError) throw new DhpProtocolError(error.kind, error.message);
    if (error instanceof AgentsServiceError) {
      const kind = error.kind === 'agents_not_found'
        ? 'capability_not_found'
        : error.kind === 'agents_active_conflict'
          ? 'conflict_in_flight'
          : 'invalid_request';
      throw new DhpProtocolError(kind, error.message);
    }
    if (isGitAuthError(error)) throw new DhpProtocolError(error.kind, error.message);
    throw error;
  };

  /** 工作区根：必须是**已登记**的工作区（防止越权读别人的目录）。 */
  const requireRoot = (root: string | undefined): string => workbench.requireWorkspace(root ?? workspaceRoot).root;

  // ── 工具函数 ──────────────────────────────────────────────────────────

  const pendingOf = (sessionId: string): readonly PendingInteraction[] => {
    const rt = runtimes.get(sessionId);
    return rt?.broker?.pending() ?? [];
  };

  /**
   * 幂等 + CAS 的统一入口。
   *
   * 所有写命令都走这里，保证：
   *  - 同 `commandId` 同内容 → `duplicate`（不重复执行副作用）
   *  - 同 `commandId` 异内容 → `idempotency_conflict`
   *  - `baseRevision` 不符 → `stale`（带回最新 revision）
   */
  const runCommand = async (
    input: {
      readonly commandId: string;
      readonly baseRevision: number;
      readonly sessionId: string;
      readonly payload: unknown;
    },
    exec: () => Promise<AckResult>,
  ): Promise<AckResult> => {
    mutable();
    parseInput(commandSchema, input);
    const rt = runtimes.get(input.sessionId);
    if (rt === undefined) {
      throw new DhpProtocolError('capability_not_found', `unknown session: ${input.sessionId}`);
    }
    const hash = requestHash({ sessionId: input.sessionId, payload: input.payload });

    const active = inflight.get(input.commandId);
    if (active) {
      if (active.hash !== hash) throw new DhpProtocolError('idempotency_conflict', 'Command ID reused with different content');
      return { ...await active.promise, status: 'duplicate' };
    }
    const prior = idempotency.get(input.commandId);
    if (prior !== undefined) {
      if (prior.requestHash !== hash) {
        throw new DhpProtocolError(
          'idempotency_conflict',
          `commandId ${input.commandId} reused with different content`,
        );
      }
      // 等价成功：把第一次的结果原样返回。
      return {
        commandId: prior.commandId,
        status: 'duplicate',
        revision: prior.revision,
        ...(prior.data !== undefined ? { data: prior.data } : {}),
      };
    }

    if (input.baseRevision !== rt.state.snapshot.revision) {
      return {
        commandId: input.commandId,
        status: 'stale',
        revision: rt.state.snapshot.revision,
        reason: `baseRevision ${input.baseRevision} != current ${rt.state.snapshot.revision}`,
      };
    }

    if (rt.commandActive) throw new DhpProtocolError('conflict_in_flight', 'A session command is in flight');
    rt.commandActive = true;
    const promise = (async () => {
      try {
        const result = await exec();
        await workbench.save();
        notifySnapshot(input.sessionId);
        idempotency.put({ commandId: input.commandId, requestHash: hash, status: result.status, revision: result.revision, createdAt: Date.now(), ...(result.data !== undefined ? { data: result.data } : {}) });
        return result;
      } finally { rt.commandActive = false; inflight.delete(input.commandId); }
    })();
    inflight.set(input.commandId, { hash, promise });
    return promise;
  };

  /** 确保会话的 agent 已创建（懒创建：创建会话不花时间）。 */
  const ensureAgent = (sessionId: string): Agent => {
    const rt = runtimes.get(sessionId);
    if (rt === undefined) throw new DhpProtocolError('capability_not_found', `unknown session: ${sessionId}`);
    if (rt.agent !== undefined) return rt.agent;

    const meta = rt.state.snapshot.meta;
    const selected = workbench.model(meta.model);
    const broker = new InteractionBroker(
      (interaction) => {
        // 审批到达：写进投影（这样重连后自动恢复）+ 推送通知。
        registry.append(sessionId, { type: 'permission.request', id: interaction.id, interaction });
        registry.setPending(sessionId, [...broker.pending()]);
        server.broadcast(Notification.InteractionRequest, { interaction });
      },
      { sessionId },
    );
    rt.broker = broker;

    const created = createDesktopAgent({
      modelSpec: meta.model,
      cwd: meta.workspaceRoot,
      permissionMode: parseInput(permissionSchema, meta.permissionMode),
      permissionHandler: (req) => broker.handle(req),
      env,
      channel: selected.channel,
      history: rt.messages,
      observation: { sessionId, model: selected.model, onContext: (c) => workbench.context(sessionId, c), onUsage: (r) => workbench.record(r) },
      // 改动 / 产出 / 来源：在 Host 侧用装饰器采集，内核一行不动（27 §7.2）。
      toolHooks: createChangeToolHooks(collectorFor(meta.workspaceRoot), sessionId),
    });
    if (!created.ok) {
      throw new DhpProtocolError('unsupported_capability', `cannot create agent: ${created.reason}`);
    }
    // MCP 工具进入 ToolRegistry 后，模型才能看到并调用它们（27 FR-N-001）。
    for (const tool of mcp.toolDefinitions()) {
      try {
        created.agent.registry.register(tool);
      } catch {
        // 重名（例如同一服务重复启动）不阻塞会话创建。
      }
    }
    rt.agent = created.agent;
    return created.agent;
  };

  // ── 方法：会话 ────────────────────────────────────────────────────────

  register(Method.SessionCreate, async (params) => {
    mutable();
    const p = parseInput(z.object({ title: titleSchema.optional(), model: modelSpecSchema.optional(), permissionMode: permissionSchema.optional(), workspaceRoot: z.string().min(1).optional() }).strict(), params ?? {});
    const root = workbench.requireWorkspace(p.workspaceRoot ?? workspaceRoot).root;
    const cfg = await effective(root);
    mutable();
    workbench.importConfiguredModel(cfg.model);
    workbench.model(p.model ?? cfg.model);
    const sessionId = `ses_${randomUUID().replace(/-/g, '').slice(0, 20)}`;
    const state = registry.create({
      sessionId,
      title: p.title ?? '新会话',
      model: p.model ?? cfg.model,
      permissionMode: parseInput(permissionSchema, p.permissionMode ?? cfg.permissionMode),
      workspaceRoot: root,
    });
    runtimes.set(sessionId, { state, agent: undefined, broker: undefined, messages: [], busy: false, commandActive: false, run: undefined });
    await workbench.save();
    server.broadcast(Notification.SessionChanged, {
      sessionId,
      change: 'created',
      title: state.title,
    });
    return { snapshot: state.snapshot } satisfies SessionCreateResult;
  });

  register(Method.SessionList, async (params) => {
    const p = parseInput(z.object({ limit: nonnegative.int().optional() }).strict(), params ?? {});
    const sessions = registry.list();
    return { sessions: p.limit === undefined ? sessions : sessions.slice(0, p.limit) } satisfies SessionListResult;
  });

  register(Method.SessionSnapshot, async (params) => {
    const p = parseInput(sessionIdSchema.strict(), params);
    const state = requireRuntime(p.sessionId).state;
    const pending = pendingOf(p.sessionId);
    return { ...state.snapshot, pendingInteractions: pending } satisfies SessionSnapshotResult;
  });

  register(Method.SessionResume, async (params) => {
    const p = parseInput(sessionIdSchema.strict(), params);
    const state = requireRuntime(p.sessionId).state;
    return { snapshot: { ...state.snapshot, pendingInteractions: pendingOf(p.sessionId) } };
  });

  register(Method.SessionClose, async (params) => {
    mutable();
    const p = parseInput(sessionIdSchema.strict(), params);
    const rt = requireRuntime(p.sessionId);
    if (rt.commandActive) throw new DhpProtocolError('conflict_in_flight', 'A session command is in flight');
    rt.commandActive = true;
    rt.state.abort?.abort();
    rt.broker?.drain('会话已关闭');
    await rt.run;
    await rt.agent?.close();
    runtimes.delete(p.sessionId);
    for (const conn of [...subscriptions.keys()]) removeSubscription(conn, p.sessionId);
    delete store.data.contexts[p.sessionId];
    // DHP 的 `session.end` 只在真正关闭会话时产生（内核的 session.end 是"一轮结束"）。
    if (registry.get(p.sessionId) !== undefined) {
      registry.append(p.sessionId, { type: 'session.end', reason: 'closed' });
    }
    registry.close(p.sessionId);
    await workbench.save();
    server.broadcast(Notification.SessionChanged, { sessionId: p.sessionId, change: 'closed' });
    return { ok: true };
  });

  register(Method.SessionRename, async (params) => {
    mutable();
    const p = parseInput(sessionIdSchema.extend({ title: titleSchema }).strict(), params);
    if (requireRuntime(p.sessionId).commandActive) throw new DhpProtocolError('conflict_in_flight', 'A session command is in flight');
    registry.rename(p.sessionId, p.title);
    registry.bumpRevision(p.sessionId);
    notifySnapshot(p.sessionId);
    await workbench.save();
    server.broadcast(Notification.SessionChanged, {
      sessionId: p.sessionId,
      change: 'renamed',
      title: p.title,
    });
    return { ok: true };
  });

  // ── 方法：会话 fork / 删除（FR-N-035）──────────────────────────────────

  register(FeatureMethod.SessionFork, async (params) => {
    mutable();
    const p = parseInput(
      commandSchema.extend({ atSeq: nonnegative.int().optional(), title: titleSchema.optional() }).strict(),
      params,
    );
    const rt = requireRuntime(p.sessionId);
    if (rt.commandActive) throw new DhpProtocolError('conflict_in_flight', 'A session command is in flight');
    requireIdle(rt);

    // 分叉点：把投影里的行号映射回消息历史（只切在消息边界上）。
    const history = rt.agent?.history ?? rt.messages;
    let cut = history.length;
    if (p.atSeq !== undefined) {
      const rows = rt.state.snapshot.rows;
      // 投影里的 `message` 行与历史里的 `Message` 一一对应（同序）。
      let messageRows = 0;
      for (const row of rows) {
        if (row.seq > p.atSeq) break;
        if (row.kind === 'message') messageRows += 1;
      }
      cut = Math.min(history.length, messageRows);
    }
    const forked = structuredClone(history.slice(0, cut));

    const sessionId = `ses_${randomUUID().replace(/-/g, '').slice(0, 20)}`;
    const meta = rt.state.snapshot.meta;
    const state = registry.create({
      sessionId,
      title: p.title ?? `${meta.title} (fork)`,
      model: meta.model,
      permissionMode: meta.permissionMode,
      workspaceRoot: meta.workspaceRoot,
    });
    runtimes.set(sessionId, {
      state,
      agent: undefined,
      broker: undefined,
      messages: forked,
      busy: false,
      commandActive: false,
      run: undefined,
    });
    await workbench.save();
    server.broadcast(Notification.SessionChanged, { sessionId, change: 'created', title: state.title });
    return { sessionId } satisfies SessionForkResult;
  });

  register(FeatureMethod.SessionDelete, async (params) => {
    mutable();
    const p = parseInput(commandSchema.strict(), params);
    const rt = requireRuntime(p.sessionId);
    if (rt.commandActive) throw new DhpProtocolError('conflict_in_flight', 'A session command is in flight');
    if (rt.busy) throw new DhpProtocolError('conflict_in_flight', 'Session is busy');
    rt.state.abort?.abort();
    rt.broker?.drain('会话已删除');
    await rt.run;
    await rt.agent?.close();
    runtimes.delete(p.sessionId);
    for (const conn of [...subscriptions.keys()]) removeSubscription(conn, p.sessionId);
    delete store.data.contexts[p.sessionId];
    delete store.data.changes[p.sessionId];
    delete store.data.artifacts[p.sessionId];
    delete store.data.sources[p.sessionId];
    delete store.data.coverage[p.sessionId];
    registry.close(p.sessionId);
    await workbench.save();
    server.broadcast(Notification.SessionChanged, { sessionId: p.sessionId, change: 'closed' });
    return { ok: true };
  });

  register(Method.SessionSubscribe, async (params, ctx) => {
    const p = parseInput(sessionIdSchema.extend({ baseSeq: nonnegative.int().optional(), epoch: nonnegative.int().optional() }).strict(), params);
    const state = requireRuntime(p.sessionId).state;
    let subs = subscriptions.get(ctx.connectionId);
    if (!subs) {
      subs = new Map(); subscriptions.set(ctx.connectionId, subs);
      disconnects.set(ctx.connectionId, ctx.onDisconnect(() => {
        for (const sub of subscriptions.get(ctx.connectionId)?.values() ?? []) sub.unsubscribe();
        subscriptions.delete(ctx.connectionId); disconnects.delete(ctx.connectionId);
      }));
    }
    if (!subs.has(p.sessionId) && subs.size >= 8) throw new DhpProtocolError('conflict_in_flight', 'Too many subscriptions');
    subs.get(p.sessionId)?.unsubscribe();
    const unsubscribe = registry.subscribe(p.sessionId, (delta) => ctx.notify(Notification.SessionEvent, { delta }));
    subs.set(p.sessionId, { unsubscribe, notify: ctx.notify });

    // 断档判定：客户端水位与服务端不连续 → 随订阅回快照。
    const baseSeq = p.baseSeq;
    const needsSnapshot =
      baseSeq === undefined ||
      p.epoch === undefined ||
      p.epoch !== state.epoch ||
      baseSeq + 1 < state.ringFloor ||
      baseSeq > state.snapshot.seq;

    if (needsSnapshot) {
      ctx.notify(Notification.SessionEvent, {
        delta: {
          sessionId: p.sessionId,
          epoch: state.epoch,
          // 用 `fromSeq = seq + 1` 的"空 delta"不合法，所以这里直接发 snapshot 通知：
          // 客户端收到 `snapshot` 字段时整体替换（铁律 1）。
          fromSeq: 0,
          toSeq: 0,
          events: [],
        },
        snapshot: { ...state.snapshot, pendingInteractions: pendingOf(p.sessionId) },
      });
    } else if (baseSeq !== undefined && baseSeq < state.snapshot.seq) {
      // 可以补洞：把缺失区间立即推送。
      const gap = registry.eventsBetween(p.sessionId, baseSeq + 1, state.snapshot.seq);
      if (gap !== undefined && gap.events.length > 0) {
        ctx.notify(Notification.SessionEvent, { delta: gap });
      }
    }

    return {
      subscribed: true,
      snapshotIncluded: needsSnapshot,
      seq: state.snapshot.seq,
      epoch: state.epoch,
    } satisfies SessionSubscribeResult;
  });

  register(Method.SessionUnsubscribe, async (params, ctx) => {
    const p = parseInput(sessionIdSchema.strict(), params);
    removeSubscription(ctx.connectionId, p.sessionId);
    return { subscribed: false };
  });

  register(Method.SessionEvents, async (params) => {
    const p = parseInput(sessionIdSchema.extend({ fromSeq: nonnegative.int().positive(), toSeq: nonnegative.int().optional() }).strict(), params);
    const state = requireRuntime(p.sessionId).state;
    const toSeq = p.toSeq ?? state.snapshot.seq;
    if (toSeq > state.snapshot.seq || toSeq < p.fromSeq - 1) throw new DhpProtocolError('invalid_request', 'Invalid event range');
    const delta = registry.eventsBetween(p.sessionId, p.fromSeq, toSeq);
    if (delta === undefined) {
      throw new DhpProtocolError(
        'gap_unrecoverable',
        `events from ${p.fromSeq} no longer available (floor ${state.ringFloor}); use session/snapshot`,
      );
    }
    return { delta };
  });

  // ── 方法：对话 ────────────────────────────────────────────────────────

  register(Method.TurnSend, async (params) => {
    const p = parseInput(commandSchema.extend({ text: z.string().min(1).max(2_000_000).refine((s) => s.trim().length > 0) }).strict(), params);
    return runCommand(
      { commandId: p.commandId, baseRevision: p.baseRevision, sessionId: p.sessionId, payload: { text: p.text } },
      async () => {
        const rt = runtimes.get(p.sessionId);
        if (rt === undefined) throw new DhpProtocolError('capability_not_found', 'unknown session');
        requireIdle(rt);
        if (rt.state.archived) throw new DhpProtocolError('denied', 'Restore archived session before sending');
        rt.busy = true;
        try {
        const agent = ensureAgent(p.sessionId);
        const executionId = `exe_${randomUUID()}`;
        // 轮次被接受 → 命令级状态变化 → revision 前进（客户端下次写命令需重读）。
        registry.bumpRevision(p.sessionId);
        rt.state.executionId = executionId;
        rt.state.turn += 1;

        agent.history.push({ id: `msg_${randomUUID()}`, role: 'user', content: [{ type: 'text', text: p.text }], meta: { createdAt: Date.now() } });
        registry.append(p.sessionId, { type: 'turn.start', turn: rt.state.turn });
        registry.append(p.sessionId, { type: 'message.complete', role: 'user', text: p.text, stopReason: 'user' });
        const ac = new AbortController();
        rt.state.abort = ac;
        await workbench.save();
        rt.run = (async () => {
          try {
            // Already seeded and saved; [] avoids duplicate history, no store resume option.
            await pumpAgentEvents(agent, registry, p.sessionId, [], ac.signal, {
              onPending: (pending) => registry.setPending(p.sessionId, pending),
              pendingOf: () => pendingOf(p.sessionId),
            });
          } catch (err) {
            registry.append(p.sessionId, {
              type: 'error',
              code: 'SY-UI-001',
              message: 'Run failed; check channel configuration and Host state.',
              fatal: false,
            });
          } finally {
            rt.broker?.drain('Run finished');
            registry.setPending(p.sessionId, []);
            const repaired = repairHistory(agent.history);
            agent.history.splice(0, agent.history.length, ...repaired);
            rt.messages = agent.history;
            rt.busy = false;
            delete rt.state.abort; delete rt.state.executionId;
            registry.append(p.sessionId, { type: 'turn.end', turn: rt.state.turn });
            await workbench.save();
          }
        })().catch(() => log('error', 'Failed to persist run; further writes fail closed'));

        return {
          commandId: p.commandId,
          status: 'accepted' as const,
          revision: rt.state.snapshot.revision,
          data: { executionId },
        };
        } catch (e) {
          rt.busy = false;
          delete rt.state.abort; delete rt.state.executionId;
          if (rt.state.runState !== 'idle') registry.append(p.sessionId, { type: 'turn.end', turn: rt.state.turn });
          throw e;
        }
      },
    );
  });

  register(Method.TurnStop, async (params) => {
    const p = parseInput(commandSchema.extend({ expectedExecutionId: z.string().optional() }).strict(), params);
    return runCommand(
      { commandId: p.commandId, baseRevision: p.baseRevision, sessionId: p.sessionId, payload: { stop: true, expectedExecutionId: p.expectedExecutionId } },
      async () => {
        const rt = runtimes.get(p.sessionId);
        if (rt === undefined) throw new DhpProtocolError('capability_not_found', 'unknown session');
        if (p.expectedExecutionId !== undefined && rt.state.executionId !== p.expectedExecutionId) {
          // 迟到的停止不能杀掉后续执行。
          return {
            commandId: p.commandId,
            status: 'noop' as const,
            revision: rt.state.snapshot.revision,
            reason: 'execution already changed',
          };
        }
        rt.state.abort?.abort();
        rt.broker?.drain('Run stopped');
        return { commandId: p.commandId, status: 'accepted' as const, revision: rt.state.snapshot.revision };
      },
    );
  });

  register(Method.TurnSteer, async (params) => {
    const p = parseInput(commandSchema.extend({ text: z.string() }).strict(), params);
    return runCommand(
      { commandId: p.commandId, baseRevision: p.baseRevision, sessionId: p.sessionId, payload: { steer: p.text } },
      async () => {
        const rt = runtimes.get(p.sessionId);
        if (rt === undefined) throw new DhpProtocolError('capability_not_found', 'unknown session');
        // v1：给用户一个诚实的"暂不支持"，而不是静默丢弃。
        return {
          commandId: p.commandId,
          status: 'rejected' as const,
          revision: rt.state.snapshot.revision,
          reason: 'steer 尚未实现（v1 仅支持 stop 后重新发送）',
        };
      },
    );
  });

  // ── 方法：交互 ────────────────────────────────────────────────────────

  register(Method.InteractionResolve, async (params) => {
    const p = parseInput(commandSchema.extend({ interactionId: z.string().min(1), optionId: z.string().min(1) }).strict(), params);
    return runCommand(
      {
        commandId: p.commandId,
        baseRevision: p.baseRevision,
        sessionId: p.sessionId,
        payload: { interactionId: p.interactionId, optionId: p.optionId },
      },
      async () => {
        const rt = runtimes.get(p.sessionId);
        if (rt === undefined) throw new DhpProtocolError('capability_not_found', 'unknown session');
        const broker = rt.broker;
        if (broker === undefined) {
          throw new DhpProtocolError('capability_not_found', 'no pending interaction broker');
        }
        const outcome = broker.resolve(p.interactionId, p.optionId);
        if (!outcome.ok) {
          throw new DhpProtocolError(outcome.kind, outcome.message);
        }
        registry.setPending(p.sessionId, broker.pending());
        registry.bumpRevision(p.sessionId);
        const d = outcome.decision;
        // `recheck` 不是结算（卡片保持未决），此时不写 permission.result。
        if ('decision' in d) {
          registry.append(p.sessionId, {
            type: 'permission.result',
            id: p.interactionId,
            decision: d.decision,
            by: 'user',
          });
        }
        return {
          commandId: p.commandId,
          status: 'accepted' as const,
          revision: rt.state.snapshot.revision,
        } satisfies InteractionResolveResult;
      },
    );
  });

  register(WorkbenchMethod.Overview, async () => workbench.overview());
  // ── 方法：单文件改动 diff（FR-N-011，会话口径）────────────────────────
  //
  // 只读：diff 来自采集器记下的"本会话首次触碰前 → 现在"，
  // 与 Git 的 worktree/staged diff 是两件事，不可互相替代（`27` §7.1）。

  register(FeatureMethod.SessionChangeDiff, async (params) => {
    const p = parseInput(sessionChangeDiffSchema, params);
    const rt = requireRuntime(p.sessionId);
    const diff = await collectorFor(rt.state.snapshot.meta.workspaceRoot).diff(p.sessionId, p.path);
    if (diff === null) {
      // 没有这个路径的改动：报 404 语义，不编造空 diff（空 diff 会被误读成"没有变化"）。
      throw new DhpProtocolError('capability_not_found', 'this session has no recorded change for that path');
    }
    return { sessionId: p.sessionId, ...diff };
  });

  register(WorkbenchMethod.SessionInspect, async (params) => {
    const p = parseInput(sessionIdSchema.strict(), params);
    const rt = requireRuntime(p.sessionId);
    const inspection = workbench.inspect(p.sessionId);
    // 改动 / 产出 / 来源以采集器为准（状态文件只是持久化副本）。
    const snap = collectorFor(rt.state.snapshot.meta.workspaceRoot).snapshot(p.sessionId);
    const servers = mcp.list();
    const groups = agents.list();
    return {
      ...inspection,
      changes: snap.changes,
      artifacts: snap.artifacts,
      sources: snap.sources,
      coverage: snap.coverage,
      resources: [
        {
          id: 'mcp' as const,
          name: 'MCP',
          // `supported` 表示"这个能力已接入"（构建级事实），不是"已配置"。
          // 已配置多少、有几个可用，由 detail 说清楚——两者混用会让人误判。
          supported: true,
          detail: servers.length > 0
            ? `${servers.length} 个受信任服务 · ${servers.filter((s) => s.status === 'ready').length} 个可用 · ${servers.reduce((n, s) => n + s.toolCount, 0)} 个工具`
            : '尚未添加受信任的 MCP 服务；添加后其工具会进入模型的工具列表。',
        },
        {
          id: 'agents' as const,
          name: 'Agent 群',
          supported: true,
          detail: groups.groups.length > 0
            ? `${groups.groups.length} 个群${groups.active !== null ? ` · 激活：${groups.active}（执行模型取 common 角色）` : ''}`
            : '尚未配置三角色群（hyaki / sota / common）。',
        },
        {
          id: 'skills' as const,
          name: '技能',
          supported: false,
          detail: '当前没有已接入的技能执行器。不会把磁盘中的说明文档伪装成已生效技能。',
        },
        {
          id: 'checkpoints' as const,
          name: '检查点',
          supported: false,
          detail: '会话持久化不是工作区文件回滚检查点；回滚能力仍未实现。',
        },
      ],
    };
  });
  register(WorkbenchMethod.UsageQuery, async (params) => {
    const p = parseInput(usageQuerySchema, params);
    return workbench.query({ from: p.from, to: p.to, ...(p.workspaceRoot !== undefined ? { workspaceRoot: p.workspaceRoot } : {}) });
  });
  register(WorkbenchMethod.SessionArchive, async (params) => {
    mutable();
    const p = parseInput(sessionIdSchema.extend({ archived: z.boolean() }).strict(), params);
    const rt = requireRuntime(p.sessionId); requireIdle(rt);
    if (rt.commandActive) throw new DhpProtocolError('conflict_in_flight', 'A session command is in flight');
    rt.state.archived = p.archived;
    registry.bumpRevision(p.sessionId); notifySnapshot(p.sessionId);
    await workbench.save();
    server.broadcast(Notification.SessionChanged, { sessionId: p.sessionId, change: 'archived' });
    return { ok: true };
  });
  register(WorkbenchMethod.SessionConfigure, async (params) => {
    const p = parseInput(commandSchema.extend({ model: modelSpecSchema.optional(), permissionMode: permissionSchema.optional() }).strict().refine((p) => p.model !== undefined || p.permissionMode !== undefined), params);
    return runCommand({ ...p, payload: { configure: true, model: p.model, permissionMode: p.permissionMode } }, async () => {
      const rt = requireRuntime(p.sessionId); requireIdle(rt);
      const meta = rt.state.snapshot.meta;
      const model = p.model ?? meta.model;
      const mode = parseInput(permissionSchema, p.permissionMode ?? meta.permissionMode);
      workbench.model(model);
      const old = rt.agent;
      rt.messages = repairHistory(old?.history ?? rt.messages);
      await workbench.save();
      registry.patchMeta(p.sessionId, { model, permissionMode: mode });
      if (old && model !== meta.model) {
        rt.agent = undefined;
        try { ensureAgent(p.sessionId); }
        catch (e) { rt.agent = old; registry.patchMeta(p.sessionId, { model: meta.model, permissionMode: meta.permissionMode }); throw e; }
        await old.close();
      } else old?.engine.setMode(mode);
      if (model !== meta.model) workbench.context(p.sessionId, UNKNOWN_CONTEXT);
      registry.bumpRevision(p.sessionId);
      server.broadcast(Notification.SessionChanged, { sessionId: p.sessionId, change: 'configured' });
      return { commandId: p.commandId, status: 'accepted', revision: rt.state.snapshot.revision };
    });
  });
  register(WorkbenchMethod.ChannelSave, async (params) => {
    mutable();
    const channel = parseInput(channelSchema, params);
    const affected = [...runtimes.values()].filter((rt) => rt.state.snapshot.meta.model.startsWith(`${channel.id}:`));
    for (const rt of affected) {
      requireIdle(rt);
      if (rt.commandActive) throw new DhpProtocolError('conflict_in_flight', 'A session command is in flight');
      if (!channel.models.some((m) => `${channel.id}:${m.id}` === rt.state.snapshot.meta.model)) throw new DhpProtocolError('denied', 'Cannot remove a model referenced by a session');
    }
    for (const rt of affected) rt.commandActive = true;
    try {
      const result = await workbench.saveChannel(channel);
      for (const rt of affected) {
        rt.messages = repairHistory(rt.agent?.history ?? rt.messages);
        const old = rt.agent; rt.agent = undefined; rt.broker = undefined;
        await old?.close(); workbench.context(rt.state.sessionId, UNKNOWN_CONTEXT);
      }
      await workbench.save(); return result;
    } finally { for (const rt of affected) rt.commandActive = false; }
  });

  // ── 方法：MCP（FR-N-001）─────────────────────────────────────────────

  register(FeatureMethod.McpList, async () => ({ servers: mcp.list() }));

  register(FeatureMethod.McpAdd, async (params) => {
    mutable();
    const p = parseInput(mcpAddSchema, params);
    const result = await mcp.add({
      trusted: p.trusted,
      ...(p.name !== undefined ? { name: p.name } : {}),
      ...(p.command !== undefined ? { command: p.command } : {}),
      ...(p.args !== undefined ? { args: p.args } : {}),
      ...(p.url !== undefined ? { url: p.url } : {}),
      ...(p.envNames !== undefined ? { envNames: p.envNames } : {}),
    }).catch(serviceError);
    await workbench.save();
    return result;
  });

  register(FeatureMethod.McpRemove, async (params) => {
    mutable();
    const p = parseInput(mcpServerIdSchema, params);
    const result = await mcp.remove(p.serverId).catch(serviceError);
    await workbench.save();
    return result;
  });

  register(FeatureMethod.McpRestart, async (params) => {
    mutable();
    const p = parseInput(mcpServerIdSchema, params);
    return await mcp.restart(p.serverId).catch(serviceError);
  });

  register(FeatureMethod.McpTools, async (params) => {
    const p = parseInput(mcpServerIdSchema, params);
    return await mcp.tools(p.serverId).catch(serviceError);
  });

  // ── 方法：Agent 群三角色（FR-N-003）──────────────────────────────────

  register(FeatureMethod.AgentsList, async () => agents.list());

  register(FeatureMethod.AgentsSave, async (params) => {
    mutable();
    const p = parseInput(agentGroupSchema, params);
    // 模型规格必须真实存在（不编造厂商目录）。
    for (const role of ['hyaki', 'sota', 'common'] as const) workbench.model(p.roles[role]);
    return await agents.save(p).catch(serviceError);
  });

  register(FeatureMethod.AgentsDelete, async (params) => {
    mutable();
    const p = parseInput(agentGroupNameSchema, params);
    return await agents.remove(p.name).catch(serviceError);
  });

  register(FeatureMethod.AgentsActivate, async (params) => {
    mutable();
    const p = parseInput(agentGroupNameSchema, params);
    const result = await agents.activate(p.name).catch(serviceError);
    // 激活后：空闲会话的执行模型取 `common` 角色（`27` FR-N-003 验收要点）。
    for (const rt of runtimes.values()) {
      if (rt.busy || rt.state.archived) continue;
      const common = result.common;
      if (rt.state.snapshot.meta.model === common) continue;
      try {
        workbench.model(common);
      } catch {
        continue; // 模型不可用就保持原样，不伪造。
      }
      const old = rt.agent;
      rt.messages = repairHistory(old?.history ?? rt.messages);
      rt.agent = undefined;
      rt.broker = undefined;
      registry.patchMeta(rt.state.sessionId, { model: common });
      await old?.close();
      workbench.context(rt.state.sessionId, UNKNOWN_CONTEXT);
      registry.bumpRevision(rt.state.sessionId);
    }
    await workbench.save();
    return result;
  });

  // ── 方法：Git 只读（FR-N-021…024 / 027）─────────────────────────────

  register(FeatureMethod.GitStatus, async (params) => {
    const p = parseInput(workspaceRootSchema, params);
    return await gitService.status(requireRoot(p.workspaceRoot)).catch(serviceError);
  });

  register(FeatureMethod.GitGraph, async (params) => {
    const p = parseInput(gitGraphSchema, params);
    return await gitService.graph(requireRoot(p.workspaceRoot), {
      ...(p.maxCount !== undefined ? { maxCount: p.maxCount } : {}),
      ...(p.skip !== undefined ? { skip: p.skip } : {}),
    }).catch(serviceError);
  });

  register(FeatureMethod.GitBranches, async (params) => {
    const p = parseInput(workspaceRootSchema, params);
    return await gitService.branches(requireRoot(p.workspaceRoot)).catch(serviceError);
  });

  register(FeatureMethod.GitDiff, async (params) => {
    const p = parseInput(gitDiffSchema, params);
    return await gitService.diff(requireRoot(p.workspaceRoot), p.path, {
      ...(p.mode !== undefined ? { mode: p.mode } : {}),
      ...(p.commit !== undefined ? { commit: p.commit } : {}),
    }).catch(serviceError);
  });

  register(FeatureMethod.GitRemotes, async (params) => {
    const p = parseInput(workspaceRootSchema, params);
    const root = requireRoot(p.workspaceRoot);
    const remotes = await gitService.remotes(root).catch(serviceError);
    // 合并登录状态（凭据只从主进程通道来，不从 git 配置读）。
    const auth = await gitAuth.status(root, remotes.remotes.map((r) => ({ name: r.name, url: r.url }))).catch(serviceError);
    return { workspaceRoot: auth.workspaceRoot, remotes: auth.remotes };
  });

  register(FeatureMethod.GitAuthStatus, async (params) => {
    const p = parseInput(workspaceRootSchema, params);
    const root = requireRoot(p.workspaceRoot);
    const remotes = await gitService.remotes(root).catch(serviceError);
    return await gitAuth.status(root, remotes.remotes.map((r) => ({ name: r.name, url: r.url }))).catch(serviceError);
  });

  // ── 方法：Git 写操作（FR-N-025）──────────────────────────────────────
  //
  // 写操作只从**用户**路径进入 DHP；模型与工具没有任何通道能触发它们。

  register(FeatureMethod.GitStage, async (params) => {
    mutable();
    const p = parseInput(gitStageSchema.extend({ commandId: z.string().min(1).max(200), baseRevision: nonnegative.int() }).strict(), params);
    const result = await gitWrite.stage(requireRoot(p.workspaceRoot), p.paths, { commandId: p.commandId, baseRevision: p.baseRevision }).catch(serviceError);
    if (result.status === 'accepted') gitService.bumpRevision(requireRoot(p.workspaceRoot));
    await workbench.save();
    return result;
  });

  register(FeatureMethod.GitUnstage, async (params) => {
    mutable();
    const p = parseInput(gitStageSchema.extend({ commandId: z.string().min(1).max(200), baseRevision: nonnegative.int() }).strict(), params);
    const result = await gitWrite.unstage(requireRoot(p.workspaceRoot), p.paths, { commandId: p.commandId, baseRevision: p.baseRevision }).catch(serviceError);
    if (result.status === 'accepted') gitService.bumpRevision(requireRoot(p.workspaceRoot));
    await workbench.save();
    return result;
  });

  register(FeatureMethod.GitCommit, async (params) => {
    mutable();
    const p = parseInput(gitCommitSchema.extend({ commandId: z.string().min(1).max(200), baseRevision: nonnegative.int() }).strict(), params);
    const result = await gitWrite.commit(requireRoot(p.workspaceRoot), p.message, { commandId: p.commandId, baseRevision: p.baseRevision }, {
      ...(p.includeUnstaged !== undefined ? { includeUnstaged: p.includeUnstaged } : {}),
      ...(p.noVerify !== undefined ? { noVerify: p.noVerify } : {}),
      ...(p.allowEmpty !== undefined ? { allowEmpty: p.allowEmpty } : {}),
      ...(p.noSign !== undefined ? { noSign: p.noSign } : {}),
    }).catch(serviceError);
    if (result.status === 'accepted') gitService.bumpRevision(requireRoot(p.workspaceRoot));
    await workbench.save();
    return result;
  });

  register(FeatureMethod.GitBranchCreate, async (params) => {
    mutable();
    const p = parseInput(gitBranchSchema.extend({ commandId: z.string().min(1).max(200), baseRevision: nonnegative.int() }).strict(), params);
    const result = await gitWrite.createBranch(requireRoot(p.workspaceRoot), p.name, { commandId: p.commandId, baseRevision: p.baseRevision }, {
      ...(p.checkout !== undefined ? { checkout: p.checkout } : {}),
    }).catch(serviceError);
    if (result.status === 'accepted') gitService.bumpRevision(requireRoot(p.workspaceRoot));
    await workbench.save();
    return result;
  });

  register(FeatureMethod.GitBranchSwitch, async (params) => {
    mutable();
    const p = parseInput(gitBranchSchema.extend({ commandId: z.string().min(1).max(200), baseRevision: nonnegative.int() }).strict(), params);
    const result = await gitWrite.switchBranch(requireRoot(p.workspaceRoot), p.name, { commandId: p.commandId, baseRevision: p.baseRevision }).catch(serviceError);
    if (result.status === 'accepted') gitService.bumpRevision(requireRoot(p.workspaceRoot));
    await workbench.save();
    return result;
  });

  // ── 方法：远端与凭据（FR-N-027 / 030）────────────────────────────────

  register(FeatureMethod.GitRemoteAdd, async (params) => {
    mutable();
    const p = parseInput(gitRemoteAddSchema, params);
    const root = requireRoot(p.workspaceRoot);
    const remotes = await gitService.remotes(root).catch(serviceError);
    if (remotes.remotes.some((r) => r.name === p.name)) {
      throw new DhpProtocolError('conflict_in_flight', `remote already exists: ${p.name}`);
    }
    const safe = assertSafeRemoteUrl(p.url);
    await runGit({ root, args: ['remote', 'add', p.name, safe], write: true }).catch(serviceError);
    store.data.gitRemotes[root] = [...(store.data.gitRemotes[root] ?? []), { name: p.name, url: sanitizeRemoteUrl(safe), addedAt: Date.now() }];
    await workbench.save();
    return { name: p.name, url: sanitizeRemoteUrl(safe) };
  });

  register(FeatureMethod.GitRemoteRemove, async (params) => {
    mutable();
    const p = parseInput(gitRemoteNameSchema, params);
    const root = requireRoot(p.workspaceRoot);
    await runGit({ root, args: ['remote', 'remove', p.name], write: true }).catch(serviceError);
    store.data.gitRemotes[root] = (store.data.gitRemotes[root] ?? []).filter((r) => r.name !== p.name);
    await workbench.save();
    return { removed: true };
  });

  register(FeatureMethod.GitAuthOauthStart, async (params) => {
    mutable();
    const p = parseInput(gitOauthStartSchema, params);
    const root = requireRoot(p.workspaceRoot);
    const started = await gitAuth.startOauth({
      workspaceRoot: root,
      remote: p.remote,
      provider: p.provider,
      ...(p.clientId !== undefined ? { clientId: p.clientId } : {}),
      ...(p.domain !== undefined ? { domain: p.domain } : {}),
    }).catch(serviceError);
    // 记住 flow → 工作区/远端：poll 拿到令牌时要写回元信息与通知。
    oauthFlows.set(started.flowId, { root, remote: p.remote });
    return started;
  });

  register(FeatureMethod.GitAuthOauthPoll, async (params) => {
    const p = parseInput(gitOauthFlowSchema, params);
    const result = await gitAuth.pollOauth(p.flowId).catch(serviceError);
    const flow = oauthFlows.get(p.flowId);
    if (result.status === 'ready' && flow !== undefined) {
      oauthFlows.delete(p.flowId);
      // 令牌只在钥匙串里；这里落的是账号 / scope / 指纹这些公开元信息。
      publishGitAuth(flow.root, flow.remote, {
        method: 'oauth',
        configured: true,
        account: result.account,
        scope: [...result.scope],
        ready: true,
        keyFingerprint: null,
        updatedAt: Date.now(),
      });
      await workbench.save();
    } else if (result.status === 'denied' || result.status === 'expired') {
      oauthFlows.delete(p.flowId);
    }
    return result;
  });

  register(FeatureMethod.GitAuthOauthCancel, async (params) => {
    mutable();
    const p = parseInput(gitOauthFlowSchema, params);
    const result = await gitAuth.cancelOauth(p.flowId).catch(serviceError);
    oauthFlows.delete(p.flowId);
    return result;
  });

  register(FeatureMethod.GitAuthSshUseAgent, async (params) => {
    mutable();
    const p = parseInput(gitRemoteAuthSchema, params);
    const root = requireRoot(p.workspaceRoot);
    const auth = await gitAuth.useSshAgent({ workspaceRoot: root, remote: p.remote }).catch(serviceError);
    publishGitAuth(root, p.remote, auth);
    await workbench.save();
    return auth;
  });

  register(FeatureMethod.GitAuthSshGenerate, async (params) => {
    mutable();
    const p = parseInput(gitRemoteAuthSchema, params);
    const root = requireRoot(p.workspaceRoot);
    const generated = await gitAuth.generateSshKey({
      workspaceRoot: root,
      remote: p.remote,
      ...(p.comment !== undefined ? { comment: p.comment } : {}),
    }).catch(serviceError);
    // 只把公钥与指纹返回给渲染层；私钥已经在服务内部交给主进程钥匙串。
    publishGitAuth(root, p.remote, {
      method: 'ssh-key',
      configured: true,
      account: null,
      scope: [],
      ready: true,
      keyFingerprint: generated.fingerprint,
      updatedAt: Date.now(),
    });
    await workbench.save();
    return generated;
  });

  register(FeatureMethod.GitAuthClear, async (params) => {
    mutable();
    const p = parseInput(gitRemoteAuthSchema, params);
    const root = requireRoot(p.workspaceRoot);
    const result = await gitAuth.clear({ workspaceRoot: root, remote: p.remote }).catch(serviceError);
    publishGitAuth(root, p.remote, {
      method: 'none',
      configured: false,
      account: null,
      scope: [],
      ready: false,
      keyFingerprint: null,
      updatedAt: null,
    });
    await workbench.save();
    return result;
  });

  // ── 方法：预检与上传（FR-N-028 / 029）────────────────────────────────

  register(FeatureMethod.GitPreflight, async (params) => {
    const p = parseInput(gitPreflightSchema, params);
    return await gitUpload.preflight(requireRoot(p.workspaceRoot), p.remote, {
      ...(p.branch !== undefined ? { branch: p.branch } : {}),
      ...(p.scope !== undefined ? { scope: p.scope } : {}),
    }).catch(serviceError);
  });

  register(FeatureMethod.GitUpload, async (params) => {
    mutable();
    const p = parseInput(gitUploadSchema, params);
    const root = requireRoot(p.workspaceRoot);
    const result = await gitUpload.upload(root, p.remote, p.branch, p.message, { commandId: p.commandId, baseRevision: p.baseRevision }, {
      ...(p.includeUnstaged !== undefined ? { includeUnstaged: p.includeUnstaged } : {}),
      ...(p.scope !== undefined ? { scope: p.scope } : {}),
    }).catch(serviceError);
    gitService.bumpRevision(root);
    await workbench.save();
    return result;
  });

  // ── 方法：提交信息生成（FR-N-026，只读）──────────────────────────────
  //
  // 只读：不执行任何 git 写操作、不落盘。模型不可用时返回 fallback，
  // 界面预填并允许用户改写——生成失败不等于功能不可用。

  register(FeatureMethod.GitCommitMessage, async (params) => {
    const p = parseInput(gitCommitMessageSchema, params);
    const root = requireRoot(p.workspaceRoot);
    const scope = p.scope ?? 'staged';

    const status = await gitService.status(root).catch(serviceError);
    const sessionSnapshot = p.sessionId !== undefined ? collectorFor(root).snapshot(p.sessionId) : undefined;
    const files = scope === 'session'
      ? (sessionSnapshot?.changes ?? []).map((c) => c.path)
      : status.files.filter((f) => f.staged).map((f) => f.path);

    // 整树 diff 一次取齐（不逐文件调用，避免 N 次 git 子进程）。
    const diff = await runGit({
      root,
      args: scope === 'session' ? ['diff'] : ['diff', '--cached'],
      maxOutputBytes: 512 * 1024,
    }).catch(serviceError);

    const modelSpec = p.sessionId !== undefined
      ? (runtimes.get(p.sessionId)?.state.snapshot.meta.model ?? (await effective()).model)
      : (await effective()).model;

    const sessionChanges = sessionSnapshot === undefined
      ? undefined
      : sessionSnapshot.changes.map((c) => ({ path: c.path, status: c.status, added: c.added, removed: c.removed }));

    const service = new CommitMessageService({ complete: (req) => completeOnce(modelSpec, req) });
    return await service.generate({
      workspaceRoot: root,
      files,
      diff: diff.stdout,
      ...(sessionChanges !== undefined ? { sessionChanges } : {}),
      ...(p.hint !== undefined ? { hint: p.hint } : {}),
    });
  });

  // ── 方法：配置 / 模型 ────────────────────────────────────────────────

  register(Method.ConfigGet, async () => {
    const eff = await effective();
    return eff satisfies ConfigGetResult;
  });

  register(Method.ConfigSet, async (params) => {
    mutable();
    const p = parseInput(z.object({ key: z.enum(['model', 'permissionMode', 'language']), value: z.string() }).strict(), params);
    if (p.key === 'model') { workbench.model(p.value); store.data.defaults.model = p.value; }
    else if (p.key === 'permissionMode') store.data.defaults.permissionMode = parseInput(permissionSchema, p.value);
    else store.data.defaults.language = parseInput(z.enum(['en', 'zh']), p.value);
    // Legacy default commands affect new sessions only; no CLI config writes.
    await workbench.save();
    const eff = await effective();
    return { ok: true as const, effective: String(eff[p.key]) };
  });

  register(Method.ModelList, async () => {
    const eff = await effective();
    const available = workbench.channels().flatMap((c) => c.models.map((m) => ({ spec: `${c.id}:${m.id}`, provider: c.id, model: m.id, hasKey: c.credentialReady })));
    return { current: eff.model, available } satisfies ModelListResult;
  });

  register(Method.ModelUse, async (params) => {
    mutable();
    const p = parseInput(z.object({ spec: modelSpecSchema }).strict(), params);
    workbench.model(p.spec);
    store.data.defaults.model = p.spec;
    await workbench.save();
    return { ok: true as const, current: p.spec };
  });

  // ── 方法：工作区 ──────────────────────────────────────────────────────

  register(Method.WorkspaceOpen, async (params) => {
    mutable();
    const p = parseInput(z.object({ path: z.string().min(1).max(4096) }).strict(), params);
    const w = await workbench.openWorkspace(p.path);
    return { workspaceRoot: w.root, name: w.name };
  });

  register(Method.WorkspaceTree, async (params) => {
    const p = parseInput(z.object({ workspaceRoot: z.string().optional(), path: z.string().optional(), maxDepth: nonnegative.int().max(20).optional() }).strict(), params ?? {});
    const root = workbench.requireWorkspace(p.workspaceRoot ?? workspaceRoot).root;
    const nodes = await new WorkspaceService({ root }).tree(p.path ?? '.', p.maxDepth ?? 3);
    return { root, nodes } satisfies WorkspaceTreeResult;
  });

  register(Method.WorkspaceReadFile, async (params) => {
    const p = parseInput(z.object({ workspaceRoot: z.string().optional(), path: z.string(), maxBytes: nonnegative.int().positive().optional() }).strict(), params);
    const root = workbench.requireWorkspace(p.workspaceRoot ?? workspaceRoot).root;
    try {
      const r = await new WorkspaceService({ root, ...(p.maxBytes !== undefined ? { maxReadBytes: Math.min(p.maxBytes, 512 * 1024) } : {}) }).readFile(p.path);
      return r satisfies WorkspaceReadFileResult;
    } catch (err) {
      const e = err as { kind?: string; message?: string };
      throw new DhpProtocolError(
        e.kind === 'not_found' ? 'path_rejected' : e.kind === 'path_rejected' ? 'path_rejected' : 'outside_workspace',
        e.message ?? 'workspace read failed',
      );
    }
  });

  register(Method.WorkspaceDiff, async (params) => {
    const p = params as { path: string; before: string; after: string };
    return workspace.diff(p.path, p.before, p.after) satisfies WorkspaceDiffResult;
  });

  // ── 方法：治理 / 成本 / 诊断 ──────────────────────────────────────────

  register(Method.GovernanceStatus, async () => {
    return {
      tenantId: 'local',
      policyRevision: 'local-1',
      capabilityCount: 0,
      tasks: { total: 0, unterminated: 0 },
      pendingApprovals: [...runtimes.values()].reduce((n, rt) => n + (rt.broker?.pending().length ?? 0), 0),
      auditOk: true,
      budget: { accountId: 'local', usedUsd: 0 },
    };
  });

  register(Method.GovernanceTasks, async () => ({ tasks: [] }));
  register(Method.GovernanceApprovals, async () => {
    const approvals = [...runtimes.values()].flatMap((rt) =>
      (rt.broker?.pending() ?? []).map((p) => ({
        id: p.id,
        subject: p.subject,
        risk: p.risk,
        ...(p.expiresAt !== undefined ? { expiresAt: new Date(p.expiresAt).toISOString() } : {}),
      })),
    );
    return { approvals };
  });

  register(Method.GovernanceDecide, async (params) => {
    const p = params as {
      commandId: string;
      baseRevision: number;
      approvalId: string;
      optionId: string;
    };
    // 找到持有该交互的会话，复用 interaction/resolve 的逻辑。
    for (const [sessionId, rt] of runtimes) {
      const found = (rt.broker?.pending() ?? []).some((i) => i.id === p.approvalId);
      if (!found) continue;
      return runCommand(
        {
          commandId: p.commandId,
          baseRevision: p.baseRevision,
          sessionId,
          payload: { approvalId: p.approvalId, optionId: p.optionId },
        },
        async () => {
          const outcome = rt.broker!.resolve(p.approvalId, p.optionId);
          if (!outcome.ok) throw new DhpProtocolError(outcome.kind, outcome.message);
          registry.setPending(sessionId, rt.broker!.pending());
          return { commandId: p.commandId, status: 'accepted' as const, revision: rt.state.snapshot.revision };
        },
      );
    }
    throw new DhpProtocolError('capability_not_found', `unknown approval: ${p.approvalId}`);
  });

  register(Method.GovernanceAudit, async () => ({ ok: true, events: [] }));

  register(Method.GovernancePolicyExplain, async (params) => {
    const p = params as { capabilityId: string };
    return {
      effect: 'ask' as const,
      reasons: ['默认策略：写操作需用户确认（permissionMode=default）'],
      matchedRules: [{ id: 'default-write-ask', effect: 'ask', source: 'builtin' }],
    } satisfies GovernancePolicyExplainResult;
  });

  register(Method.CostWorkspace, async (params) => {
    const p = parseInput(z.object({ workspaceRoot: z.string().optional() }).strict(), params ?? {});
    const root = workbench.requireWorkspace(p.workspaceRoot ?? workspaceRoot).root;
    const records = store.data.ledger.filter((r) => r.workspaceRoot === root);
    return { workspace: root, totals: totals(records), models: [...new Set(records.map((r) => r.model))].map((spec) => ({ spec, ...totals(records.filter((r) => r.model === spec)) })) };
  });

  register(Method.DoctorRun, async () => {
    const checks: DoctorRunResult['checks'][number][] = [];
    checks.push({ name: 'syaoHome', status: 'ok', detail: paths.home });
    checks.push({
      name: 'node',
      status: 'ok',
      detail: `${process.version} (${process.platform}/${process.arch})`,
    });
    const cfg = await effective();
    let keyOk = false;
    try { workbench.model(cfg.model); keyOk = true; } catch { /* no fallback */ }
    checks.push({
      name: 'provider',
      status: keyOk ? 'ok' : 'warn',
      detail: keyOk ? 'Configured model is ready' : 'Model or credentials unavailable; no mock fallback',
    });
    checks.push({
      name: 'workspace',
      status: 'ok',
      detail: workspaceRoot,
    });
    return { checks } satisfies DoctorRunResult;
  });

  // ── 方法：系统 ────────────────────────────────────────────────────────

  register(Method.AppInfo, async () => {
    return {
      appVersion: '0.1.0',
      hostVersion: '0.1.0',
      dhpVersion: { major: 1, minor: 0 },
      nodeVersion: process.version,
      platform: `${process.platform}-${process.arch}`,
      workspaceRoot,
      capabilities: ['session', 'turn', 'interaction', 'config', 'model', 'workspace'],
    } satisfies AppInfoResult;
  });

  let closePromise: Promise<void> | undefined;
  const close = (): Promise<void> => {
    if (closePromise) return closePromise;
    closing = true;
    closePromise = (async () => {
      for (const rt of runtimes.values()) { rt.state.abort?.abort(); rt.broker?.drain('Host closing'); }
      await Promise.allSettled([...operations]);
      await Promise.allSettled([...inflight.values()].map((x) => x.promise));
      for (const rt of runtimes.values()) { rt.state.abort?.abort(); rt.broker?.drain('Host closing'); await rt.run; await rt.agent?.close(); }
      try { await workbench.close(); }
      finally {
        for (const subs of subscriptions.values()) for (const sub of subs.values()) sub.unsubscribe();
        subscriptions.clear(); for (const remove of disconnects.values()) remove(); disconnects.clear();
        await server.close(); runtimes.clear();
      }
    })();
    return closePromise;
  };
  register(Method.AppShutdown, async () => {
    setImmediate(() => { void close().then(() => { if (opts.exitOnShutdown) process.exit(0); }).catch(() => log('error', 'Host shutdown persistence failed')); });
    return { ok: true };
  });
  return { server, paths, workspace, close };
}

/** 供 `toSessionEvents` 的单事件调试用。 */
export { toSessionEvents };
