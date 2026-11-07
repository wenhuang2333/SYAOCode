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

import { useState, type CSSProperties, type ReactNode } from 'react';
import {
  EMPTY_USAGE,
  type Artifact,
  type ChangesCoverage,
  type FileChange,
  type FileChangeStatus,
  type SessionInspection,
  type SessionSnapshot,
  type SourceRef,
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
}

const permissionNames: Record<string, string> = {
  plan: '只读规划',
  strict: '严格审批',
  default: '标准权限',
  acceptEdits: '自动编辑',
  bypass: '完全授权',
};

const CONTEXT_COLORS = ['#8063e5', '#a299ee', '#c3baf7'];

export function DetailPanel({ inspection, snapshot, turnCount, onClose, onOpenPage }: DetailPanelProps) {
  const [open, setOpen] = useState<ReadonlySet<DetailSectionId>>(() => new Set<DetailSectionId>(['overview']));
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
                {changes.map((change) => (
                  <li className="change-row" key={`${change.path}:${change.updatedAt}`} aria-label={changeLineLabel(change)}>
                    <span className={`change-status change-status-${change.status}`} title={changeStatusLabel(change)}>{changeStatusLetter(change)}</span>
                    <span className="change-path" title={change.path}>{change.path}</span>
                    {change.stat === 'unavailable' || change.added == null || change.removed == null
                      ? <span className="change-stat change-stat-unknown">不可统计</span>
                      : <span className="change-stat"><span className="change-stat-add">+{change.added}</span> <span className="change-stat-del">-{change.removed}</span></span>}
                  </li>
                ))}
              </ul>}
            <p className="data-note">会话口径：只统计本会话的工具改动，与 Git 侧栏的"工作区未提交改动"互不相加。</p>
          </>
        ))}

        {section('artifacts', '产出', <small>{artifacts.length === 0 ? '暂无产出' : `${artifacts.length} 项产出`}</small>, (
          artifacts.length === 0
            ? <p className="detail-empty">{DETAIL_EMPTY_TEXT.artifacts}</p>
            : <ul className="artifact-list">
              {artifacts.map((artifact) => (
                <li className="artifact-row" key={artifact.id} aria-label={artifactLineLabel(artifact)}>
                  <div className="artifact-head">
                    <strong title={artifact.path}>{artifact.name}</strong>
                    <span className="artifact-kind">{ARTIFACT_KIND_LABELS[artifact.kind]}</span>
                  </div>
                  <div className="artifact-meta">
                    <span>{artifactSizeText(artifact)}</span>
                    <span>来源工具 {artifact.tool}</span>
                    <span>{formatClock(artifact.createdAt)}</span>
                  </div>
                </li>
              ))}
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
