import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { parseArgs, resolvePermissionTier, UsageError } from '../src/args';
import { runDoctor } from '../src/doctor';
import {
  exitCodeFor,
  EXIT_LIMIT,
  EXIT_OK,
  EXIT_PERM,
  EXIT_UNVERIFIED,
  EXIT_VERIFICATION_FAILED,
} from '../src/run';
import { loadCliConfig } from '../src/effective-config';
import { nodeRuntime } from '@syaocode/node';
import type { RunSummary } from '@syaocode/core';

function summary(over: Partial<RunSummary>): RunSummary {
  return {
    sessionId: 's',
    endReason: 'completed',
    turns: 1,
    totalUsage: { inputTokens: 0, outputTokens: 0 },
    permissionDenied: false,
    verdict: 'not_run',
    claims: [],
    toolReceipts: [],
    finalText: '',
    ...over,
  };
}

describe('exitCodeFor (BR-042)', () => {
  it('maps limits, permission denials and verification outcomes', () => {
    expect(exitCodeFor(summary({}))).toBe(EXIT_OK);
    expect(exitCodeFor(summary({ permissionDenied: true }))).toBe(EXIT_PERM);
    expect(exitCodeFor(summary({ endReason: 'max_turns' }))).toBe(EXIT_LIMIT);
    expect(exitCodeFor(summary({ endReason: 'unverified', verdict: 'unverified' }))).toBe(EXIT_UNVERIFIED);
    expect(exitCodeFor(summary({ endReason: 'verification_failed', verdict: 'failed' }))).toBe(EXIT_VERIFICATION_FAILED);
  });
});

