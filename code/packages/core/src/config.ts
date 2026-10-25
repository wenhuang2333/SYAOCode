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
});

export type SyaoConfig = z.infer<typeof configSchema>;

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
  return {
    ...base,
    ...layer,
    rules: [...base.rules, ...(layer.rules ?? [])],
    extraDirs: [...base.extraDirs, ...(layer.extraDirs ?? [])],
    limits: { ...base.limits, ...(layer.limits ?? {}) },
    env: { ...base.env, ...(layer.env ?? {}) },
  };
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
  const parsed = configSchema.partial().safeParse(raw);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      errors.push({ path: `${layer}:${issue.path.join('.')}`, message: issue.message });
    }
    return {};
  }
  return parsed.data as Partial<SyaoConfig>;
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
