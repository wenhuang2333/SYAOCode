import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { EMPTY_USAGE, type ChannelInfo, type UsageReport, type UsageTotals } from '@syaocode/dhp';
import {
  UsagePage, cacheHitRate, cacheCoverage, channelRequestHealth, costCoverage, formatCompact,
  formatNumber, formatPercent, formatUsd, identifyDatePreset, localDateValue, presetUsageQuery, usageGroupColor, usageQueryForDates,
} from '../src/renderer/usage-page.tsx';
import {
  SettingsPage, createChannelDraft, localDateTimeValue, validateChannelDraft, type ChannelDraft,
} from '../src/renderer/settings-page.tsx';

const totals = (overrides: Partial<UsageTotals> = {}): UsageTotals => ({ ...EMPTY_USAGE, ...overrides });
const channel: ChannelInfo = {
  id: 'provider', name: '我的服务', protocol: 'openai-compatible', baseUrl: 'https://example.com/v1', apiKeyEnv: 'PROVIDER_API_KEY',
  models: [{ id: 'model-a', name: '模型 A', contextWindow: 128000, inputPricePerMillion: 1.2 }],
  credentialReady: true, builtin: false, reasoningLevels: [], balance: null, quota: null,
};
const mock: ChannelInfo = { ...channel, id: 'mock', name: '离线 Mock', protocol: 'mock', builtin: true };
const now = new Date(2026, 10, 6, 14, 23, 45).getTime();
const query = presetUsageQuery('7d', undefined, now);
const report = (overrides: Partial<UsageReport> = {}): UsageReport => ({ ...query, totals: totals(), days: [], models: [], projects: [], channels: [], ...overrides });
const renderUsage = (value: UsageReport | undefined, channels: readonly ChannelInfo[] = [channel]): string => renderToStaticMarkup(createElement(UsagePage, {
  report: value, channels, workspaces: [], query, loading: false, onQuery: () => { throw new Error('Rendering must not query'); },
}));
const validDraft = (): ChannelDraft => createChannelDraft(channel);

function validated(overrides: Partial<ChannelDraft> = {}) {
  const result = validateChannelDraft({ ...validDraft(), ...overrides }, { now });
  if (!result.ok) throw new Error(JSON.stringify(result.errors));
  return result.channel;
}
function invalid(overrides: Partial<ChannelDraft>) {
  const result = validateChannelDraft({ ...validDraft(), ...overrides });
  if (result.ok) throw new Error('Expected invalid draft');
  return result.errors;
}

describe('usage local-date queries', () => {
  it.each([['today', 6], ['7d', 31], ['30d', 8]] as const)('%s includes the full local ending day', (preset, startDay) => {
    const result = presetUsageQuery(preset, '/projects/a', now);
    const start = new Date(result.from); const end = new Date(result.to);
    expect(start.getDate()).toBe(startDay);
    expect(start.getHours()).toBe(0);
    expect(start.getMilliseconds()).toBe(0);
    expect(end.getFullYear()).toBe(2026);
    expect(end.getMonth()).toBe(10);
    expect(end.getDate()).toBe(6);
    expect([end.getHours(), end.getMinutes(), end.getSeconds(), end.getMilliseconds()]).toEqual([23, 59, 59, 999]);
    expect(result.workspaceRoot).toBe('/projects/a');
    expect(identifyDatePreset(result, now)).toBe(preset);
  });
  it('accepts a one-day range and omits an empty project filter', () => {
    const result = usageQueryForDates('2026-11-06', '2026-11-06', '');
    expect(result.ok).toBe(true);
    if (result.ok) { expect(result.query).not.toHaveProperty('workspaceRoot'); expect(result.query.from).toBeLessThan(result.query.to); }
  });
  it.each([
    ['', '2026-11-06'], ['2026-11-07', '2026-11-06'], ['2026-02-30', '2026-03-01'],
    ['2026-13-01', '2026-13-02'], ['2026-1-1', '2026-01-02'], ['invalid', 'invalid'],
  ])('rejects invalid dates %s / %s without a query', (from, to) => {
    const result = usageQueryForDates(from, to);
    expect(result.ok).toBe(false); expect(result).not.toHaveProperty('query');
  });
  it('handles month and year boundaries using calendar dates', () => {
    const result = presetUsageQuery('7d', undefined, new Date(2026, 0, 3, 5).getTime());
    expect(localDateValue(result.from)).toBe('2025-12-28');
    expect(localDateValue(result.to)).toBe('2026-01-03');
  });
  it.each(['2026-03-08', '2026-11-01'])('uses local midnight boundaries on DST transition day %s', (day) => {
    const result = usageQueryForDates(day, day);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const end = new Date(result.query.to);
      expect(localDateValue(result.query.to)).toBe(day);
      expect([end.getHours(), end.getMinutes(), end.getSeconds(), end.getMilliseconds()]).toEqual([23, 59, 59, 999]);
      const nextDay = new Date(result.query.from); nextDay.setDate(nextDay.getDate() + 1);
      expect(result.query.to).toBe(nextDay.getTime() - 1);
    }
  });
  it('recognizes a custom date range', () => {
    expect(identifyDatePreset({ ...query, from: new Date(2020, 0, 1).getTime() }, now)).toBe('custom');
  });
});

