import { z } from 'zod';
import type { Runtime } from './runtime/index.js';
import type { PermissionMode } from './events.js';
import type { PermissionRule } from './permissions.js';
import { SyaoError } from './errors/syao-error.js';

/**
 * Layered configuration (FR-120, BR-024). Precedence:
 * code > env > project > user > defaults. Zod-validated; failures aggregate
 * into SY-CFG-001 with field paths in details.
 */

export const permissionRuleSchema = z.object({
  effect: z.enum(['allow', 'ask', 'deny']),
  tool: z.string().min(1),
  match: z
    .object({
      path: z.string().optional(),
      command: z.string().optional(),
      url: z.string().optional(),
    })
    .optional(),
  source: z.enum(['user', 'project', 'plugin', 'code']),
});

/** Protocols a registry entry may speak (03 §5.6). */
export const rpcProtocolSchema = z.enum(['mcp', 'a2a', 'acp', 'local']);

/**
 * Agent RPC shapes (03 §5.6, report C9).
 *
 * The field shapes are declared once and used twice: the config schema fills
 * in defaults, the layer schema does not. A layer must contribute only the
 * fields it declares — otherwise a nested default (e.g. `rpc.audit.enabled`)
 * would silently override a lower layer.
 */
const rpcPolicyFields = {
  /** Path to a signed policy bundle; loaded by the CLI/rpc layer. */
  bundle: z.string().optional(),
  mode: z.enum(['strict', 'default', 'acceptEdits', 'plan', 'bypass']).optional(),
  /** Layer rules; BR-024 makes user denies veto project rules. */
  rules: z.array(permissionRuleSchema),
};

const rpcBudgetFields = {
  limitUsd: z.number().positive().optional(),
  limitTokens: z.number().int().positive().optional(),
};

const rpcServerFields = {
  host: z.string().optional(),
  port: z.number().int().min(1).max(65535).optional(),
  /**
   * Bearer token reference. Never a literal secret: only an environment
   * reference (`env:NAME`, `${NAME}` or a bare variable name) is accepted,
   * so a token cannot be persisted in a config file (BR-023).
   */
  token: z.string().optional(),
};

const rpcAuditFields = {
  enabled: z.boolean(),
  retentionDays: z.number().int().positive(),
};

const rpcRegistryEntry = z.object({
  id: z.string().min(1),
  protocol: rpcProtocolSchema,
  endpoint: z.string().min(1),
});

/** Agent RPC section with defaults (the effective configuration). */
export const rpcConfigSchema = z
  .object({
    policy: z
      .object({ ...rpcPolicyFields, rules: rpcPolicyFields.rules.default([]) })
      .default({ rules: [] }),
    budget: z.object(rpcBudgetFields).default({}),
    server: z.object(rpcServerFields).default({}),
    audit: z
      .object({
        enabled: rpcAuditFields.enabled.default(false),
        retentionDays: rpcAuditFields.retentionDays.default(30),
      })
      .default({ enabled: false, retentionDays: 30 }),
    registry: z.array(rpcRegistryEntry).default([]),
  })
  .default({});

/** Layer variant: no defaults, so a layer only declares what it sets. */
const rpcLayerSchema = z
  .object({
    policy: z.object(rpcPolicyFields).partial(),
    budget: z.object(rpcBudgetFields),
    server: z.object(rpcServerFields),
    audit: z.object(rpcAuditFields).partial(),
    registry: z.array(rpcRegistryEntry),
  })
  .partial();

export type RpcConfig = z.infer<typeof rpcConfigSchema>;

/** Matches `env:NAME`, `${NAME}`, `$NAME` or a bare `NAME` variable reference. */
const ENV_REFERENCE = /^(?:env:|\$\{?)?([A-Za-z_][A-Za-z0-9_]*)\}?$/;

/**
 * Resolve a `server.token` reference against the environment (03 §5.6).
 * Returns undefined for literals, so a pasted secret is ignored rather than
 * used — the config file must never carry a plaintext token.
 */
export function resolveServerToken(
  reference: string | undefined,
  env: { get(name: string): string | undefined },
): string | undefined {
  if (reference === undefined || reference === '') return undefined;
  const m = ENV_REFERENCE.exec(reference.trim());
  const name = m?.[1];
  if (name === undefined) return undefined;
  return env.get(name);
}

