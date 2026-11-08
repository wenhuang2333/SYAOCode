import { useEffect, useId, useState } from 'react';
import type { ChannelInfo, UsageDay, UsageGroup, UsageQuery, UsageReport, UsageTotals, WorkspaceInfo } from '@liwencode/dhp';
import { tv, type Lang } from './i18n-views';

export interface UsagePageProps {
  readonly report: UsageReport | undefined;
  readonly channels: readonly ChannelInfo[];
  readonly workspaces: readonly WorkspaceInfo[];
  readonly query: UsageQuery;
  readonly loading: boolean;
  readonly onQuery: (query: UsageQuery) => void;
  /** 界面语言；默认中文（与桌面端默认一致）。 */
  readonly lang?: Lang | undefined;
}

type TrendMetric = 'tokens' | 'cost' | 'requests';
export type DatePreset = 'today' | '7d' | '30d' | 'custom';
export function metrics(lang: Lang = 'zh'): Readonly<Record<TrendMetric, string>> {
  return { tokens: tv(lang, 'usage.metric.tokens'), cost: tv(lang, 'usage.metric.cost'), requests: tv(lang, 'usage.metric.requests') };
}

/** 中文指标名（默认语言），保留给既有调用方与测试。 */
export const METRICS: Readonly<Record<TrendMetric, string>> = metrics('zh');
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

export function usageQueryForDates(from: string, to: string, workspaceRoot?: string, lang: Lang = 'zh'):
  { readonly ok: true; readonly query: UsageQuery } | { readonly ok: false; readonly error: string } {
  const start = parseLocalDate(from);
  const end = parseLocalDate(to);
  if (!start || !end) return { ok: false, error: tv(lang, 'usage.error.dateRangeRequired') };
  if (start > end) return { ok: false, error: tv(lang, 'usage.error.dateOrder') };
  // Local calendar arithmetic, not +86,400,000: DST days can be 23 or 25 hours.
  end.setDate(end.getDate() + 1);
  end.setMilliseconds(-1);
  return { ok: true, query: { from: start.getTime(), to: end.getTime(), ...(workspaceRoot ? { workspaceRoot } : {}) } };
}

export function presetUsageQuery(preset: Exclude<DatePreset, 'custom'>, workspaceRoot?: string, now = Date.now(), lang: Lang = 'zh'): UsageQuery {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - (preset === 'today' ? 0 : preset === '7d' ? 6 : 29));
  const result = usageQueryForDates(localDateValue(start.getTime()), localDateValue(now), workspaceRoot, lang);
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

export function costCoverage(totals: UsageTotals | undefined, lang: Lang = 'zh'): string {
  if (!totals) return tv(lang, 'usage.coverage.waiting');
  if (totals.requests === 0) return tv(lang, 'usage.coverage.noRequests');
  const known = Math.max(0, totals.requests - totals.unknownCostRequests);
  const state = totals.unknownCostRequests > 0
    ? (known > 0 ? tv(lang, 'usage.coverage.partialKnown') : tv(lang, 'usage.coverage.costUnknown'))
    : tv(lang, 'usage.coverage.known');
  return tv(lang, 'usage.coverage.costLine', {
    state,
    percent: formatPercent(known / totals.requests),
    known: formatNumber(known),
    total: formatNumber(totals.requests),
  });
}

