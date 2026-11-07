import { useEffect, useId, useState } from 'react';
import type { ChannelInfo, UsageDay, UsageGroup, UsageQuery, UsageReport, UsageTotals, WorkspaceInfo } from '@syaocode/dhp';

export interface UsagePageProps {
  readonly report: UsageReport | undefined;
  readonly channels: readonly ChannelInfo[];
  readonly workspaces: readonly WorkspaceInfo[];
  readonly query: UsageQuery;
  readonly loading: boolean;
  readonly onQuery: (query: UsageQuery) => void;
}

type TrendMetric = 'tokens' | 'cost' | 'requests';
export type DatePreset = 'today' | '7d' | '30d' | 'custom';
const METRICS: Readonly<Record<TrendMetric, string>> = { tokens: 'Tokens', cost: '成本 (USD)', requests: '请求数' };
const numberFormat = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 4 });

export function formatNumber(value: number | null | undefined): string {
  return value == null || !Number.isFinite(value) ? '—' : numberFormat.format(value);
}

export function formatCompact(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '—';
  if (Math.abs(value) >= 1_000_000_000) return `${formatNumber(Math.round(value / 10_000_000) / 100)}B`;
  if (Math.abs(value) >= 1_000_000) return `${formatNumber(Math.round(value / 10_000) / 100)}M`;
  if (Math.abs(value) >= 10_000) return `${formatNumber(Math.round(value / 10) / 100)}K`;
  return formatNumber(value);
}

export function formatUsd(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '—';
  if (value > 0 && value < 0.0001) return '< $0.0001';
  return `$${value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 4 })}`;
}

export function formatPercent(ratio: number | null | undefined): string {
  return ratio == null || !Number.isFinite(ratio) ? '—' : `${(ratio * 100).toFixed(1)}%`;
}