export const configSchema = z.object({
  model: z
    .object({
      provider: z.string().min(1),
      name: z.string().min(1),
      apiKeyEnv: z.string().optional(),
      baseUrl: z.string().url().optional(),
    })
    .optional(),
  permissionMode: z.enum(['strict', 'default', 'acceptEdits', 'plan', 'bypass']).default('strict'),
  rules: z.array(permissionRuleSchema).default([]),
  extraDirs: z.array(z.string()).default([]),
  limits: z
    .object({
      maxTurns: z.number().int().min(1).max(1000).default(100),
      maxBudgetUsd: z.number().positive().optional(),
      maxTotalTokens: z.number().int().positive().optional(),
      maxWallClockMs: z.number().int().positive().optional(),
      /** Legacy alias for maxWallClockMs. */
      timeoutMs: z.number().int().positive().optional(),
    })
    .default({}),
  env: z.record(z.string()).default({}),
  /** Agent RPC governance surface (report C9 / 03 §5.6). */
  rpc: rpcConfigSchema,
});

export type SyaoConfig = z.infer<typeof configSchema>;

/**
 * Layer schema: the same shape with every default removed.
 *
 * A layer must only contribute the fields it actually declares. Parsing a
 * layer with `configSchema` would fill in nested defaults (e.g. `rpc.audit`),
 * and those filled values would then silently override a lower layer.
 */
const layerSchema = configSchema.partial().extend({ rpc: rpcLayerSchema.optional() });

export interface LoadConfigOptions {
  userPath?: string;
  projectPath?: string;
  env?: Record<string, string | undefined>;
  /** Lowest layer above built-in defaults (e.g. the CLI's `default` mode). */
  base?: Partial<SyaoConfig>;
  code?: Partial<SyaoConfig>;
  runtime: Runtime;
}

const DEFAULTS: SyaoConfig = configSchema.parse({});

function mergeLayer(base: SyaoConfig, layer: Partial<SyaoConfig>): SyaoConfig {
  const baseRpc = base.rpc;
  const layerRpc = layer.rpc;
  return {
    ...base,
    ...layer,
    rules: [...base.rules, ...(layer.rules ?? [])],
    extraDirs: [...base.extraDirs, ...(layer.extraDirs ?? [])],
    limits: { ...base.limits, ...(layer.limits ?? {}) },
    env: { ...base.env, ...(layer.env ?? {}) },
    rpc:
      layerRpc === undefined
        ? baseRpc
        : {
            policy: {
              ...baseRpc.policy,
              ...(layerRpc.policy ?? {}),
              rules: [...baseRpc.policy.rules, ...(layerRpc.policy?.rules ?? [])],
            },
            budget: { ...baseRpc.budget, ...(layerRpc.budget ?? {}) },
            server: { ...baseRpc.server, ...(layerRpc.server ?? {}) },
            audit: { ...baseRpc.audit, ...(layerRpc.audit ?? {}) },
            // Registry entries accumulate across layers; later entries win on id.
            registry: mergeRegistry(baseRpc.registry, layerRpc.registry ?? []),
          },
  };
}

function mergeRegistry(
  base: RpcConfig['registry'],
  layer: RpcConfig['registry'],
): RpcConfig['registry'] {
  if (layer.length === 0) return base;
  const byId = new Map(base.map((e) => [e.id, e]));
  for (const entry of layer) byId.set(entry.id, entry);
  return [...byId.values()];
}

/** Zod-inferred rule shape (its `match` allows explicit `undefined`). */
type ConfigRule = z.infer<typeof permissionRuleSchema>;

/** Stable identity for BR-024 rule comparison. */
function ruleKey(rule: ConfigRule): string {
  return [
    rule.tool,
    rule.match?.path ?? '',
    rule.match?.command ?? '',
    rule.match?.url ?? '',
  ].join('|');
}

/**
 * Enforce BR-024 on the rpc policy layer: a project bundle may add rules but
 * can never relax a user-level deny. A conflicting project rule is forced back
 * to deny, keeping the same tool/match identity so ordering stays meaningful.
 */
function enforceProjectDenyPrecedence(
  userRules: ConfigRule[],
  projectRules: ConfigRule[],
  warn: (msg: string) => void,
): ConfigRule[] {
  const userDeny = new Set(userRules.filter((r) => r.effect === 'deny').map(ruleKey));
  return projectRules.map((rule) => {
    if (rule.effect === 'deny' || !userDeny.has(ruleKey(rule))) return rule;
    warn(`rpc policy: project rule tries to relax a user deny for '${rule.tool}'; forced back to deny (BR-024)`);
    return { ...rule, effect: 'deny' as const };
  });
}

async function readJsonIfExists(path: string, runtime: Runtime): Promise<Record<string, unknown> | undefined> {
  if (!(await runtime.fs.exists(path))) return undefined;
  try {
    return JSON.parse(await runtime.fs.readFile(path)) as Record<string, unknown>;
  } catch (e) {
    throw new SyaoError({
      code: 'SY-CFG-001',
      message: `Failed to parse config file ${path}`,
      details: { path },
      cause: e,
    });
  }
}