export function cacheCoverage(totals: UsageTotals | undefined, lang: Lang = 'zh'): string {
  if (!totals || totals.requests === 0) return tv(lang, 'usage.coverage.noCache');
  return tv(lang, 'usage.coverage.cacheLine', {
    state: totals.cacheReportedRequests < totals.requests ? tv(lang, 'usage.coverage.cachePartial') : tv(lang, 'usage.coverage.cacheCovered'),
    reported: formatNumber(totals.cacheReportedRequests),
    total: formatNumber(totals.requests),
  });
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

function Chart({ report, query, metric, lang }: {
  report: UsageReport | undefined; query: UsageQuery; metric: TrendMetric | 'sessions'; lang: Lang;
}): React.JSX.Element {
  const id = useId();
  const labels = metrics(lang);
  const title = metric === 'sessions' ? tv(lang, 'usage.chart.dailyActiveSessions') : tv(lang, 'usage.chart.trendOf', { metric: labels[metric] });
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
      <desc id={`${id}-desc`}>{tv(lang, 'usage.chart.desc', { axis: metric === 'sessions' ? tv(lang, 'usage.chart.axisSessions') : labels[metric] })}</desc>
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
        ? <rect key={point.day.date} x={Math.min(width - right - barWidth, Math.max(left, point.x - barWidth / 2))} y={y(point.value)} width={barWidth} height={Math.max(0, y(0) - y(point.value))} rx="3" fill={`url(#${id}-bar)`}><title>{tv(lang, 'usage.chart.pointSessions', { date: point.day.date, value: exactNumber(point.value) })}</title></rect>
        : <circle className="usage-chart-point" key={point.day.date} cx={point.x} cy={y(point.value)} r={points.length > 60 ? 1.8 : 3.5}><title>{metric === 'cost'
          ? tv(lang, 'usage.chart.pointWithCoverage', {
            base: tv(lang, 'usage.chart.pointValue', { date: point.day.date, metric: labels[metric], value: formatUsd(point.value) }),
            coverage: costCoverage(point.day.totals, lang),
          })
          : tv(lang, 'usage.chart.pointValue', { date: point.day.date, metric: labels[metric], value: exactNumber(point.value) })}</title></circle>)}
      {(noRequests || allUnknown || !report) && <text className="usage-chart-empty" x={(left + width - right) / 2} y={top + plotHeight / 2} textAnchor="middle">{!report ? tv(lang, 'usage.chart.emptyWaiting') : noRequests ? tv(lang, 'usage.chart.emptyNoRequests') : tv(lang, 'usage.chart.emptyUnknown')}</text>}
    </svg>
    <div className="usage-chart-legend"><span className="usage-dot usage-dot-accent"/>{metric === 'sessions' ? tv(lang, 'usage.chart.legendSessions') : labels[metric]}<span className="usage-chart-legend-note">{metric === 'cost' ? tv(lang, 'usage.chart.legendCostNote') : tv(lang, 'usage.chart.legendDateNote')}</span></div>
  </div>;
}