describe('usage formatting and honest metric coverage', () => {
  it('distinguishes zero from missing or nonfinite values', () => {
    expect(formatNumber(null)).toBe('—'); expect(formatCompact(undefined)).toBe('—');
    expect(formatNumber(NaN)).toBe('—'); expect(formatUsd(Infinity)).toBe('—');
    expect(formatNumber(0)).toBe('0'); expect(formatUsd(0)).toBe('$0.00');
    expect(formatUsd(null)).toBe('—'); expect(formatPercent(null)).toBe('—'); expect(formatPercent(0)).toBe('0.0%');
    expect(formatUsd(0.000001)).toBe('< $0.0001');
    expect(formatCompact(1234567)).toBe('1.23M');
  });
  it('uses cache as a subset of input without adding it to tokens', () => {
    expect(cacheHitRate(totals({ requests: 2, inputTokens: 100, cacheReadTokens: 60, cacheReportedRequests: 2 }))).toBe(.6);
    expect(cacheHitRate(totals({ requests: 1, inputTokens: 100, cacheReadTokens: 0, cacheReportedRequests: 1 }))).toBe(0);
  });
  it('does not invent a cache denominator when reporting is partial', () => {
    const value = totals({ requests: 3, inputTokens: 100, cacheReadTokens: 60, cacheReportedRequests: 1 });
    expect(cacheHitRate(value)).toBeNull(); expect(cacheCoverage(value)).toBe('部分覆盖 · 1/3 次请求');
    expect(cacheHitRate(totals())).toBeNull();
    expect(cacheHitRate(totals({ requests: 1, inputTokens: 0, cacheReadTokens: 0, cacheReportedRequests: 1 }))).toBeNull();
  });
  it('marks partial cost and zero coverage instead of implying free requests', () => {
    expect(costCoverage(totals({ requests: 4, costUsd: 1, unknownCostRequests: 1 }))).toContain('部分已知 · 覆盖 75.0% (3/4 次)');
    expect(costCoverage(totals({ requests: 4, costUsd: null, unknownCostRequests: 4 }))).toContain('成本未提供 · 覆盖 0.0%');
  });
  it('derives channel health only from requests, separating cancellation', () => {
    expect(channelRequestHealth(undefined).tone).toBe('neutral');
    expect(channelRequestHealth(totals()).label).toBe('暂无请求记录');
    expect(channelRequestHealth(totals({ requests: 4, errors: 1 })).label).toBe('错误率 25.0%');
    expect(channelRequestHealth(totals({ requests: 4, errors: 0, cancelled: 4 })).label).toBe('历史请求无错误');
  });
});

