import { z } from 'zod';
import { DhpProtocolError } from './dhp-server.ts';

export const nonnegative = z.number().finite().nonnegative();
export const timestamp = nonnegative.max(8.64e15);
export const titleSchema = z.string().trim().min(1).max(200);
export const permissionSchema = z.enum(['plan', 'strict', 'default', 'acceptEdits', 'bypass']);
export const sessionIdSchema = z.object({ sessionId: z.string().min(1) });
export const commandSchema = sessionIdSchema.extend({
  commandId: z.string().min(1).max(200), baseRevision: nonnegative.int(),
});
export const modelSpecSchema = z.string().min(1).max(400).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*:[^\s]+$/);
export const safeUrlSchema = z.string().url().max(2048).refine((raw) => {
  try {
    const u = new URL(raw);
    return !u.username && !u.password && !u.search && !u.hash &&
      !/%(?:3f|23|40)/i.test(u.pathname) &&
      (u.protocol === 'https:' || (u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname)));
  } catch { return false; }
}, 'URL must be HTTPS (loopback HTTP allowed), without credentials, query or fragment');
export const channelModelSchema = z.object({
  id: z.string().trim().min(1).max(300).regex(/^\S+$/), name: titleSchema,
  contextWindow: nonnegative.int().positive().optional(),
  inputPricePerMillion: nonnegative.optional(), outputPricePerMillion: nonnegative.optional(),
  cacheReadPricePerMillion: nonnegative.optional(),
}).strict();
export const channelSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/), name: titleSchema,
  protocol: z.enum(['mock', 'openai-compatible', 'anthropic']),
  baseUrl: safeUrlSchema.optional(), apiKeyEnv: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/).max(200).optional(),
  models: z.array(channelModelSchema).max(500).refine((ms) => new Set(ms.map((m) => m.id)).size === ms.length, 'duplicate model id'),
  balance: z.object({ amount: nonnegative, currency: z.enum(['USD', 'CNY']), updatedAt: timestamp, source: z.literal('manual') }).strict().nullable().optional(),
  quota: z.object({ used: nonnegative, limit: nonnegative, unit: z.enum(['tokens', 'requests', 'credits']), resetsAt: timestamp.optional(), updatedAt: timestamp, source: z.literal('manual') }).strict().nullable().optional(),
}).strict().superRefine((c, ctx) => {
  if (c.protocol === 'mock') {
    if (c.id !== 'mock' || c.models.length !== 1 || c.models[0]?.id !== 'default' || c.apiKeyEnv || c.baseUrl) {
      ctx.addIssue({ code: 'custom', message: 'only builtin mock:default is allowed' });
    }
  } else if (!c.apiKeyEnv || c.id === 'mock') {
    ctx.addIssue({ code: 'custom', message: 'remote channels require apiKeyEnv' });
  }
  const protocols: Record<string, string> = { deepseek: 'openai-compatible', 'openai-compatible': 'openai-compatible', anthropic: 'anthropic' };
  if (protocols[c.id] && protocols[c.id] !== c.protocol) ctx.addIssue({ code: 'custom', message: 'builtin protocol is fixed' });
});
export const usageQuerySchema = z.object({ from: timestamp, to: timestamp, workspaceRoot: z.string().min(1).optional() }).strict()
  .refine((q) => q.from <= q.to && q.to - q.from <= 36600 * 86400000, 'invalid range (maximum 36600 days)');

/** `!` 前缀直接执行命令（FR-N-036）：命令原文上限与审计条目一致。 */
export const sessionRunCommandSchema = z.object({
  sessionId: z.string().min(1).max(200),
  command: z.string().min(1).max(4096),
}).strict();

/** 单文件改动 diff（FR-N-011）：路径先过基本形状校验，围栏由采集器把关。 */
export const sessionChangeDiffSchema = z.object({
  sessionId: z.string().min(1).max(200),
  path: z.string().min(1).max(4096),
}).strict();

// ── 增补能力的入参校验（27 §5.1）────────────────────────────────────────
//
// 原则：**凭据类参数一律不出现**。令牌与私钥走 preload → 主进程 → 钥匙串，
// 不经过 DHP，因此这里没有任何"接收密钥"的 schema。

export const workspaceRootSchema = z.object({ workspaceRoot: z.string().min(1).max(4096) }).strict();

