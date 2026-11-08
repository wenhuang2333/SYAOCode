import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Message } from '@liwencode/core';
import type {
  AgentGroup,
  Artifact,
  ChannelConfig,
  ChangesCoverage,
  ContextInfo,
  FileChange,
  GitAuthMethod,
  SessionSnapshot,
  SourceRef,
  UsageRecord,
  WorkspaceInfo,
} from '@liwencode/dhp';
import { channelSchema, modelSpecSchema, nonnegative, permissionSchema, timestamp, titleSchema, z } from './workbench-validation.ts';

/**
 * 已接受排队、尚未注入的 steer（`28` §4 崩溃恢复）。
 *
 * 只用于"Host 重启后补一条 `steer.not_consumed`（reason `host_restarted`）"，
 * **绝不**用于自动重放：steer 文本的唯一真相是内核注入的那条 user 消息。
 */
export interface PendingSteer {
  id: string;
  text: string;
}

export interface SavedSession {
  snapshot: SessionSnapshot;
  messages: Message[];
  turn: number;
  archived: boolean;
  /** 排队中的 steer。旧状态文件没有该字段 → 缺省视为空（不阻塞迁移）。 */
  pendingSteers?: PendingSteer[];
}

/** MCP 服务的**持久化**部分：状态（ready/error）是运行时的，不落盘。 */
export interface McpServerRecord {
  id: string;
  name: string;
  transport: 'stdio' | 'http';
  command: string | null;
  args: string[];
  url: string | null;
  /** 只存环境变量**名**；值来自 Host 启动环境，绝不落盘（`27` §12 红线 1）。 */
  envNames: string[];
  trusted: boolean;
  createdAt: number;
}

/** 远端绑定：URL 已剥离内嵌凭据。 */
export interface GitRemoteRecord {
  name: string;
  url: string;
  addedAt: number;
}

/**
 * 登录状态的**元信息**。
 *
 * `keychainEntry` 只是钥匙串条目的标识名；令牌、口令、私钥内容**永远不在这里**。
 */
export interface GitAuthRecord {
  method: GitAuthMethod;
  configured: boolean;
  account: string | null;
  scope: string[];
  keyFingerprint: string | null;
  keychainEntry: string | null;
  updatedAt: number;
}

/**
 * `!` 前缀直接执行命令的审计记录（`27` §4.4）。
 *
 * 与 Git 审计**分开存**：两者是不同的操作面，混表会让"谁改了我仓库"查不清。
 * 同样不含任何凭据值。
 */
export interface CommandAuditRecord {
  at: number;
  sessionId: string;
  workspaceRoot: string;
  command: string;
  result: 'success' | 'failed' | 'denied';
  exitCode: number | null;
  detail: string;
}

/** 写操作与上传的审计记录（成功与失败都记，不含任何凭据）。 */
export interface GitAuditRecord {
  at: number;
  workspaceRoot: string;
  action: string;
  detail: string;
  result: 'success' | 'failed';
  code: number | null;
}

export interface DesktopState {
  version: 2;
  workspaces: WorkspaceInfo[];
  sessions: SavedSession[];
  channels: ChannelConfig[];
  ledger: UsageRecord[];
  contexts: Record<string, ContextInfo>;
  defaults: { model?: string; permissionMode?: string; language?: 'en' | 'zh' };
  // ── v2 新增（`27` §5.5）──────────────────────────────────────────────
  changes: Record<string, FileChange[]>;
  artifacts: Record<string, Artifact[]>;
  sources: Record<string, SourceRef[]>;
  coverage: Record<string, ChangesCoverage>;
  mcp: McpServerRecord[];
  agentGroups: AgentGroup[];
  agentActive: string | null;
  gitRemotes: Record<string, GitRemoteRecord[]>;
  gitAuth: Record<string, GitAuthRecord>;
  gitAudit: GitAuditRecord[];
  commandAudit: CommandAuditRecord[];
}