function Distribution({ title, groups, available, lang }: {
  title: string; groups: readonly UsageGroup[]; available: boolean; lang: Lang;
}): React.JSX.Element {
  const id = useId();
  const total = groups.reduce((sum, group) => sum + group.totals.totalTokens, 0);
  const circumference = 2 * Math.PI * 65;
  let offset = 0;
  return <section className="dash-panel usage-distribution">
    <div className="dash-panel-heading"><h2>{tv(lang, 'usage.distribution.title', { title })}</h2><span className="dash-caption">{tv(lang, 'usage.distribution.byKnownTokens')}</span></div>
    <div className="usage-distribution-visual">
      <svg className="usage-donut" viewBox="0 0 180 180" role="img" aria-labelledby={`${id}-title`}>
        <title id={`${id}-title`}>{tv(lang, 'usage.distribution.donutTitle', { title, total: available ? exactNumber(total) : tv(lang, 'usage.distribution.notProvided') })}</title>
        <circle className="usage-donut-track" cx="90" cy="90" r="65" fill="none" strokeWidth="18"/>
        {groups.map((group) => {
          const length = total > 0 ? group.totals.totalTokens / total * circumference : 0;
          const start = offset; offset += length;
          return length > 0 ? <circle key={group.id} cx="90" cy="90" r="65" fill="none" strokeWidth="18" stroke={usageGroupColor(group.id)} strokeDasharray={`${length} ${circumference}`} strokeDashoffset={-start} transform="rotate(-90 90 90)"><title>{`${group.name}: ${exactNumber(group.totals.totalTokens)} Tokens`}</title></circle> : null;
        })}
        <text className="usage-donut-value" x="90" y="88" textAnchor="middle">{available ? formatCompact(total) : '—'}</text>
        <text className="usage-donut-label" x="90" y="109" textAnchor="middle">{tv(lang, 'usage.distribution.knownTokens')}</text>
      </svg>
      <ul className="usage-distribution-legend" aria-label={tv(lang, 'usage.distribution.legendAria', { title })}>
        {groups.length === 0 ? <li className="usage-legend-empty">{available ? tv(lang, 'usage.distribution.emptyGroups') : tv(lang, 'usage.distribution.waiting')}</li> : groups.map((group) => <li key={group.id}>
          <span className="usage-dot" style={{ backgroundColor: usageGroupColor(group.id) }}/><span className="usage-legend-name" title={group.name}>{group.name}</span>
          <strong title={exactNumber(group.totals.totalTokens)}>{formatCompact(tokenValue(group.totals, 'totalTokens'))}</strong><span>{formatPercent(total > 0 ? group.totals.totalTokens / total : null)}</span>
        </li>)}
      </ul>
    </div>
    <div className="dash-table-scroll" tabIndex={0} role="region" aria-label={tv(lang, 'usage.distribution.regionAria', { title })}>
      <table className="dash-table"><caption>{tv(lang, 'usage.distribution.caption', { title })}</caption><thead><tr><th scope="col">{title}</th><th scope="col">{tv(lang, 'usage.distribution.tableRequests')}</th><th scope="col">{tv(lang, 'usage.distribution.tableTokens')}</th><th scope="col">{tv(lang, 'usage.distribution.tableCache')}</th><th scope="col">{tv(lang, 'usage.distribution.tableCost')}</th></tr></thead>
        <tbody>{groups.length === 0 ? <tr><td colSpan={5} className="dash-table-empty">{available ? tv(lang, 'usage.distribution.emptyRange') : tv(lang, 'usage.distribution.waiting')}</td></tr> : groups.map((group) => <tr key={group.id}>
          <th scope="row"><span className="usage-table-name"><span className="usage-dot" style={{ backgroundColor: usageGroupColor(group.id) }}/><span title={group.id}>{group.name}</span></span></th>
          <td>{exactNumber(group.totals.requests)}<small>{tv(lang, 'usage.distribution.errorsSuffix', { count: formatNumber(group.totals.errors) })}</small></td>
          <td>{exactNumber(tokenValue(group.totals, 'inputTokens'))} / {exactNumber(tokenValue(group.totals, 'outputTokens'))}{group.totals.unknownUsageRequests > 0 && <small>{tv(lang, 'usage.distribution.unknownUsageSuffix', { count: formatNumber(group.totals.unknownUsageRequests) })}</small>}</td>
          <td>{exactNumber(group.totals.cacheReadTokens)}<small>{cacheCoverage(group.totals, lang)}</small></td>
          <td title={group.totals.costUsd === null ? tv(lang, 'usage.kpi.notProvided') : `${exactNumber(group.totals.costUsd)} USD`}>{formatUsd(group.totals.costUsd)}<small>{costCoverage(group.totals, lang)}</small></td>
        </tr>)}</tbody>
      </table>
    </div>
  </section>;
}

export function channelRequestHealth(totals: UsageTotals | undefined, lang: Lang = 'zh'): { label: string; tone: 'neutral' | 'good' | 'warning' } {
  if (!totals || totals.requests === 0) return { label: tv(lang, 'usage.coverage.healthNoRequests'), tone: 'neutral' };
  if (totals.errors > 0) return { label: tv(lang, 'usage.coverage.healthErrors', { percent: formatPercent(totals.errors / totals.requests) }), tone: 'warning' };
  return { label: tv(lang, 'usage.coverage.healthOk'), tone: 'good' };
}

