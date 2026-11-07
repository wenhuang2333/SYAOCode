/**
 * 会话详情面板（`27` §11.1 / §11.2）。
 *
 * 6 个可折叠分区，顺序固定：概览 / 改动 / 产出 / 来源 / 上下文 / 能力。
 *
 * 纪律：
 *  - **会话口径**（`SessionInspection.changes`），与 Git 侧栏的**工作区口径**绝不混算；
 *  - 不可统计的行数显示"不可统计"，绝不用 0 冒充；
 *  - 颜色不是唯一信息载体：状态字母、`+/-` 文本、`aria-label` 同时存在。
 */

import { useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import {
  EMPTY_USAGE,
  type Artifact,
  type ChangesCoverage,
  type DiffHunk,
  type FileChange,
  type FileChangeStatus,
  type SessionChangeDiffResult,
  type SessionInspection,
  type SessionSnapshot,
  type SourceRef,
  type WorkspaceReadFileResult,
} from '@syaocode/dhp';
import { Icon } from './icons';
import { formatBytes, formatClock, formatDuration, formatMoney, formatNumber } from './format';

// ── 纯函数（可被测试直接断言）────────────────────────────────────────────

export type DetailSectionId = 'overview' | 'changes' | 'artifacts' | 'sources' | 'context' | 'capabilities';

export const DETAIL_SECTIONS: readonly { readonly id: DetailSectionId; readonly label: string }[] = [
  { id: 'overview', label: '概览' },
  { id: 'changes', label: '改动' },
  { id: 'artifacts', label: '产出' },
  { id: 'sources', label: '来源' },
  { id: 'context', label: '上下文' },
  { id: 'capabilities', label: '能力' },
];

/** 改动状态 → 左侧字母标记。 */
export const CHANGE_STATUS_LETTERS: Readonly<Record<FileChangeStatus, string>> = {
  added: 'A',
  modified: 'M',
  deleted: 'D',
  renamed: 'R',
};

/** 改动状态 → 中文说明（颜色之外的第二信息载体）。 */
export const CHANGE_STATUS_LABELS: Readonly<Record<FileChangeStatus, string>> = {
  added: '新增',
  modified: '修改',
  deleted: '删除',
  renamed: '重命名',
};

export const ARTIFACT_KIND_LABELS: Readonly<Record<Artifact['kind'], string>> = {
  file: '文件',
  image: '图片',
  patch: '补丁',
  report: '报告',
  archive: '归档',
};

export const DETAIL_EMPTY_TEXT = {
  changes: '本会话没有文件改动',
  artifacts: '本会话没有产出文件',
  sources: '本会话没有参考来源',
} as const;

/** 改动统计汇总；任一条目不可统计时，总计也标为未知（`null`）。 */
export interface ChangeTotals {
  readonly files: number;
  readonly added: number | null;
  readonly removed: number | null;
  readonly unavailable: number;
}

export function summarizeChanges(changes: readonly FileChange[]): ChangeTotals {
  let added = 0;
  let removed = 0;
  let unavailable = 0;
  for (const change of changes) {
    if (change.stat === 'unavailable' || change.added == null || change.removed == null) {
      unavailable += 1;
      continue;
    }
    added += change.added;
    removed += change.removed;
  }
  return {
    files: changes.length,
    added: unavailable > 0 ? null : added,
    removed: unavailable > 0 ? null : removed,
    unavailable,
  };
}

/** 折叠态摘要：`改动 3 个文件 · +42 -7`。 */
export function formatChangeSummary(changes: readonly FileChange[]): string {
  const totals = summarizeChanges(changes);
  if (totals.files === 0) return '改动 0 个文件';
  if (totals.added == null || totals.removed == null) return `改动 ${totals.files} 个文件 · 统计不完整`;
  return `改动 ${totals.files} 个文件 · +${totals.added} -${totals.removed}`;
}

/** 状态字母：新增 A / 修改 M / 删除 D / 重命名 R；不可统计为 `?`（§11.2 表格）。 */
export function changeStatusLetter(change: FileChange): string {
  if (change.stat === 'unavailable' || change.added == null || change.removed == null) return '?';
  return CHANGE_STATUS_LETTERS[change.status] ?? '?';
}

/** 状态中文说明。 */
export function changeStatusLabel(change: FileChange): string {
  return CHANGE_STATUS_LABELS[change.status] ?? '未知状态';
}

/** 行数文本：`+12 -3`；不可统计时是"不可统计"（**不是 0**）。 */
export function changeStatText(change: FileChange): string {
  if (change.stat === 'unavailable' || change.added == null || change.removed == null) return '不可统计';
  return `+${change.added} -${change.removed}`;
}

/** 行级 `aria-label`：`src/a.ts，新增 12 行，删除 3 行`。 */
export function changeLineLabel(change: FileChange): string {
  if (change.stat === 'unavailable' || change.added == null || change.removed == null) {
    return `${change.path}，不可统计行数`;
  }
  return `${change.path}，新增 ${change.added} 行，删除 ${change.removed} 行`;
}

/** 产出大小文案。 */
export function artifactSizeText(artifact: Artifact): string {
  return formatBytes(artifact.sizeBytes);
}

/** 产出 `aria-label`：名称 / 类型 / 大小 / 来源工具 / 时间。 */
export function artifactLineLabel(artifact: Artifact): string {
  return `${artifact.name}，${ARTIFACT_KIND_LABELS[artifact.kind]}，${artifactSizeText(artifact)}，来源工具 ${artifact.tool}`;
}

// ── 产出的操作与预览（`27` §8.3 / §8.4）────────────────────────────────

/** 三个操作的固定文案与顺序：预览 / 复制路径 / 在文件管理器中显示。 */
export function artifactActionLabels(): readonly [string, string, string] {
  return ['预览', '复制路径', '在文件管理器中显示'];
}

/** 预览被截断时的说明（§8.4：只显示前一部分）。 */
export const PREVIEW_TRUNCATED_TEXT = '文件过大，只显示前一部分；完整内容请用外部编辑器打开';

/** 预览不可用的四种原因（文案互不相同，且都说明"为什么看不到内容"）。 */
export function previewUnavailableText(reason: 'binary' | 'too_large' | 'missing' | 'empty'): string {
  switch (reason) {
    case 'binary': return '二进制/图片文件，无法预览文本';
    case 'too_large': return '文件过大，无法在这里预览；完整内容请用外部编辑器打开';
    case 'missing': return '文件已不存在（可能已被删除或移动）';
    case 'empty': return '文件是空的（0 字节），没有可预览的内容';
  }
}

/**
 * 粗略判断文本是否像二进制。
 *
 * 规则：含 NUL 直接判定；否则统计前 4096 个字符里控制字符（不含 \t \n \r）的比例，
 * 超过 10% 视为二进制。只用于"不把乱码塞进预览"，不是文件类型识别。
 */
export function isProbablyBinary(text: string): boolean {
  if (text === '') return false;
  if (text.includes('\u0000')) return true;
  const sample = text.slice(0, 4096);
  let control = 0;
  for (const char of sample) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 32 && code !== 9 && code !== 10 && code !== 13) control += 1;
    else if (code === 0xfffd) control += 1;
  }
  return control / sample.length > 0.1;
}

