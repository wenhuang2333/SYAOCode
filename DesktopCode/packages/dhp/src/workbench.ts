import type { SessionSummary } from './methods.ts';
import type { RunState } from './projection.ts';
import type { Artifact, ChangesCoverage, FileChange, SourceRef } from './features.ts';

export const WorkbenchMethod = {
  Overview: 'desktop/overview',
  SessionInspect: 'session/inspect',
  SessionConfigure: 'session/configure',
  SessionArchive: 'session/archive',
  ChannelSave: 'channel/save',
  UsageQuery: 'usage/query',
} as const;

export type DesktopPermissionMode = 'plan' | 'strict' | 'default' | 'acceptEdits' | 'bypass';
export type ChannelProtocol = 'mock' | 'openai-compatible' | 'anthropic';

export interface WorkspaceInfo {
  readonly id: string;
  readonly name: string;
  readonly root: string;
  readonly addedAt: number;
}

export interface DesktopSessionSummary extends SessionSummary {
  readonly workspaceRoot: string;
  readonly model: string;
  readonly permissionMode: string;
  readonly runState: RunState;
  readonly archived: boolean;
}

export interface ChannelModel {
  readonly id: string;
  readonly name: string;
  readonly contextWindow?: number;
  readonly inputPricePerMillion?: number;
  readonly outputPricePerMillion?: number;
  readonly cacheReadPricePerMillion?: number;
}

export interface BalanceSnapshot {
  readonly amount: number;
  readonly currency: 'USD' | 'CNY';
  readonly updatedAt: number;
  readonly source: 'manual';
}

export interface QuotaSnapshot {
  readonly used: number;
  readonly limit: number;
  readonly unit: 'tokens' | 'requests' | 'credits';
  readonly resetsAt?: number;
  readonly updatedAt: number;
  readonly source: 'manual';
}

export interface ChannelConfig {
  readonly id: string;
  readonly name: string;
  readonly protocol: ChannelProtocol;
  readonly baseUrl?: string;
  readonly apiKeyEnv?: string;
  readonly models: readonly ChannelModel[];
  readonly balance?: BalanceSnapshot | null;
  readonly quota?: QuotaSnapshot | null;
}

export interface ChannelInfo extends ChannelConfig {
  readonly credentialReady: boolean;
  readonly builtin: boolean;
  readonly reasoningLevels: readonly string[];
}

export interface UsageTotals {
  readonly requests: number;
  readonly errors: number;
  readonly cancelled: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number | null;
  readonly totalTokens: number;
  readonly costUsd: number | null;
  readonly unknownCostRequests: number;
  readonly unknownUsageRequests: number;
  readonly cacheReportedRequests: number;
  readonly activeSessions: number;
  readonly activeChannels: number;
  readonly durationMs: number;
}

export interface UsageRecord {
  readonly id: string;
  readonly sessionId: string;
  readonly workspaceRoot: string;
  readonly channelId: string;
  readonly model: string;
  readonly startedAt: number;
  readonly endedAt: number;
  readonly status: 'ok' | 'error' | 'cancelled';
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly cacheReadTokens: number | null;
  readonly costUsd: number | null;
}

export interface UsageGroup {
  readonly id: string;
  readonly name: string;
  readonly totals: UsageTotals;
}

export interface UsageDay {
  readonly date: string;
  readonly totals: UsageTotals;
}

export interface UsageQuery {
  readonly from: number;
  readonly to: number;
  readonly workspaceRoot?: string;
}

export interface UsageReport {
  readonly from: number;
  readonly to: number;
  readonly totals: UsageTotals;
  readonly days: readonly UsageDay[];
  readonly models: readonly UsageGroup[];
  readonly projects: readonly UsageGroup[];
  readonly channels: readonly UsageGroup[];
}

export interface ContextInfo {
  readonly usedTokens: number | null;
  readonly capacity: number | null;
  readonly capacitySource: 'configured' | 'adapter' | 'unknown';
  readonly source: 'estimated' | 'unknown';
  readonly segments: readonly { readonly name: string; readonly tokens: number }[];
  readonly capturedAt: number | null;
  readonly compression: 'unsupported';
}

export interface ResourceInfo {
  readonly id: 'mcp' | 'skills' | 'agents' | 'checkpoints';
  readonly name: string;
  readonly supported: boolean;
  readonly detail: string;
}

export interface SessionInspection {
  readonly sessionId: string;
  readonly totals: UsageTotals;
  readonly context: ContextInfo;
  readonly resources: readonly ResourceInfo[];
  /** 新增（27 §5.4）：会话口径的改动文件与行数。 */
  readonly changes: readonly FileChange[];
  /** 新增：产出清单。 */
  readonly artifacts: readonly Artifact[];
  /** 新增：参考来源。 */
  readonly sources: readonly SourceRef[];
  /** 新增：改动统计的覆盖范围说明（诚实降级）。 */
  readonly coverage: ChangesCoverage;
}

export interface DesktopOverview {
  readonly workspaces: readonly WorkspaceInfo[];
  readonly sessions: readonly DesktopSessionSummary[];
  readonly channels: readonly ChannelInfo[];
  readonly today: UsageTotals;
}

export interface SessionConfigureParams {
  readonly commandId: string;
  readonly baseRevision: number;
  readonly sessionId: string;
  readonly model?: string;
  readonly permissionMode?: DesktopPermissionMode;
}

export const EMPTY_USAGE: UsageTotals = {
  requests: 0, errors: 0, cancelled: 0, inputTokens: 0, outputTokens: 0,
  cacheReadTokens: null, totalTokens: 0, costUsd: null, unknownCostRequests: 0,
  unknownUsageRequests: 0, cacheReportedRequests: 0, activeSessions: 0,
  activeChannels: 0, durationMs: 0,
};
