import { randomUUID } from 'node:crypto';
import type { ModelRequest, Provider, Usage } from '@syaocode/core';
import { EMPTY_USAGE, type ChannelModel, type ContextInfo, type UsageGroup, type UsageQuery, type UsageRecord, type UsageReport, type UsageTotals } from '@syaocode/dhp';

export const UNKNOWN_CONTEXT: ContextInfo = { usedTokens: null, capacity: null, capacitySource: 'unknown', source: 'unknown', segments: [], capturedAt: null, compression: 'unsupported' };
export function dayKey(at: number): string {
  const d = new Date(at);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
export function totals(records: readonly UsageRecord[]): UsageTotals {
  const inputTokens = records.reduce((n, r) => n + (r.inputTokens ?? 0), 0);
  const outputTokens = records.reduce((n, r) => n + (r.outputTokens ?? 0), 0);
  const knownCost = records.filter((r) => r.costUsd !== null);
  const knownCache = records.filter((r) => r.cacheReadTokens !== null);
  return {
    ...EMPTY_USAGE, requests: records.length,
    errors: records.filter((r) => r.status === 'error').length, cancelled: records.filter((r) => r.status === 'cancelled').length,
    inputTokens, outputTokens, totalTokens: inputTokens + outputTokens,
    cacheReadTokens: knownCache.length ? knownCache.reduce((n, r) => n + r.cacheReadTokens!, 0) : null,
    costUsd: knownCost.length ? knownCost.reduce((n, r) => n + r.costUsd!, 0) : null,
    unknownCostRequests: records.length - knownCost.length,
    unknownUsageRequests: records.filter((r) => r.inputTokens === null || r.outputTokens === null).length,
    cacheReportedRequests: knownCache.length,
    activeSessions: new Set(records.map((r) => r.sessionId)).size, activeChannels: new Set(records.map((r) => r.channelId)).size,
    durationMs: records.reduce((n, r) => n + Math.max(0, r.endedAt - r.startedAt), 0),
  };
}
export function queryUsage(ledger: readonly UsageRecord[], query: UsageQuery, names: { projects?: ReadonlyMap<string, string>; channels?: ReadonlyMap<string, string> } = {}): UsageReport {
  const records = ledger.filter((r) => r.startedAt >= query.from && r.startedAt <= query.to && (query.workspaceRoot === undefined || r.workspaceRoot === query.workspaceRoot));
  const group = (key: (r: UsageRecord) => string, labels?: ReadonlyMap<string, string>): UsageGroup[] => {
    const groups = new Map<string, UsageRecord[]>();
    for (const r of records) { const id = key(r); const list = groups.get(id) ?? []; list.push(r); groups.set(id, list); }
    return [...groups].map(([id, rs]) => ({ id, name: labels?.get(id) ?? id, totals: totals(rs) }));
  };
  const days = [];
  const byDay = new Map<string, UsageRecord[]>();
  for (const r of records) { const key = dayKey(r.startedAt); const list = byDay.get(key) ?? []; list.push(r); byDay.set(key, list); }
  const end = new Date(query.to); end.setHours(0, 0, 0, 0);
  const date = new Date(query.from); date.setHours(0, 0, 0, 0);
  for (; date.getTime() <= end.getTime(); date.setDate(date.getDate() + 1)) {
    const key = dayKey(date.getTime());
    days.push({ date: key, totals: totals(byDay.get(key) ?? []) });
  }
  return { from: query.from, to: query.to, totals: totals(records), days, models: group((r) => r.model), projects: group((r) => r.workspaceRoot, names.projects), channels: group((r) => r.channelId, names.channels) };
}
export function captureContext(req: ModelRequest, provider: Provider, model: ChannelModel): ContextInfo {
  const estimate = (s: string): number => Math.ceil(Buffer.byteLength(s, 'utf8') / 4);
  const segments = [
    { name: 'system', tokens: estimate(req.system ?? '') },
    { name: 'messages', tokens: estimate(JSON.stringify(req.messages)) },
    { name: 'tools', tokens: req.tools ? estimate(JSON.stringify(req.tools)) : 0 },
  ];
  const cap = provider.capabilities(req.model).contextWindow;
  const adapterCap = Number.isFinite(cap) && cap > 0 ? cap : null;
  return { usedTokens: segments.reduce((n, s) => n + s.tokens, 0), capacity: model.contextWindow ?? adapterCap,
    capacitySource: model.contextWindow !== undefined ? 'configured' : adapterCap === null ? 'unknown' : 'adapter',
    source: 'estimated', segments, capturedAt: Date.now(), compression: 'unsupported' };
}

export interface ObservedUsage {
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens?: number | null;
  costUsd?: number | null;
}
const numberOrNull = (n: unknown): number | null => typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : null;
export function normalizedUsage(u: Usage | undefined): ObservedUsage {
  return { inputTokens: numberOrNull(u?.inputTokens), outputTokens: numberOrNull(u?.outputTokens), cacheReadTokens: numberOrNull(u?.cacheReadTokens), cacheWriteTokens: numberOrNull(u?.cacheWriteTokens), costUsd: numberOrNull(u?.costUsd) };
}
export function pricedCost(u: ObservedUsage, model: ChannelModel): number | null {
  if (u.costUsd !== null && u.costUsd !== undefined) return u.costUsd;
  if (u.inputTokens === null || u.outputTokens === null || model.inputPricePerMillion === undefined || model.outputPricePerMillion === undefined) return null;
  // No cache-write price in the fixed DTO: don't misprice cache creation.
  if ((u.cacheWriteTokens ?? 0) > 0) return null;
  if (model.cacheReadPricePerMillion !== undefined && u.cacheReadTokens === null) return null;
  if (u.cacheReadTokens !== null && u.cacheReadTokens > u.inputTokens) return null;
  const cached = model.cacheReadPricePerMillion !== undefined ? (u.cacheReadTokens ?? 0) : 0;
  const cost = ((u.inputTokens - cached) * model.inputPricePerMillion + cached * (model.cacheReadPricePerMillion ?? 0) + u.outputTokens * model.outputPricePerMillion) / 1e6;
  return Number.isFinite(cost) ? cost : null;
}

/** Installed beneath the kernel retry wrapper: every attempt is one request. */
export function observeProvider(provider: Provider, opts: {
  sessionId: string; workspaceRoot: string; channelId: string; model: ChannelModel;
  onContext(context: ContextInfo): void;
  onUsage(record: UsageRecord): Promise<void>;
  /** Adapter wire observation avoids treating its initialized zero counters as reports. */
  wireUsage?: () => ObservedUsage;
}): Provider {
  return {
    id: provider.id, capabilities: (model) => provider.capabilities(model),
    ...(provider.countTokens ? { countTokens: provider.countTokens.bind(provider) } : {}),
    async *stream(req, args) {
      const startedAt = Date.now();
      const identity = { id: `req_${randomUUID()}`, sessionId: opts.sessionId, workspaceRoot: opts.workspaceRoot, channelId: opts.channelId, model: `${opts.channelId}:${req.model}`, startedAt };
      let status: UsageRecord['status'] = 'error';
      let usage: Usage | undefined;
      try {
        opts.onContext(captureContext(req, provider, opts.model));
        // A crash leaves a cancelled, unknown record, never an operation to replay.
        await opts.onUsage({ ...identity, endedAt: startedAt, status: 'cancelled', inputTokens: null, outputTokens: null, cacheReadTokens: null, costUsd: null });
        for await (const event of provider.stream(req, args)) {
          if (event.type === 'usage') usage = { ...event.usage };
          if (event.type === 'message_stop') status = event.stopReason === 'error' ? 'error' : 'ok';
          yield event;
        }
      } catch (e) {
        status = 'error';
        throw e;
      } finally {
        if (args.signal.aborted) status = 'cancelled';
        const u = opts.wireUsage ? opts.wireUsage() : normalizedUsage(usage);
        await opts.onUsage({ ...identity, endedAt: Math.max(startedAt, Date.now()), status, inputTokens: u.inputTokens, outputTokens: u.outputTokens, cacheReadTokens: u.cacheReadTokens, costUsd: pricedCost(u, opts.model) });
      }
    },
  };
}
