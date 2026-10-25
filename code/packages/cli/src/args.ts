/** Minimal hand-rolled arg parsing (no framework dep). Subset of FR-135 for v0.1. */

import { t, type MsgKey } from './i18n/index.js';

export interface CliArgs {
  positional: string[];
  print: boolean;
  outputFormat: 'text' | 'json' | 'stream-json';
  model?: string;
  permissionMode?: 'strict' | 'default' | 'acceptEdits' | 'plan' | 'bypass';
  /** Full-permission tier shortcut (maps to bypass). */
  si: boolean;
  /** Partial-permission tier shortcut (reads pass, writes/exec ask; maps to default). */
  yao: boolean;
  allowedTools: string[];
  disallowedTools: string[];
  maxTurns?: number;
  maxBudgetUsd?: number;
  maxTotalTokens?: number;
  maxWallClockMs?: number;
  /** JSON policy file for non-interactive/CI runs (v0.2.5). */
  policy?: string;
  /** Auto-run discovered verification after a completed run (default: on for -p/exec). */
  verify?: boolean;
  cwd?: string;
  verbose: boolean;
  /** Skip the TUI boot animation (FR-137 / TUI). */
  noBoot: boolean;
  /** Activate a saved agent group at startup (its common role drives the session). */
  agents?: string;
  command?: 'exec' | 'doctor' | 'config' | 'verify' | 'version' | 'help';
  configSub?: 'list' | 'get' | 'path';
  verifySub?: 'init';
  /** Overwrite an existing .syaocode/verify.json (syao verify init). */
  force?: boolean;
}

export type PermissionTier = 'strict' | 'yao' | 'si' | 'acceptEdits' | 'plan';

/**
 * Three-tier permission mapping:
 *  - no flag  → default  读取免确认；写/删/执行需确认（规范 FR-041 的 default）
 *  - --yao → default 同上（显式写法）
 *  - --si   → bypass  文件增删改查读全部免确认（危险命令库仍拒绝，BR-006）
 * Precedence: --permission-mode > tier flag > saved user config > default.
 *
 * strict 仍可用（--permission-mode strict 或 /permission strict）：一切操作都确认。
 * 默认为 default 而不是 strict，是为了降低上手难度——读操作不再逐条打断，
 * 写/删/执行仍然必须审批，安全边界不变。
 */
export function resolvePermissionTier(
  args: Pick<CliArgs, 'permissionMode' | 'si' | 'yao'>,
  savedMode?: 'strict' | 'default' | 'acceptEdits' | 'plan' | 'bypass',
): { mode: 'strict' | 'default' | 'acceptEdits' | 'plan' | 'bypass'; tier: PermissionTier; source: string } {
  if (args.permissionMode !== undefined) {
    return { mode: args.permissionMode, tier: tierOfMode(args.permissionMode), source: '--permission-mode' };
  }
  if (args.si) return { mode: 'bypass', tier: 'si', source: '--si' };
  if (args.yao) return { mode: 'default', tier: 'yao', source: '--yao' };
  if (savedMode !== undefined) return { mode: savedMode, tier: tierOfMode(savedMode), source: 'user-config' };
  return { mode: 'default', tier: 'yao', source: 'default' };
}

function tierOfMode(mode: 'strict' | 'default' | 'acceptEdits' | 'plan' | 'bypass'): PermissionTier {
  switch (mode) {
    case 'bypass': return 'si';
    case 'default': return 'yao';
    default: return mode; // strict | acceptEdits | plan pass through as their own label
  }
}

/** 帮助文本（按当前语言解析；保持在调用时生成，避免模块加载期冻结语言） */
export function usageText(): string {
  return t('usage.text');
}

export function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    positional: [],
    print: false,
    outputFormat: 'text',
    si: false,
    yao: false,
    allowedTools: [],
    disallowedTools: [],
    verbose: false,
    noBoot: false,
  };
  let i = 0;
  const next = (flag: string): string => {
    i += 1;
    const v = argv[i];
    if (v === undefined) {
      throw new UsageError(t('args.missingValue', { flag }));
    }
    return v;
  };
  const untilNextFlag = (): string[] => {
    const values: string[] = [];
    while (i + 1 < argv.length && !argv[i + 1]!.startsWith('-')) {
      i += 1;
      values.push(argv[i]!);
    }
    return values;
  };
  for (; i < argv.length; i += 1) {
    const a = argv[i]!;
    switch (a) {
      case '-p':
      case '--print':
        args.print = true;
        break;
      case 'exec':
        args.command = 'exec';
        args.print = true;
        break;
      case 'doctor':
        args.command = 'doctor';
        break;
      case 'config':
        args.command = 'config';
        break;
      case 'verify':
        args.command = 'verify';
        break;
      case '--version':
        args.command = 'version';
        break;
      case '--help':
      case '-h':
        args.command = 'help';
        break;
      case '--output-format': {
        const v = next(a);
        if (v !== 'text' && v !== 'json' && v !== 'stream-json') {
          throw new UsageError(t('args.invalidOutputFormat', { value: v }));
        }
        args.outputFormat = v;
        break;
      }
      case '-m':
      case '--model':
        args.model = next(a);
        break;
      case '--permission-mode': {
        const v = next(a);
        if (v !== 'strict' && v !== 'default' && v !== 'acceptEdits' && v !== 'plan' && v !== 'bypass') {
          throw new UsageError(t('args.invalidPermissionMode', { value: v }));
        }
        args.permissionMode = v;
        break;
      }
      case '--si':
        args.si = true;
        if (args.yao) throw new UsageError(t('args.mutuallyExclusive'));
        break;
      case '--yao':
        args.yao = true;
        if (args.si) throw new UsageError(t('args.mutuallyExclusive'));
        break;
      case '--allowed-tools':
        args.allowedTools.push(...untilNextFlag());
        break;
      case '--disallowed-tools':
        args.disallowedTools.push(...untilNextFlag());
        break;
      case '--max-turns':
        args.maxTurns = Number(next(a));
        break;
      case '--max-budget-usd':
        args.maxBudgetUsd = Number(next(a));
        break;
      case '--max-total-tokens':
        args.maxTotalTokens = Number(next(a));
        break;
      case '--max-wall-clock-ms':
        args.maxWallClockMs = Number(next(a));
        break;
      case '--policy':
        args.policy = next(a);
        break;
      case '--verify':
        args.verify = true;
        break;
      case '--no-verify':
        args.verify = false;
        break;
      case '--cwd':
        args.cwd = next(a);
        break;
      case '--verbose':
        args.verbose = true;
        break;
      case '--no-boot':
        args.noBoot = true;
        break;
      case '--agents':
        args.agents = next(a);
        break;
      case '--force':
        args.force = true;
        break;
      default:
        if (a.startsWith('-')) {
          throw new UsageError(t('args.unknownOption', { option: a }));
        }
        args.positional.push(a);
        break;
    }
  }
  if (args.command === 'config') {
    const sub = args.positional[0];
    if (sub !== 'list' && sub !== 'get' && sub !== 'path') {
      throw new UsageError(`config subcommand must be list | get | path (SY-CLI-001)`);
    }
    args.configSub = sub;
  }
  if (args.command === 'verify') {
    if (args.positional[0] !== 'init') {
      throw new UsageError(`verify subcommand must be init (SY-CLI-001)`);
    }
    args.verifySub = 'init';
  }
  return args;
}

export class UsageError extends Error {}
