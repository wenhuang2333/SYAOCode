import { useCallback, useEffect, useRef, useState } from 'react';
import { DhpConnection, ProjectionStore, type WebSocketLike } from '@syaocode/client';
import {
  FeatureMethod, Method, WorkbenchMethod, isSuccessfulStatus,
  type AckResult, type AgentsListResult, type AgentsSaveParams, type ChannelConfig, type DesktopOverview, type DesktopPermissionMode,
  type GitAuthStatusResult, type GitBranchesResult, type GitCommitMessageResult, type GitDiffResult, type GitGraphResult, type GitPreflightResult,
  type GitRemotesResult, type GitStatusResult, type GitUploadResult, type McpAddParams, type McpServerInfo, type McpToolSummary,
  type SessionChangesNotification, type SessionInspection, type SessionSnapshot, type UsageQuery, type UsageReport,
  type WorkspaceTreeResult, type WorkspaceReadFileResult,
} from '@syaocode/dhp';
import { isSigningFailure, type GitCommitInput } from './git-sidebar';

interface Bridge {
  readonly host: { info(): Promise<{ port: number; workspaceRoot: string }> };
  readonly app: {
    openDirectory(): Promise<string | undefined>;
    /** 可选：打开外部 https 链接（主进程校验协议）。未提供时界面只展示链接文本。 */
    openExternal?(url: string): Promise<void>;
  };
  /**
   * 可选：Git 凭据窄桥（**只写不读回**，见 `27` §10.7.4）。
   *
   * 主进程尚未提供时，渲染层明确降级提示，不假装"保存成功"。
   */
  readonly git?: {
    setToken(input: { readonly workspaceRoot: string; readonly remote: string; readonly url: string; readonly token: string }): Promise<void>;
    clear(input: { readonly workspaceRoot: string; readonly remote: string; readonly url: string }): Promise<void>;
    useSshAgent?(input: { readonly workspaceRoot: string; readonly remote: string; readonly url: string }): Promise<void>;
  };
  readonly events: { onHostCrashed(cb: (p: { stderrTail: string }) => void): () => void };
}

declare global { interface Window { readonly syao?: Bridge } }

/**
 * 命令信封（`27` §5.1）：`commandId` + `baseRevision`。
 *
 * 会话写操作与 Git 写操作共用同一套语义（幂等 + CAS）。
 */
export function envelopeOf(baseRevision: number, commandId: string): { readonly commandId: string; readonly baseRevision: number } {
  return { commandId, baseRevision };
}

/**
 * Git 写操作的返回值兼容两种形状：
 *  - Host 直接返回业务结果；
 *  - Host 返回六态 ACK（`status` / `reason` / `data`）。
 *
 * 两种都要能识别失败，否则界面会拿"未完成"当"成功"。
 */
export function unwrapGitResult<T>(raw: unknown): T | undefined {
  if (typeof raw === 'object' && raw !== null && 'status' in raw) {
    const ack = raw as AckResult;
    if (!isSuccessfulStatus(ack.status)) throw new Error(ack.reason ?? `操作未完成：${ack.status}`);
    return ack.data as T | undefined;
  }
  return raw as T | undefined;
}

export type Page = 'chat' | 'usage' | 'sessions' | 'files' | 'agents' | 'resources' | 'settings';
export type ConnectionStatus = 'booting' | 'ready' | 'reconnecting' | 'error';

export function initialQuery(): UsageQuery {
  const end = new Date();
  end.setHours(23, 59, 59, 999);
  const start = new Date(end);
  start.setDate(start.getDate() - 6);
  start.setHours(0, 0, 0, 0);
  return { from: start.getTime(), to: end.getTime() };
}