const image = z.union([
  z.object({ type: z.literal('base64'), mediaType: z.string(), data: z.string() }).strict(),
  z.object({ type: z.literal('url'), url: z.string() }).strict(),
]);
const text = z.object({ type: z.literal('text'), text: z.string() }).strict();
const imageBlock = z.object({ type: z.literal('image'), source: image }).strict();
const message = z.object({
  id: z.string(), role: z.enum(['user', 'assistant']),
  content: z.array(z.union([
    text, imageBlock,
    z.object({ type: z.literal('thinking'), text: z.string(), signature: z.string().optional(), redacted: z.boolean().optional() }).strict(),
    z.object({ type: z.literal('tool_use'), id: z.string(), name: z.string(), input: z.unknown() }).strict(),
    z.object({ type: z.literal('tool_result'), toolUseId: z.string(), content: z.array(z.union([text, imageBlock])), isError: z.boolean().optional(), trust: z.enum(['trusted', 'untrusted']).optional() }).strict(),
  ])),
  // `steerId`：由内核 steer 通道注入的用户消息（`28` §3.3）。落盘必须能读回，否则重启丢历史。
  meta: z.object({ createdAt: timestamp, providerData: z.unknown().optional(), steerId: z.string().optional() }).strict().optional(),
}).strict();
const rowBase = z.object({ key: z.string(), seq: nonnegative.int() });
const row = z.union([
  rowBase.extend({ kind: z.literal('message'), role: z.enum(['user', 'assistant']), text: z.string(), final: z.boolean(), stopReason: z.string().optional() }).strict(),
  rowBase.extend({ kind: z.literal('thinking'), text: z.string(), final: z.boolean(), collapsed: z.boolean() }).strict(),
  rowBase.extend({ kind: z.literal('toolCall'), callId: z.string(), name: z.string(), input: z.unknown(), state: z.enum(['proposed', 'running', 'ok', 'error']), progress: z.string().optional(), resultText: z.string().optional(), resultBlocks: nonnegative.optional(), durationMs: nonnegative.optional() }).strict(),
  rowBase.extend({ kind: z.literal('marker'), tone: z.enum(['info', 'warn', 'error', 'success']), text: z.string() }).strict(),
  // steer 过程行（`28` §5）：重启后必须能原样读回三种状态，否则会丢"未注入原因"。
  rowBase.extend({ kind: z.literal('steer'), steerId: z.string().min(1), text: z.string(), state: z.enum(['queued', 'consumed', 'notConsumed']), reason: z.string().optional(), turn: nonnegative.int().optional() }).strict(),
]);
const pending = z.object({
  id: z.string(), kind: z.enum(['permission', 'question', 'plan']), createdAt: timestamp, expiresAt: timestamp.optional(), sessionId: z.string(),
  subject: z.string(), risk: z.enum(['read', 'write', 'exec']),
  preview: z.object({ type: z.enum(['diff', 'command', 'path', 'text']), text: z.string() }).strict().optional(),
  options: z.array(z.object({ id: z.string(), label: z.string(), scope: z.enum(['once', 'session', 'project', 'deny']) }).strict()),
  explain: z.string().optional(), sensitive: z.boolean().optional(),
}).strict();
const pendingSteerSchema = z.object({ id: z.string().min(1), text: z.string().min(1).max(10_000) }).strict();
const snapshot = z.object({
  meta: z.object({ sessionId: z.string().min(1), title: titleSchema, createdAt: timestamp, updatedAt: timestamp, model: modelSpecSchema, permissionMode: permissionSchema, workspaceRoot: z.string().min(1) }).strict(),
  rows: z.array(row), seq: nonnegative.int(), epoch: nonnegative.int().positive(), revision: nonnegative.int(),
  pendingInteractions: z.array(pending), runState: z.enum(['idle', 'streaming', 'awaiting-approval', 'stopping']),
}).strict();
const contextSchema = z.object({
  usedTokens: nonnegative.nullable(), capacity: nonnegative.positive().nullable(), capacitySource: z.enum(['configured', 'adapter', 'unknown']),
  source: z.enum(['estimated', 'unknown']), segments: z.array(z.object({ name: z.string(), tokens: nonnegative }).strict()),
  capturedAt: timestamp.nullable(), compression: z.literal('unsupported'),
}).strict();

// ── v2 新增集合的严格 schema ──────────────────────────────────────────────