export function localDateValue(timestamp: number): string {
  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime())) return '';
  return `${date.getFullYear().toString().padStart(4, '0')}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function parseLocalDate(value: string): Date | undefined {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined;
  const date = new Date(`${value}T00:00:00`);
  return Number.isFinite(date.getTime()) && localDateValue(date.getTime()) === value ? date : undefined;
}

export function usageQueryForDates(from: string, to: string, workspaceRoot?: string):
  { readonly ok: true; readonly query: UsageQuery } | { readonly ok: false; readonly error: string } {
  const start = parseLocalDate(from);
  const end = parseLocalDate(to);
  if (!start || !end) return { ok: false, error: '请选择有效的开始日期和结束日期。' };
  if (start > end) return { ok: false, error: '开始日期不能晚于结束日期，请调整日期范围。' };
  // Local calendar arithmetic, not +86,400,000: DST days can be 23 or 25 hours.
  end.setDate(end.getDate() + 1);
  end.setMilliseconds(-1);
  return { ok: true, query: { from: start.getTime(), to: end.getTime(), ...(workspaceRoot ? { workspaceRoot } : {}) } };
}

export function presetUsageQuery(preset: Exclude<DatePreset, 'custom'>, workspaceRoot?: string, now = Date.now()): UsageQuery {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - (preset === 'today' ? 0 : preset === '7d' ? 6 : 29));
  const result = usageQueryForDates(localDateValue(start.getTime()), localDateValue(now), workspaceRoot);
  if (!result.ok) throw new Error(result.error);
  return result.query;
}

export function identifyDatePreset(query: UsageQuery, now = Date.now()): DatePreset {
  for (const preset of ['today', '7d', '30d'] as const) {
    const expected = presetUsageQuery(preset, query.workspaceRoot, now);
    if (query.from === expected.from && query.to === expected.to) return preset;
  }
  return 'custom';
}

export function cacheHitRate(totals: UsageTotals | undefined): number | null {
  // The DTO has no input-token denominator scoped to cache-reporting requests.
  // Never divide a partial cache numerator by the input from ALL requests.
  if (!totals || totals.requests === 0 || totals.cacheReadTokens === null || totals.inputTokens <= 0
    || totals.cacheReportedRequests !== totals.requests || totals.unknownUsageRequests > 0) return null;
  return totals.cacheReadTokens / totals.inputTokens;
}

export function costCoverage(totals: UsageTotals | undefined): string {
  if (!totals) return '等待用量报告';
  if (totals.requests === 0) return '暂无请求记录';
  const known = Math.max(0, totals.requests - totals.unknownCostRequests);
  return `${totals.unknownCostRequests > 0 ? (known > 0 ? '部分已知' : '成本未提供') : '已知成本'} · 覆盖 ${formatPercent(known / totals.requests)} (${formatNumber(known)}/${formatNumber(totals.requests)} 次)`;
}

export function cacheCoverage(totals: UsageTotals | undefined): string {
  if (!totals || totals.requests === 0) return '暂无缓存上报';
  return `${totals.cacheReportedRequests < totals.requests ? '部分覆盖' : '上报覆盖'} · ${formatNumber(totals.cacheReportedRequests)}/${formatNumber(totals.requests)} 次请求`;
}

function tokenValue(totals: UsageTotals | undefined, key: 'totalTokens' | 'inputTokens' | 'outputTokens'): number | null {
  if (!totals || (totals.requests > 0 && totals.unknownUsageRequests >= totals.requests)) return null;
  return totals[key];
}

/** A group's chart, legend and detail row always use the same stable color. */
export function usageGroupColor(id: string): string {
  let hash = 0;
  for (const char of id) hash = (Math.imul(hash, 31) + char.charCodeAt(0)) >>> 0;
  const colors = ['#8063e5', '#4c9bbd', '#51ad99', '#dfad58', '#c775a2', '#8c96d8', '#6f9d65', '#c58464'];
  return colors[hash % colors.length]!;
}

function exactNumber(value: number | null | undefined): string {
  return value == null || !Number.isFinite(value) ? '—' : value.toLocaleString('en-US', { maximumFractionDigits: 12 });
}

function Kpi({ label, value, note, exact, accent = false, symbol }: {
  label: string; value: string; note: string; exact: string; accent?: boolean; symbol: string;
}): React.JSX.Element {
  return <article className={`usage-kpi${accent ? ' usage-kpi-accent' : ''}`}>
    <div className="usage-kpi-top"><span>{label}</span><span className="usage-kpi-symbol" aria-hidden="true">{symbol}</span></div>
    <strong className="usage-kpi-value" title={exact}>{value}</strong>
    <span className="usage-kpi-note">{note}</span>
  </article>;
}

function chartValue(day: UsageDay, metric: TrendMetric | 'sessions'): number | null {
  if (metric === 'cost') return day.totals.costUsd;
  if (metric === 'tokens') return tokenValue(day.totals, 'totalTokens');
  return metric === 'sessions' ? day.totals.activeSessions : day.totals.requests;
}

function niceMaximum(value: number, integer: boolean): number {
  if (value <= 0) return integer ? 4 : 1;
  const scale = 10 ** Math.floor(Math.log10(value));
  const step = [1, 2, 4, 5, 8, 10].find((candidate) => candidate * scale >= value) ?? 10;
  return integer ? Math.max(4, step * scale) : step * scale;
}

function Chart({ report, query, metric }: { report: UsageReport | undefined; query: UsageQuery; metric: TrendMetric | 'sessions' }): React.JSX.Element {
  const id = useId();
  const title = metric === 'sessions' ? '每日活跃会话' : `${METRICS[metric]} 趋势`;
  const days = [...(report?.days ?? [])].sort((a, b) => a.date.localeCompare(b.date));
  const from = report?.from ?? query.from;
  const to = report?.to ?? query.to;
  const first = parseLocalDate(localDateValue(from))?.getTime() ?? 0;
  const last = parseLocalDate(localDateValue(to))?.getTime() ?? first;
  const range = Math.max(0, last - first);
  const width = 520; const height = 230; const left = 64; const right = 20; const top = 22; const bottom = 38;
  const plotWidth = width - left - right; const plotHeight = height - top - bottom;
  const points = days.map((day) => ({
    day, value: chartValue(day, metric),
    x: left + (range === 0 ? plotWidth / 2 : Math.max(0, Math.min(1, ((parseLocalDate(day.date)?.getTime() ?? first) - first) / range)) * plotWidth),
  }));
  const maximum = niceMaximum(points.reduce((max, p) => Math.max(max, p.value ?? 0), 0), metric !== 'cost');
  const y = (value: number): number => top + plotHeight * (1 - value / maximum);
  const barWidth = Math.max(1, Math.min(24, plotWidth / Math.max(1, days.length) * 0.55));
  let previousDate: Date | undefined;
  const line = points.map((point) => {
    const date = parseLocalDate(point.day.date);
    const expected = previousDate ? new Date(previousDate) : undefined;
    expected?.setDate(expected.getDate() + 1);
    const contiguous = expected?.getTime() === date?.getTime();
    previousDate = point.value === null ? undefined : date;
    return point.value === null ? '' : `${contiguous ? 'L' : 'M'} ${point.x} ${y(point.value)}`;
  }).join(' ');
  const noRequests = report !== undefined && report.totals.requests === 0;
  const allUnknown = report !== undefined && !noRequests && points.every((point) => point.value === null);
  return <div className="usage-chart-wrap">
    <svg className="usage-chart" viewBox={`0 0 ${width} ${height}`} role="img" aria-labelledby={`${id}-title ${id}-desc`}>
      <title id={`${id}-title`}>{title}</title>
      <desc id={`${id}-desc`}>按本地日期统计。横轴为日期，纵轴为{metric === 'sessions' ? '会话数' : METRICS[metric]}。精确值见下方每日明细；未知值留空，不按零绘制。</desc>
      <defs><linearGradient id={`${id}-bar`} x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#8063e5"/><stop offset="100%" stopColor="#c7b7f7"/></linearGradient></defs>
      {[0, 1, 2, 3, 4].map((tick) => <g key={tick}>
        <line className="usage-grid-line" x1={left} x2={width - right} y1={y(maximum * tick / 4)} y2={y(maximum * tick / 4)} />
        <text className="usage-axis-label" x={left - 10} y={y(maximum * tick / 4) + 4} textAnchor="end">{metric === 'cost' ? formatUsd(maximum * tick / 4) : formatCompact(maximum * tick / 4)}</text>
      </g>)}
      <line className="usage-axis-line" x1={left} x2={width - right} y1={y(0)} y2={y(0)}/>
      {(range === 0 ? [0.5] : [0, 0.25, 0.5, 0.75, 1]).filter((fraction, index, all) => index === 0 || localDateValue(first + range * fraction) !== localDateValue(first + range * (all[index - 1] ?? 0))).map((fraction) => <text
        className="usage-axis-label" key={fraction} x={left + plotWidth * fraction} y={height - 12} textAnchor={fraction === 0 ? 'start' : fraction === 1 ? 'end' : 'middle'}
      >{localDateValue(first + range * fraction).slice(5).replace('-', '/')}</text>)}
      {!noRequests && metric !== 'sessions' && <path className="usage-trend-line" d={line} fill="none"/>}
      {!noRequests && points.map((point) => point.value === null ? null : metric === 'sessions'
        ? <rect key={point.day.date} x={Math.min(width - right - barWidth, Math.max(left, point.x - barWidth / 2))} y={y(point.value)} width={barWidth} height={Math.max(0, y(0) - y(point.value))} rx="3" fill={`url(#${id}-bar)`}><title>{`${point.day.date} · ${exactNumber(point.value)} 个活跃会话`}</title></rect>
        : <circle className="usage-chart-point" key={point.day.date} cx={point.x} cy={y(point.value)} r={points.length > 60 ? 1.8 : 3.5}><title>{`${point.day.date} · ${METRICS[metric]} ${metric === 'cost' ? formatUsd(point.value) : exactNumber(point.value)}${metric === 'cost' ? `；${costCoverage(point.day.totals)}` : ''}`}</title></circle>)}
      {(noRequests || allUnknown || !report) && <text className="usage-chart-empty" x={(left + width - right) / 2} y={top + plotHeight / 2} textAnchor="middle">{!report ? '等待用量报告' : noRequests ? '所选范围暂无请求记录' : '该指标尚未提供'}</text>}
    </svg>
    <div className="usage-chart-legend"><span className="usage-dot usage-dot-accent"/>{metric === 'sessions' ? '有请求的会话（每日去重）' : METRICS[metric]}<span className="usage-chart-legend-note">{metric === 'cost' ? '仅绘制已知成本，缺失值留空' : '按请求发生的本地日期'}</span></div>
  </div>;
}