/** 复制路径的结果文案：成功/失败必须不同，失败不得出现"成功"。 */
export function artifactCopyNote(ok: boolean): string {
  return ok ? '已复制路径' : '复制失败，请手动选择路径';
}

/** 预览读取错误的人话说明（`path_rejected` = 不存在/越界/不是文件）。 */
export function describePreviewError(error: unknown): string {
  const candidate = error as { readonly kind?: unknown; readonly message?: unknown } | null;
  const kind = candidate?.kind;
  const message = typeof candidate?.message === 'string' ? candidate.message : '';
  if (kind === 'path_rejected' || message.includes('path_rejected')) return previewUnavailableText('missing');
  return message === '' ? '预览失败' : `预览失败：${message}`;
}

/** 在文件管理器中显示失败的人话说明。 */
export function describeRevealError(error: unknown): string {
  const candidate = error as { readonly kind?: unknown; readonly message?: unknown } | null;
  const kind = candidate?.kind;
  const message = typeof candidate?.message === 'string' ? candidate.message : '';
  if (kind === 'path_rejected' || message.includes('path_rejected') || message.includes('ENOENT')) return '文件已不存在（可能已被删除或移动）';
  return message === '' ? '无法在文件管理器中显示' : `无法在文件管理器中显示：${message}`;
}