describe('effective config (report E2/E3/E4)', () => {
  it('layers CLI default < project < env < flags', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'syao-config-'));
    const project = path.join(tmp, 'project');
    fs.mkdirSync(path.join(project, '.syaocode'), { recursive: true });
    fs.writeFileSync(path.join(project, '.syaocode', 'config.json'), JSON.stringify({ permissionMode: 'acceptEdits' }));
    const oldHome = process.env.HOME;
    const oldMode = process.env.SYAO_PERMISSION_MODE;
    process.env.HOME = tmp;
    delete process.env.SYAO_PERMISSION_MODE;
    try {
      const base = await loadCliConfig({ cwd: project, allowedTools: [], disallowedTools: [] }, nodeRuntime());
      expect(base.permissionMode).toBe('acceptEdits'); // project beats CLI default

      process.env.SYAO_PERMISSION_MODE = 'plan';
      const env = await loadCliConfig({ cwd: project, allowedTools: [], disallowedTools: [] }, nodeRuntime());
      expect(env.permissionMode).toBe('plan'); // env beats project

      const flag = await loadCliConfig(
        { cwd: project, si: true, allowedTools: ['read'], disallowedTools: [] },
        nodeRuntime(),
      );
      expect(flag.permissionMode).toBe('bypass'); // flag beats env/project
      expect(flag.rules.some((r) => r.effect === 'allow' && r.tool === 'read')).toBe(true);
    } finally {
      if (oldHome === undefined) delete process.env.HOME;
      else process.env.HOME = oldHome;
      if (oldMode === undefined) delete process.env.SYAO_PERMISSION_MODE;
      else process.env.SYAO_PERMISSION_MODE = oldMode;
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('policy file (report v0.2.5)', () => {
  it('applies declared mode/rules/limits; explicit flags still win', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'syao-policy-'));
    const policy = path.join(tmp, 'policy.json');
    fs.writeFileSync(
      policy,
      JSON.stringify({
        permissionMode: 'plan',
        allowedTools: ['read'],
        rules: [{ effect: 'deny', tool: 'bash', match: { command: 'curl *' }, source: 'user' }],
        limits: { maxTotalTokens: 99, maxTurns: 7 },
      }),
    );
    const oldHome = process.env.HOME;
    process.env.HOME = tmp;
    try {
      const config = await loadCliConfig({ cwd: tmp, policy, allowedTools: [], disallowedTools: [] }, nodeRuntime());
      expect(config.permissionMode).toBe('plan');
      expect(config.limits.maxTotalTokens).toBe(99);
      expect(config.limits.maxTurns).toBe(7);
      expect(config.rules.some((r) => r.effect === 'allow' && r.tool === 'read')).toBe(true);
      expect(config.rules.some((r) => r.effect === 'deny' && r.match?.command === 'curl *')).toBe(true);

      const flagged = await loadCliConfig(
        { cwd: tmp, policy, si: true, maxTotalTokens: 5, allowedTools: [], disallowedTools: [] },
        nodeRuntime(),
      );
      expect(flagged.permissionMode).toBe('bypass');
      expect(flagged.limits.maxTotalTokens).toBe(5);
    } finally {
      if (oldHome === undefined) delete process.env.HOME;
      else process.env.HOME = oldHome;
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('rejects malformed policy with SY-CFG-001', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'syao-policy-'));
    const policy = path.join(tmp, 'policy.json');
    fs.writeFileSync(policy, JSON.stringify({ rules: [{ effect: 'maybe', tool: 'read' }] }));
    const oldHome = process.env.HOME;
    process.env.HOME = tmp;
    try {
      await expect(
        loadCliConfig({ cwd: tmp, policy, allowedTools: [], disallowedTools: [] }, nodeRuntime()),
      ).rejects.toSatisfy((e) => e instanceof Error && e.message.includes('Invalid rule in policy file'));
    } finally {
      if (oldHome === undefined) delete process.env.HOME;
      else process.env.HOME = oldHome;
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('parseArgs (FR-135 subset)', () => {
  it('parses -p with prompt and output format', () => {
    const args = parseArgs(['-p', 'do it', '--output-format', 'stream-json']);
    expect(args.print).toBe(true);
    expect(args.positional).toEqual(['do it']);
    expect(args.outputFormat).toBe('stream-json');
  });

  it('parses exec subcommand and tool lists', () => {
    const args = parseArgs(['exec', 'fix it', '--allowed-tools', 'read', 'grep', '--disallowed-tools', 'bash']);
    expect(args.command).toBe('exec');
    expect(args.print).toBe(true);
    expect(args.allowedTools).toEqual(['read', 'grep']);
    expect(args.disallowedTools).toEqual(['bash']);
  });

  it('rejects unknown options and bad enum values with SY-CLI-001 note', () => {
    expect(() => parseArgs(['--nope'])).toThrow(UsageError);
    expect(() => parseArgs(['--output-format', 'yaml'])).toThrow(/SY-CLI-001/);
    expect(() => parseArgs(['--permission-mode', 'yolo'])).toThrow(/SY-CLI-001/);
  });

  it('parses limits and model', () => {
    const args = parseArgs(['-p', 'x', '--max-turns', '5', '--max-budget-usd', '0.5', '-m', 'mock:default']);
    expect(args.maxTurns).toBe(5);
    expect(args.maxBudgetUsd).toBe(0.5);
    expect(args.model).toBe('mock:default');
  });
});

describe('three-tier permission flags', () => {
  it('parses --si / --yao and rejects mixing them', () => {
    expect(parseArgs(['--si']).si).toBe(true);
    expect(parseArgs(['--yao']).yao).toBe(true);
    expect(() => parseArgs(['--si', '--yao'])).toThrow(/mutually exclusive/);
  });

  it('resolvePermissionTier maps the ladder: bare→default(reads pass), yao→default, si→bypass', () => {
    expect(resolvePermissionTier({ si: false, yao: false })).toEqual({
      mode: 'default',
      tier: 'yao',
      source: 'default',
    });
    expect(resolvePermissionTier({ si: false, yao: true }).mode).toBe('default');
    expect(resolvePermissionTier({ si: true, yao: false }).mode).toBe('bypass');
    // explicit --permission-mode wins over tier flags
    expect(resolvePermissionTier({ permissionMode: 'plan', si: true, yao: false }).mode).toBe('plan');
    // saved user config beats the bare default
    expect(resolvePermissionTier({ si: false, yao: false }, 'acceptEdits').mode).toBe('acceptEdits');
    // --permission-mode now accepts strict
    expect(parseArgs(['--permission-mode', 'strict']).permissionMode).toBe('strict');
  });
});

describe('exit codes (BR-042)', () => {
  it('maps end reasons to 0/3/4', () => {
    expect(exitCodeFor(summary({ endReason: 'completed' }))).toBe(EXIT_OK);
    expect(exitCodeFor(summary({ endReason: 'max_turns' }))).toBe(EXIT_LIMIT);
    expect(exitCodeFor(summary({ endReason: 'budget_exhausted' }))).toBe(EXIT_LIMIT);
    expect(exitCodeFor(summary({ endReason: 'timeout' }))).toBe(EXIT_LIMIT);
  });
});

describe('doctor (FR-173)', () => {
  it('runs without keys, hides values, flags nothing fatal on a sane host', () => {
    const checks = runDoctor(process.cwd());
    expect(checks.length).toBeGreaterThan(5);
    const node = checks.find((c) => c.name === 'node');
    expect(node?.status).toBe('ok');
    for (const c of checks) {
      // secrets never printed (BR-023)
      expect(c.detail).not.toMatch(/sk-[A-Za-z0-9]{10,}/);
    }
    const providerChecks = checks.filter((c) => c.name.startsWith('provider-'));
    expect(providerChecks.length).toBe(3);
  });
});