function Distribution({ title, groups, available }: { title: string; groups: readonly UsageGroup[]; available: boolean }): React.JSX.Element {
  const id = useId();
  const total = groups.reduce((sum, group) => sum + group.totals.totalTokens, 0);
  const circumference = 2 * Math.PI * 65;
  let offset = 0;
  return <section className="dash-panel usage-distribution">
    <div className="dash-panel-heading"><h2>{title}分布</h2><span className="dash-caption">按已知 Tokens</span></div>
    <div className="usage-distribution-visual">
      <svg className="usage-donut" viewBox="0 0 180 180" role="img" aria-labelledby={`${id}-title`}>
        <title id={`${id}-title`}>{`${title} Tokens 分布，总计 ${available ? exactNumber(total) : '未提供'}。各分组数值见图例和明细表。`}</title>
        <circle className="usage-donut-track" cx="90" cy="90" r="65" fill="none" strokeWidth="18"/>
        {groups.map((group) => {
          const length = total > 0 ? group.totals.totalTokens / total * circumference : 0;
          const start = offset; offset += length;
          return length > 0 ? <circle key={group.id} cx="90" cy="90" r="65" fill="none" strokeWidth="18" stroke={usageGroupColor(group.id)} strokeDasharray={`${length} ${circumference}`} strokeDashoffset={-start} transform="rotate(-90 90 90)"><title>{`${group.name}: ${exactNumber(group.totals.totalTokens)} Tokens`}</title></circle> : null;
        })}
        <text className="usage-donut-value" x="90" y="88" textAnchor="middle">{available ? formatCompact(total) : '—'}</text>
        <text className="usage-donut-label" x="90" y="109" textAnchor="middle">已知 Tokens</text>
      </svg>
      <ul className="usage-distribution-legend" aria-label={`${title}分布图例`}>
        {groups.length === 0 ? <li className="usage-legend-empty">{available ? '暂无分组数据' : '等待用量报告'}</li> : groups.map((group) => <li key={group.id}>
          <span className="usage-dot" style={{ backgroundColor: usageGroupColor(group.id) }}/><span className="usage-legend-name" title={group.name}>{group.name}</span>
          <strong title={exactNumber(group.totals.totalTokens)}>{formatCompact(tokenValue(group.totals, 'totalTokens'))}</strong><span>{formatPercent(total > 0 ? group.totals.totalTokens / total : null)}</span>
        </li>)}
      </ul>
    </div>
    <div className="dash-table-scroll" tabIndex={0} role="region" aria-label={`${title}用量明细，可横向滚动`}>
      <table className="dash-table"><caption>{title}用量明细 · 精确值</caption><thead><tr><th scope="col">{title}</th><th scope="col">请求</th><th scope="col">输入 / 输出</th><th scope="col">缓存读取</th><th scope="col">成本 (USD)</th></tr></thead>
        <tbody>{groups.length === 0 ? <tr><td colSpan={5} className="dash-table-empty">{available ? '所选范围暂无记录' : '等待用量报告'}</td></tr> : groups.map((group) => <tr key={group.id}>
          <th scope="row"><span className="usage-table-name"><span className="usage-dot" style={{ backgroundColor: usageGroupColor(group.id) }}/><span title={group.id}>{group.name}</span></span></th>
          <td>{exactNumber(group.totals.requests)}<small>{formatNumber(group.totals.errors)} 次错误</small></td>
          <td>{exactNumber(tokenValue(group.totals, 'inputTokens'))} / {exactNumber(tokenValue(group.totals, 'outputTokens'))}{group.totals.unknownUsageRequests > 0 && <small>{formatNumber(group.totals.unknownUsageRequests)} 次用量未知</small>}</td>
          <td>{exactNumber(group.totals.cacheReadTokens)}<small>{cacheCoverage(group.totals)}</small></td>
          <td title={group.totals.costUsd === null ? '未提供' : `${exactNumber(group.totals.costUsd)} USD`}>{formatUsd(group.totals.costUsd)}<small>{costCoverage(group.totals)}</small></td>
        </tr>)}</tbody>
      </table>
    </div>
  </section>;
}

