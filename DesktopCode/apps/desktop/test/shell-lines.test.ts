/**
 * `!` 前缀本地命令（FR-N-036）：纯函数 + 静态渲染 + 源码契约。
 *
 * 风格沿用 `git-sidebar.test.ts` / `detail-sections.test.ts`：
 * 纯函数直接断言，组件用 `renderToStaticMarkup` 做静态标记断言。
 * **不引入 jsdom / Playwright**：这里没有真实 DOM，也没有浏览器依赖。
 */

import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { SessionRunCommandResult } from '@liwencode/dhp';
import { SHELL_HINT } from '../src/renderer/composer-palette.tsx';
import {
  ShellResultBlock,
  denialReason,
  isShellCommand, shellCommandOf, shellOutputText, shellResultSummary, shellResultTone,
  shellTruncatedNote, shouldKeepDraft, type ShellOutcome,
} from '../src/renderer/shell-lines.tsx';

const ROOT = path.resolve(__dirname, '..');
const read = (p: string): string => readFileSync(path.join(ROOT, p), 'utf8');

const result = (overrides: Partial<SessionRunCommandResult> = {}): SessionRunCommandResult => ({
  sessionId: 's-1',
  command: 'ls',
  exitCode: 0,
  stdout: 'a.txt\nb.txt\n',
  stderr: '',
  truncated: false,
  timedOut: false,
  durationMs: 42,
  ...overrides,
});

const ok = (overrides: Partial<SessionRunCommandResult> = {}): ShellOutcome => ({ result: result(overrides) });
const failed = (overrides: Partial<SessionRunCommandResult> = {}): ShellOutcome => ({ result: result({ exitCode: 2, ...overrides }) });
const denied = (message = '命令被权限规则拒绝：rm 属于危险命令'): ShellOutcome => ({ denial: { kind: 'command_denied', message } });
const timeout = (): ShellOutcome => ({ result: result({ timedOut: true, exitCode: 1 }) });

describe('isShellCommand / shellCommandOf', () => {
  it('recognises the `!` prefix only at the start', () => {
    expect(isShellCommand('!ls')).toBe(true);
    expect(isShellCommand('  ! ls')).toBe(true);
    expect(isShellCommand('!\nls')).toBe(true);
    expect(isShellCommand('ls')).toBe(false);
    expect(isShellCommand('echo !')).toBe(false);
    expect(isShellCommand('')).toBe(false);
    expect(isShellCommand('  ')).toBe(false);
  });

  it('strips the bang and leading whitespace', () => {
    expect(shellCommandOf('!ls')).toBe('ls');
    expect(shellCommandOf('  ! ls -la  ')).toBe('ls -la');
    expect(shellCommandOf('!git status')).toBe('git status');
    // 空命令：剥完是空串，界面应当拒绝提交。
    expect(shellCommandOf('!')).toBe('');
    expect(shellCommandOf('!   ')).toBe('');
    expect(shellCommandOf('ls')).toBe('ls');
  });
});

describe('shellResultTone / shellResultSummary', () => {
  it('maps the four outcomes to distinct tones', () => {
    expect(shellResultTone(ok())).toBe('ok');
    expect(shellResultTone(failed())).toBe('failed');
    expect(shellResultTone(denied())).toBe('denied');
    expect(shellResultTone(timeout())).toBe('timeout');
    // 被信号杀死（负退出码）也是失败，不是成功。
    expect(shellResultTone(ok({ exitCode: -1 }))).toBe('failed');
  });

  it('gives four distinct summaries and never calls a denial a success', () => {
    const summaries = [ok(), failed(), denied(), timeout()].map((outcome) => shellResultSummary(outcome));
    expect(new Set(summaries).size).toBe(4);
    expect(shellResultSummary(ok())).toContain('退出码 0');
    expect(shellResultSummary(failed())).toContain('退出码 2');
    expect(shellResultSummary(timeout())).toContain('超时');
    expect(shellResultSummary(timeout())).toContain('60 s');
    const deniedText = shellResultSummary(denied());
    expect(deniedText).toContain('拒绝');
    expect(deniedText).not.toContain('成功');
    expect(deniedText).toContain('rm');
    // 拒绝原因不会重复前缀。
    expect(denialReason({ message: '命令被权限规则拒绝：rm 属于危险命令' })).toBe('rm 属于危险命令');
    expect(denialReason(undefined)).toBe('');
  });

  it('reports a transport failure without pretending it succeeded', () => {
    const outcome: ShellOutcome = { error: '本地运行时未连接' };
    expect(shellResultTone(outcome)).toBe('failed');
    expect(shellResultSummary(outcome)).toContain('本地运行时未连接');
    expect(shellResultSummary(outcome)).not.toContain('成功');
  });
});