const fileChangeSchema = z.object({
  path: z.string().min(1),
  status: z.enum(['added', 'modified', 'deleted', 'renamed']),
  added: nonnegative.int().nullable(),
  removed: nonnegative.int().nullable(),
  stat: z.enum(['exact', 'unavailable']),
  tool: z.string(),
  updatedAt: timestamp,
}).strict().refine((v) => (v.stat === 'unavailable' ? v.added === null && v.removed === null : true), {
  message: 'unavailable stats must not carry line numbers',
});
const artifactSchema = z.object({
  id: z.string().min(1), path: z.string().min(1), name: z.string().min(1),
  kind: z.enum(['file', 'image', 'patch', 'report', 'archive']),
  sizeBytes: nonnegative.nullable(), tool: z.string(), createdAt: timestamp,
}).strict();
const sourceSchema = z.object({
  id: z.string().min(1), title: z.string(), url: z.string(), domain: z.string(),
  count: nonnegative.int().positive(), tool: z.string(),
  trust: z.enum(['verified', 'extracted', 'declared']), verified: z.boolean(),
}).strict().refine((v) => (v.trust === 'verified' ? v.verified : true), { message: 'unverified sources must not claim verified' });
const coverageSchema = z.object({ exact: z.boolean(), bashUsed: z.boolean(), note: z.string().nullable() }).strict();
const mcpServerSchema = z.object({
  id: z.string().min(1), name: z.string().min(1), transport: z.enum(['stdio', 'http']),
  command: z.string().nullable(), args: z.array(z.string()), url: z.string().nullable(),
  envNames: z.array(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/)), trusted: z.boolean(), createdAt: timestamp,
}).strict();
const agentGroupSchema = z.object({
  name: z.string().min(1), roles: z.object({ hyaki: modelSpecSchema, sota: modelSpecSchema, common: modelSpecSchema }).strict(),
  active: z.boolean(), createdAt: timestamp, updatedAt: timestamp,
}).strict();
const gitRemoteSchema = z.object({ name: z.string().min(1), url: z.string().min(1), addedAt: timestamp }).strict();
const gitAuthSchema = z.object({
  method: z.enum(['oauth', 'ssh-agent', 'ssh-key', 'token', 'none']),
  configured: z.boolean(), account: z.string().nullable(), scope: z.array(z.string()),
  keyFingerprint: z.string().nullable(), keychainEntry: z.string().nullable(), updatedAt: timestamp,
}).strict();
const commandAuditSchema = z.object({
  at: timestamp, sessionId: z.string().min(1), workspaceRoot: z.string().min(1), command: z.string(),
  result: z.enum(['success', 'failed', 'denied']), exitCode: z.number().int().nullable(), detail: z.string(),
}).strict();
const gitAuditSchema = z.object({
  at: timestamp, workspaceRoot: z.string().min(1), action: z.string().min(1), detail: z.string(),
  result: z.enum(['success', 'failed']), code: z.number().int().nullable(),
}).strict();

const sharedShape = {
  workspaces: z.array(z.object({ id: z.string(), name: z.string(), root: z.string().refine(path.isAbsolute), addedAt: timestamp }).strict()),
  sessions: z.array(z.object({ snapshot, messages: z.array(message), turn: nonnegative.int(), archived: z.boolean(), pendingSteers: z.array(pendingSteerSchema).optional() }).strict()),
  channels: z.array(channelSchema),
  ledger: z.array(z.object({ id: z.string(), sessionId: z.string(), workspaceRoot: z.string(), channelId: z.string(), model: z.string(), startedAt: timestamp, endedAt: timestamp, status: z.enum(['ok', 'error', 'cancelled']), inputTokens: nonnegative.nullable(), outputTokens: nonnegative.nullable(), cacheReadTokens: nonnegative.nullable(), costUsd: nonnegative.nullable() }).strict().refine((r) => r.endedAt >= r.startedAt)),
  contexts: z.record(contextSchema),
  defaults: z.object({ model: modelSpecSchema.optional(), permissionMode: permissionSchema.optional(), language: z.enum(['en', 'zh']).optional() }).strict(),
} as const;

const identityCheck = (s: { workspaces: readonly { root: string; id: string }[]; sessions: readonly { snapshot: { meta: { sessionId: string; workspaceRoot: string } } }[]; channels: readonly { id: string }[]; ledger: readonly { id: string }[] }, ctx: z.RefinementCtx): void => {
  const unique = (ids: string[]): boolean => new Set(ids).size === ids.length;
  if (!unique(s.workspaces.map((w) => w.root)) || !unique(s.workspaces.map((w) => w.id)) ||
      !unique(s.sessions.map((x) => x.snapshot.meta.sessionId)) || !unique(s.channels.map((c) => c.id)) || !unique(s.ledger.map((r) => r.id)) ||
      s.sessions.some((x) => !s.workspaces.some((w) => w.root === x.snapshot.meta.workspaceRoot))) {
    ctx.addIssue({ code: 'custom', message: 'invalid state identities' });
  }
};

