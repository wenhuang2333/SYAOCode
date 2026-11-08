import { useEffect, useRef, useState, type ReactNode, type SyntheticEvent } from 'react';
import { ApprovalCard, Composer, Timeline, messages } from '@syaocode/ui';
import { EMPTY_USAGE, type DesktopPermissionMode, type TreeNode } from '@syaocode/dhp';
import type { Page, Workbench } from './use-workbench';
import { ComposerPalette, collectFilePaths, detectTrigger, shellHintFor, type CommandAction } from './composer-palette';
import { applyTheme, readStoredTheme, resolveTheme, storeTheme, systemPrefersDark, THEME_OPTIONS, type ThemePreference } from './theme';
import { ShellResultBlock, isShellCommand, shellCommandOf, shouldKeepDraft, type ShellOutcome } from './shell-lines';
import { UsagePage } from './usage-page';
import { SettingsPage } from './settings-page';
import { DetailPanel } from './detail-panel';
import { GitSidebar, INITIAL_SIDEBAR_STATE, authStatusLabel, authStatusTone, gitStatusBadge, gitTabState, type GitTab, type SidebarSlotState } from './git-sidebar';
import { AgentsPage } from './agents-page';
import { McpPage } from './mcp-page';
import { Icon } from './icons';
import { tv, type Lang } from './i18n-views';

export { Icon };


/** 页面名（导航与面包屑共用）。 */
export function pageNames(lang: Lang = 'zh'): Record<Page, string> {
  return {
    chat: tv(lang, 'workbench.nav.chat'),
    usage: tv(lang, 'workbench.nav.usage'),
    sessions: tv(lang, 'workbench.nav.sessions'),
    files: tv(lang, 'workbench.nav.files'),
    agents: tv(lang, 'workbench.nav.agents'),
    resources: tv(lang, 'workbench.nav.resources'),
    settings: tv(lang, 'workbench.nav.settings'),
  };
}

/** 中文页面名（默认语言），保留给既有调用方与测试；与 `pageNames('zh')` 必须永远一致。 */
export const names: Record<Page, string> = pageNames('zh');

/**
 * 会逐次询问工具操作的权限档位（内核 `permissions.ts` 的实际语义）。
 *
 * `acceptEdits` 下工作区内写**不问**，`bypass` 下基本不问——对这两个档位说
 * "需要授权的工具操作会先询问你"是假话，所以欢迎页按档位分文案。
 */
export const ASK_MODES: ReadonlySet<string> = new Set(['plan', 'strict', 'default']);

/** 外观偏好文案（`theme.ts` 里的 label 是中文常量，这里按语言取值）。 */
export function themeLabel(lang: Lang = 'zh', preference: ThemePreference = 'system'): string {
  switch (preference) {
    case 'light': return tv(lang, 'workbench.topbar.themeLight');
    case 'dark': return tv(lang, 'workbench.topbar.themeDark');
    case 'system': return tv(lang, 'workbench.topbar.themeSystem');
  }
}

/**
 * 权限档位文案。
 *
 * 诚实要求：`bypass` 的文案不能暗示"完全不受限"——内核的危险命令规则、
 * 敏感路径询问与工作区围栏在任何档位都生效（见确认框里的补充说明）。
 */
export function permissionNames(lang: Lang = 'zh'): Record<string, string> {
  return {
    plan: tv(lang, 'workbench.permission.plan'),
    strict: tv(lang, 'workbench.permission.strict'),
    default: tv(lang, 'workbench.permission.default'),
    acceptEdits: tv(lang, 'workbench.permission.acceptEdits'),
    bypass: tv(lang, 'workbench.permission.bypass'),
  };
}