/** 预览面板状态（读取中 / 成功 / 不可用 / 错误）。 */
export type ArtifactPreviewState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready'; readonly text: string; readonly truncated: boolean }
  | { readonly kind: 'unavailable'; readonly reason: 'binary' | 'too_large' | 'missing' | 'empty' }
  | { readonly kind: 'error'; readonly message: string };

/**
 * 产出预览面板（只读）。
 *
 * 纪律：`unavailable` / `error` 时**不渲染 `<pre>`**；成功时用纯文本 children，
 * 只用 React 的纯文本 children 渲染（不注入原始 HTML）。`truncated` 必须明说"只显示前一部分"。
 */
export function ArtifactPreview({ preview }: { readonly preview: ArtifactPreviewState | undefined }): ReactNode {
  if (!preview) return <p className="artifact-preview-note" role="status">正在读取…</p>;
  switch (preview.kind) {
    case 'loading':
      return <p className="artifact-preview-note" role="status">正在读取…</p>;
    case 'unavailable':
      return <p className="artifact-preview-note">{previewUnavailableText(preview.reason)}</p>;
    case 'error':
      return <p className="artifact-preview-note artifact-preview-error" role="alert">{preview.message}</p>;
    case 'ready':
      return (
        <div className="artifact-preview">
          {preview.truncated && <p className="artifact-preview-note">{PREVIEW_TRUNCATED_TEXT}</p>}
          <pre className="artifact-preview-text">{preview.text}</pre>
        </div>
      );
  }
}

/** 可信度标注：`verified=false` 必须有可见标注（"未验证"）。 */
export function sourceTrustLabel(source: SourceRef): string {
  if (source.verified && source.trust === 'verified') return '已验证';
  if (source.trust === 'declared') return '未验证（来源声明）';
  return '未验证';
}

/** 来源出现次数文案。 */
export function sourceCountText(source: SourceRef): string {
  return `出现 ${source.count} 次`;
}

/** 来源 `aria-label`：标题 / 域名 / 次数 / 可信度。 */
export function sourceLineLabel(source: SourceRef): string {
  return `${source.title}，域名 ${source.domain}，${sourceCountText(source)}，${sourceTrustLabel(source)}`;
}

// ── 单文件只读 diff（N-11）──────────────────────────────────────────────
//
// 口径纪律：这里展示的是**会话口径**（本会话首次触碰前 → 现在），
// 与 Git 侧栏的**工作区口径**是两件事。因此刻意不复用 `.git-diff-*` 类名，
// 避免两种口径在视觉上被当成同一个东西。

/** `unavailable` 四种原因各自的人话文案（互不相同，且都说明"为什么没有 diff"）。 */
export const CHANGE_DIFF_UNAVAILABLE_TEXT: Readonly<Record<'binary' | 'too_large' | 'no_snapshot' | 'deleted', string>> = {
  binary: '二进制文件，无法显示文本 diff',
  too_large: '差异过大，只显示行数',
  no_snapshot: '本次会话没有留下改动前的内容（例如应用重启后），无法对比',
  deleted: '文件已删除，显示删除前的行数',
};

/** 没有可用 diff 时的说明；有可用 diff 时为空串（界面据此决定是否渲染 `<pre>`）。 */
export function changeDiffNote(result: SessionChangeDiffResult): string {
  if (result.unavailable !== null) return CHANGE_DIFF_UNAVAILABLE_TEXT[result.unavailable];
  if (result.hunks.length === 0) return '本次会话没有产生文本差异（或只有权限/模式变化）';
  if (result.truncated) return '差异过长，下面只显示前一部分';
  return '';
}

/** diff 行数文本：`+12 -3`。 */
export function changeDiffStatsText(result: SessionChangeDiffResult): string {
  return `+${result.added} -${result.removed}`;
}

/** 单行的着色类名（add / del / ctx 三种，颜色之外还有 `+` / `-` / 空格前缀）。 */
export function changeDiffLineClass(kind: DiffHunk['lines'][number]['kind']): string {
  return kind === 'add' ? 'change-diff-line-add' : kind === 'del' ? 'change-diff-line-del' : 'change-diff-line-ctx';
}