/** v1 结构（只用于迁移读取；新代码不要写入 v1）。 */
const v1Schema = z.object({ version: z.literal(1), ...sharedShape }).strict().superRefine(identityCheck);

const v2Schema = z.object({
  version: z.literal(2),
  ...sharedShape,
  changes: z.record(z.array(fileChangeSchema)),
  artifacts: z.record(z.array(artifactSchema)),
  sources: z.record(z.array(sourceSchema)),
  coverage: z.record(coverageSchema),
  mcp: z.array(mcpServerSchema),
  agentGroups: z.array(agentGroupSchema),
  agentActive: z.string().nullable(),
  gitRemotes: z.record(z.array(gitRemoteSchema)),
  gitAuth: z.record(gitAuthSchema),
  gitAudit: z.array(gitAuditSchema),
  commandAudit: z.array(commandAuditSchema),
}).strict().superRefine((s, ctx) => {
  identityCheck(s, ctx);
  const groupNames = s.agentGroups.map((g) => g.name);
  if (new Set(groupNames).size !== groupNames.length) ctx.addIssue({ code: 'custom', message: 'duplicate agent group names' });
  if (s.agentActive !== null && !groupNames.includes(s.agentActive)) ctx.addIssue({ code: 'custom', message: 'active agent group is not defined' });
  if (s.agentGroups.filter((g) => g.active).length > 1) ctx.addIssue({ code: 'custom', message: 'more than one active agent group' });
});

/** 空 v2 状态（新装 + v1 迁移共用）。 */
function emptyState(): DesktopState {
  return {
    version: 2,
    workspaces: [], sessions: [], channels: [], ledger: [], contexts: {}, defaults: {},
    changes: {}, artifacts: {}, sources: {}, coverage: {},
    mcp: [], agentGroups: [], agentActive: null,
    gitRemotes: {}, gitAuth: {}, gitAudit: [], commandAudit: [],
  };
}

/** v1 → v2：补齐默认空集合，**不删除 v1 原文件**（`27` §5.5 / Q6）。 */
export function migrateV1ToV2(v1: z.infer<typeof v1Schema>): DesktopState {
  const base = emptyState();
  return {
    ...base,
    workspaces: v1.workspaces as WorkspaceInfo[],
    sessions: v1.sessions as SavedSession[],
    channels: v1.channels as ChannelConfig[],
    ledger: v1.ledger as UsageRecord[],
    contexts: v1.contexts as Record<string, ContextInfo>,
    defaults: v1.defaults as DesktopState['defaults'],
  };
}

/** Repair incomplete tool exchanges without executing any old action. */
export function repairHistory(messages: readonly Message[]): Message[] {
  const output: Message[] = [];
  for (let i = 0; i < messages.length; i++) {
    const m = structuredClone(messages[i]!);
    output.push(m);
    if (m.role !== 'assistant') continue;
    const next = messages[i + 1];
    const answered = new Set(next?.role === 'user' ? next.content.flatMap((b) => b.type === 'tool_result' ? [b.toolUseId] : []) : []);
    const missing = m.content.filter((b) => b.type === 'tool_use' && !answered.has(b.id));
    if (!missing.length) continue;
    const results: Message['content'] = missing.map((b) => ({ type: 'tool_result', toolUseId: b.type === 'tool_use' ? b.id : '', isError: true, content: [{ type: 'text', text: 'Interrupted by Host shutdown; action was not replayed.' }] }));
    if (next?.role === 'user') {
      output.push({ ...structuredClone(next), content: [...results, ...structuredClone(next.content)] });
      i++;
    } else output.push({ id: `interrupted_${randomUUID()}`, role: 'user', content: results });
  }
  return output;
}

/**
 * 状态文件：`state-v2.json`（`27` §5.5）。
 *
 * 迁移规则：
 *  1. 只有 v1 → 读入、补齐默认、写 v2、**保留 v1 备份**；
 *  2. v2 损坏 → 报错并保留原文件，不静默覆盖；
 *  3. v2 只在同一个 `LIWENCODE_HOME` 内生效。
 */