export function channelRequestHealth(totals: UsageTotals | undefined): { label: string; tone: 'neutral' | 'good' | 'warning' } {
  if (!totals || totals.requests === 0) return { label: '暂无请求记录', tone: 'neutral' };
  if (totals.errors > 0) return { label: `错误率 ${formatPercent(totals.errors / totals.requests)}`, tone: 'warning' };
  return { label: '历史请求无错误', tone: 'good' };
}

function snapshotTime(timestamp: number): string {
  return Number.isFinite(timestamp) ? new Date(timestamp).toLocaleString('zh-CN', { hour12: false }) : '时间未提供';
}

function ChannelHealth({ channels, report }: { channels: readonly ChannelInfo[]; report: UsageReport | undefined }): React.JSX.Element {
  const ids = [...new Set([...channels.map((channel) => channel.id), ...(report?.channels.map((group) => group.id) ?? [])])];
  return <section className="dash-panel usage-health">
    <div className="dash-panel-heading"><div><h2>渠道健康</h2><p className="dash-caption">当前筛选范围的请求结果，不代表实时连通性</p></div><span className="dash-tag">本地请求观测</span></div>
    <div className="usage-health-grid">{ids.length === 0 ? <p className="dash-empty">暂无渠道配置或历史请求。</p> : ids.map((id) => {
      const channel = channels.find((item) => item.id === id);
      const group = report?.channels.find((item) => item.id === id);
      const health = channelRequestHealth(group?.totals);
      return <article className="usage-channel-card" key={id}>
        <div className="usage-channel-heading"><strong>{channel?.name ?? group?.name ?? id}</strong><span className={`dash-tag dash-tag-${health.tone}`}>{!report ? '等待报告' : health.label}</span></div>
        <p className="usage-channel-credential">{channel?.protocol === 'mock' ? <span className="dash-tag dash-tag-demo">离线演示 · Mock</span> : channel ? (channel.credentialReady ? '凭据已配置 · 未检测连通性' : '凭据未配置') : '历史渠道 · 当前未配置'}</p>
        <dl className="usage-channel-numbers"><div><dt>请求数</dt><dd>{formatNumber(report ? group?.totals.requests ?? 0 : null)}</dd></div><div><dt>错误</dt><dd>{formatNumber(report ? group?.totals.errors ?? 0 : null)}</dd></div><div><dt>取消</dt><dd>{formatNumber(report ? group?.totals.cancelled ?? 0 : null)}</dd></div></dl>
        <div className="usage-channel-balance"><span>账户余额</span><strong>{channel?.balance ? `${formatNumber(channel.balance.amount)} ${channel.balance.currency}` : '未提供'}</strong></div>
        <p className="usage-snapshot-note">{channel?.balance ? `手动录入 · ${snapshotTime(channel.balance.updatedAt)} · 非实时` : '未接入账单 API；不从本地成本推算余额'}</p>
        {channel?.quota ? <div className="usage-quota"><div><span>手动配额 · {channel.quota.unit}</span><strong>{formatNumber(channel.quota.used)} / {formatNumber(channel.quota.limit)}</strong></div><progress max={channel.quota.limit > 0 ? channel.quota.limit : 1} value={Math.min(channel.quota.used, Math.max(1, channel.quota.limit))} aria-label={`${channel.name} 手动配额使用量`}/><p className="usage-snapshot-note">记录于 {snapshotTime(channel.quota.updatedAt)}{channel.quota.used >= channel.quota.limit ? ' · 已达额度上限' : ''}{channel.quota.resetsAt !== undefined ? ` · 重置 ${snapshotTime(channel.quota.resetsAt)}` : ''}</p></div> : <p className="usage-snapshot-note">配额未提供</p>}
      </article>;
    })}</div>
  </section>;
}

