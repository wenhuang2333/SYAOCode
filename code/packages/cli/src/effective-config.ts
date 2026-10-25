import { loadConfig, Redactor, type Runtime, type SyaoConfig } from '@syaocode/core';
import * as path from 'node:path';
import type { CliArgs } from './args.js';
import { resolvePermissionTier } from './args.js';
import { envFilePath, getProfile, parseEnvFile, syaoHome, userConfigPath } from './model-config.js';
import type { ProviderSpec } from './provider-select.js';
import { readFileSync } from 'node:fs';

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
}

export async function loadCliConfig(
  args: EffectiveConfigArgs,
  runtime: Runtime,
): Promise<SyaoConfig> {
  const cwd = cliCwd(args);
  const hasTierFlag = args.permissionMode !== undefined || args.si || args.yao;
  const tier = hasTierFlag
    ? resolvePermissionTier({
        ...(args.permissionMode !== undefined ? { permissionMode: args.permissionMode } : {}),
        si: args.si === true,
        yao: args.yao === true,
      }).mode
    : undefined;
  const model = argsModelSpec(args);
  const code: Partial<SyaoConfig> = {
    rules: [
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
  if (args.maxTurns !== undefined) config.limits.maxTurns = args.maxTurns;
  if (args.maxBudgetUsd !== undefined) config.limits.maxBudgetUsd = args.maxBudgetUsd;
  if (args.maxTotalTokens !== undefined) config.limits.maxTotalTokens = args.maxTotalTokens;
  if (args.maxWallClockMs !== undefined) config.limits.maxWallClockMs = args.maxWallClockMs;
  return config;
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