/** 中文权限档位名（默认语言），保留给既有调用方与测试。 */
export const PERMISSION_NAMES: Record<string, string> = permissionNames('zh');
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
  return <aside className="sidebar" aria-label={tv(w.language, 'workbench.sidebar.mainNav')}>
    <div className="brand-block"><span className="brand-symbol"><Icon name="code" size={22} /></span><div><strong>LIWENCode</strong><small>{tv(w.language, 'workbench.brand.subtitle')}</small></div><span className="version-badge">0.1</span></div>
    <button className="new-session" onClick={() => void w.createSession()} disabled={disabled}><Icon name="plus" />{tv(w.language, 'workbench.sidebar.newSession')}<kbd>⌘ N</kbd></button>
    <label className="session-search"><Icon name="search" size={15} /><input id="session-search" aria-label={tv(w.language, 'workbench.sidebar.searchAria')} placeholder={tv(w.language, 'workbench.sidebar.searchPlaceholder')} value={search} onChange={(e) => setSearch(e.target.value)} />{search && <button aria-label={tv(w.language, 'workbench.sidebar.clearSearch')} onClick={() => setSearch('')}><Icon name="close" size={13} /></button>}</label>
    <nav>
      <span className="nav-caption">{tv(w.language, 'workbench.caption.monitor')}</span>
      {(['chat', 'usage'] as const).map((p) => <button key={p} className={`nav-item ${w.page === p ? 'active' : ''}`} onClick={() => w.setPage(p)}><Icon name={p} />{pageNames(w.language)[p]}{p === 'chat' && <span className="nav-meta">⌘ 1</span>}</button>)}
      <span className="nav-caption">{tv(w.language, 'workbench.caption.sessions')}</span>
      {(['sessions', 'files'] as const).map((p) => <button key={p} className={`nav-item ${w.page === p ? 'active' : ''}`} onClick={() => w.setPage(p)}><Icon name={p} />{pageNames(w.language)[p]}</button>)}
      <span className="nav-caption">{tv(w.language, 'workbench.caption.resources')}</span>
      {(['agents', 'resources'] as const).map((p) => <button key={p} className={`nav-item ${w.page === p ? 'active' : ''}`} onClick={() => w.setPage(p)}><Icon name={p} />{pageNames(w.language)[p]}</button>)}
    </nav>
    <div className="projects-title"><span>{tv(w.language, 'workbench.sidebar.projects')}</span><button aria-label={tv(w.language, 'workbench.sidebar.addProject')} title={tv(w.language, 'workbench.sidebar.addProjectTitle')} onClick={() => void w.openWorkspace()} disabled={disabled}><Icon name="plus" size={16} /></button></div>
    <div className="project-tree">
      <div className="project-heading"><Icon name="folder" size={16} /> {tv(w.language, 'workbench.sidebar.myProjects')} <span>{w.overview?.workspaces.length ?? 0}</span></div>
      {w.overview?.workspaces.map((workspace) => {
        const sessions = all.filter((s) => s.workspaceRoot === workspace.root);
        const matches = sessions.filter((s) => `${s.title} ${workspace.name}`.toLowerCase().includes(search.toLowerCase()));
        if (search && matches.length === 0 && !workspace.name.toLowerCase().includes(search.toLowerCase())) return null;
        const closed = !search && collapsed.has(workspace.root);
        return <div className="project" key={workspace.id}>
          <div className={`project-line ${w.workspaceRoot === workspace.root ? 'selected' : ''}`}>
            <button className={closed ? 'tree-expander' : 'tree-expander expanded'} aria-label={closed ? tv(w.language, 'workbench.sidebar.expand', { name: workspace.name }) : tv(w.language, 'workbench.sidebar.collapse', { name: workspace.name })} aria-expanded={!closed} onClick={() => setCollapsed((old) => { const next = new Set(old); next.has(workspace.root) ? next.delete(workspace.root) : next.add(workspace.root); return next; })}><Icon name="chevron" size={12} /></button>
            <button className="project-name" title={workspace.root} onClick={() => void w.selectWorkspace(workspace.root)}><Icon name="folder" size={14} /><span>{workspace.name}</span><small>{tv(w.language, 'workbench.sidebar.sessionCount', { count: sessions.length })}</small></button>
          </div>
          {!closed && <div className="project-sessions">{matches.map((s) => <button key={s.sessionId} className={`session-link ${w.sessionId === s.sessionId && w.page === 'chat' ? 'active' : ''}`} title={s.title} onClick={() => void w.selectSession(s.sessionId)}><span className={`session-dot ${s.runState !== 'idle' ? 'running' : ''}`} /><span>{s.title}</span>{s.runState !== 'idle' && <small>{tv(w.language, 'workbench.sidebar.running')}</small>}</button>)}{matches.length === 0 && <div className="tree-empty">{search ? tv(w.language, 'workbench.sidebar.noMatchingSessions') : tv(w.language, 'workbench.sidebar.noSessions')}</div>}</div>}
        </div>;
      })}
      {search && all.every((s) => !`${s.title} ${leaf(s.workspaceRoot)}`.toLowerCase().includes(search.toLowerCase())) && <div className="tree-empty">{tv(w.language, 'workbench.sidebar.noMatchingAtAll')}</div>}
      {!w.overview && <div className="tree-empty">{w.status === 'error' ? tv(w.language, 'workbench.sidebar.runtimeNotConnected') : tv(w.language, 'workbench.sidebar.loadingProjects')}</div>}
    </div>
    <section className="account-summary" aria-label={tv(w.language, 'workbench.sidebar.accountSummary')}>
      <button className="today-summary" onClick={() => w.setPage('usage')}><span><Icon name="usage" size={13} /> {tv(w.language, 'workbench.sidebar.todayTokens', { tokens: number(today.totalTokens) })}</span><strong>{money(today.costUsd)}</strong></button>
      <div className="channel-cards">{channels.map((channel) => <button className="channel-mini" key={channel.id} onClick={() => w.setPage('settings')}>
        <div><strong><i className={`state-dot ${channel.credentialReady ? 'green' : 'amber'}`} />{channel.name}</strong><span>{channel.protocol === 'mock' ? tv(w.language, 'workbench.sidebar.offlineDemo') : channel.balance ? `${channel.balance.currency === 'CNY' ? '¥' : '$'}${channel.balance.amount.toFixed(2)}` : tv(w.language, 'workbench.sidebar.balanceUnknown')}</span></div>
        {channel.quota ? <><div className="mini-meter"><span style={{ width: `${Math.min(100, channel.quota.used / channel.quota.limit * 100)}%` }} /></div><small>{number(channel.quota.used)} / {number(channel.quota.limit)} {channel.quota.unit}{tv(w.language, 'workbench.sidebar.quotaSnapshot')}</small></> : <small>{channel.balance ? tv(w.language, 'workbench.sidebar.manualRecord', { date: new Date(channel.balance.updatedAt).toLocaleDateString() }) : channel.credentialReady ? tv(w.language, 'workbench.sidebar.credentialReadyQuotaUnknown') : tv(w.language, 'workbench.sidebar.credentialNotConfigured')}</small>}
      </button>)}</div>
    </section>
    <div className="sidebar-footer"><span className="local-avatar">S</span><div><strong>{tv(w.language, 'workbench.sidebar.localWorkspace')}</strong><small><i className={`state-dot ${w.status === 'ready' ? 'green' : 'amber'}`} />{w.status === 'ready' ? tv(w.language, 'workbench.sidebar.statusConnected') : w.status === 'error' ? tv(w.language, 'workbench.sidebar.statusFailed') : w.status === 'reconnecting' ? tv(w.language, 'workbench.sidebar.statusReconnecting') : tv(w.language, 'workbench.sidebar.statusBooting')}</small></div><button aria-label={tv(w.language, 'workbench.sidebar.channelsAndSettings')} className={w.page === 'settings' ? 'active' : ''} onClick={() => w.setPage('settings')}><Icon name="settings" /></button></div>
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
  return <div ref={ref} className="model-picker" role="dialog" aria-label={tv(w.language, 'workbench.picker.aria')}>
    <div className="model-channel-column"><div className="picker-label">{tv(w.language, 'workbench.picker.channelColumn')}</div>{channels.map((c) => <button className={channel?.id === c.id ? 'selected' : ''} key={c.id} onClick={() => setSelected(c.id)}><i className={`state-dot ${c.credentialReady ? 'green' : 'amber'}`} /><span>{c.name}</span>{current.startsWith(`${c.id}:`) && <b>✓</b>}</button>)}<button className="text-link picker-settings" onClick={() => { w.setPage('settings'); close(); }}>{tv(w.language, 'workbench.picker.manageChannels')}</button></div>
    <div className="model-list-column"><div className="picker-label">{tv(w.language, 'workbench.picker.modelsOf', { name: channel?.name ?? '' })}</div>{channel?.models.map((model) => {
      const spec = `${channel.id}:${model.id}`;
      return <button key={model.id} title={channel.credentialReady ? model.id : tv(w.language, 'workbench.picker.needCredential')} disabled={!channel.credentialReady || w.mutating} className={current === spec ? 'selected' : ''} onClick={() => { void w.configure({ model: spec }); close(); }}><span>{model.name || model.id}<small>{model.id}{model.contextWindow ? tv(w.language, 'workbench.picker.contextWindow', { tokens: number(model.contextWindow) }) : ''}</small></span>{current === spec && <b>✓</b>}</button>;
    })}{!channel?.models.length && <p className="picker-empty">{tv(w.language, 'workbench.picker.noModels')}</p>}</div>
    <div className="reasoning-column"><div className="picker-label">{tv(w.language, 'workbench.picker.reasoningLabel')}</div><button disabled>{tv(w.language, 'workbench.picker.modelDefault')}</button><p>{tv(w.language, 'workbench.picker.reasoningNote')}</p>{channel?.protocol === 'mock' && <span className="subtle-badge">{tv(w.language, 'workbench.picker.offlineDemo')}</span>}</div>
  </div>;
}