function snapshotTime(timestamp: number, lang: Lang): string {
  if (!Number.isFinite(timestamp)) return tv(lang, 'usage.health.timeMissing');
  return new Date(timestamp).toLocaleString(lang === 'zh' ? 'zh-CN' : 'en-US', { hour12: false });
}

function ChannelHealth({ channels, report, lang }: {
  channels: readonly ChannelInfo[]; report: UsageReport | undefined; lang: Lang;
}): React.JSX.Element {
  const ids = [...new Set([...channels.map((channel) => channel.id), ...(report?.channels.map((group) => group.id) ?? [])])];
  return <section className="dash-panel usage-health">
    <div className="dash-panel-heading"><div><h2>{tv(lang, 'usage.health.title')}</h2><p className="dash-caption">{tv(lang, 'usage.health.caption')}</p></div><span className="dash-tag">{tv(lang, 'usage.health.tag')}</span></div>
    <div className="usage-health-grid">{ids.length === 0 ? <p className="dash-empty">{tv(lang, 'usage.health.empty')}</p> : ids.map((id) => {
      const channel = channels.find((item) => item.id === id);
      const group = report?.channels.find((item) => item.id === id);
      const health = channelRequestHealth(group?.totals, lang);
      return <article className="usage-channel-card" key={id}>
        <div className="usage-channel-heading"><strong>{channel?.name ?? group?.name ?? id}</strong><span className={`dash-tag dash-tag-${health.tone}`}>{!report ? tv(lang, 'usage.health.waiting') : health.label}</span></div>
        <p className="usage-channel-credential">{channel?.protocol === 'mock' ? <span className="dash-tag dash-tag-demo">{tv(lang, 'usage.health.mockDemo')}</span> : channel ? (channel.credentialReady ? tv(lang, 'usage.health.credentialReady') : tv(lang, 'usage.health.credentialNotReady')) : tv(lang, 'usage.health.historyOnly')}</p>
        <dl className="usage-channel-numbers"><div><dt>{tv(lang, 'usage.health.requests')}</dt><dd>{formatNumber(report ? group?.totals.requests ?? 0 : null)}</dd></div><div><dt>{tv(lang, 'usage.health.errors')}</dt><dd>{formatNumber(report ? group?.totals.errors ?? 0 : null)}</dd></div><div><dt>{tv(lang, 'usage.health.cancelled')}</dt><dd>{formatNumber(report ? group?.totals.cancelled ?? 0 : null)}</dd></div></dl>
        <div className="usage-channel-balance"><span>{tv(lang, 'usage.health.balance')}</span><strong>{channel?.balance ? `${formatNumber(channel.balance.amount)} ${channel.balance.currency}` : tv(lang, 'usage.kpi.notProvided')}</strong></div>
        <p className="usage-snapshot-note">{channel?.balance ? tv(lang, 'usage.health.manualEntry', { time: snapshotTime(channel.balance.updatedAt, lang) }) : tv(lang, 'usage.health.noBillingApi')}</p>
        {channel?.quota ? <div className="usage-quota"><div><span>{tv(lang, 'usage.health.quotaLabel', { unit: channel.quota.unit })}</span><strong>{formatNumber(channel.quota.used)} / {formatNumber(channel.quota.limit)}</strong></div><progress max={channel.quota.limit > 0 ? channel.quota.limit : 1} value={Math.min(channel.quota.used, Math.max(1, channel.quota.limit))} aria-label={tv(lang, 'usage.health.quotaProgressAria', { name: channel.name })}/><p className="usage-snapshot-note">{tv(lang, 'usage.health.recordedAt', { time: snapshotTime(channel.quota.updatedAt, lang) })}{channel.quota.used >= channel.quota.limit ? tv(lang, 'usage.health.atLimit') : ''}{channel.quota.resetsAt !== undefined ? tv(lang, 'usage.health.resetsAt', { time: snapshotTime(channel.quota.resetsAt, lang) }) : ''}</p></div> : <p className="usage-snapshot-note">{tv(lang, 'usage.health.quotaMissing')}</p>}
      </article>;
    })}</div>
  </section>;
}

