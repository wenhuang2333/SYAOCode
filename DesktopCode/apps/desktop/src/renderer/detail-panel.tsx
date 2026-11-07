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
import { t, type Lang } from './i18n';
import { formatBytes, formatClock, formatDuration, formatMoney, formatNumber } from './format';

// ── 纯函数（可被测试直接断言）────────────────────────────────────────────

export type DetailSectionId = 'overview' | 'changes' | 'artifacts' | 'sources' | 'context' | 'capabilities';

/** 分区顺序（固定）：顺序是产品决定，与语言无关。 */
const SECTION_IDS: readonly DetailSectionId[] = ['overview', 'changes', 'artifacts', 'sources', 'context', 'capabilities'];

/** 6 个分区的标题（按语言生成）。 */
export function detailSections(lang: Lang = 'zh'): readonly { readonly id: DetailSectionId; readonly label: string }[] {
  return SECTION_IDS.map((id) => ({ id, label: t(lang, `detail.sections.${id}`) }));
}

/** 中文分区标题（兼容既有调用方与测试）。 */
export const DETAIL_SECTIONS = detailSections('zh');

/** 改动状态 → 左侧字母标记。 */
export const CHANGE_STATUS_LETTERS: Readonly<Record<FileChangeStatus, string>> = {
  added: 'A',
  modified: 'M',
  deleted: 'D',
  renamed: 'R',
};

/** 改动状态 → 文字说明（颜色之外的第二信息载体）。 */
export function changeStatusLabels(lang: Lang = 'zh'): Readonly<Record<FileChangeStatus, string>> {
  return {
    added: t(lang, 'detail.changeStatus.added'),
    modified: t(lang, 'detail.changeStatus.modified'),
    deleted: t(lang, 'detail.changeStatus.deleted'),
    renamed: t(lang, 'detail.changeStatus.renamed'),
  };
}

/** 中文改动状态说明（兼容既有调用方与测试）。 */
export const CHANGE_STATUS_LABELS = changeStatusLabels('zh');

/** 产出类型标签。 */
export function artifactKindLabels(lang: Lang = 'zh'): Readonly<Record<Artifact['kind'], string>> {
  return {
    file: t(lang, 'detail.artifactKind.file'),
    image: t(lang, 'detail.artifactKind.image'),
    patch: t(lang, 'detail.artifactKind.patch'),
    report: t(lang, 'detail.artifactKind.report'),
    archive: t(lang, 'detail.artifactKind.archive'),
  };
}

/** 中文产出类型标签（兼容既有调用方与测试）。 */
export const ARTIFACT_KIND_LABELS = artifactKindLabels('zh');

/** 三个分区的空态文案。 */
export function detailEmptyText(lang: Lang = 'zh'): { readonly changes: string; readonly artifacts: string; readonly sources: string } {
  return {
    changes: t(lang, 'detail.emptyChanges'),
    artifacts: t(lang, 'detail.emptyArtifacts'),
    sources: t(lang, 'detail.emptySources'),
  };
}

/** 中文空态（兼容既有调用方与测试）。 */
export const DETAIL_EMPTY_TEXT = detailEmptyText('zh');

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
export function formatChangeSummary(changes: readonly FileChange[], lang: Lang = 'zh'): string {
  const totals = summarizeChanges(changes);
  if (totals.files === 0) return t(lang, 'detail.changeSummaryZero');
  if (totals.added == null || totals.removed == null) {
    // 有文件不可统计时不能给出一个"看起来完整"的合计——那会让人以为统计是全的。
    return t(lang, 'detail.changeSummaryIncomplete', { files: totals.files });
  }
  return t(lang, 'detail.changeSummary', { files: totals.files, added: totals.added, removed: totals.removed });
}