/** 单行前缀：`+` / `-` / 空格（颜色不是唯一信息载体）。 */
export function changeDiffLinePrefix(kind: DiffHunk['lines'][number]['kind']): string {
  return kind === 'add' ? '+' : kind === 'del' ? '-' : ' ';
}

/** 读取失败的人话说明（例如会话没记录过该路径）。 */
export function describeDiffError(error: unknown): string {
  const candidate = error as { readonly kind?: unknown; readonly message?: unknown } | null;
  const kind = candidate?.kind;
  const message = typeof candidate?.message === 'string' ? candidate.message : '';
  if (kind === 'capability_not_found' || message.includes('capability_not_found') || message.includes('-32005')) {
    return '本会话没有记录过这个路径的改动，无法生成 diff';
  }
  return message === '' ? '读取 diff 失败' : `读取 diff 失败：${message}`;
}

/** 覆盖范围说明：用过 `bash` 时必须显示"命令改动未逐文件统计"。 */
export function coverageNote(coverage: ChangesCoverage | undefined): string {
  if (!coverage || !coverage.bashUsed) return '';
  return coverage.note ?? '命令改动未逐文件统计';
}

// ── 组件 ────────────────────────────────────────────────────────────────

export interface DetailPanelProps {
  readonly inspection: SessionInspection | undefined;
  readonly snapshot: SessionSnapshot | undefined;
  /** 当前会话轮次（来自概览列表，缺失时为 0）。 */
  readonly turnCount: number;
  readonly onClose: () => void;
  readonly onOpenPage: (page: 'agents' | 'resources') => void;
  /**
   * 读取单个改动文件的会话口径 diff（N-11）。
   *
   * **可选**：未提供时改动行不可点击——不假装支持（`27` §6 不伪造）。
   */
  readonly onLoadDiff?: ((path: string) => Promise<SessionChangeDiffResult | undefined>) | undefined;
  /** 读取产出文件用于只读预览（`workspace/read-file`）。未提供时预览按钮不出现。 */
  readonly onPreviewArtifact?: ((path: string) => Promise<WorkspaceReadFileResult | undefined>) | undefined;
  /** 在文件管理器中显示产出（主进程窄桥，只接受工作区相对路径）。未提供时按钮禁用。 */
  readonly onRevealArtifact?: ((path: string) => Promise<void>) | undefined;
}

const permissionNames: Record<string, string> = {
  plan: '只读规划',
  strict: '严格审批',
  default: '标准权限',
  acceptEdits: '自动编辑',
  bypass: '完全授权',
};

const CONTEXT_COLORS = ['#8063e5', '#a299ee', '#c3baf7'];

export interface ChangeDiffPanelProps {
  readonly loading?: boolean;
  readonly error?: string;
  readonly result?: SessionChangeDiffResult | undefined;
}

/**
 * 单个改动文件的**会话口径**只读 diff。
 *
 * 纪律：
 *  - `unavailable !== null` 时绝不渲染 `<pre>`（空 diff 会被误读成"没有改动"）；
 *  - 四种 `unavailable` 各自有不同的人话文案；
 *  - 类名刻意与 Git 侧栏的 `.git-diff-*` 分开（会话口径 ≠ 工作区口径）。
 */
export function ChangeDiffPanel({ loading = false, error = '', result }: ChangeDiffPanelProps): ReactNode {
  if (loading) return <p className="change-diff-note" role="status">正在读取会话 diff…</p>;
  if (error !== '') return <p className="change-diff-note change-diff-error" role="alert">{error}</p>;
  if (!result) return <p className="change-diff-note" role="status">没有取到该文件的 diff。</p>;
  const note = changeDiffNote(result);
  if (result.unavailable !== null || result.hunks.length === 0) {
    return (
      <div className="change-diff" data-unavailable={result.unavailable ?? 'none'}>
        <p className="change-diff-note" role="status">{note}</p>
        <p className="change-diff-stats">{changeDiffStatsText(result)}</p>
      </div>
    );
  }
  return (
    <div className="change-diff" data-unavailable="none" aria-label={`${result.path} 的会话口径只读 diff`}>
      <div className="change-diff-head"><span>{result.path}</span><small>{changeDiffStatsText(result)}</small></div>
      {result.truncated && <p className="change-diff-note">差异过长，下面只显示前一部分</p>}
      {result.hunks.map((hunk, hunkIndex) => (
        <pre className="change-diff-hunk" key={`${hunk.oldStart}:${hunk.newStart}:${hunkIndex}`}>
          {`@@ -${hunk.oldStart} +${hunk.newStart} @@`}{'\n'}
          {hunk.lines.map((line, lineIndex) => (
            <span key={lineIndex} className={`change-diff-line ${changeDiffLineClass(line.kind)}`}>
              {changeDiffLinePrefix(line.kind)}{line.text}{'\n'}
            </span>
          ))}
        </pre>
      ))}
    </div>
  );
}