export async function loadConfig(opts: LoadConfigOptions): Promise<SyaoConfig> {
  const errors: { path: string; message: string }[] = [];
  const warn = (msg: string) => opts.runtime.logger.log('warn', 'config', { msg });
  let config: SyaoConfig = opts.base !== undefined ? mergeLayer(DEFAULTS, opts.base) : DEFAULTS;

  const userRaw = await readJsonIfExists(opts.userPath ?? `${opts.runtime.env.get('HOME') ?? ''}/.syaocode/config.json`, opts.runtime);
  if (userRaw !== undefined) config = mergeLayer(config, validateLayer(userRaw, 'user', errors));

  const projectRaw = await readJsonIfExists(opts.projectPath ?? '.syaocode/config.json', opts.runtime);
  if (projectRaw !== undefined) {
    const project = validateLayer(projectRaw, 'project', errors);
    // BR-002: project-level config may not enable bypass.
    if (project.permissionMode === 'bypass') {
      warn('project-level config cannot enable bypass mode (BR-002); ignored (SY-CFG-001)');
      project.permissionMode = 'default';
    }
    // BR-024: project cannot relax user-level deny rules — union of denies.
    const userDeny = new Set(config.rules.filter((r) => r.effect === 'deny').map((r) => `${r.tool}|${JSON.stringify(r.match ?? {})}`));
    for (const rule of project.rules ?? []) {
      if (rule.effect !== 'deny' && userDeny.has(`${rule.tool}|${JSON.stringify(rule.match ?? {})}`)) {
        warn(`project rule tries to relax user deny for '${rule.tool}'; forced back to deny (BR-024)`);
        rule.effect = 'deny';
      }
    }
    // BR-002 / BR-024 also apply to the Agent RPC policy layer (report C9).
    if (project.rpc?.policy?.mode === 'bypass') {
      warn('project-level rpc.policy.mode cannot be bypass (BR-002); ignored');
      project.rpc = { ...project.rpc, policy: { ...project.rpc.policy, mode: 'default' } };
    }
    if (project.rpc?.policy !== undefined && (project.rpc.policy.rules ?? []).length > 0) {
      project.rpc = {
        ...project.rpc,
        policy: {
          ...project.rpc.policy,
          rules: enforceProjectDenyPrecedence(config.rpc.policy.rules, project.rpc.policy.rules ?? [], warn),
        },
      };
    }
    config = mergeLayer(config, project);
  }

  const env = opts.env ?? {};
  const envRaw: Record<string, unknown> = {};
  if (env.SYAO_MODEL !== undefined && env.SYAO_MODEL !== '') {
    const idx = env.SYAO_MODEL.indexOf(':');
    if (idx > 0) {
      envRaw.model = { provider: env.SYAO_MODEL.slice(0, idx), name: env.SYAO_MODEL.slice(idx + 1) };
    }
  }
  if (env.SYAO_PERMISSION_MODE !== undefined && env.SYAO_PERMISSION_MODE !== '') {
    envRaw.permissionMode = env.SYAO_PERMISSION_MODE as PermissionMode;
  }
  if (Object.keys(envRaw).length > 0) {
    config = mergeLayer(config, validateLayer(envRaw, 'env', errors));
  }

  if (opts.code !== undefined) config = mergeLayer(config, opts.code);

  if (errors.length > 0) {
    throw new SyaoError({
      code: 'SY-CFG-001',
      message: 'Configuration validation failed',
      details: { issues: errors },
    });
  }
  return config;
}

function validateLayer(raw: unknown, layer: string, errors: { path: string; message: string }[]): Partial<SyaoConfig> {
  const parsed = layerSchema.safeParse(raw);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      errors.push({ path: `${layer}:${issue.path.join('.')}`, message: issue.message });
    }
    return {};
  }
  // Zod materializes optional keys as `undefined`; spreading those would
  // override a lower layer with nothing.
  return stripUndefined(parsed.data) as Partial<SyaoConfig>;
}

/** Recursively drop keys whose value is `undefined`. */
function stripUndefined(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripUndefined);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (v === undefined) continue;
      out[k] = stripUndefined(v);
    }
    return out;
  }
  return value;
}

export function rulesFromConfig(config: SyaoConfig): PermissionRule[] {
  return config.rules.map((r) => ({
    effect: r.effect,
    tool: r.tool,
    source: r.source,
    ...(r.match !== undefined
      ? {
          match: {
            ...(r.match.path !== undefined ? { path: r.match.path } : {}),
            ...(r.match.command !== undefined ? { command: r.match.command } : {}),
            ...(r.match.url !== undefined ? { url: r.match.url } : {}),
          },
        }
      : {}),
  }));
}
