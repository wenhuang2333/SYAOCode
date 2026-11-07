import { useEffect, useRef, useState, type ReactNode, type SyntheticEvent } from 'react';
import { ApprovalCard, Composer, Timeline, messages } from '@syaocode/ui';
import { EMPTY_USAGE, type DesktopPermissionMode, type TreeNode } from '@syaocode/dhp';
import type { Page, Workbench } from './use-workbench';
import { ComposerPalette, collectFilePaths, detectTrigger, shellHintFor, type CommandAction } from './composer-palette';
import { ShellResultBlock, isShellCommand, shellCommandOf, shouldKeepDraft, type ShellOutcome } from './shell-lines';
import { UsagePage } from './usage-page';
import { SettingsPage } from './settings-page';
import { DetailPanel } from './detail-panel';
import { GitSidebar, INITIAL_SIDEBAR_STATE, authStatusLabel, authStatusTone, gitStatusBadge, gitTabState, type GitTab, type SidebarSlotState } from './git-sidebar';
import { AgentsPage } from './agents-page';
import { McpPage } from './mcp-page';
import { Icon } from './icons';

export { Icon };

const m = messages('zh');
const names: Record<Page, string> = { chat: '工作台', usage: '用量统计', sessions: '会话树', files: '变更与文件', agents: 'Agent 群', resources: 'MCP 服务', settings: '渠道与设置' };
const permissionNames: Record<string, string> = { plan: '只读规划', strict: '严格审批', default: '标准权限', acceptEdits: '自动编辑', bypass: '完全授权' };
export const number = (value: number | null | undefined) => value == null ? '—' : new Intl.NumberFormat('en', { notation: value >= 10000 ? 'compact' : 'standard', maximumFractionDigits: 1 }).format(value);
const money = (value: number | null | undefined) => value == null ? '—' : `$${value.toFixed(value < 0.01 ? 4 : 2)}`;
const duration = (ms: number) => ms < 1000 ? `${Math.round(ms)}ms` : ms < 60000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.floor(ms / 60000)}m ${Math.round(ms / 1000) % 60}s`;
const leaf = (path: string) => path.split(/[\\/]/).filter(Boolean).pop() ?? path;

function Sidebar({ w, search, setSearch }: { w: Workbench; search: string; setSearch: (v: string) => void }) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const all = w.overview?.sessions.filter((s) => !s.archived) ?? [];
  const today = w.overview?.today ?? EMPTY_USAGE;
  const channels = w.overview?.channels ?? [];
  const disabled = w.status !== 'ready' || w.mutating;
  return <aside className="sidebar" aria-label="主导航">
    <div className="brand-block"><span className="brand-symbol"><Icon name="code" size={22} /></span><div><strong>SYAOCode</strong><small>DESKTOP · 本地工作台</small></div><span className="version-badge">0.1</span></div>
    <button className="new-session" onClick={() => void w.createSession()} disabled={disabled}><Icon name="plus" />新建会话<kbd>⌘ N</kbd></button>
    <label className="session-search"><Icon name="search" size={15} /><input id="session-search" aria-label="搜索会话" placeholder="搜索会话与项目" value={search} onChange={(e) => setSearch(e.target.value)} />{search && <button aria-label="清空搜索" onClick={() => setSearch('')}><Icon name="close" size={13} /></button>}</label>
    <nav>
      <span className="nav-caption">监控</span>
      {(['chat', 'usage'] as const).map((p) => <button key={p} className={`nav-item ${w.page === p ? 'active' : ''}`} onClick={() => w.setPage(p)}><Icon name={p} />{names[p]}{p === 'chat' && <span className="nav-meta">⌘ 1</span>}</button>)}
      <span className="nav-caption">会话</span>
      {(['sessions', 'files'] as const).map((p) => <button key={p} className={`nav-item ${w.page === p ? 'active' : ''}`} onClick={() => w.setPage(p)}><Icon name={p} />{names[p]}</button>)}
      <span className="nav-caption">资源</span>
      {(['agents', 'resources'] as const).map((p) => <button key={p} className={`nav-item ${w.page === p ? 'active' : ''}`} onClick={() => w.setPage(p)}><Icon name={p} />{names[p]}</button>)}
    </nav>
    <div className="projects-title"><span>项目</span><button aria-label="添加项目" title="添加项目目录" onClick={() => void w.openWorkspace()} disabled={disabled}><Icon name="plus" size={16} /></button></div>
    <div className="project-tree">
      <div className="project-heading"><Icon name="folder" size={16} /> 我的项目 <span>{w.overview?.workspaces.length ?? 0}</span></div>
      {w.overview?.workspaces.map((workspace) => {
        const sessions = all.filter((s) => s.workspaceRoot === workspace.root);
        const matches = sessions.filter((s) => `${s.title} ${workspace.name}`.toLowerCase().includes(search.toLowerCase()));
        if (search && matches.length === 0 && !workspace.name.toLowerCase().includes(search.toLowerCase())) return null;
        const closed = !search && collapsed.has(workspace.root);
        return <div className="project" key={workspace.id}>
          <div className={`project-line ${w.workspaceRoot === workspace.root ? 'selected' : ''}`}>
            <button className={closed ? 'tree-expander' : 'tree-expander expanded'} aria-label={`${closed ? '展开' : '收起'} ${workspace.name}`} aria-expanded={!closed} onClick={() => setCollapsed((old) => { const next = new Set(old); next.has(workspace.root) ? next.delete(workspace.root) : next.add(workspace.root); return next; })}><Icon name="chevron" size={12} /></button>
            <button className="project-name" title={workspace.root} onClick={() => void w.selectWorkspace(workspace.root)}><Icon name="folder" size={14} /><span>{workspace.name}</span><small>{sessions.length} 会话</small></button>
          </div>
          {!closed && <div className="project-sessions">{matches.map((s) => <button key={s.sessionId} className={`session-link ${w.sessionId === s.sessionId && w.page === 'chat' ? 'active' : ''}`} title={s.title} onClick={() => void w.selectSession(s.sessionId)}><span className={`session-dot ${s.runState !== 'idle' ? 'running' : ''}`} /><span>{s.title}</span>{s.runState !== 'idle' && <small>运行中</small>}</button>)}{matches.length === 0 && <div className="tree-empty">{search ? '没有匹配的会话' : '尚无会话'}</div>}</div>}
        </div>;
      })}
      {search && all.every((s) => !`${s.title} ${leaf(s.workspaceRoot)}`.toLowerCase().includes(search.toLowerCase())) && <div className="tree-empty">未找到匹配的会话</div>}
      {!w.overview && <div className="tree-empty">{w.status === 'error' ? '运行时未连接' : '正在载入项目…'}</div>}
    </div>
    <section className="account-summary" aria-label="余额与配额">
      <button className="today-summary" onClick={() => w.setPage('usage')}><span><Icon name="usage" size={13} /> 今日 {number(today.totalTokens)} tokens</span><strong>{money(today.costUsd)}</strong></button>
      <div className="channel-cards">{channels.map((channel) => <button className="channel-mini" key={channel.id} onClick={() => w.setPage('settings')}>
        <div><strong><i className={`state-dot ${channel.credentialReady ? 'green' : 'amber'}`} />{channel.name}</strong><span>{channel.protocol === 'mock' ? '离线演示' : channel.balance ? `${channel.balance.currency === 'CNY' ? '¥' : '$'}${channel.balance.amount.toFixed(2)}` : '余额未提供'}</span></div>
        {channel.quota ? <><div className="mini-meter"><span style={{ width: `${Math.min(100, channel.quota.used / channel.quota.limit * 100)}%` }} /></div><small>{number(channel.quota.used)} / {number(channel.quota.limit)} {channel.quota.unit} · 手动快照</small></> : <small>{channel.balance ? `手动记录 · ${new Date(channel.balance.updatedAt).toLocaleDateString()}` : channel.credentialReady ? '凭据就绪 · 配额未提供' : '未配置凭据 · 点击设置'}</small>}
      </button>)}</div>
    </section>
    <div className="sidebar-footer"><span className="local-avatar">S</span><div><strong>本地工作空间</strong><small><i className={`state-dot ${w.status === 'ready' ? 'green' : 'amber'}`} />{w.status === 'ready' ? '运行时已连接' : w.status === 'error' ? '连接失败' : w.status === 'reconnecting' ? '正在重新连接' : '正在启动'}</small></div><button aria-label="渠道与设置" className={w.page === 'settings' ? 'active' : ''} onClick={() => w.setPage('settings')}><Icon name="settings" /></button></div>
  </aside>;
}

function ModelPicker({ w, close }: { w: Workbench; close: () => void }) {
  const channels = w.overview?.channels ?? [];
  const current = w.snapshot?.meta.model ?? '';
  const [selected, setSelected] = useState(current.split(':')[0] ?? 'mock');
  const channel = channels.find((c) => c.id === selected) ?? channels[0];
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const click = (e: PointerEvent) => { if (!ref.current?.contains(e.target as Node)) close(); };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    document.addEventListener('pointerdown', click); document.addEventListener('keydown', key);
    return () => { document.removeEventListener('pointerdown', click); document.removeEventListener('keydown', key); };
  }, [close]);
  return <div ref={ref} className="model-picker" role="dialog" aria-label="选择渠道与模型">
    <div className="model-channel-column"><div className="picker-label">渠道</div>{channels.map((c) => <button className={channel?.id === c.id ? 'selected' : ''} key={c.id} onClick={() => setSelected(c.id)}><i className={`state-dot ${c.credentialReady ? 'green' : 'amber'}`} /><span>{c.name}</span>{current.startsWith(`${c.id}:`) && <b>✓</b>}</button>)}<button className="text-link picker-settings" onClick={() => { w.setPage('settings'); close(); }}>管理渠道与凭据 →</button></div>
    <div className="model-list-column"><div className="picker-label">模型 · {channel?.name}</div>{channel?.models.map((model) => {
      const spec = `${channel.id}:${model.id}`;
      return <button key={model.id} title={channel.credentialReady ? model.id : '请先配置渠道凭据'} disabled={!channel.credentialReady || w.mutating} className={current === spec ? 'selected' : ''} onClick={() => { void w.configure({ model: spec }); close(); }}><span>{model.name || model.id}<small>{model.id}{model.contextWindow ? ` · ${number(model.contextWindow)} 上下文` : ''}</small></span>{current === spec && <b>✓</b>}</button>;
    })}{!channel?.models.length && <p className="picker-empty">尚无模型，请在设置中添加真实模型 ID。</p>}</div>
    <div className="reasoning-column"><div className="picker-label">思考等级</div><button disabled>模型默认</button><p>当前 Agent 适配器未接入思考预算控制，不发送无效参数。</p>{channel?.protocol === 'mock' && <span className="subtle-badge">离线演示</span>}</div>
  </div>;
}

function Conversation({ w, confirm, onSlot }: { w: Workbench; confirm: (value: 'bypass') => void; onSlot: (slot: 'git' | 'detail') => void }) {
  const [picker, setPicker] = useState(false);
  const [caret, setCaret] = useState(0);
  const [files, setFiles] = useState<readonly string[]>([]);
  const [filesLoading, setFilesLoading] = useState(false);
  const [filesError, setFilesError] = useState('');
  const [notice, setNotice] = useState('');
  // `!` 本地命令的**渲染层视图**：不进会话历史、不进模型上下文，切换会话即消失。
  const [shellLines, setShellLines] = useState<readonly { readonly id: number; readonly command: string; readonly outcome: ShellOutcome | undefined }[]>([]);
  const [shellBusy, setShellBusy] = useState(false);
  const shellSeq = useRef(0);
  const bottom = useRef<HTMLDivElement>(null);
  const scroll = useRef<HTMLDivElement>(null);
  const composer = useRef<HTMLDivElement>(null);
  const filesRoot = useRef('');
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const follow = useRef(true);
  const idle = w.snapshot?.runState === 'idle';
  const pending = w.snapshot?.pendingInteractions ?? [];
  const disabled = w.status !== 'ready' || !w.sessionId || w.loadingSession;
  const trigger = detectTrigger(w.draft, caret);
  const shellHint = shellHintFor(w.draft);
  const canStop = Boolean(w.sessionId) && w.snapshot !== undefined && !idle && !w.mutating;
  useEffect(() => { follow.current = true; }, [w.sessionId]);
  useEffect(() => { if (follow.current) bottom.current?.scrollIntoView({ block: 'end' }); }, [w.snapshot?.seq, w.sessionId]);
  useEffect(() => { setPicker(false); }, [w.sessionId]);
  // 切会话时草稿可能来自另一个会话：光标与提示一并重置，避免用旧光标误判触发串。
  useEffect(() => { setCaret(0); setNotice(''); setShellLines([]); }, [w.sessionId]);
  useEffect(() => () => { if (noticeTimer.current) clearTimeout(noticeTimer.current); }, []);
  // `@` 文件引用只读工作区树（`workspace/tree`，maxDepth 3）；失败时诚实降级，不弹错误窗。
  useEffect(() => {
    if (trigger?.kind !== 'mention' || !w.workspaceRoot || w.status !== 'ready' || filesRoot.current === w.workspaceRoot) return;
    const root = w.workspaceRoot;
    let cancelled = false;
    let settled = false;
    setFilesLoading(true);
    setFilesError('');
    setFiles([]);
    void w.readTree(root)
      .then((result) => {
        if (cancelled) return;
        settled = true;
        filesRoot.current = root;
        setFiles(collectFilePaths(result.nodes));
      })
      .catch((error: Error) => {
        if (cancelled) return;
        // 失败不缓存，下次重新打开文件面板时重试；界面只给诚实空态，不弹错误窗。
        setFiles([]);
        setFilesError(error.message);
      })
      .finally(() => { if (!cancelled) setFilesLoading(false); });
    return () => { cancelled = true; if (!settled) filesRoot.current = ''; };
  }, [trigger?.kind, w.workspaceRoot, w.status, w.readTree]);
  const showNotice = (message: string) => {
    setNotice(message);
    if (noticeTimer.current) clearTimeout(noticeTimer.current);
    noticeTimer.current = setTimeout(() => setNotice(''), 5000);
  };
  const syncCaret = (event: SyntheticEvent<HTMLDivElement>) => {
    if (event.target instanceof HTMLTextAreaElement) setCaret(event.target.selectionStart);
  };
  // 补全 / 插入后回写文本并恢复光标位置（`Composer` 不暴露 ref，只能从容器里取）。
  // 这里**不抢焦点**：键盘路径焦点本就在输入区，鼠标路径靠面板的 mousedown preventDefault 保持；
  // 而 `/permission` 需要把焦点交给权限下拉，抢焦点会让它立刻被抢回输入区。
  const applyComposerText = (next: { readonly text: string; readonly caret: number }) => {
    w.setDraft(next.text);
    setCaret(next.caret);
    requestAnimationFrame(() => {
      const textarea = composer.current?.querySelector('textarea');
      if (textarea) textarea.setSelectionRange(next.caret, next.caret);
    });
  };
  /**
   * 提交 `!` 命令（FR-N-036）。
   *
   * 硬要求：
   *  1. **绝不走 `w.send`**——命令不能被当成消息发给模型；
   *  2. 结果只进 `shellLines`（本会话的渲染层视图），不写会话历史；
   *  3. 只有成功才清空草稿；失败 / 被拒 / 超时都保留草稿，方便修改重试；
   *  4. `command_denied` 单独识别：显示“被权限规则拒绝 + 原因”，不显示为成功。
   */
  const submitShell = async (raw: string) => {
    const command = shellCommandOf(raw);
    if (command === '') { showNotice('请在 ! 后输入要执行的命令。'); return; }
    if (shellBusy) { showNotice('上一条本地命令仍在执行，请稍候。'); return; }
    const id = ++shellSeq.current;
    setShellBusy(true);
    setShellLines((previous) => [...previous, { id, command, outcome: undefined }]);
    let outcome: ShellOutcome;
    try {
      const result = await w.runShellCommand(command);
      outcome = { result };
    } catch (error) {
      // 按 `kind` 分支（契约）；message 里的码只做兜底，避免传输层丢字段时把"被拒"说成"失败"。
      const candidate = error as { readonly kind?: unknown; readonly code?: unknown } | null;
      const message = (error as Error).message;
      const isDenied = candidate?.kind === 'command_denied'
        || candidate?.code === -32047
        || message.includes('command_denied')
        || message.includes('-32047');
      outcome = isDenied
        ? { denial: { kind: 'command_denied', message } }
        : { error: message };
    }
    setShellLines((previous) => previous.map((line) => line.id === id ? { ...line, outcome } : line));
    setShellBusy(false);
    // 成功才清空草稿；失败保留，用户可以直接改命令再试。
    if (!shouldKeepDraft(outcome)) w.setDraft('');
  };

  const paletteAction = (action: CommandAction) => {
    switch (action.kind) {
      case 'new': void w.createSession(); break;
      case 'model': setPicker(true); break;
      case 'permission': {
        // 权限下拉在同一个输入区工具栏里，用 id 聚焦；运行中 / 未连接时是 disabled，诚实提示。
        const select = document.getElementById('composer-permission');
        if (select instanceof HTMLSelectElement && !select.disabled) select.focus();
        else showNotice('当前无法聚焦权限选择（会话运行中或未连接）。');
        break;
      }
      case 'stop':
        if (canStop) void w.stop();
        else showNotice('当前没有正在运行的轮次。');
        break;
      case 'archive':
        if (w.sessionId) void w.archive(w.sessionId, true);
        else showNotice('还没有可归档的会话。');
        break;
      case 'git': onSlot('git'); break;
      case 'detail': onSlot('detail'); break;
      case 'usage': w.setPage('usage'); break;
      case 'insert':
      case 'help':
      case 'none': break;
    }
  };
  return <div className="conversation">
    <div className="conversation-scroll" ref={scroll} onScroll={() => { const el = scroll.current; if (el) follow.current = el.scrollHeight - el.scrollTop - el.clientHeight < 160; }}>
      {w.loadingSession ? <div className="welcome"><span className="loading-spinner" /><h2>正在打开会话</h2></div> : !w.snapshot?.rows.length ? <div className="welcome"><span className="welcome-mark"><Icon name="code" size={37} /></span><span className="eyebrow">YOUR LOCAL CODING WORKSPACE</span><h1>从一个想法，开始构建。</h1><p>理解代码、规划方案、执行任务。<br />每个项目的上下文与会话，都在这里井然有序。</p><div className="welcome-workspace"><Icon name="folder" size={16} /><span title={w.workspaceRoot}>{leaf(w.workspaceRoot) || '先选择一个项目'}</span><button onClick={() => void w.openWorkspace()} disabled={w.status !== 'ready'}>切换目录</button></div>
        {!w.sessionId ? <button className="btn btn-primary welcome-create" disabled={w.status !== 'ready' || w.mutating} onClick={() => void w.createSession()}><Icon name="plus" size={16} /> 在此项目新建会话</button> : <div className="starter-grid">{[['理解项目', '请先阅读当前项目，梳理目录结构与主要模块，不要修改代码。'], ['规划改动', '请先分析项目现状，帮我制定分步骤的开发和验证计划。'], ['检查代码', '请检查当前项目可能存在的问题，给出有文件依据的改进建议。']].map(([title, text]) => <button key={title} onClick={() => w.setDraft(text!)}><Icon name={title === '理解项目' ? 'folder' : title === '规划改动' ? 'sessions' : 'shield'} /><strong>{title}</strong><span>从清晰的上下文开始 →</span></button>)}</div>}
        <small className="welcome-notice">本地会话自动保存 · 需要授权的工具操作会先询问你</small>
      </div> : <Timeline rows={w.snapshot.rows} m={m} />}
      {pending.map((p) => <ApprovalCard key={p.id} interaction={p} m={m} onResolve={(id, opt) => void w.resolve(id, opt)} />)}
      {shellLines.length > 0 && <div className="shell-lines" aria-label="本地命令记录（未发送给模型）">
        {shellLines.map((line) => <ShellResultBlock key={line.id} command={line.command} outcome={line.outcome} pending={line.outcome === undefined} />)}
      </div>}
      <div ref={bottom} />
    </div>
    <div
      className="composer-shell"
      ref={composer}
      onInputCapture={syncCaret}
      onKeyUpCapture={syncCaret}
      onClickCapture={syncCaret}
      onSelectCapture={syncCaret}
    >
      {picker && <ModelPicker w={w} close={() => setPicker(false)} />}
      <Composer value={w.draft} onChange={w.setDraft} onSubmit={(text) => {
        follow.current = true;
        // `!` 分支：本地执行，绝不交给模型（也不经过 w.send）。
        if (isShellCommand(text)) { void submitShell(text); return; }
        void w.send(text);
      }} m={m} disabled={disabled} busy={w.mutating || (Boolean(w.sessionId) && !idle) || shellBusy} awaitingApproval={pending.length > 0} />
      <ComposerPalette text={w.draft} caret={caret} files={files} filesLoading={filesLoading} filesError={filesError} canStop={canStop} disabled={disabled} anchorRef={composer} onAction={paletteAction} onText={applyComposerText} />
      {shellHint && <div className="composer-shell-hint" role="status">{shellHint}</div>}
      {notice && <div className="composer-notice" role="status">{notice}</div>}
      <div className="composer-toolbar">
        <div className="composer-options">
          <Icon name="shield" size={14} />
          <select id="composer-permission" aria-label="会话权限" value={w.snapshot?.meta.permissionMode ?? 'default'} disabled={disabled || !idle || w.mutating} onChange={(e) => { if (e.target.value === 'bypass') confirm('bypass'); else void w.configure({ permissionMode: e.target.value as DesktopPermissionMode }); }}>{Object.entries(permissionNames).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>
          <span className="toolbar-divider" />
          <button className="model-trigger" disabled={disabled || !idle || w.mutating} onClick={() => setPicker(!picker)} aria-expanded={picker}><i className="state-dot green" /><span>{w.snapshot?.meta.model ?? '选择渠道与模型'}</span><Icon name="down" size={12} /></button>
        </div>
        {w.snapshot && !idle && <button className="stop-button" onClick={() => void w.stop()} disabled={w.mutating || w.status !== 'ready'}><span />停止运行</button>}
      </div>
    </div>
    <div className="composer-footnote"><span>{w.snapshot?.meta.model.startsWith('mock:') ? '离线演示模型 · 不会调用真实厂商 API' : '模型输出仅供参考，工具执行由权限引擎控制'}</span><span>Enter 发送 · Shift Enter 换行</span></div>
  </div>;
}

function SessionPage({ w, search }: { w: Workbench; search: string }) {
  const [archived, setArchived] = useState(false);
  const sessions = (w.overview?.sessions ?? []).filter((s) => s.archived === archived && `${s.title} ${s.workspaceRoot}`.toLowerCase().includes(search.toLowerCase()));
  return <div className="standard-page"><div className="page-heading"><div><span className="eyebrow">CONVERSATIONS</span><h1>会话树</h1><p>按项目组织工作，随时回到未完成的思考。</p></div><button className="btn btn-primary" onClick={() => void w.createSession()} disabled={w.status !== 'ready' || w.mutating}>新建会话</button></div><div className="segmented"><button className={!archived ? 'selected' : ''} onClick={() => setArchived(false)}>进行中的会话</button><button className={archived ? 'selected' : ''} onClick={() => setArchived(true)}>已归档</button></div>
    {!sessions.length && <div className="empty-state"><Icon name="sessions" size={30} /><h3>{search ? '没有匹配的会话' : archived ? '暂无归档会话' : '创建你的第一个会话'}</h3><p>会话保存在本机，不会因为关闭窗口而消失。</p></div>}
    {w.overview?.workspaces.map((workspace) => { const group = sessions.filter((s) => s.workspaceRoot === workspace.root); return group.length > 0 && <section className="session-group" key={workspace.id}><h3><Icon name="folder" />{workspace.name}<small>{group.length} 会话</small></h3>{group.map((s) => <div className="session-record" key={s.sessionId}><button onClick={() => void w.selectSession(s.sessionId)} disabled={archived}><Icon name="chat" /><div><strong>{s.title}</strong><small>{s.model} · {s.turnCount} 轮 · {new Date(s.updatedAt).toLocaleString()}</small></div></button>{archived ? <button className="btn" disabled={w.mutating || w.status !== 'ready'} onClick={() => void w.archive(s.sessionId, false)}>恢复会话</button> : <span className="subtle-badge">{s.runState === 'idle' ? '空闲' : '运行中'}</span>}</div>)}</section>; })}
  </div>;
}

function FilePage({ w }: { w: Workbench }) {
  const [nodes, setNodes] = useState<readonly TreeNode[]>([]);
  const [text, setText] = useState('');
  const [selected, setSelected] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [tab, setTab] = useState('files');
  const generation = useRef(0);
  useEffect(() => {
    let cancelled = false;
    ++generation.current;
    setSelected(''); setText(''); setNodes([]); setError('');
    if (!w.workspaceRoot || w.status !== 'ready') return;
    setLoading(true);
    void w.readTree(w.workspaceRoot).then((result) => { if (!cancelled) setNodes(result.nodes); }).catch((e: Error) => { if (!cancelled) setError(e.message); }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [w.workspaceRoot, w.status, w.readTree]);
  const open = async (path: string) => {
    const ticket = ++generation.current;
    setSelected(path); setText(''); setError(''); setLoading(true);
    try { const file = await w.readFile(w.workspaceRoot, path); if (ticket === generation.current) setText(file.text + (file.truncated ? '\n\n[文件已按读取上限截断]' : '')); }
    catch (e) { if (ticket === generation.current) setError((e as Error).message); }
    finally { if (ticket === generation.current) setLoading(false); }
  };
  const tree = (list: readonly TreeNode[]): ReactNode => list.map((node) => node.type === 'dir' ? <details key={node.path} className="file-folder"><summary><Icon name="folder" size={14} />{node.name}</summary><div>{tree(node.children ?? [])}</div></details> : <button className={`file-link ${selected === node.path ? 'selected' : ''}`} key={node.path} title={node.path} onClick={() => void open(node.path)}><Icon name="files" size={13} />{node.name}</button>);
  const tools = w.snapshot?.rows.filter((r) => r.kind === 'toolCall') ?? [];
  return <div className="standard-page file-page"><div className="page-heading"><div><span className="eyebrow">WORKSPACE</span><h1>变更与文件</h1><p>{w.workspaceRoot}</p></div></div><div className="segmented"><button className={tab === 'files' ? 'selected' : ''} onClick={() => setTab('files')}>项目文件</button><button className={tab === 'tools' ? 'selected' : ''} onClick={() => setTab('tools')}>本会话工具记录</button></div>{error && <div className="inline-error" role="alert">{error}</div>}
    {tab === 'files' ? <div className="file-browser"><div className="file-tree">{tree(nodes)}{!nodes.length && <p>{loading ? '正在读取目录…' : '目录为空或尚未添加项目'}</p>}</div><div className="file-preview"><div>{selected || '文件预览'}<span>只读</span></div>{selected ? <pre>{loading ? '正在读取…' : text}</pre> : <div className="empty-state"><Icon name="files" size={30} /><p>选择一个文件查看内容</p><small>敏感文件及工作区外路径不可读取</small></div>}</div></div> : <div className="tool-history"><p className="data-note">这是本会话的真实工具执行记录，不代表完整 Git 差异；不执行文件回滚。</p>{tools.length ? <Timeline rows={tools} m={m} /> : <div className="empty-state">当前会话尚无工具调用。</div>}</div>}
  </div>;
}

function Modal({ title, children, close }: { title: string; children: ReactNode; close: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const el = ref.current;
    el?.querySelector<HTMLElement>('input,button')?.focus();
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close();
      if (event.key !== 'Tab') return;
      const list = Array.from(el?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled)') ?? []);
      const first = list[0]; const last = list[list.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    document.addEventListener('keydown', key);
    return () => { document.removeEventListener('keydown', key); previous?.focus(); };
  }, [close]);
  return <div className="modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) close(); }}><div ref={ref} className="modal" role="dialog" aria-modal="true" aria-label={title}><header><h2>{title}</h2><button aria-label="关闭对话框" onClick={close}><Icon name="close" /></button></header>{children}</div></div>;
}

const GIT_TAB_KEY = 'syao:git-tab';

function readStoredGitTab(): GitTab {
  try {
    const stored = window.localStorage.getItem(GIT_TAB_KEY);
    if (stored === 'changes' || stored === 'graph' || stored === 'branches' || stored === 'upload') return stored;
  } catch {
    // 存储不可用（隐私模式等）时退回默认标签页，不影响功能。
  }
  return 'changes';
}

export function WorkbenchView({ w }: { w: Workbench }) {
  const [search, setSearch] = useState('');
  // 右栏默认收起；会话详情与 Git 共用槽位且互斥（`27` §11.0 / §11.3.1）。
  const [sidebar, setSidebar] = useState<SidebarSlotState>(() => ({ ...INITIAL_SIDEBAR_STATE, tab: readStoredGitTab() }));
  const [dialog, setDialog] = useState<'rename' | 'archive' | 'bypass' | null>(null);
  const [title, setTitle] = useState('');
  const [dialogSession, setDialogSession] = useState('');
  const [saving, setSaving] = useState(false);
  const closeDialog = useRef(() => setDialog(null)).current;
  const gitTrigger = useRef<HTMLButtonElement>(null);
  const gitRoot = w.snapshot?.meta.workspaceRoot ?? w.workspaceRoot;
  useEffect(() => { setDialog(null); }, [w.sessionId]);
  useEffect(() => { try { window.localStorage.setItem(GIT_TAB_KEY, sidebar.tab); } catch { /* 忽略存储不可用 */ } }, [sidebar.tab]);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.isComposing) return;
      if (e.key.toLowerCase() === 'k') { e.preventDefault(); document.getElementById('session-search')?.focus(); }
      if (e.key.toLowerCase() === 'n' && w.status === 'ready') { e.preventDefault(); void w.createSession(); }
      if (e.key === '1') { e.preventDefault(); w.setPage('chat'); }
    };
    window.addEventListener('keydown', key); return () => window.removeEventListener('keydown', key);
  }, [w.createSession, w.setPage, w.status]);
  // 顶部徽标需要状态，但**不能因此打开侧栏**：只做静默探测（§11.0）。
  useEffect(() => {
    if (w.status !== 'ready' || w.page !== 'chat' || w.gitProbeUnavailable) return;
    void w.gitProbe(gitRoot);
    const timer = setInterval(() => { void w.gitProbe(gitRoot); }, 20_000);
    return () => clearInterval(timer);
  }, [w.status, w.page, gitRoot, w.gitProbe, w.gitProbeUnavailable]);
  // 打开 Git 才读取状态：不因改动 / 远端 / 上传结果自动弹出（§11.0「不自动弹出」）。
  useEffect(() => {
    if (sidebar.slot === 'git' && w.status === 'ready') void w.gitRefresh(gitRoot);
  }, [sidebar.slot, gitRoot, w.status, w.gitRefresh]);
  useEffect(() => {
    if (sidebar.slot === 'git' && sidebar.tab === 'graph' && !w.gitGraph && w.status === 'ready') void w.gitGraphLoad(gitRoot, 0);
  }, [sidebar.slot, sidebar.tab, gitRoot, w.gitGraph, w.gitGraphLoad, w.status]);
  // Esc 关闭右栏（§11.3.1 三种关闭方式之一）。
  useEffect(() => {
    if (sidebar.slot === 'none') return;
    const key = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setSidebar((current) => gitTabState(current, 'close'));
      // Esc 关闭后焦点归还触发按钮（§11.4）。
      gitTrigger.current?.focus();
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [sidebar.slot]);
  const idle = w.snapshot?.runState === 'idle';
  const gitBadge = gitStatusBadge(w.gitStatus);
  const gitAuthInfo = w.gitAuth?.remotes[0]?.auth;
  const gitLabel = `Git 侧栏${gitBadge ? `（${gitBadge}）` : ''}，${authStatusLabel(gitAuthInfo)}`;
  const turnCount = w.overview?.sessions.find((session) => session.sessionId === w.sessionId)?.turnCount ?? 0;
  return <div className="workbench-app">
    <Sidebar w={w} search={search} setSearch={setSearch} />
    <div className="main-shell">
      <header className="workbench-topbar"><div className="breadcrumb"><Icon name={w.page === 'chat' ? 'chat' : w.page} size={16} /><strong>{w.page === 'chat' ? w.snapshot?.meta.title ?? '工作台' : names[w.page]}</strong>{w.page === 'chat' && <span className={`run-badge ${!idle && w.snapshot ? 'running' : ''}`}><i className="state-dot" />{w.loadingSession ? '载入中' : !w.snapshot || idle ? '空闲' : w.snapshot.runState === 'awaiting-approval' ? '等待审批' : '运行中'}</span>}</div><div className="topbar-actions">{w.page === 'chat' && <><span className="header-project" title={w.workspaceRoot}>{leaf(w.workspaceRoot)}</span><button aria-label="重命名会话" title="重命名会话" disabled={!w.snapshot || !idle || w.mutating} onClick={() => { setTitle(w.snapshot?.meta.title ?? ''); setDialog('rename'); }}><Icon name="edit" /></button><button aria-label="归档会话" title="归档会话" disabled={!w.snapshot || !idle || w.mutating} onClick={() => setDialog('archive')}><Icon name="archive" /></button><button ref={gitTrigger} aria-label={gitLabel} title="Git 侧栏" aria-pressed={sidebar.slot === 'git'} className={`git-trigger ${sidebar.slot === 'git' ? 'active' : ''}`} onClick={() => setSidebar((current) => gitTabState(current, 'toggle-git'))}><Icon name="git" />{gitBadge && <span className="git-badge">{gitBadge}</span>}<i className={`git-auth-dot state-dot ${authStatusTone(gitAuthInfo)}`} aria-hidden="true" /></button><button aria-label="切换会话详情" title="会话详情" aria-pressed={sidebar.slot === 'detail'} className={sidebar.slot === 'detail' ? 'active' : ''} onClick={() => setSidebar((current) => gitTabState(current, 'toggle-detail'))}><Icon name="panel" /></button></>}</div></header>
      {w.error && <div className="error-banner" role="alert"><Icon name="shield" size={16} /><span>{w.error}</span><button aria-label="关闭错误提示" onClick={() => w.setError('')}><Icon name="close" size={15} /></button></div>}
      {w.status !== 'ready' && <div className="connection-banner" role="status">{w.status === 'booting' ? '正在启动安全的本地运行时…' : w.status === 'reconnecting' ? '连接已断开，正在重新连接。不会自动重发操作。' : '本地运行时未连接，暂不可执行操作。'}</div>}
      <div className="workspace-body"><main className={`main-content ${w.page === 'chat' ? 'chat-content' : ''}`}>
        {w.page === 'chat' && <Conversation w={w} confirm={(value) => { setDialogSession(w.sessionId); setDialog(value); }} onSlot={(slot) => setSidebar((current) => current.slot === slot ? current : gitTabState(current, slot === 'git' ? 'toggle-git' : 'toggle-detail'))} />}
        {w.page === 'usage' && <UsagePage report={w.report} channels={w.overview?.channels ?? []} workspaces={w.overview?.workspaces ?? []} query={w.query} loading={w.loadingUsage} onQuery={w.setQuery} />}
        {w.page === 'settings' && <SettingsPage channels={w.overview?.channels ?? []} saving={saving} onSave={async (channel) => { setSaving(true); try { await w.saveChannel(channel); } finally { setSaving(false); } }} />}
        {w.page === 'sessions' && <SessionPage w={w} search={search} />}
        {w.page === 'files' && <FilePage w={w} />}
        {w.page === 'agents' && <AgentsPage result={w.agents} channels={w.overview?.channels ?? []} loading={w.agentsLoading} error={w.agentsError} busy={w.mutating} onSave={w.agentsSave} onDelete={w.agentsDelete} onActivate={w.agentsActivate} />}
        {w.page === 'resources' && <McpPage servers={w.mcpServers} loading={w.mcpLoading} error={w.mcpError} busy={w.mutating} onAdd={w.mcpAdd} onRemove={w.mcpRemove} onRestart={w.mcpRestart} onTools={w.mcpTools} />}
      </main>{w.page === 'chat' && sidebar.slot === 'detail' && <DetailPanel inspection={w.inspection} snapshot={w.snapshot} turnCount={turnCount} onClose={() => setSidebar((current) => gitTabState(current, 'close'))} onOpenPage={(page) => w.setPage(page)} onLoadDiff={(path) => w.sessionChangeDiff(w.sessionId, path)} onPreviewArtifact={(path) => w.readFile(gitRoot, path)} onRevealArtifact={window.syao?.app.revealPath ? async (path) => { await window.syao?.app.revealPath?.(path); } : undefined} />}{w.page === 'chat' && sidebar.slot === 'git' && <GitSidebar workspaceRoot={gitRoot} status={w.gitStatus} branches={w.gitBranches} graph={w.gitGraph} remotes={w.gitRemotes} auth={w.gitAuth} preflight={w.gitPreflight} upload={w.gitUpload} diff={w.gitDiff} loading={w.gitLoading} busy={w.mutating} error={w.gitError} tab={sidebar.tab} onTab={(tab) => setSidebar((current) => gitTabState(current, 'select-tab', tab))} onClose={() => setSidebar((current) => gitTabState(current, 'close'))} onRefresh={() => void w.gitRefresh(gitRoot)} onLoadGraph={(skip) => void w.gitGraphLoad(gitRoot, skip)} onStage={(paths) => void w.gitStage(gitRoot, paths)} onUnstage={(paths) => void w.gitUnstage(gitRoot, paths)} onCommit={(input) => w.gitCommit(gitRoot, input)} onBranchSwitch={(name) => void w.gitBranchSwitch(gitRoot, name)} onBranchCreate={(name) => void w.gitBranchCreate(gitRoot, name, true)} onPreflight={(input) => w.gitPreflightRun(gitRoot, input)} onUpload={(input) => w.gitUploadRun(gitRoot, input)} onOpenDetail={() => setSidebar((current) => gitTabState(current, 'toggle-detail'))} onSetToken={async (input) => { await w.gitSetToken(input.workspaceRoot, input.remote, input.url, input.token); }} onUseSshAgent={async (input) => { await w.gitUseSshAgent(input.workspaceRoot, input.remote, input.url); }} onClearAuth={async (input) => { await w.gitClearAuth(input.workspaceRoot, input.remote, input.url); }} onGenerateMessage={async (input) => await w.gitCommitMessage(gitRoot, input.scope === 'session' ? 'session' : 'staged', w.sessionId)} onOauthStart={(input) => w.gitOauthStart(input)} onOauthPoll={(flowId) => w.gitOauthPoll(flowId)} onOauthCancel={(flowId) => w.gitOauthCancel(flowId)} onOpenExternal={(url) => w.openExternal(url)} onLoadDiff={async (input) => { await w.gitDiffLoad(gitRoot, input.path, input.mode); }} />}</div>
    </div>
    {dialog && <Modal title={dialog === 'rename' ? '重命名会话' : dialog === 'archive' ? '归档会话' : '切换为完全授权？'} close={closeDialog}>{dialog === 'rename' ? <form onSubmit={(e) => { e.preventDefault(); if (title.trim()) { void w.rename(title); closeDialog(); } }}><label className="modal-label">会话名称<input value={title} maxLength={120} onChange={(e) => setTitle(e.target.value)} /></label><footer><button type="button" className="btn" onClick={closeDialog}>取消</button><button className="btn btn-primary" disabled={!title.trim() || w.mutating}>保存名称</button></footer></form> : <><p>{dialog === 'archive' ? '归档后会话将从项目树隐藏，历史和用量仍然保留。你可以在会话树的“已归档”中恢复。' : '完全授权会跳过常规操作审批，允许模型直接执行读写与命令操作。仅在你信任当前项目和任务时使用；内核硬性拒绝规则仍生效。'}</p><footer><button className="btn" onClick={closeDialog}>取消</button><button className={`btn ${dialog === 'bypass' ? 'btn-danger' : 'btn-primary'}`} disabled={dialog === 'bypass' && dialogSession !== w.sessionId} onClick={() => { if (dialog === 'archive') void w.archive(w.sessionId, true); else void w.configure({ permissionMode: 'bypass' }, dialogSession); closeDialog(); }}>{dialog === 'archive' ? '确认归档' : '确认完全授权'}</button></footer></>}</Modal>}
  </div>;
}