export function DetailPanel({ inspection, snapshot, turnCount, onClose, onOpenPage, onLoadDiff, onPreviewArtifact, onRevealArtifact }: DetailPanelProps) {
  const [open, setOpen] = useState<ReadonlySet<DetailSectionId>>(() => new Set<DetailSectionId>(['overview']));
  // 单文件只读 diff（N-11）：同一时刻只展开一行；再点同一行收起。
  const [expandedPath, setExpandedPath] = useState('');
  const [diffResult, setDiffResult] = useState<SessionChangeDiffResult>();
  const [diffLoading, setDiffLoading] = useState(false);
  const [diffError, setDiffError] = useState('');
  const diffTicket = useRef(0);
  const sessionKey = inspection?.sessionId ?? '';
  useEffect(() => {
    // 会话切换后旧 diff 不能继续显示（会话口径不同，串会话会误导）。
    diffTicket.current += 1;
    setExpandedPath('');
    setDiffResult(undefined);
    setDiffError('');
    setDiffLoading(false);
  }, [sessionKey]);
  const toggleDiff = useCallback(async (path: string) => {
    if (!onLoadDiff) return;
    if (expandedPath === path) {
      diffTicket.current += 1;
      setExpandedPath('');
      setDiffResult(undefined);
      setDiffError('');
      setDiffLoading(false);
      return;
    }
    const ticket = ++diffTicket.current;
    setExpandedPath(path);
    setDiffResult(undefined);
    setDiffError('');
    setDiffLoading(true);
    try {
      const result = await onLoadDiff(path);
      if (ticket !== diffTicket.current) return;
      if (!result) { setDiffError('运行时没有返回该文件的 diff'); return; }
      setDiffResult(result);
    } catch (error) {
      if (ticket !== diffTicket.current) return;
      setDiffError(describeDiffError(error));
    } finally {
      if (ticket === diffTicket.current) setDiffLoading(false);
    }
  }, [expandedPath, onLoadDiff]);
  // ── 产出操作：预览 / 复制路径 / 在文件管理器中显示 ──────────────────
  const [previewArtifactId, setPreviewArtifactId] = useState('');
  const [preview, setPreview] = useState<ArtifactPreviewState>();
  const [copyNote, setCopyNote] = useState<{ readonly artifactId: string; readonly text: string }>();
  const [revealNote, setRevealNote] = useState<{ readonly artifactId: string; readonly text: string }>();
  const previewTicket = useRef(0);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => { if (copyTimer.current !== undefined) clearTimeout(copyTimer.current); }, []);
  const artifactSessionKey = inspection?.sessionId ?? '';
  useEffect(() => {
    // 会话切换：旧产出与旧预览一律清掉（产出是会话口径，串会话会误导）。
    previewTicket.current += 1;
    setPreviewArtifactId('');
    setPreview(undefined);
    setCopyNote(undefined);
    setRevealNote(undefined);
  }, [artifactSessionKey]);

  const closePreview = () => {
    previewTicket.current += 1;
    setPreviewArtifactId('');
    // 收起时清空预览内容：下次展开必须重新读，绝不复用旧文本。
    setPreview(undefined);
  };

  const togglePreview = async (artifact: Artifact): Promise<void> => {
    if (!onPreviewArtifact) return;
    if (previewArtifactId === artifact.id) { closePreview(); return; }
    const ticket = ++previewTicket.current;
    setPreviewArtifactId(artifact.id);
    // **先清空再读**：读取失败时必须显示失效态，而不是保留上一次的旧内容。
    setPreview(undefined);
    if (artifact.kind === 'image') { setPreview({ kind: 'unavailable', reason: 'binary' }); return; }
    setPreview({ kind: 'loading' });
    try {
      const result = await onPreviewArtifact(artifact.path);
      if (ticket !== previewTicket.current) return;
      if (!result) { setPreview({ kind: 'error', message: '运行时没有返回预览内容' }); return; }
      if (result.text === '') { setPreview({ kind: 'unavailable', reason: 'empty' }); return; }
      if (isProbablyBinary(result.text)) { setPreview({ kind: 'unavailable', reason: 'binary' }); return; }
      setPreview({ kind: 'ready', text: result.text, truncated: result.truncated });
    } catch (error) {
      if (ticket !== previewTicket.current) return;
      const text = describePreviewError(error);
      if (text === previewUnavailableText('missing')) setPreview({ kind: 'unavailable', reason: 'missing' });
      else setPreview({ kind: 'error', message: text });
    }
  };

  const copyArtifactPath = async (artifact: Artifact): Promise<void> => {
    if (copyTimer.current !== undefined) { clearTimeout(copyTimer.current); copyTimer.current = undefined; }
    try {
      await navigator.clipboard.writeText(artifact.path);
      setCopyNote({ artifactId: artifact.id, text: artifactCopyNote(true) });
      // 成功提示 2 秒后消失；失败提示保留到下一次操作，避免用户没看到。
      copyTimer.current = setTimeout(() => {
        copyTimer.current = undefined;
        setCopyNote(undefined);
      }, 2000);
    } catch {
      setCopyNote({ artifactId: artifact.id, text: artifactCopyNote(false) });
    }
  };

  const revealArtifact = async (artifact: Artifact): Promise<void> => {
    if (!onRevealArtifact) return;
    try {
      await onRevealArtifact(artifact.path);
      setRevealNote(undefined);
    } catch (error) {
      setRevealNote({ artifactId: artifact.id, text: describeRevealError(error) });
    }
  };

  const totals = inspection?.totals ?? EMPTY_USAGE;
  const context = inspection?.context;
  const capacity = context?.capacity;
  const used = context?.usedTokens;
  const ratio = capacity && used != null ? Math.min(100, used / capacity * 100) : null;
  const cache = totals.cacheReadTokens;
  const changes = inspection?.changes ?? [];
  const artifacts = inspection?.artifacts ?? [];
  const sources = inspection?.sources ?? [];
  const note = coverageNote(inspection?.coverage);
  const stats: readonly (readonly [string, string])[] = [
    ['轮次', formatNumber(turnCount)],
    ['请求', formatNumber(totals.requests)],
    ['估算成本', formatMoney(totals.costUsd)],
    ['缓存读取', formatNumber(cache)],
    ['总 tokens', formatNumber(totals.totalTokens)],
    ['请求耗时', formatDuration(totals.durationMs)],
    ['输入', formatNumber(totals.inputTokens)],
    ['输出', formatNumber(totals.outputTokens)],
    ['错误请求', formatNumber(totals.errors)],
  ];

  const section = (id: DetailSectionId, title: string, summary: ReactNode, body: ReactNode) => (
    <details
      className="detail-section"
      key={id}
      open={open.has(id)}
      onToggle={(event) => {
        const next = event.currentTarget.open;
        setOpen((previous) => {
          const set = new Set(previous);
          if (next) set.add(id); else set.delete(id);
          return set;
        });
      }}
    >
      <summary aria-label={`${title}分区`}>
        <span className="detail-section-title">{title}</span>
        {summary}
      </summary>
      <div className="detail-section-body">{body}</div>
    </details>
  );

  return (
    <aside className="detail-panel" aria-label="会话详情">
      <div className="detail-title">
        <span><i className="state-dot" />会话详情</span>
        <button aria-label="关闭会话详情" onClick={onClose}><Icon name="close" size={15} /></button>
      </div>
      <div className="detail-scroll">
        {section('overview', '概览', <small>{snapshot ? new Date(snapshot.meta.createdAt).toLocaleDateString() : '未选择会话'}</small>, (
          <section className="detail-card">
            <div className="session-stats">{stats.map(([label, value]) => <div key={label}><span>{label}</span><strong>{value}</strong><i /></div>)}</div>
            {totals.unknownCostRequests > 0 && <p className="data-note">{totals.unknownCostRequests} 次请求未提供定价，成本仅为已知部分。</p>}
            <div className="detail-meta"><span>会话目录</span><code title={snapshot?.meta.workspaceRoot}>{snapshot?.meta.workspaceRoot ?? '—'}</code></div>
            <div className="detail-meta"><span>当前模型</span><code>{snapshot?.meta.model ?? '—'}</code></div>
            <div className="detail-meta"><span>权限模式</span><span>{permissionNames[snapshot?.meta.permissionMode ?? ''] ?? '—'}</span></div>
            <p className="data-note">累计用量不等于当前上下文或上游账单。</p>
          </section>
        ))}

        {section('changes', '改动', <small>{formatChangeSummary(changes)}</small>, (
          <>
            {note && <p className="data-note detail-coverage-note" role="note">{note}</p>}
            {changes.length === 0
              ? <p className="detail-empty">{DETAIL_EMPTY_TEXT.changes}</p>
              : <ul className="change-list">
                {changes.map((change) => {
                  const expanded = expandedPath === change.path;
                  const bodyId = `change-diff-${change.path.replace(/[^A-Za-z0-9_-]/g, '-')}`;
                  const row = <>
                    <span className={`change-status change-status-${change.status}`} title={changeStatusLabel(change)}>{changeStatusLetter(change)}</span>
                    <span className="change-path" title={change.path}>{change.path}</span>
                    {change.stat === 'unavailable' || change.added == null || change.removed == null
                      ? <span className="change-stat change-stat-unknown">不可统计</span>
                      : <span className="change-stat"><span className="change-stat-add">+{change.added}</span> <span className="change-stat-del">-{change.removed}</span></span>}
                    {onLoadDiff && <Icon name={expanded ? 'down' : 'chevron'} size={11} />}
                  </>;
                  return <li className={`change-row-item${expanded ? ' expanded' : ''}`} key={`${change.path}:${change.updatedAt}`}>
                    {onLoadDiff
                      ? <button
                        type="button"
                        className={`change-row change-row-button${expanded ? ' expanded' : ''}`}
                        aria-label={`${changeLineLabel(change)}${expanded ? '，已展开只读 diff' : '，点击查看只读 diff'}`}
                        aria-expanded={expanded}
                        aria-controls={bodyId}
                        onClick={() => void toggleDiff(change.path)}
                      >{row}</button>
                      : <div className="change-row" aria-label={changeLineLabel(change)}>{row}</div>}
                    {/* 容器常驻（`aria-controls` 指向它始终有效），内容按展开态渲染。 */}
                    <div className="change-diff-slot" id={bodyId} hidden={!expanded}>
                      {expanded && <ChangeDiffPanel loading={diffLoading} error={diffError} result={diffResult} />}
                    </div>
                  </li>;
                })}
              </ul>}
            <p className="data-note">会话口径：只统计本会话的工具改动，与 Git 侧栏的"工作区未提交改动"互不相加。</p>
          </>
        ))}

        {section('artifacts', '产出', <small>{artifacts.length === 0 ? '暂无产出' : `${artifacts.length} 项产出`}</small>, (
          artifacts.length === 0
            ? <p className="detail-empty">{DETAIL_EMPTY_TEXT.artifacts}</p>
            : <ul className="artifact-list">
              {artifacts.map((artifact) => {
                const [previewLabel, copyLabel, revealLabel] = artifactActionLabels();
                const expanded = previewArtifactId === artifact.id;
                return <li className="artifact-row" key={artifact.id} aria-label={artifactLineLabel(artifact)}>
                  <div className="artifact-head">
                    <strong title={artifact.path}>{artifact.name}</strong>
                    <span className="artifact-kind">{ARTIFACT_KIND_LABELS[artifact.kind]}</span>
                  </div>
                  <div className="artifact-meta">
                    <span>{artifactSizeText(artifact)}</span>
                    <span>来源工具 {artifact.tool}</span>
                    <span>{formatClock(artifact.createdAt)}</span>
                  </div>
                  <div className="artifact-actions">
                    {onPreviewArtifact && (
                      <button
                        type="button"
                        className="artifact-action"
                        aria-label={`${expanded ? '收起预览' : previewLabel} ${artifact.name}`}
                        aria-expanded={expanded}
                        onClick={() => void togglePreview(artifact)}
                      >{expanded ? '收起预览' : previewLabel}</button>
                    )}
                    <button
                      type="button"
                      className="artifact-action"
                      aria-label={`${copyLabel} ${artifact.name}`}
                      onClick={() => void copyArtifactPath(artifact)}
                    >{copyLabel}</button>
                    <button
                      type="button"
                      className="artifact-action"
                      aria-label={`${revealLabel} ${artifact.name}`}
                      title={onRevealArtifact ? '在系统文件管理器中显示该文件' : '主进程未提供显示文件的通道'}
                      disabled={!onRevealArtifact}
                      onClick={() => void revealArtifact(artifact)}
                    >{revealLabel}</button>
                  </div>
                  {copyNote?.artifactId === artifact.id && <p className="artifact-note" role="status">{copyNote.text}</p>}
                  {revealNote?.artifactId === artifact.id && <p className="artifact-note artifact-note-error" role="alert">{revealNote.text}</p>}
                  {expanded && <ArtifactPreview preview={preview} />}
                </li>;
              })}
            </ul>
        ))}

        {section('sources', '来源', <small>{sources.length === 0 ? '暂无来源' : `${sources.length} 条来源`}</small>, (
          sources.length === 0
            ? <p className="detail-empty">{DETAIL_EMPTY_TEXT.sources}</p>
            : <ul className="source-list">
              {sources.map((source) => (
                <li className="source-row" key={source.id} aria-label={sourceLineLabel(source)}>
                  <div className="source-head">
                    <strong title={source.title}>{source.title}</strong>
                    <span className={`source-trust ${source.verified && source.trust === 'verified' ? 'source-trust-verified' : 'source-trust-unverified'}`}>
                      {sourceTrustLabel(source)}
                    </span>
                  </div>
                  <div className="source-meta">
                    <span>{source.domain}</span>
                    <span>{sourceCountText(source)}</span>
                    <span>来源工具 {source.tool}</span>
                  </div>
                </li>
              ))}
            </ul>
        ))}

        {section('context', '上下文', <small>{formatNumber(used)} / {formatNumber(capacity)}</small>, (
          <section className="detail-card">
            <div className="context-overview">
              <div className="context-ring" style={{ '--context-ratio': `${ratio ?? 0}%` } as CSSProperties}>
                <div><strong>{ratio == null ? '—' : `${Math.round(ratio)}%`}</strong><span>{context?.source === 'estimated' ? '估算占用' : '尚未采集'}</span></div>
              </div>
              <div className="context-segments">
                {(context?.segments.length ? context.segments : [{ name: '系统提示', tokens: 0 }, { name: '工具定义', tokens: 0 }, { name: '对话历史', tokens: 0 }]).map((part, index) => (
                  <div key={part.name}><i style={{ background: CONTEXT_COLORS[index % CONTEXT_COLORS.length] }} /><span>{part.name}</span><b>{used == null ? '—' : formatNumber(part.tokens)}</b></div>
                ))}
              </div>
            </div>
            <p className="data-note">最近请求的文本估算，非精确 tokenizer 计数。容量：{context?.capacitySource === 'configured' ? '用户配置' : context?.capacitySource === 'adapter' ? '适配器声明' : '尚未提供'}。</p>
            <div className="context-footer"><span>剩余 {capacity && used != null ? formatNumber(Math.max(0, capacity - used)) : '—'} tokens</span><small>未启用自动压缩</small></div>
          </section>
        ))}

        {section('capabilities', '能力', <small>本会话可用能力</small>, (
          (inspection?.resources?.length ? inspection.resources : [
            { id: 'mcp', name: 'MCP', detail: '尚未接入受信任的 MCP 执行服务', supported: false },
            { id: 'skills', name: '技能', detail: '尚未接入技能执行器', supported: false },
            { id: 'agents', name: '子代理', detail: '当前使用单 Agent 运行', supported: false },
            { id: 'checkpoints', name: '检查点', detail: '会话自动保存；不支持工作区文件回滚', supported: false },
          ]).map((resource) => (
            <div className="detail-card resource-card" key={resource.id}>
              <div className="card-heading">{resource.name}<small>{resource.supported ? '可用' : '未接入'}</small></div>
              <p>{resource.detail}</p>
              <button className="text-link" onClick={() => onOpenPage(resource.id === 'agents' ? 'agents' : 'resources')}>查看能力说明 →</button>
            </div>
          ))
        ))}
      </div>
    </aside>
  );
}