export function UsagePage({ report, channels, workspaces, query, loading, onQuery, lang = 'zh' }: UsagePageProps): React.JSX.Element {
  const id = useId();
  const labels = metrics(lang);
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
    const result = usageQueryForDates(start, end, root, lang);
    if (!result.ok) { setRangeError(result.error); setPreset('custom'); return; }
    setRangeError(''); setPreset(identifyDatePreset(result.query)); onQuery(result.query);
  };
  const choosePreset = (next: Exclude<DatePreset, 'custom'>): void => {
    const nextQuery = presetUsageQuery(next, workspaceRoot);
    setFrom(localDateValue(nextQuery.from)); setTo(localDateValue(nextQuery.to)); setPreset(next); setRangeError(''); onQuery(nextQuery);
  };
  const totals = report?.totals;
  const tokensNote = totals?.unknownUsageRequests
    ? tv(lang, 'usage.kpi.knownSubtotal', { count: formatNumber(totals.unknownUsageRequests) })
    : tv(lang, 'usage.kpi.inputPlusOutput');
  const hasMock = report?.channels.some((group) => channels.some((channel) => channel.id === group.id && channel.protocol === 'mock')) ?? false;
  const stats = [
    { label: tv(lang, 'usage.kpi.totalTokens'), value: formatCompact(tokenValue(totals, 'totalTokens')), exact: exactNumber(tokenValue(totals, 'totalTokens')), note: tokensNote, symbol: 'Σ', accent: true },
    { label: tv(lang, 'usage.kpi.inputTokens'), value: formatCompact(tokenValue(totals, 'inputTokens')), exact: exactNumber(tokenValue(totals, 'inputTokens')), note: totals?.unknownUsageRequests ? tokensNote : tv(lang, 'usage.kpi.inputIncludesCache'), symbol: '↙' },
    { label: tv(lang, 'usage.kpi.outputTokens'), value: formatCompact(tokenValue(totals, 'outputTokens')), exact: exactNumber(tokenValue(totals, 'outputTokens')), note: totals?.unknownUsageRequests ? tokensNote : tv(lang, 'usage.kpi.outputGenerated'), symbol: '↗' },
    { label: tv(lang, 'usage.kpi.cacheRead'), value: formatCompact(totals?.cacheReadTokens), exact: exactNumber(totals?.cacheReadTokens), note: cacheCoverage(totals, lang), symbol: '▱' },
    { label: tv(lang, 'usage.kpi.cacheHitRate'), value: formatPercent(cacheHitRate(totals)), exact: formatPercent(cacheHitRate(totals)), note: totals && totals.cacheReportedRequests < totals.requests ? tv(lang, 'usage.kpi.cacheIncomplete') : tv(lang, 'usage.kpi.cacheFormula'), symbol: '%' },
    { label: tv(lang, 'usage.kpi.activeSessions'), value: formatNumber(totals?.activeSessions), exact: exactNumber(totals?.activeSessions), note: tv(lang, 'usage.kpi.sessionsNote'), symbol: '◷' },
    { label: tv(lang, 'usage.kpi.activeChannels'), value: formatNumber(totals?.activeChannels), exact: exactNumber(totals?.activeChannels), note: tv(lang, 'usage.kpi.channelsNote'), symbol: '⇄' },
    { label: tv(lang, 'usage.kpi.cost'), value: formatUsd(totals?.costUsd), exact: totals?.costUsd == null ? tv(lang, 'usage.kpi.notProvided') : `${exactNumber(totals.costUsd)} USD`, note: costCoverage(totals, lang), symbol: '$', accent: true },
    { label: tv(lang, 'usage.kpi.requests'), value: formatNumber(totals?.requests), exact: exactNumber(totals?.requests), note: tv(lang, 'usage.kpi.requestsNote', { cancelled: totals ? tv(lang, 'usage.kpi.requestsCancelled', { count: formatNumber(totals.cancelled) }) : '' }), symbol: '⌁' },
    { label: tv(lang, 'usage.kpi.errorRate'), value: formatPercent(totals && totals.requests > 0 ? totals.errors / totals.requests : null), exact: totals ? `${totals.errors}/${totals.requests}` : tv(lang, 'usage.kpi.notProvided'), note: tv(lang, 'usage.kpi.errorsNote'), symbol: '!' },
  ];
  return <main className="usage-page dash-page" aria-labelledby={`${id}-title`}>
    <header className="dash-page-header"><div><p className="dash-eyebrow">{tv(lang, 'usage.header.eyebrow')}</p><h1 id={`${id}-title`}>{tv(lang, 'usage.header.title')}</h1><p className="dash-subtitle">{tv(lang, 'usage.header.subtitle')}</p></div><span className="dash-tag">{tv(lang, 'usage.header.tag')}</span></header>
    <div className="usage-toolbar">
      <div className="dash-segmented" role="group" aria-label={tv(lang, 'usage.toolbar.presetAria')}>{([['today', tv(lang, 'usage.toolbar.today')], ['7d', tv(lang, 'usage.toolbar.last7d')], ['30d', tv(lang, 'usage.toolbar.last30d')]] as const).map(([key, label]) => <button type="button" key={key} aria-pressed={preset === key} onClick={() => choosePreset(key)}>{label}</button>)}</div>
      <div className="usage-date-range"><label><span>{tv(lang, 'usage.toolbar.startDate')}</span><input type="date" value={from} aria-invalid={Boolean(rangeError)} aria-describedby={rangeError ? `${id}-range-error` : undefined} onChange={(event) => changeDates(event.target.value, to)}/></label><span className="usage-date-divider" aria-hidden="true">—</span><label><span>{tv(lang, 'usage.toolbar.endDate')}</span><input type="date" value={to} aria-invalid={Boolean(rangeError)} aria-describedby={rangeError ? `${id}-range-error` : undefined} onChange={(event) => changeDates(from, event.target.value)}/></label></div>
      <label className="usage-project-filter"><span>{tv(lang, 'usage.toolbar.project')}</span><select value={workspaceRoot} onChange={(event) => changeDates(from, to, event.target.value)}><option value="">{tv(lang, 'usage.toolbar.allProjects')}</option>{workspaceRoot && !workspaces.some((workspace) => workspace.root === workspaceRoot) && <option value={workspaceRoot}>{tv(lang, 'usage.toolbar.unregistered', { root: workspaceRoot })}</option>}{workspaces.map((workspace) => <option key={workspace.root} value={workspace.root}>{workspace.name}</option>)}</select></label>
    </div>
    {rangeError && <p className="dash-notice dash-notice-error" role="alert" id={`${id}-range-error`}>{rangeError}</p>}
    <div className="usage-report-status" role="status">{loading
      ? (report ? tv(lang, 'usage.status.refreshing') : tv(lang, 'usage.status.loading'))
      : report
        ? tv(lang, 'usage.status.range', { from: localDateValue(report.from), to: localDateValue(report.to) })
        : tv(lang, 'usage.status.none')}{preset === 'custom' && <span className="dash-tag">{tv(lang, 'usage.status.custom')}</span>}</div>
    {hasMock && <p className="dash-notice dash-notice-demo">{tv(lang, 'usage.mockNotice')}</p>}
    <div className="usage-report-content" aria-busy={loading}>
      <section className="usage-kpi-grid" aria-label={tv(lang, 'usage.aria.kpiGrid')}>{stats.map((stat) => <Kpi key={stat.label} {...stat}/>)}</section>
      <div className="usage-chart-grid">
        <section className="dash-panel usage-trend"><div className="dash-panel-heading"><div><h2>{tv(lang, 'usage.chart.trendTitle')}</h2><p className="dash-caption">{metric === 'cost' ? costCoverage(totals, lang) : tv(lang, 'usage.chart.trendCaption')}</p></div><div className="dash-segmented usage-metric-tabs" role="group" aria-label={tv(lang, 'usage.chart.metricAria')}>{(Object.keys(METRICS) as TrendMetric[]).map((key) => <button type="button" key={key} aria-pressed={metric === key} onClick={() => setMetric(key)}>{key === 'cost' ? tv(lang, 'usage.metric.costShort') : labels[key]}</button>)}</div></div><Chart report={report} query={query} metric={metric} lang={lang}/></section>
        <section className="dash-panel usage-activity"><div className="dash-panel-heading"><div><h2>{tv(lang, 'usage.chart.activityTitle')}</h2><p className="dash-caption">{tv(lang, 'usage.chart.activityCaption')}</p></div><span className="usage-panel-number">{formatNumber(totals?.activeSessions)}<small>{tv(lang, 'usage.chart.sessionUnit')}</small></span></div><Chart report={report} query={query} metric="sessions" lang={lang}/></section>
      </div>
      <div className="usage-distribution-grid"><Distribution title={tv(lang, 'usage.distribution.models')} groups={report?.models ?? []} available={report !== undefined} lang={lang}/><Distribution title={tv(lang, 'usage.distribution.projects')} groups={report?.projects ?? []} available={report !== undefined} lang={lang}/></div>
      <details className="dash-panel usage-daily-details"><summary>{tv(lang, 'usage.daily.summary')} <span>{tv(lang, 'usage.daily.summaryNote')}</span></summary><div className="dash-table-scroll" tabIndex={0} role="region" aria-label={tv(lang, 'usage.daily.regionAria')}><table className="dash-table"><caption>{tv(lang, 'usage.daily.caption')}</caption><thead><tr><th scope="col">{tv(lang, 'usage.daily.columnDate')}</th><th scope="col">{tv(lang, 'usage.daily.columnTokens')}</th><th scope="col">{tv(lang, 'usage.daily.columnCost')}</th><th scope="col">{tv(lang, 'usage.daily.columnRequests')}</th><th scope="col">{tv(lang, 'usage.daily.columnErrors')}</th><th scope="col">{tv(lang, 'usage.daily.columnSessions')}</th></tr></thead><tbody>{!report?.days.length ? <tr><td colSpan={6} className="dash-table-empty">{report ? tv(lang, 'usage.daily.emptyRange') : tv(lang, 'usage.daily.waiting')}</td></tr> : report.days.map((day) => <tr key={day.date}><th scope="row">{day.date}</th><td>{exactNumber(tokenValue(day.totals, 'totalTokens'))}{day.totals.unknownUsageRequests > 0 && <small>{tv(lang, 'usage.distribution.unknownUsageSuffix', { count: formatNumber(day.totals.unknownUsageRequests) })}</small>}</td><td title={day.totals.costUsd === null ? tv(lang, 'usage.kpi.notProvided') : `${exactNumber(day.totals.costUsd)} USD`}>{formatUsd(day.totals.costUsd)}<small>{costCoverage(day.totals, lang)}</small></td><td>{exactNumber(day.totals.requests)}</td><td>{exactNumber(day.totals.errors)} / {exactNumber(day.totals.cancelled)}</td><td>{exactNumber(day.totals.activeSessions)}</td></tr>)}</tbody></table></div></details>
      <ChannelHealth channels={channels} report={report} lang={lang}/>
      <p className="usage-footnote">{tv(lang, 'usage.footnote')}</p>
    </div>
  </main>;
}