describe('shellOutputText / shellTruncatedNote / shouldKeepDraft', () => {
  it('merges stdout and stderr with an explicit separator', () => {
    expect(shellOutputText(result({ stdout: 'out', stderr: '' }))).toBe('out');
    expect(shellOutputText(result({ stdout: '', stderr: 'boom' }))).toBe('--- stderr ---\nboom');
    expect(shellOutputText(result({ stdout: 'out', stderr: 'boom' }))).toBe('out\n--- stderr ---\nboom');
    const empty = shellOutputText(result({ stdout: '', stderr: '' }));
    expect(empty).not.toBe('');
    expect(empty).toContain('没有输出');
    // 换行必须保留（等宽 <pre> 里直接渲染）。
    expect(shellOutputText(result({ stdout: 'l1\nl2\n', stderr: '' }))).toBe('l1\nl2\n');
  });

  it('spells out truncation and keeps the draft only on failure', () => {
    expect(shellTruncatedNote(result({ truncated: true }))).toContain('已截断');
    expect(shellTruncatedNote(result({ truncated: true }))).toContain('256 KiB');
    expect(shellTruncatedNote(result())).toBe('');
    expect(shouldKeepDraft(ok())).toBe(false);
    expect(shouldKeepDraft(failed())).toBe(true);
    expect(shouldKeepDraft(denied())).toBe(true);
    expect(shouldKeepDraft(timeout())).toBe(true);
  });
});

describe('ShellResultBlock static rendering', () => {
  const render = (outcome: ShellOutcome | undefined, command = 'ls -la', pending = false): string =>
    renderToStaticMarkup(createElement(ShellResultBlock, { command, outcome, pending }));

  it('labels the block as a local command that was never sent to the model', () => {
    const html = render(ok());
    expect(html).toContain('本地命令');
    expect(html).toContain('未发送给模型');
    expect(html).toContain('shell-line');
    expect(html).toContain('ls -la');
    expect(html).toContain('a.txt');
    expect(html).toContain('退出码 0');
  });

  it('shows a distinct status for each tone', () => {
    expect(render(ok())).toContain('shell-line-ok');
    expect(render(failed())).toContain('shell-line-failed');
    expect(render(timeout())).toContain('shell-line-timeout');
    expect(render(timeout())).toContain('超时');
    const deniedHtml = render(denied());
    expect(deniedHtml).toContain('shell-line-denied');
    expect(deniedHtml).toContain('拒绝');
    expect(deniedHtml).not.toContain('成功');
    // 被拒时不显示任何输出块（没执行就没有输出）。
    expect(deniedHtml).not.toContain('shell-line-output');
  });

  it('says the output was truncated', () => {
    const html = render(ok({ truncated: true }));
    expect(html).toContain('已截断');
    expect(html).toContain('256 KiB');
  });

  it('shows a pending state instead of a fake result', () => {
    const html = render(undefined, 'sleep 5', true);
    expect(html).toContain('执行中');
    expect(html).not.toContain('退出码');
    expect(html).not.toContain('shell-line-ok');
  });
});

describe('source contracts: `!` never goes through send', () => {
  it('routes the `!` branch to runShellCommand', () => {
    const source = read('src/renderer/workbench.tsx');
    expect(source).toContain('isShellCommand');
    expect(source).toContain('submitShell');
    expect(source).toContain('w.runShellCommand');
    expect(source).toContain('ShellResultBlock');
    // `!` 分支必须早于 w.send 返回，命令不会被当成消息。
    const branch = source.indexOf('if (isShellCommand(text))');
    expect(branch).toBeGreaterThan(-1);
    const sendCall = source.indexOf('void w.send(text)', branch);
    expect(sendCall).toBeGreaterThan(branch);
    expect(source.slice(branch, sendCall)).toContain('return');
  });

  it('no longer claims the feature is unimplemented', () => {
    expect(SHELL_HINT).not.toContain('尚未接入');
    expect(SHELL_HINT).toContain('权限闸门');
    const hook = read('src/renderer/use-workbench.ts');
    expect(hook).toContain('FeatureMethod.SessionRunCommand');
    expect(hook).toContain('runShellCommand');
  });

  it('recognises a denial even when the transport drops the kind field', () => {
    const source = read('src/renderer/workbench.tsx');
    expect(source).toContain('command_denied');
    expect(source).toContain('-32047');
  });

  it('keeps shell rows out of the session history (renderer-only state)', () => {
    const source = read('src/renderer/workbench.tsx');
    // 本地行来自组件 state，而不是 snapshot.rows。
    expect(source).toContain('setShellLines');
    expect(source).not.toContain('snapshot.rows = ');
    expect(source).toContain('setShellLines([]);');
  });
});