function Conversation({ w, confirm, onSlot }: { w: Workbench; confirm: (value: 'bypass') => void; onSlot: (slot: 'git' | 'detail') => void }) {
  // 文案随配置里的语言走；`Conversation` 是独立组件，自己取一份。
  const m = messages(w.language);
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
  const shellHint = shellHintFor(w.draft, w.language);
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
    if (command === '') { showNotice(tv(w.language, 'workbench.conversation.shellEmpty')); return; }
    if (shellBusy) { showNotice(tv(w.language, 'workbench.conversation.shellBusy')); return; }
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
        else showNotice(tv(w.language, 'workbench.conversation.focusPermissionFailed'));
        break;
      }
      case 'stop':
        if (canStop) void w.stop();
        else showNotice(tv(w.language, 'workbench.conversation.noRunningTurn'));
        break;
      case 'archive':
        if (w.sessionId) void w.archive(w.sessionId, true);
        else showNotice(tv(w.language, 'workbench.conversation.noSessionToArchive'));
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
      {w.loadingSession ? <div className="welcome"><span className="loading-spinner" /><h2>{tv(w.language, 'workbench.welcome.openingSession')}</h2></div> : !w.snapshot?.rows.length ? <div className="welcome"><span className="welcome-mark"><Icon name="code" size={37} /></span><span className="eyebrow">{tv(w.language, 'workbench.welcome.eyebrow')}</span><h1>{tv(w.language, 'workbench.welcome.title')}</h1><p>{tv(w.language, 'workbench.welcome.body')}<br />{tv(w.language, 'workbench.welcome.bodySecond')}</p><div className="welcome-workspace"><Icon name="folder" size={16} /><span title={w.workspaceRoot}>{leaf(w.workspaceRoot) || tv(w.language, 'workbench.welcome.chooseProject')}</span><button onClick={() => void w.openWorkspace()} disabled={w.status !== 'ready'}>{tv(w.language, 'workbench.welcome.switchDirectory')}</button></div>
        {!w.sessionId ? <button className="btn btn-primary welcome-create" disabled={w.status !== 'ready' || w.mutating} onClick={() => void w.createSession()}><Icon name="plus" size={16} /> {tv(w.language, 'workbench.welcome.createSession')}</button> : <div className="starter-grid">{([
          { id: 'understand', icon: 'folder', title: tv(w.language, 'workbench.welcome.starterUnderstand'), text: tv(w.language, 'workbench.welcome.starterUnderstandPrompt') },
          { id: 'plan', icon: 'sessions', title: tv(w.language, 'workbench.welcome.starterPlan'), text: tv(w.language, 'workbench.welcome.starterPlanPrompt') },
          { id: 'review', icon: 'shield', title: tv(w.language, 'workbench.welcome.starterReview'), text: tv(w.language, 'workbench.welcome.starterReviewPrompt') },
        ] as const).map((starter) => <button key={starter.id} onClick={() => w.setDraft(starter.text)}><Icon name={starter.icon} /><strong>{starter.title}</strong><span>{tv(w.language, 'workbench.welcome.starterHint')}</span></button>)}</div>}
        {/* "会先询问你"只在**会询问**的权限档位下成立：acceptEdits 下工作区内写不问，
            bypass 下基本不问。无条件写这句话在那些档位下是假话，所以按档位分文案。 */}
        <small className="welcome-notice">{tv(w.language, ASK_MODES.has(w.snapshot?.meta.permissionMode ?? '') ? 'workbench.welcome.noticeAsking' : 'workbench.welcome.noticeNotAsking')}</small>
      </div> : <Timeline rows={w.snapshot.rows} m={m} />}
      {pending.map((p) => <ApprovalCard key={p.id} interaction={p} m={m} onResolve={(id, opt) => void w.resolve(id, opt)} />)}
      {shellLines.length > 0 && <div className="shell-lines" aria-label={tv(w.language, 'workbench.conversation.shellLines')}>
        {shellLines.map((line) => <ShellResultBlock key={line.id} command={line.command} outcome={line.outcome} pending={line.outcome === undefined} lang={w.language} />)}
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
      <ComposerPalette lang={w.language} text={w.draft} caret={caret} files={files} filesLoading={filesLoading} filesError={filesError} canStop={canStop} disabled={disabled} anchorRef={composer} onAction={paletteAction} onText={applyComposerText} />
      {shellHint && <div className="composer-shell-hint" role="status">{shellHint}</div>}
      {notice && <div className="composer-notice" role="status">{notice}</div>}
      <div className="composer-toolbar">
        <div className="composer-options">
          <Icon name="shield" size={14} />
          <select id="composer-permission" aria-label={tv(w.language, 'workbench.conversation.permissionAria')} value={w.snapshot?.meta.permissionMode ?? 'default'} disabled={disabled || !idle || w.mutating} onChange={(e) => { if (e.target.value === 'bypass') confirm('bypass'); else void w.configure({ permissionMode: e.target.value as DesktopPermissionMode }); }}>{Object.entries(permissionNames(w.language)).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>
          <span className="toolbar-divider" />
          <button className="model-trigger" disabled={disabled || !idle || w.mutating} onClick={() => setPicker(!picker)} aria-expanded={picker}><i className="state-dot green" /><span>{w.snapshot?.meta.model ?? tv(w.language, 'workbench.picker.choosePlaceholder')}</span><Icon name="down" size={12} /></button>
        </div>
        {w.snapshot && !idle && <button className="stop-button" onClick={() => void w.stop()} disabled={w.mutating || w.status !== 'ready'}><span />{tv(w.language, 'workbench.conversation.stopRunning')}</button>}
      </div>
    </div>
    <div className="composer-footnote"><span>{w.snapshot?.meta.model.startsWith('mock:') ? tv(w.language, 'workbench.conversation.mockFootnote') : tv(w.language, 'workbench.conversation.modelFootnote')}</span><span>{tv(w.language, 'workbench.conversation.enterHint')}</span></div>
  </div>;
}

function SessionPage({ w, search }: { w: Workbench; search: string }) {
  const [archived, setArchived] = useState(false);
  const sessions = (w.overview?.sessions ?? []).filter((s) => s.archived === archived && `${s.title} ${s.workspaceRoot}`.toLowerCase().includes(search.toLowerCase()));
  return <div className="standard-page"><div className="page-heading"><div><span className="eyebrow">CONVERSATIONS</span><h1>{tv(w.language, 'workbench.sessions.title')}</h1><p>{tv(w.language, 'workbench.sessions.subtitle')}</p></div><button className="btn btn-primary" onClick={() => void w.createSession()} disabled={w.status !== 'ready' || w.mutating}>{tv(w.language, 'workbench.sessions.newSession')}</button></div><div className="segmented"><button className={!archived ? 'selected' : ''} onClick={() => setArchived(false)}>{tv(w.language, 'workbench.sessions.tabActive')}</button><button className={archived ? 'selected' : ''} onClick={() => setArchived(true)}>{tv(w.language, 'workbench.sessions.tabArchived')}</button></div>
    {!sessions.length && <div className="empty-state"><Icon name="sessions" size={30} /><h3>{search ? tv(w.language, 'workbench.sessions.emptyNoMatch') : archived ? tv(w.language, 'workbench.sessions.emptyArchived') : tv(w.language, 'workbench.sessions.emptyFirst')}</h3><p>{tv(w.language, 'workbench.sessions.emptyBody')}</p></div>}
    {w.overview?.workspaces.map((workspace) => { const group = sessions.filter((s) => s.workspaceRoot === workspace.root); return group.length > 0 && <section className="session-group" key={workspace.id}><h3><Icon name="folder" />{workspace.name}<small>{tv(w.language, 'workbench.sessions.count', { count: group.length })}</small></h3>{group.map((s) => <div className="session-record" key={s.sessionId}><button onClick={() => void w.selectSession(s.sessionId)} disabled={archived}><Icon name="chat" /><div><strong>{s.title}</strong><small>{tv(w.language, 'workbench.sessions.turns', { model: s.model, count: s.turnCount, time: new Date(s.updatedAt).toLocaleString() })}</small></div></button>{archived ? <button className="btn" disabled={w.mutating || w.status !== 'ready'} onClick={() => void w.archive(s.sessionId, false)}>{tv(w.language, 'workbench.sessions.restore')}</button> : <span className="subtle-badge">{s.runState === 'idle' ? tv(w.language, 'workbench.sessions.idle') : tv(w.language, 'workbench.sessions.running')}</span>}</div>)}</section>; })}
  </div>;
}

function FilePage({ w }: { w: Workbench }) {
  const m = messages(w.language);
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
    try { const file = await w.readFile(w.workspaceRoot, path); if (ticket === generation.current) setText(file.text + (file.truncated ? tv(w.language, 'workbench.files.truncated') : '')); }
    catch (e) { if (ticket === generation.current) setError((e as Error).message); }
    finally { if (ticket === generation.current) setLoading(false); }
  };
  const tree = (list: readonly TreeNode[]): ReactNode => list.map((node) => node.type === 'dir' ? <details key={node.path} className="file-folder"><summary><Icon name="folder" size={14} />{node.name}</summary><div>{tree(node.children ?? [])}</div></details> : <button className={`file-link ${selected === node.path ? 'selected' : ''}`} key={node.path} title={node.path} onClick={() => void open(node.path)}><Icon name="files" size={13} />{node.name}</button>);
  const tools = w.snapshot?.rows.filter((r) => r.kind === 'toolCall') ?? [];
  return <div className="standard-page file-page"><div className="page-heading"><div><span className="eyebrow">WORKSPACE</span><h1>{tv(w.language, 'workbench.files.title')}</h1><p>{w.workspaceRoot}</p></div></div><div className="segmented"><button className={tab === 'files' ? 'selected' : ''} onClick={() => setTab('files')}>{tv(w.language, 'workbench.files.tabFiles')}</button><button className={tab === 'tools' ? 'selected' : ''} onClick={() => setTab('tools')}>{tv(w.language, 'workbench.files.tabTools')}</button></div>{error && <div className="inline-error" role="alert">{error}</div>}
    {tab === 'files' ? <div className="file-browser"><div className="file-tree">{tree(nodes)}{!nodes.length && <p>{loading ? tv(w.language, 'workbench.files.readingTree') : tv(w.language, 'workbench.files.emptyTree')}</p>}</div><div className="file-preview"><div>{selected || tv(w.language, 'workbench.files.preview')}<span>{tv(w.language, 'workbench.files.readOnly')}</span></div>{selected ? <pre>{loading ? tv(w.language, 'workbench.files.reading') : text}</pre> : <div className="empty-state"><Icon name="files" size={30} /><p>{tv(w.language, 'workbench.files.pickFile')}</p><small>{tv(w.language, 'workbench.files.sensitiveNote')}</small></div>}</div></div> : <div className="tool-history"><p className="data-note">{tv(w.language, 'workbench.files.toolNote')}</p>{tools.length ? <Timeline rows={tools} m={m} /> : <div className="empty-state">{tv(w.language, 'workbench.files.noToolCalls')}</div>}</div>}
  </div>;
}

