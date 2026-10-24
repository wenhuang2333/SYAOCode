import { describe, expect, it } from 'vitest';
import { parseArgs, resolvePermissionTier, UsageError } from '../src/args';
import { runDoctor } from '../src/doctor';
import { exitCodeFor, EXIT_LIMIT, EXIT_OK, EXIT_PERM } from '../src/run';
import type { RunSummary } from '@syaocode/core';

function summary(over: Partial<RunSummary>): RunSummary {
  return {
    sessionId: 's',
    endReason: 'completed',
    turns: 1,
    totalUsage: { inputTokens: 0, outputTokens: 0 },
    finalText: '',
    ...over,
  };
}

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