describe('usage static render (not browser/DOM testing)', () => {
  it('renders all ten KPIs and complete empty charts with no random samples', () => {
    const html = renderUsage(report());
    expect(html.match(/class="usage-kpi(?: usage-kpi-accent)?"/g)).toHaveLength(10);
    expect(html.match(/<svg /g)).toHaveLength(4);
    expect(html).toContain('所选范围暂无请求记录'); expect(html).toContain('usage-grid-line');
    expect(html).not.toMatch(/NaN|Infinity|实时余额/);
    expect(html).toContain('凭据已配置 · 未检测连通性');
    expect(html).toContain('账户余额'); expect(html).toContain('未提供');
  });
  it('renders loading/unavailable reports without turning unknown into zero', () => {
    const html = renderUsage(undefined);
    expect(html).toContain('尚未收到用量报告'); expect(html).toContain('等待用量报告');
    expect(html.match(/class="usage-kpi-value"[^>]*>—/g)).toHaveLength(10);
  });
  it('shares the filtered report across cards, charts, groups and health', () => {
    const value = totals({ requests: 4, errors: 1, inputTokens: 12345, outputTokens: 7, totalTokens: 12352, cacheReadTokens: 10, cacheReportedRequests: 2, costUsd: .5, unknownCostRequests: 2, activeSessions: 2, activeChannels: 1 });
    const model = { id: 'historic-model', name: 'Historical Model', totals: value };
    const project = { id: '/project/historical', name: '历史项目', totals: value };
    const html = renderUsage(report({ totals: value, days: [{ date: '2026-11-06', totals: value }], models: [model], projects: [project], channels: [{ id: channel.id, name: channel.name, totals: value }] }));
    expect(html).toContain('Historical Model'); expect(html).toContain('历史项目'); expect(html).toContain('12,345 / 7');
    expect(html).toContain('部分已知 · 覆盖 50.0%'); expect(html).toContain('部分覆盖 · 2/4 次请求');
    expect(html).toContain('上报不完整，无法确定命中率'); expect(html).toContain('错误率 25.0%');
    expect(html.match(new RegExp(usageGroupColor(model.id), 'g'))!.length).toBeGreaterThanOrEqual(3);
  });
  it('marks mock records, snapshots and quota units without claiming live connectivity', () => {
    const configured = { ...mock, balance: { amount: 12.3, currency: 'CNY' as const, source: 'manual' as const, updatedAt: now }, quota: { used: 120, limit: 100, unit: 'requests' as const, updatedAt: now, source: 'manual' as const } };
    const value = totals({ requests: 1 });
    const html = renderUsage(report({ totals: value, channels: [{ id: 'mock', name: 'Mock', totals: value }] }), [configured]);
    expect(html).toContain('包含 Mock 离线演示数据'); expect(html).toContain('离线演示 · Mock');
    expect(html).toContain('12.3 CNY'); expect(html).toContain('手动录入'); expect(html).toContain('非实时');
    expect(html).toContain('120 / 100'); expect(html).toContain('已达额度上限');
  });
  it('renders a historical channel even if removed from current catalog', () => {
    const html = renderUsage(report({ channels: [{ id: 'old', name: '旧渠道', totals: totals({ requests: 1 }) }] }), []);
    expect(html).toContain('旧渠道'); expect(html).toContain('历史渠道 · 当前未配置');
  });
});

