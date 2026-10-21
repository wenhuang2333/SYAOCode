import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildCliContext, instructionFileNames, readInstructionFile } from '../src/context';

/** FR-051 / FR-083: project instructions + environment info reach the system prompt. */

const dirs: string[] = [];
function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'syao-ctx-'));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe('buildCliContext', () => {
  it('includes cwd, platform and date in environmentInfo', () => {
    const ctx = buildCliContext('/work/repo', {
      home: '/home/u',
      env: { HOME: '/home/u' },
      now: new Date('2026-10-17T12:00:00Z'),
      platform: 'darwin',
      arch: 'arm64',
    });
    expect(ctx.environmentInfo).toContain('Working directory: /work/repo');
    expect(ctx.environmentInfo).toContain('Platform: darwin (arm64)');
    expect(ctx.environmentInfo).toContain('Date: 2026-10-17');
  });

  it('注入运行载体与模型身份（模型可如实回答自己是谁）', () => {
    const ctx = buildCliContext('/work/repo', {
      home: '/home/u',
      env: { HOME: '/home/u' },
      model: '@zionlin (deepseek-v4.1-flash)',
      harness: 'SYAOCode v0.1.0',
    });
    expect(ctx.environmentInfo).toContain('Harness: SYAOCode v0.1.0');
    expect(ctx.environmentInfo).toContain('Model: @zionlin (deepseek-v4.1-flash)');
    expect(ctx.environmentInfo).toContain('Working directory: /work/repo');
  });

  it('reads repo-root AGENTS.md and user-level instructions', () => {
    const home = tmpDir();
    const repo = tmpDir();
    fs.mkdirSync(path.join(home, '.syaocode'), { recursive: true });
    fs.writeFileSync(path.join(home, '.syaocode', 'AGENTS.md'), 'user rule');
    fs.writeFileSync(path.join(repo, 'AGENTS.md'), 'repo rule');
    const ctx = buildCliContext(repo, { home, env: { HOME: home } });
    expect(ctx.projectInstructions).toContain('user rule');
    expect(ctx.projectInstructions).toContain('repo rule');
    expect(ctx.projectInstructions).toContain('Project instructions');
  });

  it('falls back to CLAUDE.md and honors SYAO_INSTRUCTION_FILES', () => {
    const home = tmpDir();
    const repo = tmpDir();
    fs.writeFileSync(path.join(repo, 'CLAUDE.md'), 'claude rule');
    const fallback = buildCliContext(repo, { home, env: { HOME: home } });
    expect(fallback.projectInstructions).toContain('claude rule');

    fs.writeFileSync(path.join(repo, 'CUSTOM.md'), 'custom rule');
    const custom = buildCliContext(repo, { home, env: { HOME: home, SYAO_INSTRUCTION_FILES: 'CUSTOM.md' } });
    expect(custom.projectInstructions).toContain('custom rule');
    expect(instructionFileNames({ SYAO_INSTRUCTION_FILES: 'A.md, B.md' })).toEqual(['A.md', 'B.md']);
  });

  it('never throws when files are missing or directories', () => {
    const repo = tmpDir();
    fs.mkdirSync(path.join(repo, 'AGENTS.md'));
    const ctx = buildCliContext(repo, { home: tmpDir(), env: {} });
    expect(ctx.projectInstructions).toBeUndefined();
    expect(readInstructionFile(repo)).toBeUndefined();
  });

  it('truncates oversized instruction files instead of failing', () => {
    const repo = tmpDir();
    fs.writeFileSync(path.join(repo, 'AGENTS.md'), 'x'.repeat(40 * 1024));
    const ctx = buildCliContext(repo, { home: tmpDir(), env: {} });
    expect(ctx.projectInstructions).toContain('[truncated at 32768 bytes]');
  });
});
