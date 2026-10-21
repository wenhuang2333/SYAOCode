import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Piped-stdin REPL smoke tests: drive the real interactive loop through a
 * pipe (non-TTY ⇒ headless permission policy applies, BR-042) and assert on
 * its rendered output. HOME is isolated per test.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const tsx = path.join(repoRoot, 'node_modules', '.bin', 'tsx');
const entry = path.join(repoRoot, 'packages', 'cli', 'src', 'main.ts');

function runRepl(
  commands: string[],
  options: {
    env?: Record<string, string | undefined>;
    argv?: string[];
    cwd?: string;
    language?: 'en' | 'zh';
  } = {},
): { stdout: string; code: number } {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'syao-repl-'));
  try {
    if (options.language !== undefined) {
      fs.mkdirSync(path.join(home, '.syaocode'), { recursive: true });
      fs.writeFileSync(
        path.join(home, '.syaocode', 'config.json'),
        JSON.stringify({ language: options.language }),
      );
    }
    const stdout = execFileSync(tsx, [entry, ...(options.argv ?? [])], {
      input: commands.join('\n'),
      encoding: 'utf8',
      timeout: 60_000,
      cwd: options.cwd ?? repoRoot,
      env: {
        ...process.env,
        HOME: home,
        SYAO_MODEL: 'mock:default',
        ...options.env,
      },
    });
    // strip ANSI escapes so assertions match plain text
    return { stdout: stdout.replace(/\x1b\[[0-9;]*m/g, ''), code: 0 };
  } catch (e) {
    const err = e as { stdout?: string; status?: number };
    return { stdout: (err.stdout ?? '').replace(/\x1b\[[0-9;]*m/g, ''), code: err.status ?? 1 };
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

describe('interactive REPL (piped smoke, FR-130/137)', () => {
  it('banner + /help + /status + /exit', () => {
    const { stdout } = runRepl(['/help', '/status', '/exit']);
    expect(stdout).toContain('SYAOCode v0.1 interactive mode');
    expect(stdout).toContain('/model');
    expect(stdout).toContain('Session:');
    expect(stdout).toContain('mock:default');
    expect(stdout).toContain('Goodbye.');
  }, 90_000);

  it('mock conversation renders streamed reply', () => {
    const script = JSON.stringify([
      { id: 'a1', role: 'assistant', content: [{ type: 'text', text: '你好，来自 mock 的回复' }], meta: { createdAt: 0 } },
    ]);
    const { stdout } = runRepl(['打个招呼', '/exit'], { env: { SYAO_MOCK_SCRIPT: script } });
    expect(stdout).toContain('你好，来自 mock 的回复');
    expect(stdout).toContain('Goodbye.');
  }, 90_000);

  it('headless permission policy denies write with SY-CLI-002 notice (BR-042)', () => {
    const script = JSON.stringify([
      { id: 'a1', role: 'assistant', content: [{ type: 'tool_use', id: 'c1', name: 'write', input: { path: 'x.txt', content: 'nope' } }], meta: { createdAt: 0 } },
      { id: 'a2', role: 'assistant', content: [{ type: 'text', text: '写入被拒' }], meta: { createdAt: 0 } },
    ]);
    const { stdout } = runRepl(['写点东西', '/exit'], { env: { SYAO_MOCK_SCRIPT: script } });
    expect(stdout).toContain('headless mode auto-denies');
    expect(stdout).toContain('SY-CLI-002');
  }, 90_000);

  it('/model show + /model list render catalog and key status', () => {
    const { stdout } = runRepl(['/model', '/model list', '/exit']);
    expect(stdout).toContain('Current model');
    expect(stdout).toContain('deepseek:deepseek-chat');
    expect(stdout).toContain('Provider catalog');
  }, 90_000);

  it('/permissions shows mode and switches it (bare launch starts at default)', () => {
    const { stdout } = runRepl(['/permissions', '/permissions mode acceptEdits', '/permissions', '/exit']);
    expect(stdout).toContain('Permission mode: default');
    expect(stdout).toContain('switched to acceptEdits');
    expect(stdout).toContain('Permission mode: acceptEdits');
  }, 90_000);

  it('/permission switches the three-tier level directly (strict/HuangAura/WenNova)', () => {
    const { stdout } = runRepl([
      '/permission',
      '/permission HuangAura',
      '/permission',
      '/permission WenNova',
      '/permission strict',
      '/permission 不存在',
      '/exit',
    ]);
    // 无参数：档位速查面板（含三档）
    expect(stdout).toContain('Permission tiers (/permission <tier> switches immediately');
    expect(stdout).toContain('strict');
    expect(stdout).toContain('WenNova');
    // 直接切换三档
    expect(stdout).toContain('Permission tier switched to HuangAura');
    expect(stdout).toContain('Permission mode: default');
    expect(stdout).toContain('Permission tier switched to WenNova');
    expect(stdout).toContain('Permission tier switched to strict');
    // 非法参数给出用法
    expect(stdout).toContain('Usage: /permission [strict|HuangAura|WenNova]');
  }, 90_000);

  it('!command runs read-only shell through the gate; dangerous is refused', () => {
    const { stdout } = runRepl(['!echo syao-shell-ok', '!rm -rf /', '/exit'], { argv: ['--HuangAura'] });
    expect(stdout).toContain('syao-shell-ok');
    expect(stdout).toContain('Denied');
    expect(stdout).toContain('SY-PERM-004');
  }, 90_000);

  it('planned commands are clearly stubbed', () => {
    const { stdout } = runRepl(['/mcp', '/goal', '/exit']);
    expect(stdout).toContain('later milestone');
  }, 90_000);

  it('/doctor inside the REPL matches the doctor subcommand', () => {
    const { stdout } = runRepl(['/doctor', '/exit']);
    expect(stdout).toContain('node');
    expect(stdout).toContain('workspace-writable');
  }, 90_000);

  // ── three-tier permission behavior (strict / --HuangAura / --WenNova) ──

  const readScript = JSON.stringify([
    { id: 'a1', role: 'assistant', content: [{ type: 'tool_use', id: 'c1', name: 'read', input: { path: 'tier.txt' } }], meta: { createdAt: 0 } },
    { id: 'a2', role: 'assistant', content: [{ type: 'text', text: '读取完成' }], meta: { createdAt: 0 } },
  ]);
  const writeScript = JSON.stringify([
    { id: 'a1', role: 'assistant', content: [{ type: 'tool_use', id: 'c1', name: 'write', input: { path: 'tier-out.txt', content: 'written' } }], meta: { createdAt: 0 } },
    { id: 'a2', role: 'assistant', content: [{ type: 'text', text: '写入完成' }], meta: { createdAt: 0 } },
  ]);

  it('bare launch (default tier): reads pass, no approval prompt in headless mode', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'syao-tier-'));
    try {
      fs.writeFileSync(path.join(dir, 'tier.txt'), 'default-tier-read-ok\n');
      const { stdout } = runRepl(['读一下 tier.txt', '/exit'], {
        argv: ['--cwd', dir],
        env: { SYAO_MOCK_SCRIPT: readScript },
      });
      expect(stdout).toContain('default-tier-read-ok');
      expect(stdout).not.toContain('SY-CLI-002');
      expect(stdout).toContain('读取完成');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 90_000);

  it('--HuangAura: reads pass without asking, writes still ask', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'syao-tier-'));
    try {
      fs.writeFileSync(path.join(dir, 'tier.txt'), 'huang-aura-read-ok\n');
      const read = runRepl(['读一下 tier.txt', '/exit'], {
        argv: ['--HuangAura', '--cwd', dir],
        env: { SYAO_MOCK_SCRIPT: readScript },
      });
      expect(read.stdout).not.toContain('SY-CLI-002'); // reads never asked
      expect(read.stdout).toContain('huang-aura-read-ok');

      const write = runRepl(['写入 tier-out.txt', '/exit'], {
        argv: ['--HuangAura', '--cwd', dir],
        env: { SYAO_MOCK_SCRIPT: writeScript },
      });
      expect(write.stdout).toContain('SY-CLI-002'); // writes still ask → deny headless
      expect(fs.existsSync(path.join(dir, 'tier-out.txt'))).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);

  it('--WenNova: writes execute without any asking', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'syao-tier-'));
    try {
      const write = runRepl(['写入 tier-out.txt', '/exit'], {
        argv: ['--WenNova', '--cwd', dir],
        env: { SYAO_MOCK_SCRIPT: writeScript },
      });
      expect(write.stdout).not.toContain('SY-CLI-002'); // nothing asked under WenNova
      expect(write.stdout).toContain('Wrote');
      expect(fs.existsSync(path.join(dir, 'tier-out.txt'))).toBe(true);
      expect(fs.readFileSync(path.join(dir, 'tier-out.txt'), 'utf8')).toBe('written');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 90_000);

  it('banner shows the active permission tier', () => {
    const bare = runRepl(['/exit']);
    expect(bare.stdout).toContain('partial (--HuangAura)');
    const strict = runRepl(['/exit'], { argv: ['--permission-mode', 'strict'] });
    expect(strict.stdout).toContain('strict: every action requires confirmation');
    const nova = runRepl(['/exit'], { argv: ['--WenNova'] });
    expect(nova.stdout).toContain('full (--WenNova)');
    const aura = runRepl(['/exit'], { argv: ['--HuangAura'] });
    expect(aura.stdout).toContain('partial (--HuangAura)');
  }, 120_000);

  it('persisted language=zh switches the whole REPL to Chinese (and back)', () => {
    const zh = runRepl(['/help', '/status', '/exit'], { language: 'zh' });
    expect(zh.stdout).toContain('SYAOCode v0.1 交互模式');
    expect(zh.stdout).toContain('可用命令');
    expect(zh.stdout).toContain('会话：');
    expect(zh.stdout).toContain('再见。');
    expect(zh.stdout).not.toContain('Available commands');

    const en = runRepl(['/help', '/exit'], { language: 'en' });
    expect(en.stdout).toContain('Available commands');
    expect(en.stdout).not.toContain('可用命令');
  }, 120_000);
});
