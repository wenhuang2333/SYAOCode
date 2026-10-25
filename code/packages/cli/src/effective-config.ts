import { loadConfig, SyaoError, type PermissionMode, type PermissionRule, type Runtime, type SyaoConfig } from '@syaocode/core';
import * as path from 'node:path';
import type { CliArgs } from './args.js';
import { resolvePermissionTier } from './args.js';
import { envFilePath, getProfile, parseEnvFile, syaoHome, userConfigPath } from './model-config.js';
import type { ProviderSpec } from './provider-select.js';
import { readFileSync } from 'node:fs';
import { Redactor } from '@syaocode/core';

/**
 * One effective-config path for every CLI entry (report E2/E3/E4):
 * defaults (CLI's default tier) → user → project → env → CLI flags.
 * Interactive, TUI, -p/exec and `config` all use this instead of reading
 * `~/.syaocode/config.json` directly, so project policy and env overrides
 * are finally visible to the permission engine.
 */

export const CLI_BASE_CONFIG: Partial<SyaoConfig> = { permissionMode: 'default' };

export function cliCwd(args: Pick<CliArgs, 'cwd'>): string {
  return path.resolve(args.cwd ?? process.cwd());
}

export interface EffectiveConfigArgs {
  cwd?: string;
  permissionMode?: 'strict' | 'default' | 'acceptEdits' | 'plan' | 'bypass';
  si?: boolean;
  yao?: boolean;
  allowedTools: string[];
  disallowedTools: string[];
  maxTurns?: number;
  maxBudgetUsd?: number;
  maxTotalTokens?: number;
  maxWallClockMs?: number;
  model?: string;
  policy?: string;
}

export interface CliPolicy {
  permissionMode?: PermissionMode;
  allowedTools: string[];
  disallowedTools: string[];
  rules: PermissionRule[];
  limits: Partial<SyaoConfig['limits']>;
}

export async function loadCliConfig(
  args: EffectiveConfigArgs,
  runtime: Runtime,
): Promise<SyaoConfig> {
  const cwd = cliCwd(args);
  const policy = args.policy !== undefined ? await readPolicy(runtime, cwd, args.policy) : undefined;
  const hasTierFlag = args.permissionMode !== undefined || args.si || args.yao;
  const tier = hasTierFlag
    ? resolvePermissionTier({
        ...(args.permissionMode !== undefined ? { permissionMode: args.permissionMode } : {}),
        si: args.si === true,
        yao: args.yao === true,
      }).mode
    : (policy?.permissionMode ?? undefined);
  const model = argsModelSpec(args);
  const code: Partial<SyaoConfig> = {
    rules: [
      ...(policy?.rules ?? []),
      ...(policy?.allowedTools ?? []).map((tool) => ({ effect: 'allow' as const, tool, source: 'user' as const })),
      ...(policy?.disallowedTools ?? []).map((tool) => ({ effect: 'deny' as const, tool, source: 'user' as const })),
      ...args.allowedTools.map((tool) => ({ effect: 'allow' as const, tool, source: 'user' as const })),
      ...args.disallowedTools.map((tool) => ({ effect: 'deny' as const, tool, source: 'user' as const })),
    ],
    ...(tier !== undefined ? { permissionMode: tier } : {}),
    ...(model !== undefined ? { model } : {}),
  };
  const config = await loadConfig({
    userPath: userConfigPath(),
    projectPath: path.join(cwd, '.syaocode', 'config.json'),
    env: process.env,
    base: CLI_BASE_CONFIG,
    code,
    runtime,
  });
  if (policy !== undefined) {
    for (const key of ['maxTurns', 'maxBudgetUsd', 'maxTotalTokens', 'maxWallClockMs'] as const) {
      const value = policy.limits[key];
      if (value !== undefined) config.limits[key] = value as never;
    }
  }
  if (args.maxTurns !== undefined) config.limits.maxTurns = args.maxTurns;
  if (args.maxBudgetUsd !== undefined) config.limits.maxBudgetUsd = args.maxBudgetUsd;
  if (args.maxTotalTokens !== undefined) config.limits.maxTotalTokens = args.maxTotalTokens;
  if (args.maxWallClockMs !== undefined) config.limits.maxWallClockMs = args.maxWallClockMs;
  return config;
}

