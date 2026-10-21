import * as fs from 'node:fs';
import * as path from 'node:path';
import { projectHashOf, type Usage } from '@syaocode/core';
import { syaoHome } from './model-config.js';

/**
 * 工作区维度的用量/计费账本（/cost 的数据来源）。
 *
 * 存储：`~/.syaocode/usage/<projectHash>.json`。文件按工作区路径哈希分桶，
 * 桶内再以**工作区绝对路径**为索引，因此哈希碰撞也不会串账；每个工作区累计
 * 请求数、输入/输出/缓存读写 token 与费用，并按 `provider:model` 分模型累计。
 * `/cost` 因此输出的是该工作区**跨会话**的累计值，而非本次会话。
 *
 * 只记录数字与模型名（不含密钥，也不含对话内容）。文件损坏按空账本处理；
 * 写入采用 tmp + rename 原子替换，进程崩溃不会留下半截 JSON。
 * 同一工作区多开时按"读-改-写"合并，极端并发下最后一次写入获胜（本地单用户
 * 场景可接受；与 session 日志的单写者假设一致）。
 */

export interface UsageRecord {
  requests: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
}

export interface ModelUsageRecord extends UsageRecord {
  provider: string;
  model: string;
  firstUsedAt: number;
  updatedAt: number;
}

export interface WorkspaceUsage {
  /** 工作区绝对路径（账本索引） */
  workspace: string;
  createdAt: number;
  updatedAt: number;
  totals: UsageRecord;
  /** `provider:model` → 该模型在本工作区的累计 */
  models: Record<string, ModelUsageRecord>;
}

export interface UsageFile {
  v: 1;
  workspaces: Record<string, WorkspaceUsage>;
}

export function emptyUsage(): UsageRecord {
  return { requests: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 };
}

export function modelUsageKey(provider: string, model: string): string {
  return `${provider}:${model}`;
}

/** 账本文件路径（与 session 存储同样按路径哈希分桶） */
export function usageFilePath(cwd: string, home?: string): string {
  return path.join(syaoHome(home), 'usage', `${projectHashOf(cwd)}.json`);
}

export function emptyWorkspaceUsage(cwd: string, now = Date.now()): WorkspaceUsage {
  return { workspace: cwd, createdAt: now, updatedAt: now, totals: emptyUsage(), models: {} };
}

/** 读取账本桶；缺失/损坏/版本不符时返回空账本（不抛错，不影响会话） */
export function readUsageFile(cwd: string, home?: string): UsageFile {
  try {
    const parsed = JSON.parse(fs.readFileSync(usageFilePath(cwd, home), 'utf8')) as Partial<UsageFile>;
    if (parsed.v !== 1 || typeof parsed.workspaces !== 'object' || parsed.workspaces === null) {
      return { v: 1, workspaces: {} };
    }
    return { v: 1, workspaces: parsed.workspaces };
  } catch {
    return { v: 1, workspaces: {} };
  }
}

/** 从账本桶取某工作区记录（不存在则返回空记录，不落盘） */
export function workspaceUsageOf(file: UsageFile, cwd: string): WorkspaceUsage {
  const found = file.workspaces[cwd];
  if (found === undefined || typeof found !== 'object' || found.totals === undefined) {
    return emptyWorkspaceUsage(cwd);
  }
  return {
    ...found,
    workspace: cwd,
    totals: { ...emptyUsage(), ...found.totals },
    models: found.models ?? {},
  };
}

export function readWorkspaceUsage(cwd: string, home?: string): WorkspaceUsage {
  return workspaceUsageOf(readUsageFile(cwd, home), cwd);
}

export interface RecordUsageOptions {
  /** 本次要计入的请求数（缺省 1；非交互 `-p` 一次运行可能包含多轮请求） */
  requests?: number;
  /** 用户目录（测试注入；缺省 process.env.HOME） */
  home?: string;
  /** 记账时间（测试注入） */
  now?: number;
}

/**
 * 累加一次（或一轮运行）的用量并落盘。返回更新后的工作区账本。
 * 写入失败抛错，由调用方决定是否提示（不应中断会话）。
 */
export function recordUsage(
  cwd: string,
  model: { provider: string; model: string },
  usage: Usage,
  costUsd: number | undefined,
  opts: RecordUsageOptions = {},
): WorkspaceUsage {
  const file = readUsageFile(cwd, opts.home);
  const now = opts.now ?? Date.now();
  const requests = Math.max(1, Math.floor(opts.requests ?? 1));
  const ws = workspaceUsageOf(file, cwd);
  addInto(ws.totals, usage, costUsd, requests);
  ws.updatedAt = now;

  const key = modelUsageKey(model.provider, model.model);
  const existing = ws.models[key];
  const entry: ModelUsageRecord =
    existing ?? { provider: model.provider, model: model.model, firstUsedAt: now, updatedAt: now, ...emptyUsage() };
  addInto(entry, usage, costUsd, requests);
  entry.updatedAt = now;
  ws.models[key] = entry;

  file.workspaces[cwd] = ws;
  writeUsageFile(file, cwd, opts.home);
  return ws;
}

/** 累加一条用量记录（requests 缺省计 1 次） */
export function addInto(rec: UsageRecord, usage: Usage, costUsd: number | undefined, requests = 1): void {
  rec.requests += requests;
  rec.inputTokens += usage.inputTokens;
  rec.outputTokens += usage.outputTokens;
  rec.cacheReadTokens += usage.cacheReadTokens ?? 0;
  rec.cacheWriteTokens += usage.cacheWriteTokens ?? 0;
  rec.costUsd += costUsd ?? 0;
}

/** 原子写入（tmp + rename） */
export function writeUsageFile(file: UsageFile, cwd: string, home?: string): void {
  const target = usageFilePath(cwd, home);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(file, null, 2)}\n`);
  try {
    fs.renameSync(tmp, target);
  } catch (e) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      /* best-effort */
    }
    throw e;
  }
}

/** 面板展示用的总 token 数（与既有 /cost 口径一致：缓存写入单列不计入合计） */
export function totalTokens(rec: UsageRecord): number {
  return rec.inputTokens + rec.outputTokens + rec.cacheReadTokens;
}