export function UsagePage({ report, channels, workspaces, query, loading, onQuery }: UsagePageProps): React.JSX.Element {
  const id = useId();
  const [metric, setMetric] = useState<TrendMetric>('tokens');
  const [from, setFrom] = useState(() => localDateValue(query.from));
  const [to, setTo] = useState(() => localDateValue(query.to));
  const [workspaceRoot, setWorkspaceRoot] = useState(query.workspaceRoot ?? '');
  const [preset, setPreset] = useState<DatePreset>(() => identifyDatePreset(query));
  const [rangeError, setRangeError] = useState('');
  useEffect(() => {
    setFrom(localDateValue(query.from)); setTo(localDateValue(query.to));
    setWorkspaceRoot(query.workspaceRoot ?? ''); setPreset(identifyDatePreset(query)); setRangeError('');
  }, [query.from, query.to, query.workspaceRoot]);

  const changeDates = (start: string, end: string, root = workspaceRoot): void => {
    setFrom(start); setTo(end); setWorkspaceRoot(root);
    const result = usageQueryForDates(start, end, root);
    if (!result.ok) { setRangeError(result.error); setPreset('custom'); return; }
    setRangeError(''); setPreset(identifyDatePreset(result.query)); onQuery(result.query);
  };
  const choosePreset = (next: Exclude<DatePreset, 'custom'>): void => {
    const nextQuery = presetUsageQuery(next, workspaceRoot);
    setFrom(localDateValue(nextQuery.from)); setTo(localDateValue(nextQuery.to)); setPreset(next); setRangeError(''); onQuery(nextQuery);
  };
  const totals = report?.totals;
  const tokensNote = totals?.unknownUsageRequests ? `已知小计 · ${formatNumber(totals.unknownUsageRequests)} 次用量未提供` : '输入 + 输出，不重复计缓存';
  const hasMock = report?.channels.some((group) => channels.some((channel) => channel.id === group.id && channel.protocol === 'mock')) ?? false;
  const stats = [
    { label: '总 Tokens', value: formatCompact(tokenValue(totals, 'totalTokens')), exact: exactNumber(tokenValue(totals, 'totalTokens')), note: tokensNote, symbol: 'Σ', accent: true },
    { label: '输入 Tokens', value: formatCompact(tokenValue(totals, 'inputTokens')), exact: exactNumber(tokenValue(totals, 'inputTokens')), note: totals?.unknownUsageRequests ? tokensNote : '含缓存读取，不重复累加', symbol: '↙' },
    { label: '输出 Tokens', value: formatCompact(tokenValue(totals, 'outputTokens')), exact: exactNumber(tokenValue(totals, 'outputTokens')), note: totals?.unknownUsageRequests ? tokensNote : '模型生成的输出', symbol: '↗' },
    { label: '缓存读取', value: formatCompact(totals?.cacheReadTokens), exact: exactNumber(totals?.cacheReadTokens), note: cacheCoverage(totals), symbol: '▱' },
    { label: '缓存命中率', value: formatPercent(cacheHitRate(totals)), exact: formatPercent(cacheHitRate(totals)), note: totals && totals.cacheReportedRequests < totals.requests ? '上报不完整，无法确定命中率' : '缓存读取 / 输入 Tokens', symbol: '%' },
    { label: '活跃会话', value: formatNumber(totals?.activeSessions), exact: exactNumber(totals?.activeSessions), note: '范围内有请求的会话，去重', symbol: '◷' },
    { label: '活跃渠道', value: formatNumber(totals?.activeChannels), exact: exactNumber(totals?.activeChannels), note: '范围内实际发起请求的渠道', symbol: '⇄' },
    { label: '成本 · USD', value: formatUsd(totals?.costUsd), exact: totals?.costUsd == null ? '未提供' : `${exactNumber(totals.costUsd)} USD`, note: costCoverage(totals), symbol: '$', accent: true },
    { label: '请求数', value: formatNumber(totals?.requests), exact: exactNumber(totals?.requests), note: `按 Provider 调用计数${totals ? ` · ${formatNumber(totals.cancelled)} 次取消` : ''}`, symbol: '⌁' },
    { label: '错误率', value: formatPercent(totals && totals.requests > 0 ? totals.errors / totals.requests : null), exact: totals ? `${totals.errors}/${totals.requests}` : '未提供', note: '错误请求 / 全部请求，不含取消', symbol: '!' },
  ];
  return <main className="usage-page dash-page" aria-labelledby={`${id}-title`}>
    <header className="dash-page-header"><div><p className="dash-eyebrow">WORKSPACE ANALYTICS</p><h1 id={`${id}-title`}>用量统计</h1><p className="dash-subtitle">每一次请求，都有迹可循。</p></div><span className="dash-tag">本地用量账本</span></header>
    <div className="usage-toolbar">
      <div className="dash-segmented" role="group" aria-label="日期预设">{([['today', '今天'], ['7d', '近 7 天'], ['30d', '近 30 天']] as const).map(([key, label]) => <button type="button" key={key} aria-pressed={preset === key} onClick={() => choosePreset(key)}>{label}</button>)}</div>
      <div className="usage-date-range"><label><span>开始日期</span><input type="date" value={from} aria-invalid={Boolean(rangeError)} aria-describedby={rangeError ? `${id}-range-error` : undefined} onChange={(event) => changeDates(event.target.value, to)}/></label><span className="usage-date-divider" aria-hidden="true">—</span><label><span>结束日期（含全天）</span><input type="date" value={to} aria-invalid={Boolean(rangeError)} aria-describedby={rangeError ? `${id}-range-error` : undefined} onChange={(event) => changeDates(from, event.target.value)}/></label></div>
      <label className="usage-project-filter"><span>项目</span><select value={workspaceRoot} onChange={(event) => changeDates(from, to, event.target.value)}><option value="">全部项目</option>{workspaceRoot && !workspaces.some((workspace) => workspace.root === workspaceRoot) && <option value={workspaceRoot}>{workspaceRoot}（未登记）</option>}{workspaces.map((workspace) => <option key={workspace.root} value={workspace.root}>{workspace.name}</option>)}</select></label>
    </div>
    {rangeError && <p className="dash-notice dash-notice-error" role="alert" id={`${id}-range-error`}>{rangeError}</p>}
    <div className="usage-report-status" role="status">{loading ? (report ? '正在刷新，当前显示上次查询结果…' : '正在加载用量报告…') : report ? `${localDateValue(report.from)} — ${localDateValue(report.to)} · 本地日期，结束日含全天` : '尚未收到用量报告'}{preset === 'custom' && <span className="dash-tag">自定义范围</span>}</div>
    {hasMock && <p className="dash-notice dash-notice-demo">包含 Mock 离线演示数据：测试用量不代表真实模型调用或账单。</p>}
    <div className="usage-report-content" aria-busy={loading}>
      <section className="usage-kpi-grid" aria-label="用量概览，10 项指标">{stats.map((stat) => <Kpi key={stat.label} {...stat}/>)}</section>
      <div className="usage-chart-grid">
        <section className="dash-panel usage-trend"><div className="dash-panel-heading"><div><h2>用量趋势</h2><p className="dash-caption">{metric === 'cost' ? costCoverage(totals) : '观察每天的工作节奏'}</p></div><div className="dash-segmented usage-metric-tabs" role="group" aria-label="趋势指标">{(Object.keys(METRICS) as TrendMetric[]).map((key) => <button type="button" key={key} aria-pressed={metric === key} onClick={() => setMetric(key)}>{key === 'cost' ? '成本' : METRICS[key]}</button>)}</div></div><Chart report={report} query={query} metric={metric}/></section>
        <section className="dash-panel usage-activity"><div className="dash-panel-heading"><div><h2>会话活跃</h2><p className="dash-caption">每日去重，不可跨日相加</p></div><span className="usage-panel-number">{formatNumber(totals?.activeSessions)}<small> 个会话</small></span></div><Chart report={report} query={query} metric="sessions"/></section>
      </div>
      <div className="usage-distribution-grid"><Distribution title="模型" groups={report?.models ?? []} available={report !== undefined}/><Distribution title="项目" groups={report?.projects ?? []} available={report !== undefined}/></div>
      <details className="dash-panel usage-daily-details"><summary>每日用量明细 <span>趋势与活跃图的精确数值</span></summary><div className="dash-table-scroll" tabIndex={0} role="region" aria-label="每日用量明细，可横向滚动"><table className="dash-table"><caption>同一筛选结果的按日统计</caption><thead><tr><th scope="col">日期</th><th scope="col">Tokens</th><th scope="col">成本 (USD)</th><th scope="col">请求</th><th scope="col">错误 / 取消</th><th scope="col">活跃会话</th></tr></thead><tbody>{!report?.days.length ? <tr><td colSpan={6} className="dash-table-empty">{report ? '所选范围暂无记录' : '等待用量报告'}</td></tr> : report.days.map((day) => <tr key={day.date}><th scope="row">{day.date}</th><td>{exactNumber(tokenValue(day.totals, 'totalTokens'))}{day.totals.unknownUsageRequests > 0 && <small>{formatNumber(day.totals.unknownUsageRequests)} 次用量未知</small>}</td><td title={day.totals.costUsd === null ? '未提供' : `${exactNumber(day.totals.costUsd)} USD`}>{formatUsd(day.totals.costUsd)}<small>{costCoverage(day.totals)}</small></td><td>{exactNumber(day.totals.requests)}</td><td>{exactNumber(day.totals.errors)} / {exactNumber(day.totals.cancelled)}</td><td>{exactNumber(day.totals.activeSessions)}</td></tr>)}</tbody></table></div></details>
      <ChannelHealth channels={channels} report={report}/>
      <p className="usage-footnote">统计来自当前查询的同一份请求报告。Tokens 为已上报用量；输入已包含缓存。成本为 USD 已知金额（可能采用用户配置单价估算），不是上游账单。余额和配额是独立的手动快照。</p>
    </div>
  </main>;
}