async function readPolicy(runtime: Runtime, cwd: string, pathOrName: string): Promise<CliPolicy> {
  const file = pathOrName.startsWith('/') ? pathOrName : path.join(cwd, pathOrName);
  const text = await runtime.fs.readFile(file).catch((e: unknown) => {
    throw new SyaoError({ code: 'SY-CFG-001', message: `Cannot read policy file ${file}`, details: { file }, cause: e });
  });
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new SyaoError({ code: 'SY-CFG-001', message: `Policy file is not valid JSON: ${file}`, details: { file }, cause: e });
  }
  const obj = raw !== null && typeof raw === 'object' ? (raw as Record<string, unknown>) : undefined;
  if (obj === undefined) {
    throw new SyaoError({ code: 'SY-CFG-001', message: 'Policy must be a JSON object', details: { file } });
  }
  const modes: PermissionMode[] = ['strict', 'default', 'acceptEdits', 'plan', 'bypass'];
  if (obj.permissionMode !== undefined && !modes.includes(obj.permissionMode as PermissionMode)) {
    throw new SyaoError({ code: 'SY-CFG-001', message: `Invalid permissionMode in policy: ${String(obj.permissionMode)}`, details: { file } });
  }
  const strings = (value: unknown): string[] => {
    if (value === undefined) return [];
    if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) {
      throw new SyaoError({ code: 'SY-CFG-001', message: 'Policy tool lists must be arrays of strings', details: { file } });
    }
    return value as string[];
  };
  const rules: PermissionRule[] = [];
  if (obj.rules !== undefined) {
    if (!Array.isArray(obj.rules)) {
      throw new SyaoError({ code: 'SY-CFG-001', message: 'Policy rules must be an array', details: { file } });
    }
    for (const item of obj.rules) {
      const rule = item !== null && typeof item === 'object' ? (item as Record<string, unknown>) : undefined;
      if (
        rule === undefined ||
        (rule.effect !== 'allow' && rule.effect !== 'ask' && rule.effect !== 'deny') ||
        typeof rule.tool !== 'string' ||
        (rule.source !== undefined && !['user', 'project', 'plugin', 'code'].includes(String(rule.source)))
      ) {
        throw new SyaoError({ code: 'SY-CFG-001', message: 'Invalid rule in policy file', details: { file, rule: item } });
      }
      const match = rule.match !== null && typeof rule.match === 'object' ? (rule.match as Record<string, unknown>) : undefined;
      rules.push({
        effect: rule.effect,
        tool: rule.tool,
        source: (rule.source as PermissionRule['source'] | undefined) ?? 'user',
        ...(match !== undefined
          ? {
              match: {
                ...(typeof match.path === 'string' ? { path: match.path } : {}),
                ...(typeof match.command === 'string' ? { command: match.command } : {}),
                ...(typeof match.url === 'string' ? { url: match.url } : {}),
              },
            }
          : {}),
      });
    }
  }
  const limitsRaw = obj.limits !== null && typeof obj.limits === 'object' ? (obj.limits as Record<string, unknown>) : {};
  const limits: Partial<SyaoConfig['limits']> = {};
  for (const key of ['maxTurns', 'maxBudgetUsd', 'maxTotalTokens', 'maxWallClockMs', 'timeoutMs'] as const) {
    const value = limitsRaw[key];
    if (value === undefined) continue;
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
      throw new SyaoError({ code: 'SY-CFG-001', message: `Invalid limits.${key} in policy`, details: { file } });
    }
    limits[key] = value as never;
  }
  return {
    ...(obj.permissionMode !== undefined ? { permissionMode: obj.permissionMode as PermissionMode } : {}),
    allowedTools: strings(obj.allowedTools),
    disallowedTools: strings(obj.disallowedTools),
    rules,
    limits,
  };
}

/** The model flag, else the layered config's model, else offline mock. */
export function cliModelSpec(
  args: Pick<CliArgs, 'model'>,
  config: Pick<SyaoConfig, 'model'>,
): ProviderSpec {  if (args.model !== undefined && args.model !== '') {
    return parseModelFlag(args.model, config.model);
  }
  if (config.model !== undefined) {
    return { provider: config.model.provider, model: config.model.name };
  }
  return { provider: 'mock', model: 'default' };
}

function parseModelFlag(raw: string, configured: SyaoConfig['model']): ProviderSpec {
  if (raw.startsWith('@')) {
    const profile = getProfile(raw.slice(1));
    return { provider: raw, model: profile?.model ?? 'default' };
  }
  const idx = raw.indexOf(':');
  if (idx > 0) return { provider: raw.slice(0, idx), model: raw.slice(idx + 1) };
  // A bare name keeps the configured provider (or mock when nothing is saved).
  return { provider: configured?.provider ?? 'mock', model: raw };
}

function argsModelSpec(
  args: Pick<CliArgs, 'model'>,
): SyaoConfig['model'] | undefined {
  if (args.model === undefined || args.model === '') return undefined;
  const spec = parseModelFlag(args.model, undefined);
  return { provider: spec.provider, name: spec.model };
}

/** Redactor with every known secret value registered (env + ~/.syaocode/env). */
export function createCliRedactor(): Redactor {
  const redactor = new Redactor();
  const names = /(?:^|_)(?:API_?KEY|TOKEN|SECRET|PASSWORD|PASSWD)$/i;
  for (const [name, value] of Object.entries(process.env)) {
    if (value !== undefined && value.length >= 8 && names.test(name)) {
      redactor.register(value, name.toLowerCase());
    }
  }
  try {
    const entries = parseEnvFile(readFileSync(envFilePath(syaoHome()), 'utf8'));
    for (const [name, value] of Object.entries(entries)) {
      if (value !== '') redactor.register(value, name.toLowerCase());
    }
  } catch {
    /* no env file */
  }
  return redactor;
}