export class DesktopStateStore {
  readonly file: string;
  readonly legacyFile: string;
  private queue: Promise<void> = Promise.resolve();
  private failure: unknown;
  private closed = false;
  private constructor(
    readonly directory: string,
    readonly data: DesktopState,
    private readonly lock: fs.FileHandle,
    readonly migratedFromV1: boolean,
  ) {
    this.file = path.join(directory, 'state-v2.json');
    this.legacyFile = path.join(directory, 'state-v1.json');
  }

  static async open(directory: string): Promise<DesktopStateStore> {
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    directory = await fs.realpath(directory);
    const lockPath = path.join(directory, 'host.lock');
    const locked = (): Error => new Error(`Desktop state is locked: ${lockPath}. Stop the other Host; incomplete lock metadata requires manual recovery.`);
    let lock: fs.FileHandle;
    try { lock = await fs.open(lockPath, 'wx', 0o600); }
    catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      // Serialize stale-lock recovery. A live/unknown owner is NEVER displaced.
      // Fresh contenders still use wx, so at most one can win the unlink/open gap.
      const recovery = path.join(directory, 'host-lock-recovery');
      try { await fs.mkdir(recovery); } catch { throw locked(); }
      try {
        let pid: unknown;
        try { pid = (JSON.parse(await fs.readFile(lockPath, 'utf8')) as { pid?: unknown }).pid; } catch { throw locked(); }
        if (typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid <= 0) throw locked();
        try { process.kill(pid, 0); throw locked(); }
        catch (check) { if ((check as NodeJS.ErrnoException).code !== 'ESRCH') throw locked(); }
        await fs.unlink(lockPath);
        try { lock = await fs.open(lockPath, 'wx', 0o600); } catch { throw locked(); }
      } finally { await fs.rmdir(recovery); }
    }
    try {
      await lock.writeFile(JSON.stringify({ pid: process.pid, startedAt: Date.now() }));
      await lock.sync();
      const v2File = path.join(directory, 'state-v2.json');
      const v1File = path.join(directory, 'state-v1.json');
      let data: DesktopState = emptyState();
      let migrated = false;
      let rawV2: string | undefined;
      try { rawV2 = await fs.readFile(v2File, 'utf8'); }
      catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
      if (rawV2 !== undefined) {
        try { data = v2Schema.parse(JSON.parse(rawV2)) as DesktopState; }
        catch { throw new Error(`Invalid or unsupported Desktop state; original retained: ${v2File}`); }
      } else {
        let rawV1: string | undefined;
        try { rawV1 = await fs.readFile(v1File, 'utf8'); }
        catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
        if (rawV1 !== undefined) {
          let parsed: z.infer<typeof v1Schema>;
          try { parsed = v1Schema.parse(JSON.parse(rawV1)); }
          catch { throw new Error(`Invalid or unsupported Desktop state; original retained: ${v1File}`); }
          data = migrateV1ToV2(parsed);
          migrated = true;
        }
      }
      const store = new DesktopStateStore(directory, data, lock, migrated);
      if (migrated) await store.save(); // 立刻写出 v2；v1 保留作备份。
      return store;
    } catch (e) {
      await lock.close();
      await fs.unlink(lockPath);
      throw e;
    }
  }

  save(): Promise<void> {
    if (this.closed) return Promise.reject(new Error('Desktop state is closed'));
    // Capture at enqueue time, never let a later mutation change an older queued write.
    const json = JSON.stringify(this.data);
    this.queue = this.queue.then(async () => {
      if (this.failure) throw this.failure;
      const tmp = `${this.file}.${randomUUID()}.tmp`;
      try {
        const handle = await fs.open(tmp, 'wx', 0o600);
        try { await handle.writeFile(json); await handle.sync(); } finally { await handle.close(); }
        await fs.rename(tmp, this.file);
        const dir = await fs.open(this.directory, 'r');
        try { await dir.sync(); } finally { await dir.close(); }
      } finally { await fs.unlink(tmp).catch(() => undefined); }
    }).catch((e: unknown) => { this.failure = e; throw e; });
    return this.queue;
  }
  async flush(): Promise<void> { await this.queue; if (this.failure) throw this.failure; }
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try { await this.flush(); }
    finally { await this.lock.close(); await fs.unlink(path.join(this.directory, 'host.lock')); }
  }
}