/** 状态字母：新增 A / 修改 M / 删除 D / 重命名 R；不可统计为 `?`（§11.2 表格）。 */
export function changeStatusLetter(change: FileChange): string {
  if (change.stat === 'unavailable' || change.added == null || change.removed == null) return '?';
  return CHANGE_STATUS_LETTERS[change.status] ?? '?';
}

/** 状态中文说明。 */
export function changeStatusLabel(change: FileChange, lang: Lang = 'zh'): string {
  return changeStatusLabels(lang)[change.status] ?? t(lang, 'detail.unknownStatus');
}

/** 行数文本：`+12 -3`；不可统计时是"不可统计"（**不是 0**）。 */
export function changeStatText(change: FileChange, lang: Lang = 'zh'): string {
  if (change.stat === 'unavailable' || change.added == null || change.removed == null) return t(lang, 'detail.unavailableStat');
  return `+${change.added} -${change.removed}`;
}

/** 行级 `aria-label`：`src/a.ts，新增 12 行，删除 3 行`。 */
export function changeLineLabel(change: FileChange, lang: Lang = 'zh'): string {
  if (change.stat === 'unavailable' || change.added == null || change.removed == null) {
    return t(lang, 'detail.changeLineAriaUnknown', { path: change.path });
  }
  return t(lang, 'detail.changeLineAria', {
    path: change.path,
    added: change.added,
    removed: change.removed,
  });
}

/** 产出大小文案。 */
export function artifactSizeText(artifact: Artifact): string {
  return formatBytes(artifact.sizeBytes);
}

/** 产出 `aria-label`：名称 / 类型 / 大小 / 来源工具 / 时间。 */
export function artifactLineLabel(artifact: Artifact, lang: Lang = 'zh'): string {
  return t(lang, 'detail.artifactLineAria', {
    name: artifact.name,
    kind: artifactKindLabels(lang)[artifact.kind],
    size: artifactSizeText(artifact),
    tool: artifact.tool,
  });
}

// ── 产出的操作与预览（`27` §8.3 / §8.4）────────────────────────────────

/** 三个操作的固定文案与顺序：预览 / 复制路径 / 在文件管理器中显示。 */
export function artifactActionLabels(lang: Lang = 'zh'): readonly [string, string, string] {
  return [t(lang, 'detail.actionPreview'), t(lang, 'detail.actionCopyPath'), t(lang, 'detail.actionReveal')];
}

/** 预览被截断时的说明（§8.4：只显示前一部分）；`PREVIEW_TRUNCATED_TEXT` 是中文实例。 */
export function previewTruncatedText(lang: Lang = 'zh'): string {
  return t(lang, 'detail.previewTruncated');
}

/** 中文截断说明（兼容既有调用方与测试）。 */
export const PREVIEW_TRUNCATED_TEXT = previewTruncatedText('zh');