export function useWorkbench() {
  const [status, setStatus] = useState<ConnectionStatus>('booting');
  const [error, setError] = useState('');
  const [overview, setOverview] = useState<DesktopOverview>();
  const [snapshot, setSnapshot] = useState<SessionSnapshot>();
  const [inspection, setInspection] = useState<SessionInspection>();
  // 通知驱动的最小状态：只做"该刷新了"的信号，真正的取数仍走既有函数。
  const [pendingChanges, setPendingChanges] = useState<SessionChangesNotification | null>(null);
  const [gitChangedAt, setGitChangedAt] = useState(0);
  const [mcpChangedAt, setMcpChangedAt] = useState(0);
  const [sessionId, setSessionId] = useState('');
  const [workspaceRoot, setWorkspaceRoot] = useState('');
  const [page, setPage] = useState<Page>('chat');
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [loadingSession, setLoadingSession] = useState(false);
  const [mutating, setMutating] = useState(false);
  const [query, setQuery] = useState<UsageQuery>(initialQuery);
  const [report, setReport] = useState<UsageReport>();
  const [loadingUsage, setLoadingUsage] = useState(false);
  // ── Git（工作区口径，与"会话改动"互不相加）──────────────────────────
  const [gitStatus, setGitStatus] = useState<GitStatusResult>();
  const [gitBranches, setGitBranches] = useState<GitBranchesResult>();
  const [gitGraph, setGitGraph] = useState<GitGraphResult>();
  const [gitRemotes, setGitRemotes] = useState<GitRemotesResult>();
  const [gitAuth, setGitAuth] = useState<GitAuthStatusResult>();
  const [gitPreflight, setGitPreflight] = useState<GitPreflightResult>();
  const [gitUpload, setGitUpload] = useState<GitUploadResult>();
  const [gitDiff, setGitDiff] = useState<GitDiffResult>();
  const [gitError, setGitError] = useState('');
  const [gitLoading, setGitLoading] = useState(false);
  const [gitProbeUnavailable, setGitProbeUnavailable] = useState(false);
  // ── MCP / Agent 群 ────────────────────────────────────────────────
  const [mcpServers, setMcpServers] = useState<readonly McpServerInfo[]>([]);
  const [mcpLoading, setMcpLoading] = useState(false);
  const [mcpError, setMcpError] = useState('');
  const [agents, setAgents] = useState<AgentsListResult>();
  const [agentsLoading, setAgentsLoading] = useState(false);
  const [agentsError, setAgentsError] = useState('');
  const conn = useRef<DhpConnection | undefined>(undefined);
  const store = useRef<ProjectionStore | undefined>(undefined);
  const active = useRef('');
  const selection = useRef(0);
  const refreshNumber = useRef(0);
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const executions = useRef(new Map<string, string>());
  const actionPending = useRef(false);

  const request = useCallback(async <T,>(method: string, params?: unknown): Promise<T> => {
    if (!conn.current || conn.current.connectionState !== 'ready') throw new Error('本地运行时未连接，请稍后重试。');
    return await conn.current.request(method, params) as T;
  }, []);

  const inspect = useCallback(async () => {
    const sid = active.current;
    if (!sid) { setInspection(undefined); return; }
    const result = await request<SessionInspection>(WorkbenchMethod.SessionInspect, { sessionId: sid });
    if (active.current === sid) setInspection(result);
  }, [request]);

  const refresh = useCallback(async (): Promise<DesktopOverview | undefined> => {
    const revision = ++refreshNumber.current;
    const result = await request<DesktopOverview>(WorkbenchMethod.Overview);
    if (revision === refreshNumber.current) setOverview(result);
    return result;
  }, [request]);

  const refreshSoon = useCallback(() => {
    if (refreshTimer.current) return;
    refreshTimer.current = setTimeout(() => {
      refreshTimer.current = undefined;
      void refresh().then(inspect).catch((e: Error) => setError(e.message));
    }, 250);
  }, [refresh, inspect]);

  const selectSession = useCallback(async (sid: string) => {
    const ticket = ++selection.current;
    const previous = active.current;
    active.current = sid;
    setSessionId(sid);
    setSnapshot(undefined);
    setInspection(undefined);
    store.current?.clear();
    setPage('chat');
    setLoadingSession(Boolean(sid));
    try {
      if (previous) await request(Method.SessionUnsubscribe, { sessionId: previous });
      if (ticket !== selection.current || !sid) return;
      const next = await request<SessionSnapshot>(Method.SessionSnapshot, { sessionId: sid });
      if (ticket !== selection.current) return;
      store.current?.replacement(next);
      setWorkspaceRoot(next.meta.workspaceRoot);
      localStorage.setItem('syao:last-session', sid);
      await request(Method.SessionSubscribe, { sessionId: sid, baseSeq: next.seq, epoch: next.epoch });
      if (ticket === selection.current) await inspect();
    } catch (e) {
      if (ticket === selection.current) setError((e as Error).message);
    } finally {
      if (ticket === selection.current) setLoadingSession(false);
    }
  }, [request, inspect]);

  useEffect(() => {
    const bridge = window.syao;
    if (!bridge) { setStatus('error'); setError('请通过 SYAOCode 桌面应用启动工作台，本页面需要安全的本机连接。'); return; }
    let disposed = false;
    let connection: DhpConnection | undefined;
    const boot = async () => {
      try {
        const info = await bridge.host.info();
        if (disposed) return;
        setWorkspaceRoot(info.workspaceRoot);
        const projection = new ProjectionStore({
          onResubscribe: (p) => {
            if (p.sessionId !== active.current) return;
            // Resync suppresses deltas until a replacement; omit watermarks to request one.
            void connection?.request(Method.SessionSubscribe, { sessionId: p.sessionId }).catch((e: Error) => setError(e.message));
          },
        });
        store.current = projection;
        projection.subscribe((s) => { if (!disposed && s.meta.sessionId === active.current) setSnapshot(s); });
        connection = new DhpConnection({
          url: `ws://127.0.0.1:${info.port}`, token: '',
          socketFactory: (url): WebSocketLike => new WebSocket(url) as unknown as WebSocketLike,
          onStateChange: (s) => {
            if (!disposed) setStatus(s === 'ready' ? 'ready' : s === 'closed' ? 'error' : s === 'reconnecting' ? 'reconnecting' : 'booting');
          },
          onSnapshot: (sid, s) => { if (!disposed && sid === active.current) projection.replacement(s); },
          onDelta: (sid, d) => {
            if (!disposed && sid === active.current) projection.delta(d);
            if (d.events.some((e) => ['turn.end', 'usage', 'error'].includes(e.type))) refreshSoon();
          },
          onSessionChanged: () => refreshSoon(),
          // 四类新通知（`27` §5.3）：改动/产出/来源直接整体替换，省一次 inspect 往返。
          onSessionChanges: (changes) => { if (!disposed && changes.sessionId === active.current) setPendingChanges(changes); },
          onGitChanged: () => { if (!disposed) setGitChangedAt(Date.now()); },
          onGitAuthChanged: () => { if (!disposed) setGitChangedAt(Date.now()); },
          onMcpChanged: () => { if (!disposed) setMcpChangedAt(Date.now()); },
          onError: (e) => { if (!disposed) setError(e.message); },
          onReconnected: () => {
            const s = projection.current;
            if (s && active.current === s.meta.sessionId) {
              void connection?.request(Method.SessionSubscribe, { sessionId: active.current }).catch((e: Error) => setError(e.message));
            }
            refreshSoon();
          },
        });
        conn.current = connection;
        await connection.connect();
        if (disposed) return;
        const data = await refresh();
        if (disposed || !data) return;
        const remembered = localStorage.getItem('syao:last-session');
        const target = data.sessions.find((s) => !s.archived && s.sessionId === remembered) ?? data.sessions.find((s) => !s.archived);
        if (target) await selectSession(target.sessionId);
      } catch (e) {
        if (!disposed) { setStatus('error'); setError((e as Error).message); }
      }
    };
    void boot();
    const offCrash = bridge.events.onHostCrashed(() => {
      setStatus('error'); setError('本地运行时已退出。请重新启动应用；已保存的会话会在启动后恢复。');
    });
    return () => {
      disposed = true;
      offCrash();
      if (refreshTimer.current) clearTimeout(refreshTimer.current);
      connection?.close();
    };
  }, [refresh, selectSession, refreshSoon]);

  useEffect(() => {
    if (status !== 'ready') return;
    const timer = setInterval(() => { void refresh().then(inspect).catch((e: Error) => setError(e.message)); }, 5000);
    return () => clearInterval(timer);
  }, [status, refresh, inspect]);

  useEffect(() => {
    if (page !== 'usage' || status !== 'ready') return;
    let cancelled = false;
    setLoadingUsage(true);
    void request<UsageReport>(WorkbenchMethod.UsageQuery, query)
      .then((value) => { if (!cancelled) setReport(value); })
      .catch((e: Error) => { if (!cancelled) { setReport(undefined); setError(e.message); } })
      .finally(() => { if (!cancelled) setLoadingUsage(false); });
    return () => { cancelled = true; };
  }, [page, status, query, overview?.today.requests, request]);

  const perform = useCallback(async (action: () => Promise<void>) => {
    if (actionPending.current) return;
    actionPending.current = true;
    setMutating(true);
    setError('');
    try { await action(); } catch (e) { setError((e as Error).message); }
    finally { actionPending.current = false; setMutating(false); }
  }, []);

  const envelope = useCallback((baseRevision: number) => envelopeOf(baseRevision, `cmd_${crypto.randomUUID()}`), []);

  const command = useCallback(async (method: string, payload: Record<string, unknown> = {}, sid = active.current): Promise<AckResult> => {
    if (!sid) throw new Error('请先创建或选择会话。');
    const current = await request<SessionSnapshot>(Method.SessionSnapshot, { sessionId: sid });
    const result = await request<AckResult>(method, { ...payload, sessionId: sid, ...envelope(current.revision) });
    if (!isSuccessfulStatus(result.status)) {
      if (active.current === sid) store.current?.replacement(await request<SessionSnapshot>(Method.SessionSnapshot, { sessionId: sid }));
      throw new Error(result.reason ?? `操作未完成：${result.status}`);
    }
    if (active.current === sid) {
      const next = await request<SessionSnapshot>(Method.SessionSnapshot, { sessionId: sid });
      if (active.current === sid) store.current?.replacement(next);
    }
    refreshSoon();
    return result;
  }, [request, refreshSoon, envelope]);

  // ── Git（工作区口径）───────────────────────────────────────────────

  /** Git 状态 + 分支 + 远端 + 认证：一次刷新读齐。 */
  const gitRefresh = useCallback(async (root: string): Promise<void> => {
    if (!root) { setGitError('请先选择工作区目录。'); return; }
    setGitLoading(true);
    try {
      const status = await request<GitStatusResult>(FeatureMethod.GitStatus, { workspaceRoot: root });
      setGitStatus(status);
      const [branches, remotes, auth] = await Promise.all([
        request<GitBranchesResult>(FeatureMethod.GitBranches, { workspaceRoot: root }),
        request<GitRemotesResult>(FeatureMethod.GitRemotes, { workspaceRoot: root }),
        request<GitAuthStatusResult>(FeatureMethod.GitAuthStatus, { workspaceRoot: root }),
      ]);
      setGitBranches(branches);
      setGitRemotes(remotes);
      setGitAuth(auth);
      setGitError('');
    } catch (e) {
      setGitError((e as Error).message);
    } finally {
      setGitLoading(false);
    }
  }, [request]);

  /**
   * 静默探测：只为顶部工具栏的 `+/-` 徽标与认证状态点取数，
   * **不打开侧栏、不弹出任何内容**（`27` §11.0「不自动弹出」）。
   */
  const gitProbe = useCallback(async (root: string): Promise<void> => {
    if (!root) return;
    try {
      const [status, auth] = await Promise.all([
        request<GitStatusResult>(FeatureMethod.GitStatus, { workspaceRoot: root }),
        request<GitAuthStatusResult>(FeatureMethod.GitAuthStatus, { workspaceRoot: root }),
      ]);
      setGitStatus(status);
      setGitAuth(auth);
      setGitProbeUnavailable(false);
    } catch {
      // 非 Git 仓库 / git 不可用：徽标保持为空，不打扰用户；工作区变化后再试。
      setGitProbeUnavailable(true);
    }
  }, [request]);

  /**
   * 生成提交信息（FR-N-026，只读）。
   *
   * 失败时**不抛**：Host 会降级成确定性兜底文案，界面预填并允许改写。
   * 真正的传输/协议错误仍会抛出，由调用方显示为"生成失败"。
   */
  const gitCommitMessage = useCallback(async (
    root: string,
    scope: 'staged' | 'session',
    sessionId?: string,
  ): Promise<GitCommitMessageResult | undefined> => {
    if (!root) return undefined;
    return await request<GitCommitMessageResult>(FeatureMethod.GitCommitMessage, {
      workspaceRoot: root,
      scope,
      ...(sessionId !== undefined && sessionId !== '' ? { sessionId } : {}),
    });
  }, [request]);

  /** 提交图分页（`skip` 递增，默认 50 条）。 */
  const gitGraphLoad = useCallback(async (root: string, skip = 0): Promise<void> => {
    if (!root) return;
    setGitLoading(true);
    try {
      const result = await request<GitGraphResult>(FeatureMethod.GitGraph, { workspaceRoot: root, maxCount: 50, skip });
      setGitGraph((previous) => (previous && skip > 0 ? { ...result, commits: [...previous.commits, ...result.commits] } : result));
      setGitError('');
    } catch (e) {
      setGitError((e as Error).message);
    } finally {
      setGitLoading(false);
    }
  }, [request]);

  /** 单文件 diff（只读）。 */
  const gitDiffLoad = useCallback(async (root: string, path: string, mode: 'worktree' | 'staged' = 'worktree'): Promise<GitDiffResult | undefined> => {
    try {
      const result = await request<GitDiffResult>(FeatureMethod.GitDiff, { workspaceRoot: root, path, mode });
      setGitDiff(result);
      return result;
    } catch (e) {
      setGitError((e as Error).message);
      return undefined;
    }
  }, [request]);

  /** Git 写操作：命令信封 + 六态 ACK（`27` §5.1）。 */
  const gitWrite = useCallback(async <T,>(method: string, payload: Record<string, unknown>, root: string): Promise<T | undefined> => {
    const revision = gitStatus?.revision ?? 0;
    const raw = await request<unknown>(method, { ...payload, ...envelope(revision) });
    const result = unwrapGitResult<T>(raw);
    await gitRefresh(root);
    return result;
  }, [request, envelope, gitStatus, gitRefresh]);

  const gitStage = useCallback((root: string, paths: readonly string[]) => perform(async () => {
    await gitWrite(FeatureMethod.GitStage, { workspaceRoot: root, paths }, root);
  }), [perform, gitWrite]);

  const gitUnstage = useCallback((root: string, paths: readonly string[]) => perform(async () => {
    await gitWrite(FeatureMethod.GitUnstage, { workspaceRoot: root, paths }, root);
  }), [perform, gitWrite]);

  /**
   * 提交（本地写操作，`27` §10.5.3）。
   *
   * 与其它写操作不同：错误必须**抛回提交区**——签名失败时界面要给出
   * "重试 / 无签名提交 / 取消"三路径，不能只在错误条里吞掉。
   * 签名失败也不写普通错误条，避免与三路径面板重复。
   */
  const gitCommit = useCallback(async (root: string, input: GitCommitInput): Promise<void> => {
    if (actionPending.current) throw new Error('已有操作正在进行，请稍后重试。');
    actionPending.current = true;
    setMutating(true);
    setError('');
    try {
      await gitWrite(FeatureMethod.GitCommit, {
        workspaceRoot: root,
        message: input.message,
        ...(input.allowEmpty === undefined ? {} : { allowEmpty: input.allowEmpty }),
        ...(input.noVerify === undefined ? {} : { noVerify: input.noVerify }),
        ...(input.noSign === undefined ? {} : { noSign: input.noSign }),
      }, root);
    } catch (e) {
      if (!isSigningFailure(e)) setError((e as Error).message);
      throw e;
    } finally {
      actionPending.current = false;
      setMutating(false);
    }
  }, [gitWrite]);

  const gitBranchCreate = useCallback((root: string, name: string, checkout = false) => perform(async () => {
    await gitWrite(FeatureMethod.GitBranchCreate, { workspaceRoot: root, name, checkout }, root);
  }), [perform, gitWrite]);

  const gitBranchSwitch = useCallback((root: string, name: string) => perform(async () => {
    await gitWrite(FeatureMethod.GitBranchSwitch, { workspaceRoot: root, name }, root);
  }), [perform, gitWrite]);

  /** 预检：上传前必须重新跑一次（不拿缓存冒充实时状态）。 */
  const gitPreflightRun = useCallback(async (root: string, input: { readonly remote: string; readonly branch?: string; readonly scope?: 'all' | 'session' }): Promise<GitPreflightResult | undefined> => {
    try {
      const result = await request<GitPreflightResult>(FeatureMethod.GitPreflight, {
        workspaceRoot: root,
        remote: input.remote,
        ...(input.branch === undefined ? {} : { branch: input.branch }),
        ...(input.scope === undefined ? {} : { scope: input.scope }),
      });
      setGitPreflight(result);
      setGitError('');
      return result;
    } catch (e) {
      setGitError((e as Error).message);
      return undefined;
    }
  }, [request]);

  /** 上传：唯一出网操作。失败必须把错误码带出来（界面据此给可操作路径）。 */
  const gitUploadRun = useCallback(async (root: string, input: { readonly remote: string; readonly branch: string; readonly message: string; readonly scope: 'all' | 'session' }): Promise<GitUploadResult | undefined> => {
    const revision = gitPreflight?.revision ?? gitStatus?.revision ?? 0;
    try {
      const raw = await request<unknown>(FeatureMethod.GitUpload, {
        workspaceRoot: root,
        remote: input.remote,
        branch: input.branch,
        message: input.message,
        scope: input.scope,
        ...envelope(revision),
      });
      const result = unwrapGitResult<GitUploadResult>(raw);
      if (!result || !result.sha) throw new Error('上传结果不完整，请重试。');
      setGitUpload(result);
      setGitError('');
      await gitRefresh(root);
      return result;
    } catch (e) {
      setGitError((e as Error).message);
      throw e;
    }
  }, [request, envelope, gitPreflight, gitStatus, gitRefresh]);

  /** 凭据写入（主进程窄桥，只写不读回）。 */
  const gitSetToken = useCallback(async (root: string, remote: string, url: string, token: string): Promise<void> => {
    const bridge = window.syao?.git;
    if (!bridge) throw new Error('主进程尚未提供凭据通道，令牌不会被保存。');
    await bridge.setToken({ workspaceRoot: root, remote, url, token });
    await gitRefresh(root);
  }, [gitRefresh]);

  const gitClearAuth = useCallback(async (root: string, remote: string, url: string): Promise<void> => {
    const bridge = window.syao?.git;
    if (!bridge) throw new Error('主进程尚未提供凭据通道。');
    await bridge.clear({ workspaceRoot: root, remote, url });
    await gitRefresh(root);
  }, [gitRefresh]);

  const gitUseSshAgent = useCallback(async (root: string, remote: string, url: string): Promise<void> => {
    const bridge = window.syao?.git;
    if (!bridge?.useSshAgent) throw new Error('主进程尚未提供 SSH 凭据通道。');
    await bridge.useSshAgent({ workspaceRoot: root, remote, url });
    await gitRefresh(root);
  }, [gitRefresh]);

  // ── MCP ────────────────────────────────────────────────────────────

  const mcpList = useCallback(async (): Promise<void> => {
    setMcpLoading(true);
    try {
      const result = await request<{ readonly servers: readonly McpServerInfo[] }>(FeatureMethod.McpList, {});
      setMcpServers(result.servers);
      setMcpError('');
    } catch (e) {
      setMcpError((e as Error).message);
    } finally {
      setMcpLoading(false);
    }
  }, [request]);

  const mcpAdd = useCallback(async (params: McpAddParams): Promise<void> => {
    await request(FeatureMethod.McpAdd, params);
    await mcpList();
  }, [request, mcpList]);

  const mcpRemove = useCallback(async (serverId: string): Promise<void> => {
    await request(FeatureMethod.McpRemove, { serverId });
    await mcpList();
  }, [request, mcpList]);

  const mcpRestart = useCallback(async (serverId: string): Promise<void> => {
    await request(FeatureMethod.McpRestart, { serverId });
    await mcpList();
  }, [request, mcpList]);

  const mcpTools = useCallback(async (serverId: string): Promise<readonly McpToolSummary[]> => {
    const result = await request<{ readonly tools: readonly McpToolSummary[] }>(FeatureMethod.McpTools, { serverId });
    return result.tools;
  }, [request]);

  // ── Agent 群 ───────────────────────────────────────────────────────

  const agentsList = useCallback(async (): Promise<void> => {
    setAgentsLoading(true);
    try {
      const result = await request<AgentsListResult>(FeatureMethod.AgentsList, {});
      setAgents(result);
      setAgentsError('');
    } catch (e) {
      setAgentsError((e as Error).message);
    } finally {
      setAgentsLoading(false);
    }
  }, [request]);

  const agentsSave = useCallback(async (params: AgentsSaveParams): Promise<void> => {
    await request(FeatureMethod.AgentsSave, params);
    await agentsList();
  }, [request, agentsList]);

  const agentsDelete = useCallback(async (name: string): Promise<void> => {
    await request(FeatureMethod.AgentsDelete, { name });
    await agentsList();
  }, [request, agentsList]);

  const agentsActivate = useCallback(async (name: string): Promise<void> => {
    await request(FeatureMethod.AgentsActivate, { name });
    await agentsList();
  }, [request, agentsList]);


  const createSession = useCallback(() => perform(async () => {
    if (!workspaceRoot) throw new Error('请先添加项目目录。');
    const result = await request<{ snapshot: SessionSnapshot }>(Method.SessionCreate, { title: '新会话', workspaceRoot });
    await refresh();
    await selectSession(result.snapshot.meta.sessionId);
  }), [perform, workspaceRoot, request, refresh, selectSession]);

  const openWorkspace = useCallback(() => perform(async () => {
    const path = await window.syao?.app.openDirectory();
    if (!path) return;
    const result = await request<{ workspaceRoot: string }>(Method.WorkspaceOpen, { path });
    await refresh();
    await selectSession('');
    setWorkspaceRoot(result.workspaceRoot);
  }), [perform, request, refresh, selectSession]);

  const selectWorkspace = useCallback(async (root: string) => {
    await selectSession('');
    setWorkspaceRoot(root);
  }, [selectSession]);

  const send = useCallback((text: string) => perform(async () => {
    const sid = active.current;
    if (!text.trim()) return;
    if (store.current?.current?.runState !== 'idle') throw new Error('当前会话仍在执行，请等待完成或停止。');
    const result = await command(Method.TurnSend, { text: text.trim() }, sid);
    const execution = (result.data as { executionId?: string } | undefined)?.executionId;
    if (execution) executions.current.set(sid, execution);
    setDrafts((prev) => ({ ...prev, [sid]: prev[sid]?.trim() === text.trim() ? '' : prev[sid] ?? '' }));
  }), [perform, command]);

  const stop = useCallback(() => perform(async () => {
    const executionId = executions.current.get(active.current);
    await command(Method.TurnStop, executionId ? { expectedExecutionId: executionId } : {});
  }), [perform, command]);

  const configure = useCallback((patch: { model?: string; permissionMode?: DesktopPermissionMode }, sid = active.current) => perform(async () => {
    await command(WorkbenchMethod.SessionConfigure, patch, sid);
    if (active.current === sid) await inspect();
  }), [perform, command, inspect]);

  const rename = useCallback((title: string) => perform(async () => {
    await request(Method.SessionRename, { sessionId: active.current, title: title.trim() });
    await refresh();
    const next = await request<SessionSnapshot>(Method.SessionSnapshot, { sessionId: active.current });
    if (next.meta.sessionId === active.current) store.current?.replacement(next);
  }), [perform, request, refresh]);

  const archive = useCallback((sid: string, archived: boolean) => perform(async () => {
    await request(WorkbenchMethod.SessionArchive, { sessionId: sid, archived });
    const data = await refresh();
    if (archived && active.current === sid) await selectSession(data?.sessions.find((s) => !s.archived)?.sessionId ?? '');
  }), [perform, request, refresh, selectSession]);

  const resolve = useCallback((interactionId: string, optionId: string) => perform(async () => {
    await command(Method.InteractionResolve, { interactionId, optionId });
  }), [perform, command]);

  const saveChannel = useCallback(async (channel: ChannelConfig) => {
    await request(WorkbenchMethod.ChannelSave, channel);
    await refresh();
  }, [request, refresh]);

  const readTree = useCallback((root: string) => request<WorkspaceTreeResult>(Method.WorkspaceTree, { workspaceRoot: root, path: '.', maxDepth: 3 }), [request]);
  const readFile = useCallback((root: string, path: string) => request<WorkspaceReadFileResult>(Method.WorkspaceReadFile, { workspaceRoot: root, path }), [request]);

  // ── 通知接线（替代"只靠轮询"的降级路径）─────────────────────────────

  /** `session/changes`：四块整体替换（投影铁律：只替换，不合并）。 */
  useEffect(() => {
    if (pendingChanges === null) return;
    setPendingChanges(null);
    setInspection((previous) => previous === undefined ? previous : {
      ...previous,
      changes: pendingChanges.changes,
      artifacts: pendingChanges.artifacts,
      sources: pendingChanges.sources,
      coverage: pendingChanges.coverage,
    });
  }, [pendingChanges]);

  /** `git/changed` 与 `git/auth/changed`：只刷新徽标与认证点，不打开侧栏。 */
  useEffect(() => {
    if (gitChangedAt === 0 || status !== 'ready' || workspaceRoot === '' || gitProbeUnavailable) return;
    void gitProbe(workspaceRoot);
  }, [gitChangedAt, status, workspaceRoot, gitProbeUnavailable, gitProbe]);

  /** `mcp/changed`：停在 MCP 页时重拉一次列表。 */
  useEffect(() => {
    if (mcpChangedAt === 0 || page !== 'resources' || status !== 'ready') return;
    void mcpList();
  }, [mcpChangedAt, page, status, mcpList]);

  useEffect(() => {
    if (page === 'agents' && status === 'ready') void agentsList();
  }, [page, status, agentsList]);

  useEffect(() => {
    if (page === 'resources' && status === 'ready') void mcpList();
  }, [page, status, mcpList]);


  return {
    status, error, setError, overview, snapshot, inspection, sessionId, workspaceRoot,
    page, setPage, draft: drafts[sessionId] ?? '',
    setDraft: (text: string) => setDrafts((prev) => ({ ...prev, [sessionId]: text })),
    loadingSession, mutating, query, setQuery, report, loadingUsage,
    selectSession, selectWorkspace, createSession, openWorkspace, send, stop,
    configure, rename, archive, resolve, saveChannel, readTree, readFile,
    // Git（工作区口径）
    gitStatus, gitBranches, gitGraph, gitRemotes, gitAuth, gitPreflight, gitUpload, gitDiff,
    gitError, gitLoading, gitProbeUnavailable,
    gitRefresh, gitProbe, gitGraphLoad, gitDiffLoad, gitStage, gitUnstage, gitCommit,
    gitBranchCreate, gitBranchSwitch, gitPreflightRun, gitUploadRun, gitCommitMessage,
    gitSetToken, gitClearAuth, gitUseSshAgent,
    // MCP / Agent 群
    mcpServers, mcpLoading, mcpError, mcpList, mcpAdd, mcpRemove, mcpRestart, mcpTools,
    agents, agentsLoading, agentsError, agentsList, agentsSave, agentsDelete, agentsActivate,
  };
}

export type Workbench = ReturnType<typeof useWorkbench>;