export const mcpAddSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  command: z.string().trim().min(1).max(400).optional(),
  args: z.array(z.string().max(400)).max(64).optional(),
  url: z.string().trim().min(1).max(2048).optional(),
  // 只允许**变量名**：值来自 Host 启动环境，界面不读取、不回显、不落盘。
  envNames: z.array(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/)).max(64).optional(),
  trusted: z.boolean(),
}).strict();

export const mcpServerIdSchema = z.object({ serverId: z.string().min(1).max(200) }).strict();

export const agentGroupSchema = z.object({
  name: z.string().trim().min(1).max(80),
  roles: z.object({ hyaki: modelSpecSchema, sota: modelSpecSchema, common: modelSpecSchema }).strict(),
}).strict();

export const agentGroupNameSchema = z.object({ name: z.string().trim().min(1).max(80) }).strict();

export const gitDiffSchema = workspaceRootSchema.extend({
  path: z.string().min(1).max(4096),
  mode: z.enum(['worktree', 'staged', 'commit']).optional(),
  commit: z.string().max(64).optional(),
}).strict();

export const gitGraphSchema = workspaceRootSchema.extend({
  maxCount: nonnegative.int().max(500).optional(),
  skip: nonnegative.int().max(100_000).optional(),
}).strict();

export const gitStageSchema = workspaceRootSchema.extend({
  paths: z.array(z.string().min(1).max(4096)).min(1).max(2000),
}).strict();

export const gitCommitSchema = workspaceRootSchema.extend({
  message: z.string().min(1).max(4000),
  includeUnstaged: z.boolean().optional(),
  noVerify: z.boolean().optional(),
  /** 允许空提交（`--allow-empty`）；默认拒绝。 */
  allowEmpty: z.boolean().optional(),
  /** 本次不签名（`--no-gpg-sign`）；只在签名失败后由用户显式选择。 */
  noSign: z.boolean().optional(),
}).strict();

export const gitBranchSchema = workspaceRootSchema.extend({
  name: z.string().min(1).max(255),
  checkout: z.boolean().optional(),
}).strict();

export const gitRemoteAddSchema = workspaceRootSchema.extend({
  name: z.string().min(1).max(100),
  url: z.string().min(1).max(2048),
}).strict();

export const gitRemoteNameSchema = workspaceRootSchema.extend({
  name: z.string().min(1).max(100),
}).strict();

export const gitOauthStartSchema = workspaceRootSchema.extend({
  remote: z.string().min(1).max(100),
  provider: z.string().min(1).max(64),
  clientId: z.string().min(1).max(200).optional(),
  domain: z.string().min(1).max(255).optional(),
}).strict();

export const gitOauthFlowSchema = z.object({ flowId: z.string().min(1).max(200) }).strict();

export const gitRemoteAuthSchema = workspaceRootSchema.extend({
  remote: z.string().min(1).max(100),
  comment: z.string().max(200).optional(),
}).strict();

export const gitPreflightSchema = workspaceRootSchema.extend({
  remote: z.string().min(1).max(100),
  branch: z.string().min(1).max(255).optional(),
  scope: z.enum(['all', 'session']).optional(),
}).strict();

/** 提交信息生成（FR-N-026）：只读，不产生副作用。 */
export const gitCommitMessageSchema = workspaceRootSchema.extend({
  sessionId: z.string().min(1).max(200).optional(),
  scope: z.enum(['staged', 'session']).optional(),
  hint: z.string().max(500).optional(),
}).strict();

export const gitUploadSchema = workspaceRootSchema.extend({
  remote: z.string().min(1).max(100),
  branch: z.string().min(1).max(255),
  message: z.string().min(1).max(4000),
  includeUnstaged: z.boolean().optional(),
  scope: z.enum(['all', 'session']).optional(),
  commandId: z.string().min(1).max(200),
  baseRevision: nonnegative.int(),
}).strict();

/** Never include rejected values (possibly credentials) in protocol errors. */
export function parseInput<T extends z.ZodTypeAny>(schema: T, value: unknown): z.infer<T> {
  const result = schema.safeParse(value);
  if (!result.success) throw new DhpProtocolError('invalid_request', 'Invalid parameters');
  return result.data;
}
export { z };