/** 预览不可用的四种原因（文案互不相同，且都说明"为什么看不到内容"）。 */
export function previewUnavailableText(reason: 'binary' | 'too_large' | 'missing' | 'empty', lang: Lang = 'zh'): string {
  switch (reason) {
    case 'binary': return t(lang, 'detail.previewBinary');
    case 'too_large': return t(lang, 'detail.previewTooLarge');
    case 'missing': return t(lang, 'detail.previewMissing');
    case 'empty': return t(lang, 'detail.previewEmpty');
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
export function artifactCopyNote(ok: boolean, lang: Lang = 'zh'): string {
  return ok ? t(lang, 'detail.copiedPath') : t(lang, 'detail.copyFailed');
}

/** 预览读取错误的人话说明（`path_rejected` = 不存在/越界/不是文件）。 */
export function describePreviewError(error: unknown, lang: Lang = 'zh'): string {
  const candidate = error as { readonly kind?: unknown; readonly message?: unknown } | null;
  const kind = candidate?.kind;
  const message = typeof candidate?.message === 'string' ? candidate.message : '';
  if (kind === 'path_rejected' || message.includes('path_rejected')) return previewUnavailableText('missing', lang);
  return message === '' ? t(lang, 'detail.previewFailed') : t(lang, 'detail.previewFailedWith', { message });
}

/** 在文件管理器中显示失败的人话说明。 */
export function describeRevealError(error: unknown, lang: Lang = 'zh'): string {
  const candidate = error as { readonly kind?: unknown; readonly message?: unknown } | null;
  const kind = candidate?.kind;
  const message = typeof candidate?.message === 'string' ? candidate.message : '';
  if (kind === 'path_rejected' || message.includes('path_rejected') || message.includes('ENOENT')) {
    return t(lang, 'detail.previewMissing');
  }
  return message === '' ? t(lang, 'detail.revealFailed') : t(lang, 'detail.revealFailedWith', { message });
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
export function ArtifactPreview({ preview, lang = 'zh' }: { readonly preview: ArtifactPreviewState | undefined; readonly lang?: Lang }): ReactNode {
  if (!preview) return <p className="artifact-preview-note" role="status">{t(lang, 'detail.reading')}</p>;
  switch (preview.kind) {
    case 'loading':
      return <p className="artifact-preview-note" role="status">{t(lang, 'detail.reading')}</p>;
    case 'unavailable':
      return <p className="artifact-preview-note">{previewUnavailableText(preview.reason, lang)}</p>;
    case 'error':
      return <p className="artifact-preview-note artifact-preview-error" role="alert">{preview.message}</p>;
    case 'ready':
      return (
        <div className="artifact-preview">
          {preview.truncated && <p className="artifact-preview-note">{previewTruncatedText(lang)}</p>}
          <pre className="artifact-preview-text">{preview.text}</pre>
        </div>
      );
  }
}

/** 可信度标注：`verified=false` 必须有可见标注（"未验证"）。 */
export function sourceTrustLabel(source: SourceRef, lang: Lang = 'zh'): string {
  if (source.verified && source.trust === 'verified') return t(lang, 'detail.trustVerified');
  if (source.trust === 'declared') return t(lang, 'detail.trustDeclared');
  return t(lang, 'detail.trustUnverified');
}

/** 来源出现次数文案。 */
export function sourceCountText(source: SourceRef, lang: Lang = 'zh'): string {
  return t(lang, 'detail.sourceCount', { count: source.count });
}

/** 来源 `aria-label`：标题 / 域名 / 次数 / 可信度。 */
export function sourceLineLabel(source: SourceRef, lang: Lang = 'zh'): string {
  return t(lang, 'detail.sourceLineAria', {
    name: source.title,
    domain: source.domain,
    count: sourceCountText(source, lang),
    trust: sourceTrustLabel(source, lang),
  });
}

// ── 单文件只读 diff（N-11）──────────────────────────────────────────────
//
// 口径纪律：这里展示的是**会话口径**（本会话首次触碰前 → 现在），
// 与 Git 侧栏的**工作区口径**是两件事。因此刻意不复用 `.git-diff-*` 类名，
// 避免两种口径在视觉上被当成同一个东西。

/** `unavailable` 四种原因各自的人话文案（互不相同，且都说明"为什么没有 diff"）。 */
/** `unavailable` 四种原因的人话文案。 */
export function changeDiffUnavailableText(lang: Lang = 'zh'): Readonly<Record<'binary' | 'too_large' | 'no_snapshot' | 'deleted', string>> {
  return {
    binary: t(lang, 'detail.diffBinary'),
    too_large: t(lang, 'detail.diffTooLarge'),
    no_snapshot: t(lang, 'detail.diffNoSnapshot'),
    deleted: t(lang, 'detail.diffDeleted'),
  };
}

/** 中文实例（兼容既有调用方与测试）。 */
export const CHANGE_DIFF_UNAVAILABLE_TEXT = changeDiffUnavailableText('zh');

/** 没有可用 diff 时的说明；有可用 diff 时为空串（界面据此决定是否渲染 `<pre>`）。 */
export function changeDiffNote(result: SessionChangeDiffResult, lang: Lang = 'zh'): string {
  if (result.unavailable !== null) return changeDiffUnavailableText(lang)[result.unavailable];
  if (result.hunks.length === 0) return t(lang, 'detail.diffNoText');
  if (result.truncated) return t(lang, 'detail.diffTruncatedNote');
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
export function describeDiffError(error: unknown, lang: Lang = 'zh'): string {
  const candidate = error as { readonly kind?: unknown; readonly message?: unknown } | null;
  const kind = candidate?.kind;
  const message = typeof candidate?.message === 'string' ? candidate.message : '';
  if (kind === 'capability_not_found' || message.includes('capability_not_found') || message.includes('-32005')) {
    return t(lang, 'detail.diffNotRecorded');
  }
  return message === '' ? t(lang, 'detail.diffReadFailed') : t(lang, 'detail.diffReadFailedWith', { message });
}

/** 覆盖范围说明：用过 `bash` 时必须显示"命令改动未逐文件统计"。 */
export function coverageNote(coverage: ChangesCoverage | undefined, lang: Lang = 'zh'): string {
  if (!coverage || !coverage.bashUsed) return '';
  return coverage.note ?? t(lang, 'detail.coverageFallback');
}

// ── 组件 ────────────────────────────────────────────────────────────────

export interface DetailPanelProps {
  readonly inspection: SessionInspection | undefined;
  readonly snapshot: SessionSnapshot | undefined;
  /** 当前会话轮次（来自概览列表，缺失时为 0）。 */
  readonly turnCount: number;
  readonly onClose: () => void;
  readonly onOpenPage: (page: 'agents' | 'resources') => void;
  /** 界面语言（默认中文，与桌面端默认一致）。 */
  readonly lang?: Lang;
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

/** 权限模式名称（与内核 5 个档位一一对应）。 */
export function permissionNames(lang: Lang = 'zh'): Record<string, string> {
  return {
    plan: t(lang, 'detail.permissionNames.plan'),
    strict: t(lang, 'detail.permissionNames.strict'),
    default: t(lang, 'detail.permissionNames.default'),
    acceptEdits: t(lang, 'detail.permissionNames.acceptEdits'),
    bypass: t(lang, 'detail.permissionNames.bypass'),
  };
}

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
export function ChangeDiffPanel({ loading = false, error = '', result, lang = 'zh' }: ChangeDiffPanelProps & { readonly lang?: Lang }): ReactNode {
  if (loading) return <p className="change-diff-note" role="status">{t(lang, 'detail.changeDiffReading')}</p>;
  if (error !== '') return <p className="change-diff-note change-diff-error" role="alert">{error}</p>;
  if (!result) return <p className="change-diff-note" role="status">{t(lang, 'detail.changeDiffNoResult')}</p>;
  const note = changeDiffNote(result, lang);
  if (result.unavailable !== null || result.hunks.length === 0) {
    return (
      <div className="change-diff" data-unavailable={result.unavailable ?? 'none'}>
        <p className="change-diff-note" role="status">{note}</p>
        <p className="change-diff-stats">{changeDiffStatsText(result)}</p>
      </div>
    );
  }
  return (
    <div className="change-diff" data-unavailable="none" aria-label={t(lang, 'detail.diffAria', { path: result.path })}>
      <div className="change-diff-head"><span>{result.path}</span><small>{changeDiffStatsText(result)}</small></div>
      {result.truncated && <p className="change-diff-note">{t(lang, 'detail.diffTruncatedNote')}</p>}
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

export function DetailPanel({ inspection, snapshot, turnCount, onClose, onOpenPage, onLoadDiff, onPreviewArtifact, onRevealArtifact, lang = 'zh' }: DetailPanelProps) {
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
      if (!result) { setDiffError(t(lang, 'detail.diffRuntimeEmpty')); return; }
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
      if (!result) { setPreview({ kind: 'error', message: t(lang, 'detail.previewRuntimeEmpty') }); return; }
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
  const note = coverageNote(inspection?.coverage, lang);
  const stats: readonly (readonly [string, string])[] = [
    [t(lang, 'detail.overviewTurns'), formatNumber(turnCount)],
    [t(lang, 'detail.overviewRequests'), formatNumber(totals.requests)],
    [t(lang, 'detail.overviewCost'), formatMoney(totals.costUsd)],
    [t(lang, 'detail.overviewCacheRead'), formatNumber(cache)],
    [t(lang, 'detail.overviewTotalTokens'), formatNumber(totals.totalTokens)],
    [t(lang, 'detail.overviewDuration'), formatDuration(totals.durationMs)],
    [t(lang, 'detail.overviewInput'), formatNumber(totals.inputTokens)],
    [t(lang, 'detail.overviewOutput'), formatNumber(totals.outputTokens)],
    [t(lang, 'detail.overviewErrors'), formatNumber(totals.errors)],
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
      <summary aria-label={t(lang, 'detail.sectionAria', { title })}>
        <span className="detail-section-title">{title}</span>
        {summary}
      </summary>
      <div className="detail-section-body">{body}</div>
    </details>
  );

  return (
    <aside className="detail-panel" aria-label={t(lang, 'detail.title')}>
      <div className="detail-title">
        <span><i className="state-dot" />{t(lang, 'detail.title')}</span>
        <button aria-label={t(lang, 'detail.closeAria')} onClick={onClose}><Icon name="close" size={15} /></button>
      </div>
      <div className="detail-scroll">
        {section('overview', t(lang, 'detail.sections.overview'), <small>{snapshot ? new Date(snapshot.meta.createdAt).toLocaleDateString() : t(lang, 'detail.overviewNoSession')}</small>, (
          <section className="detail-card">
            <div className="session-stats">{stats.map(([label, value]) => <div key={label}><span>{label}</span><strong>{value}</strong><i /></div>)}</div>
            {totals.unknownCostRequests > 0 && <p className="data-note">{t(lang, 'detail.unknownCostNote', { count: totals.unknownCostRequests })}</p>}
            <div className="detail-meta"><span>{t(lang, 'detail.overviewWorkspace')}</span><code title={snapshot?.meta.workspaceRoot}>{snapshot?.meta.workspaceRoot ?? '—'}</code></div>
            <div className="detail-meta"><span>{t(lang, 'detail.overviewModel')}</span><code>{snapshot?.meta.model ?? '—'}</code></div>
            <div className="detail-meta"><span>{t(lang, 'detail.overviewPermission')}</span><span>{permissionNames(lang)[snapshot?.meta.permissionMode ?? ''] ?? '—'}</span></div>
            <p className="data-note">{t(lang, 'detail.usageTotalsNote')}</p>
          </section>
        ))}

        {section('changes', t(lang, 'detail.sections.changes'), <small>{formatChangeSummary(changes, lang)}</small>, (
          <>
            {note && <p className="data-note detail-coverage-note" role="note">{note}</p>}
            {changes.length === 0
              ? <p className="detail-empty">{detailEmptyText(lang).changes}</p>
              : <ul className="change-list">
                {changes.map((change) => {
                  const expanded = expandedPath === change.path;
                  const bodyId = `change-diff-${change.path.replace(/[^A-Za-z0-9_-]/g, '-')}`;
                  const row = <>
                    <span className={`change-status change-status-${change.status}`} title={changeStatusLabel(change, lang)}>{changeStatusLetter(change)}</span>
                    <span className="change-path" title={change.path}>{change.path}</span>
                    {change.stat === 'unavailable' || change.added == null || change.removed == null
                      ? <span className="change-stat change-stat-unknown">{t(lang, 'detail.unavailableStat')}</span>
                      : <span className="change-stat"><span className="change-stat-add">+{change.added}</span> <span className="change-stat-del">-{change.removed}</span></span>}
                    {onLoadDiff && <Icon name={expanded ? 'down' : 'chevron'} size={11} />}
                  </>;
                  return <li className={`change-row-item${expanded ? ' expanded' : ''}`} key={`${change.path}:${change.updatedAt}`}>
                    {onLoadDiff
                      ? <button
                        type="button"
                        className={`change-row change-row-button${expanded ? ' expanded' : ''}`}
                        aria-label={`${changeLineLabel(change, lang)}${expanded ? t(lang, 'detail.changeLineExpanded') : t(lang, 'detail.changeLineCollapsed')}`}
                        aria-expanded={expanded}
                        aria-controls={bodyId}
                        onClick={() => void toggleDiff(change.path)}
                      >{row}</button>
                      : <div className="change-row" aria-label={changeLineLabel(change, lang)}>{row}</div>}
                    {/* 容器常驻（`aria-controls` 指向它始终有效），内容按展开态渲染。 */}
                    <div className="change-diff-slot" id={bodyId} hidden={!expanded}>
                      {expanded && <ChangeDiffPanel loading={diffLoading} error={diffError} result={diffResult} lang={lang} />}
                    </div>
                  </li>;
                })}
              </ul>}
            <p className="data-note">{t(lang, 'detail.changesScopeNote')}</p>
          </>
        ))}

        {section('artifacts', t(lang, 'detail.sections.artifacts'), <small>{artifacts.length === 0 ? t(lang, 'detail.artifactsNone') : t(lang, 'detail.artifactsCount', { count: artifacts.length })}</small>, (
          artifacts.length === 0
            ? <p className="detail-empty">{detailEmptyText(lang).artifacts}</p>
            : <ul className="artifact-list">
              {artifacts.map((artifact) => {
                const [previewLabel, copyLabel, revealLabel] = artifactActionLabels(lang);
                const expanded = previewArtifactId === artifact.id;
                return <li className="artifact-row" key={artifact.id} aria-label={artifactLineLabel(artifact, lang)}>
                  <div className="artifact-head">
                    <strong title={artifact.path}>{artifact.name}</strong>
                    <span className="artifact-kind">{artifactKindLabels(lang)[artifact.kind]}</span>
                  </div>
                  <div className="artifact-meta">
                    <span>{artifactSizeText(artifact)}</span>
                    <span>{t(lang, 'detail.artifactToolLabel')} {artifact.tool}</span>
                    <span>{formatClock(artifact.createdAt)}</span>
                  </div>
                  <div className="artifact-actions">
                    {onPreviewArtifact && (
                      <button
                        type="button"
                        className="artifact-action"
                        aria-label={`${expanded ? t(lang, 'detail.previewCollapse') : previewLabel} ${artifact.name}`}
                        aria-expanded={expanded}
                        onClick={() => void togglePreview(artifact)}
                      >{expanded ? t(lang, 'detail.previewCollapse') : previewLabel}</button>
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
                      title={onRevealArtifact ? t(lang, 'detail.revealTitle') : t(lang, 'detail.revealUnavailableTitle')}
                      disabled={!onRevealArtifact}
                      onClick={() => void revealArtifact(artifact)}
                    >{revealLabel}</button>
                  </div>
                  {copyNote?.artifactId === artifact.id && <p className="artifact-note" role="status">{copyNote.text}</p>}
                  {revealNote?.artifactId === artifact.id && <p className="artifact-note artifact-note-error" role="alert">{revealNote.text}</p>}
                  {expanded && <ArtifactPreview preview={preview} lang={lang} />}
                </li>;
              })}
            </ul>
        ))}

        {section('sources', t(lang, 'detail.sections.sources'), <small>{sources.length === 0 ? t(lang, 'detail.sourcesNone') : t(lang, 'detail.sourcesCount', { count: sources.length })}</small>, (
          sources.length === 0
            ? <p className="detail-empty">{detailEmptyText(lang).sources}</p>
            : <ul className="source-list">
              {sources.map((source) => (
                <li className="source-row" key={source.id} aria-label={sourceLineLabel(source, lang)}>
                  <div className="source-head">
                    <strong title={source.title}>{source.title}</strong>
                    <span className={`source-trust ${source.verified && source.trust === 'verified' ? 'source-trust-verified' : 'source-trust-unverified'}`}>
                      {sourceTrustLabel(source, lang)}
                    </span>
                  </div>
                  <div className="source-meta">
                    <span>{source.domain}</span>
                    <span>{sourceCountText(source, lang)}</span>
                    <span>{t(lang, 'detail.sourceTool')} {source.tool}</span>
                  </div>
                </li>
              ))}
            </ul>
        ))}

        {section('context', t(lang, 'detail.sections.context'), <small>{formatNumber(used)} / {formatNumber(capacity)}</small>, (
          <section className="detail-card">
            <div className="context-overview">
              <div className="context-ring" style={{ '--context-ratio': `${ratio ?? 0}%` } as CSSProperties}>
                <div><strong>{ratio == null ? '—' : `${Math.round(ratio)}%`}</strong><span>{context?.source === 'estimated' ? t(lang, 'detail.contextEstimated') : t(lang, 'detail.contextNotCollected')}</span></div>
              </div>
              <div className="context-segments">
                {(context?.segments.length ? context.segments : [
                  { name: t(lang, 'detail.contextSegmentFallback1'), tokens: 0 },
                  { name: t(lang, 'detail.contextSegmentFallback2'), tokens: 0 },
                  { name: t(lang, 'detail.contextSegmentFallback3'), tokens: 0 },
                ]).map((part, index) => (
                  <div key={part.name}><i style={{ background: CONTEXT_COLORS[index % CONTEXT_COLORS.length] }} /><span>{part.name}</span><b>{used == null ? '—' : formatNumber(part.tokens)}</b></div>
                ))}
              </div>
            </div>
            <p className="data-note">{t(lang, 'detail.contextNote')}{' '}{context?.capacitySource === 'configured' ? t(lang, 'detail.contextCapacityConfigured') : context?.capacitySource === 'adapter' ? t(lang, 'detail.contextCapacityAdapter') : t(lang, 'detail.contextCapacityFallback')}</p>
            <div className="context-footer"><span>{t(lang, 'detail.contextRemaining', { tokens: capacity && used != null ? formatNumber(Math.max(0, capacity - used)) : '—' })}</span><small>{t(lang, 'detail.contextNoCompaction')}</small></div>
          </section>
        ))}

        {section('capabilities', t(lang, 'detail.sections.capabilities'), <small>{t(lang, 'detail.capabilitiesSubtitle')}</small>, (
          // 能力清单**由 Host 提供**（`supported` 是构建级事实，不是"已配置"）。
          // 以前这里有一份写死的兜底列表，断言"MCP 尚未接入 / 子代理使用单 Agent"——
          // 那些话在 MCP 与 Agent 群接入之后就成了假话。现在只如实说"尚未读取"。
          inspection?.resources?.length
            ? inspection.resources.map((resource) => (
              <div className="detail-card resource-card" key={resource.id}>
                <div className="card-heading">{resource.name}<small>{resource.supported ? t(lang, 'detail.capabilityAvailable') : t(lang, 'detail.capabilityUnavailable')}</small></div>
                <p>{resource.detail}</p>
                <button className="text-link" onClick={() => onOpenPage(resource.id === 'agents' ? 'agents' : 'resources')}>{t(lang, 'detail.capabilityOpenHelp')}</button>
              </div>
            ))
            : <p className="detail-empty">{t(lang, 'detail.capabilitiesNotLoaded')}</p>
        ))}
      </div>
    </aside>
  );
}