describe('settings channel draft validation', () => {
  it('keeps blank balance/quota null and blank prices/capacity absent', () => {
    const model = { ...validDraft().models[0]!, contextWindow: '', inputPricePerMillion: '', outputPricePerMillion: '', cacheReadPricePerMillion: '' };
    const result = validated({ models: [model] });
    expect(result.balance).toBeNull(); expect(result.quota).toBeNull();
    expect(result.models[0]).toEqual({ id: 'model-a', name: '模型 A' });
    expect(JSON.stringify(result)).not.toMatch(/NaN|apiKey"|credentialReady|builtin/);
  });
  it('supports multiple separately configured models and zero prices', () => {
    const first = validDraft().models[0]!;
    const result = validated({ protocol: 'anthropic', models: [first, { ...first, key: 'second', id: 'other-model', name: '第二模型', contextWindow: '200000', inputPricePerMillion: '0', outputPricePerMillion: '3.25', cacheReadPricePerMillion: '0.5' }] });
    expect(result.models).toHaveLength(2);
    expect(result.models[1]).toEqual({ id: 'other-model', name: '第二模型', contextWindow: 200000, inputPricePerMillion: 0, outputPricePerMillion: 3.25, cacheReadPricePerMillion: .5 });
  });
  it.each(['no-number', 'NaN', 'Infinity', '-1', '1e999', '0x10'])('rejects invalid numeric text %s without submitting NaN', (raw) => {
    expect(invalid({ balanceAmount: raw })).toHaveProperty('balanceAmount');
    const model = { ...validDraft().models[0]!, inputPricePerMillion: raw };
    expect(invalid({ models: [model] })).toHaveProperty('models.0.inputPricePerMillion');
  });
  it('requires models, unique IDs, names and integer context capacity', () => {
    expect(invalid({ models: [] })).toHaveProperty('models');
    const model = validDraft().models[0]!;
    expect(invalid({ models: [model, { ...model, key: 'duplicate' }] })['models.1.id']).toBeDefined();
    expect(invalid({ models: [{ ...model, name: '', contextWindow: '1.5' }] })['models.0.contextWindow']).toBeDefined();
  });
  it('records genuine zero balance and over-limit usage with manual timestamps', () => {
    const result = validated({ balanceAmount: '0', balanceCurrency: 'CNY', quotaUsed: '120', quotaLimit: '100', quotaUnit: 'credits', quotaResetsAt: '2026-12-01T09:30' });
    expect(result.balance).toEqual({ amount: 0, currency: 'CNY', updatedAt: now, source: 'manual' });
    expect(result.quota).toEqual({ used: 120, limit: 100, unit: 'credits', updatedAt: now, source: 'manual', resetsAt: new Date(2026, 11, 1, 9, 30).getTime() });
  });
  it('does not coerce incomplete quota fields to zero', () => {
    expect(invalid({ quotaUsed: '5' })).toHaveProperty('quotaLimit');
    expect(invalid({ quotaLimit: '5' })).toHaveProperty('quotaUsed');
    expect(invalid({ quotaUsed: '0', quotaLimit: '0' })).toHaveProperty('quotaLimit');
    expect(invalid({ quotaResetsAt: '2026-12-01T09:30' })).toHaveProperty('quotaUsed');
  });
  it('accepts explicit zero quota usage and an absent reset date', () => {
    const result = validated({ quotaUsed: '0', quotaLimit: '10' });
    expect(result.quota?.used).toBe(0); expect(result.quota).not.toHaveProperty('resetsAt');
  });
  it.each(['2026-02-30T10:00', 'not-a-date', '2026-11-06', '2026-11-06T25:30'])('rejects invalid reset time %s', (value) => {
    expect(invalid({ quotaUsed: '1', quotaLimit: '2', quotaResetsAt: value })).toHaveProperty('quotaResetsAt');
  });
  it('round trips local snapshot time and zero values', () => {
    const draft = createChannelDraft({ ...channel, balance: { amount: 0, currency: 'USD', source: 'manual', updatedAt: now }, quota: { used: 0, limit: 50, unit: 'requests', source: 'manual', updatedAt: now, resetsAt: now } });
    expect(draft.balanceAmount).toBe('0'); expect(draft.quotaUsed).toBe('0'); expect(draft.quotaResetsAt).toBe(localDateTimeValue(now));
  });
  it('rejects duplicate/new reserved IDs and edits to stable existing IDs', () => {
    expect(validateChannelDraft(validDraft(), { channels: [channel] }).ok).toBe(false);
    expect(invalid({ id: 'mock' })).toHaveProperty('id');
    const changed = validateChannelDraft({ ...validDraft(), id: 'renamed' }, { existing: channel });
    expect(changed.ok).toBe(false);
  });
  it('locks built-in Mock protocol and does not manufacture a new mock', () => {
    expect(invalid({ protocol: 'mock' })).toHaveProperty('protocol');
    expect(validateChannelDraft({ ...createChannelDraft(mock), protocol: 'anthropic' }, { existing: mock }).ok).toBe(false);
    const result = validateChannelDraft(createChannelDraft(mock), { existing: mock });
    expect(result.ok).toBe(true);
    if (result.ok) { expect(result.channel.protocol).toBe('mock'); expect(result.channel).not.toHaveProperty('apiKeyEnv'); expect(result.channel).not.toHaveProperty('baseUrl'); }
  });
  it.each(['sk-real-secret-value', 'invalid env', 'x=y', ''])('accepts environment names, not key-like or invalid input %s', (value) => {
    expect(invalid({ apiKeyEnv: value })).toHaveProperty('apiKeyEnv');
  });
  it.each(['http://remote.example/v1', 'https://user:password@example.com', 'https://example.com?api_key=secret', 'https://example.com#secret', 'file:///tmp/model', 'not a URL'])('rejects insecure or credential-bearing URL %s', (value) => {
    expect(invalid({ baseUrl: value })).toHaveProperty('baseUrl');
  });
  it.each(['https://remote.example/v1', 'http://localhost:1234/v1', 'http://127.0.0.1:1234', 'http://[::1]:1234', ''])('accepts supported endpoint %s', (baseUrl) => {
    expect(validated({ baseUrl }).baseUrl).toBe(baseUrl || undefined);
  });
  it('never persists UI credential flags or a secret field', () => {
    const result = validated();
    expect(result.apiKeyEnv).toBe('PROVIDER_API_KEY'); expect(result).not.toHaveProperty('apiKey');
    expect(result).not.toHaveProperty('credentialReady'); expect(result).not.toHaveProperty('reasoningLevels');
  });
});

describe('settings static render (not browser/DOM testing)', () => {
  it('renders multiple editable models, environment guidance and manual snapshot groups', () => {
    const configured = { ...channel, models: [...channel.models, { id: 'model-b', name: '模型 B' }] };
    const html = renderToStaticMarkup(createElement(SettingsPage, { channels: [configured], saving: false, onSave: async () => { throw new Error('Rendering must not save'); } }));
    expect(html).toContain('value="model-a"'); expect(html).toContain('value="model-b"');
    expect(html).toContain('API Key 环境变量名'); expect(html).toContain('重启 Host');
    expect(html).toContain('余额快照'); expect(html).toContain('配额快照');
    expect(html).toContain('只填写变量名'); expect(html).not.toContain('type="password"');
    expect(html).not.toContain('删除渠道'); expect(html).toContain('aria-label="移除模型 2 模型 B"');
  });
  it('only offers real protocols on a new channel and keeps ID editable', () => {
    const html = renderToStaticMarkup(createElement(SettingsPage, { channels: [], saving: false, onSave: async () => {} }));
    expect(html).toContain('创建渠道'); expect(html).not.toContain('value="mock"'); expect(html).not.toContain('readOnly=""');
  });
  it('locks builtin mock protocol and disables the fieldset during external saving', () => {
    const html = renderToStaticMarkup(createElement(SettingsPage, { channels: [mock], saving: true, onSave: async () => {} }));
    expect(html).toContain('离线演示'); expect(html).toContain('class="settings-form-fields" disabled=""');
    expect(html).toMatch(/<select[^>]*disabled=""[^>]*>.*value="mock"/);
    expect(html).toContain('正在保存…');
  });
});