function Modal({ title, children, close, lang }: { title: string; children: ReactNode; close: () => void; lang: Lang }) {
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
  return <div className="modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) close(); }}><div ref={ref} className="modal" role="dialog" aria-modal="true" aria-label={title}><header><h2>{title}</h2><button aria-label={tv(lang, 'workbench.modal.close')} onClick={close}><Icon name="close" /></button></header>{children}</div></div>;
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
  // 文案随配置里的语言走（`27` FR-N-037）；配置是单一真相，界面不自己猜。
  const m = messages(w.language);
  const [search, setSearch] = useState('');
  // 右栏默认收起；会话详情与 Git 共用槽位且互斥（`27` §11.0 / §11.3.1）。
  const [sidebar, setSidebar] = useState<SidebarSlotState>(() => ({ ...INITIAL_SIDEBAR_STATE, tab: readStoredGitTab() }));
  // 主题（FR-N-037）：偏好持久化到 localStorage；`system` 跟随操作系统。
  const [themePreference, setThemePreference] = useState<ThemePreference>(() =>
    readStoredTheme(typeof window === 'undefined' ? undefined : window.localStorage));
  useEffect(() => {
    const media = typeof window === 'undefined' ? undefined : window.matchMedia?.('(prefers-color-scheme: dark)');
    const sync = (): void => {
      applyTheme(resolveTheme(themePreference, systemPrefersDark(window.matchMedia?.bind(window))), document.documentElement);
    };
    sync();
    storeTheme(window.localStorage, themePreference);
    // 只有 `system` 需要跟随变化；显式选择时不必监听。
    if (themePreference !== 'system' || media === undefined) return;
    const listener = (): void => sync();
    media.addEventListener?.('change', listener);
    return () => media.removeEventListener?.('change', listener);
  }, [themePreference]);
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
  const gitBadge = gitStatusBadge(w.gitStatus, w.language);
  const gitAuthInfo = w.gitAuth?.remotes[0]?.auth;
  const gitLabel = tv(w.language, 'workbench.topbar.gitLabel', {
    badge: gitBadge ? tv(w.language, 'workbench.topbar.gitBadge', { badge: gitBadge }) : '',
    auth: authStatusLabel(gitAuthInfo, w.language),
  });
  const turnCount = w.overview?.sessions.find((session) => session.sessionId === w.sessionId)?.turnCount ?? 0;
  return <div className="workbench-app">
    <Sidebar w={w} search={search} setSearch={setSearch} />
    <div className="main-shell">
      <header className="workbench-topbar"><div className="breadcrumb"><Icon name={w.page === 'chat' ? 'chat' : w.page} size={16} /><strong>{w.page === 'chat' ? w.snapshot?.meta.title ?? tv(w.language, 'workbench.topbar.pageFallback') : pageNames(w.language)[w.page]}</strong>{w.page === 'chat' && <span className={`run-badge ${!idle && w.snapshot ? 'running' : ''}`}><i className="state-dot" />{w.loadingSession
          ? tv(w.language, 'workbench.status.loading')
          : !w.snapshot || idle
            ? tv(w.language, 'workbench.status.idle')
            : w.snapshot.runState === 'awaiting-approval'
              ? tv(w.language, 'workbench.status.awaitingApproval')
              : tv(w.language, 'workbench.status.running')}</span>}</div><div className="topbar-actions"><button aria-label={tv(w.language, 'workbench.topbar.themeAria', { label: themeLabel(w.language, themePreference) })} title={tv(w.language, 'workbench.topbar.themeTitle', { label: themeLabel(w.language, themePreference) })} onClick={() => { const order: ThemePreference[] = ['system', 'light', 'dark']; const i = order.indexOf(themePreference); setThemePreference(order[(i + 1) % order.length] ?? 'system'); }}><Icon name={themePreference === 'dark' ? 'archive' : themePreference === 'light' ? 'edit' : 'sessions'} size={14} /></button>{w.page === 'chat' && <><span className="header-project" title={w.workspaceRoot}>{leaf(w.workspaceRoot)}</span><button aria-label={tv(w.language, 'workbench.topbar.renameAria')} title={tv(w.language, 'workbench.topbar.renameAria')} disabled={!w.snapshot || !idle || w.mutating} onClick={() => { setTitle(w.snapshot?.meta.title ?? ''); setDialog('rename'); }}><Icon name="edit" /></button><button aria-label={tv(w.language, 'workbench.topbar.archiveAria')} title={tv(w.language, 'workbench.topbar.archiveAria')} disabled={!w.snapshot || !idle || w.mutating} onClick={() => setDialog('archive')}><Icon name="archive" /></button><button ref={gitTrigger} aria-label={gitLabel} title={tv(w.language, 'workbench.topbar.gitSidebarTitle')} aria-pressed={sidebar.slot === 'git'} className={`git-trigger ${sidebar.slot === 'git' ? 'active' : ''}`} onClick={() => setSidebar((current) => gitTabState(current, 'toggle-git'))}><Icon name="git" />{gitBadge && <span className="git-badge">{gitBadge}</span>}<i className={`git-auth-dot state-dot ${authStatusTone(gitAuthInfo)}`} aria-hidden="true" /></button><button aria-label={tv(w.language, 'workbench.topbar.toggleDetail')} title={tv(w.language, 'workbench.topbar.detailTitle')} aria-pressed={sidebar.slot === 'detail'} className={sidebar.slot === 'detail' ? 'active' : ''} onClick={() => setSidebar((current) => gitTabState(current, 'toggle-detail'))}><Icon name="panel" /></button></>}</div></header>
      {w.error && <div className="error-banner" role="alert"><Icon name="shield" size={16} /><span>{w.error}</span><button aria-label={tv(w.language, 'workbench.topbar.closeError')} onClick={() => w.setError('')}><Icon name="close" size={15} /></button></div>}
      {w.status !== 'ready' && <div className="connection-banner" role="status">{w.status === 'booting'
        ? tv(w.language, 'workbench.banner.booting')
        : w.status === 'reconnecting'
          ? tv(w.language, 'workbench.banner.reconnecting')
          : tv(w.language, 'workbench.banner.error')}</div>}
      <div className="workspace-body"><main className={`main-content ${w.page === 'chat' ? 'chat-content' : ''}`}>
        {w.page === 'chat' && <Conversation w={w} confirm={(value) => { setDialogSession(w.sessionId); setDialog(value); }} onSlot={(slot) => setSidebar((current) => current.slot === slot ? current : gitTabState(current, slot === 'git' ? 'toggle-git' : 'toggle-detail'))} />}
        {w.page === 'usage' && <UsagePage report={w.report} channels={w.overview?.channels ?? []} workspaces={w.overview?.workspaces ?? []} query={w.query} loading={w.loadingUsage} onQuery={w.setQuery} lang={w.language} />}
        {w.page === 'settings' && <SettingsPage channels={w.overview?.channels ?? []} saving={saving} language={w.language} onChangeLanguage={w.changeLanguage} lang={w.language} onSave={async (channel) => { setSaving(true); try { await w.saveChannel(channel); } finally { setSaving(false); } }} />}
        {w.page === 'sessions' && <SessionPage w={w} search={search} />}
        {w.page === 'files' && <FilePage w={w} />}
        {w.page === 'agents' && <AgentsPage lang={w.language} result={w.agents} channels={w.overview?.channels ?? []} loading={w.agentsLoading} error={w.agentsError} busy={w.mutating} onSave={w.agentsSave} onDelete={w.agentsDelete} onActivate={w.agentsActivate} />}
        {w.page === 'resources' && <McpPage servers={w.mcpServers} loading={w.mcpLoading} error={w.mcpError} busy={w.mutating} onAdd={w.mcpAdd} onRemove={w.mcpRemove} onRestart={w.mcpRestart} onTools={w.mcpTools} />}
      </main>{w.page === 'chat' && sidebar.slot === 'detail' && <DetailPanel lang={w.language} inspection={w.inspection} snapshot={w.snapshot} turnCount={turnCount} onClose={() => setSidebar((current) => gitTabState(current, 'close'))} onOpenPage={(page) => w.setPage(page)} onLoadDiff={(path) => w.sessionChangeDiff(w.sessionId, path)} onPreviewArtifact={(path) => w.readFile(gitRoot, path)} onRevealArtifact={window.syao?.app.revealPath ? async (path) => { await window.syao?.app.revealPath?.(path); } : undefined} />}{w.page === 'chat' && sidebar.slot === 'git' && <GitSidebar workspaceRoot={gitRoot} status={w.gitStatus} branches={w.gitBranches} graph={w.gitGraph} remotes={w.gitRemotes} auth={w.gitAuth} preflight={w.gitPreflight} upload={w.gitUpload} diff={w.gitDiff} loading={w.gitLoading} busy={w.mutating} error={w.gitError} tab={sidebar.tab} onTab={(tab) => setSidebar((current) => gitTabState(current, 'select-tab', tab))} onClose={() => setSidebar((current) => gitTabState(current, 'close'))} onRefresh={() => void w.gitRefresh(gitRoot)} onLoadGraph={(skip) => void w.gitGraphLoad(gitRoot, skip)} onStage={(paths) => void w.gitStage(gitRoot, paths)} onUnstage={(paths) => void w.gitUnstage(gitRoot, paths)} onCommit={(input) => w.gitCommit(gitRoot, input)} onBranchSwitch={(name) => void w.gitBranchSwitch(gitRoot, name)} onBranchCreate={(name) => void w.gitBranchCreate(gitRoot, name, true)} onPreflight={(input) => w.gitPreflightRun(gitRoot, input)} onUpload={(input) => w.gitUploadRun(gitRoot, input)} onOpenDetail={() => setSidebar((current) => gitTabState(current, 'toggle-detail'))} onSetToken={async (input) => { await w.gitSetToken(input.workspaceRoot, input.remote, input.url, input.token); }} onUseSshAgent={async (input) => { await w.gitUseSshAgent(input.workspaceRoot, input.remote, input.url); }} onClearAuth={async (input) => { await w.gitClearAuth(input.workspaceRoot, input.remote, input.url); }} onGenerateMessage={async (input) => await w.gitCommitMessage(gitRoot, input.scope === 'session' ? 'session' : 'staged', w.sessionId)} onOauthStart={(input) => w.gitOauthStart(input)} onOauthPoll={(flowId) => w.gitOauthPoll(flowId)} onOauthCancel={(flowId) => w.gitOauthCancel(flowId)} onOpenExternal={(url) => w.openExternal(url)} onLoadDiff={async (input) => { await w.gitDiffLoad(gitRoot, input.path, input.mode); }} lang={w.language} />}</div>
    </div>
    {dialog && <Modal lang={w.language} title={dialog === 'rename' ? tv(w.language, 'workbench.dialog.renameTitle') : dialog === 'archive' ? tv(w.language, 'workbench.dialog.archiveTitle') : tv(w.language, 'workbench.dialog.bypassTitle')} close={closeDialog}>{dialog === 'rename' ? <form onSubmit={(e) => { e.preventDefault(); if (title.trim()) { void w.rename(title); closeDialog(); } }}><label className="modal-label">{tv(w.language, 'workbench.dialog.sessionName')}<input value={title} maxLength={120} onChange={(e) => setTitle(e.target.value)} /></label><footer><button type="button" className="btn" onClick={closeDialog}>{tv(w.language, 'workbench.dialog.cancel')}</button><button className="btn btn-primary" disabled={!title.trim() || w.mutating}>{tv(w.language, 'workbench.dialog.saveName')}</button></footer></form> : <><p>{dialog === 'archive' ? tv(w.language, 'workbench.dialog.archiveBody') : tv(w.language, 'workbench.dialog.bypassBody')}</p><footer><button className="btn" onClick={closeDialog}>{tv(w.language, 'workbench.dialog.cancel')}</button><button className={`btn ${dialog === 'bypass' ? 'btn-danger' : 'btn-primary'}`} disabled={dialog === 'bypass' && dialogSession !== w.sessionId} onClick={() => { if (dialog === 'archive') void w.archive(w.sessionId, true); else void w.configure({ permissionMode: 'bypass' }, dialogSession); closeDialog(); }}>{dialog === 'archive' ? tv(w.language, 'workbench.dialog.confirmArchive') : tv(w.language, 'workbench.dialog.confirmBypass')}</button></footer></>}</Modal>}
  </div>;
}
