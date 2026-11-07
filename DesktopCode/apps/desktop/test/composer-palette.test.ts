/**
 * 输入区 `/` 命令面板与 `@` 文件引用（`27` §4.4 / FR-N-036）的界面契约测试。
 *
 * 风格与 `dashboard-pages.test.ts` / `git-sidebar.test.ts` 一致：
 * **不引入浏览器 / jsdom / Playwright**。纯函数直接断言；组件用
 * `renderToStaticMarkup` 做静态标记断言（不是 DOM 测试）；源码用 `readFileSync` 做静态契约断言。
 */

import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { TreeNode } from '@syaocode/dhp';
import { t } from '../src/renderer/i18n.ts';
import {
  COMMANDS, ComposerPalette, FILE_LIMIT, HELP_TEXT, SHELL_HINT,
  applyCommand, applyMention, collectFilePaths, detectTrigger, filterFiles, matchCommands, shellHintFor,
  type ComposerPaletteProps,
} from '../src/renderer/composer-palette.tsx';

const ROOT = path.resolve(__dirname, '..');
const read = (p: string): string => readFileSync(path.join(ROOT, p), 'utf8');

const render = (overrides: Partial<ComposerPaletteProps> = {}): string => renderToStaticMarkup(createElement(ComposerPalette, {
  text: '/',
  caret: 1,
  files: [],
  filesLoading: false,
  filesError: '',
  canStop: false,
  disabled: false,
  onAction: () => { throw new Error('Rendering must not execute commands'); },
  onText: () => { throw new Error('Rendering must not change text'); },
  ...overrides,
}));

const file = (name: string, filePath: string, children?: readonly TreeNode[]): TreeNode => children
  ? { name, path: filePath, type: 'dir', children }
  : { name, path: filePath, type: 'file' };

describe('detectTrigger: `/` only at the beginning, `@` anywhere', () => {
  it('detects a bare slash at the start of the input', () => {
    expect(detectTrigger('/', 1)).toEqual({ kind: 'slash', query: '', start: 0, end: 1 });
    expect(detectTrigger('/new', 4)).toEqual({ kind: 'slash', query: 'new', start: 0, end: 4 });
  });
  it('allows leading whitespace before the slash', () => {
    expect(detectTrigger('  /he', 5)).toEqual({ kind: 'slash', query: 'he', start: 2, end: 5 });
  });
  it('does not trigger on a slash inside a word or path', () => {
    expect(detectTrigger('src/main.ts', 11)).toBeNull();
    expect(detectTrigger('hello /new', 10)).toBeNull();
    expect(detectTrigger('https://example.com/a', 22)).toBeNull();
  });
  it('stops treating the input as a command once the caret leaves the command word', () => {
    expect(detectTrigger('/new hello', 6)).toBeNull();
    expect(detectTrigger('/new ', 5)).toBeNull();
  });
  it('uses the caret position, not the token end, for the filter query', () => {
    const trigger = detectTrigger('/new', 2);
    expect(trigger).toEqual({ kind: 'slash', query: 'n', start: 0, end: 4 });
    expect(detectTrigger('/new', 99)).toEqual({ kind: 'slash', query: 'new', start: 0, end: 4 });
  });
  it('detects `@` at the beginning and in the middle of the input', () => {
    expect(detectTrigger('@', 1)).toEqual({ kind: 'mention', query: '', start: 0, end: 1 });
    expect(detectTrigger('请看 @src', 7)).toEqual({ kind: 'mention', query: 'src', start: 3, end: 7 });
    expect(detectTrigger('@src/a.ts', 9)).toEqual({ kind: 'mention', query: 'src/a.ts', start: 0, end: 9 });
  });
  it('falls through to `@` after a command word', () => {
    expect(detectTrigger('/new @src', 10)).toEqual({ kind: 'mention', query: 'src', start: 5, end: 9 });
  });
  it('stops the mention fragment at Chinese punctuation instead of swallowing prose', () => {
    const text = '@src/a.ts，谢谢';
    // 光标停在逗号前：引用片段就是文件路径。
    expect(detectTrigger(text, 9)).toEqual({ kind: 'mention', query: 'src/a.ts', start: 0, end: 9 });
    // 光标在标点之后：引用已经结束，不再弹面板。
    expect(detectTrigger(text, text.length)).toBeNull();
  });
  it('uses the caret for the mention query too', () => {
    expect(detectTrigger('@src/a.ts', 5)).toEqual({ kind: 'mention', query: 'src/', start: 0, end: 9 });
  });
  it('does not treat an email-like `@` as a file reference', () => {
    expect(detectTrigger('test@example.com', 16)).toBeNull();
    expect(detectTrigger('a@b', 3)).toBeNull();
  });
  it('returns null when there is no trigger', () => {
    expect(detectTrigger('', 0)).toBeNull();
    expect(detectTrigger('普通消息', 4)).toBeNull();
  });
});

describe('matchCommands: fixed order, case-insensitive prefix / contains', () => {
  it('returns every command for an empty query, in the fixed order', () => {
    expect(matchCommands('')).toBe(COMMANDS);
    expect(COMMANDS.map((command) => command.id)).toEqual(['new', 'model', 'permission', 'stop', 'archive', 'git', 'detail', 'usage', 'help']);
  });
  it('matches by prefix and by contained text, case-insensitively', () => {
    expect(matchCommands('ne').map((command) => command.id)).toEqual(['new']);
    expect(matchCommands('NEW').map((command) => command.id)).toEqual(['new']);
    expect(matchCommands('stop').map((command) => command.id)).toEqual(['stop']);
    expect(matchCommands('权限').map((command) => command.id)).toEqual(['permission']);
    expect(matchCommands('e').map((command) => command.id)).toEqual(['new', 'model', 'permission', 'archive', 'detail', 'usage', 'help']);
  });
  it('returns nothing when nothing matches', () => {
    expect(matchCommands('zzz')).toEqual([]);
  });
  it('exposes the trigger keys used for display and completion', () => {
    expect(COMMANDS.every((command) => command.keys[0] === `/${command.id}`)).toBe(true);
    expect(COMMANDS.every((command) => command.title.length > 0 && command.hint.length > 0)).toBe(true);
  });
});

describe('applyCommand: remove the trigger and report the action', () => {
  const triggerOf = (text: string, caret: number) => {
    const trigger = detectTrigger(text, caret);
    if (!trigger) throw new Error(`expected a trigger for ${text}`);
    return trigger;
  };
  it('deletes `/new` and never sends the trigger text', () => {
    const result = applyCommand('/new', triggerOf('/new', 4), 'new', 4);
    expect(result.text).toBe('');
    expect(result.caret).toBe(0);
    expect(result.action).toEqual({ kind: 'new' });
    expect(result.text).not.toContain('/new');
  });
  it('keeps the surrounding text when the command is typed mid-draft', () => {
    const result = applyCommand('/new hello', triggerOf('/new hello', 4), 'new', 4);
    expect(result.text).toBe(' hello');
    expect(result.caret).toBe(0);
    expect(result.text).not.toContain('/new');
  });
  it('preserves leading whitespace', () => {
    const result = applyCommand('  /model', triggerOf('  /model', 8), 'model', 8);
    expect(result.text).toBe('  ');
    expect(result.caret).toBe(2);
    expect(result.action).toEqual({ kind: 'model' });
  });
  it('removes the whole command token even when the caret sits in the middle', () => {
    const result = applyCommand('/new', triggerOf('/new', 2), 'new', 2);
    expect(result.text).toBe('');
    expect(result.caret).toBe(0);
  });
  it('inserts help text for /help instead of executing anything', () => {
    const result = applyCommand('/help', triggerOf('/help', 5), 'help', 5);
    expect(result.action).toEqual({ kind: 'insert', text: HELP_TEXT });
    expect(result.text).toBe(HELP_TEXT);
    expect(result.caret).toBe(HELP_TEXT.length);
    expect(result.text).toContain('/permission');
    expect(result.text).toContain('Shift Enter');
  });
  it('leaves the text untouched for an unknown command or a stale trigger', () => {
    expect(applyCommand('/new', triggerOf('/new', 4), 'nope', 4)).toEqual({ text: '/new', caret: 4, action: { kind: 'none' } });
    const mention = triggerOf('@src', 4);
    expect(applyCommand('@src', mention, 'new', 4)).toEqual({ text: '@src', caret: 4, action: { kind: 'none' } });
  });
});

describe('applyMention: replace only the active `@fragment`', () => {
  it('replaces the fragment with `@<relative path>` and keeps surrounding text', () => {
    const trigger = detectTrigger('请看 @src', 7)!;
    const result = applyMention('请看 @src', trigger, 'src/a.ts');
    expect(result.text).toBe('请看 @src/a.ts');
    expect(result.caret).toBe('请看 '.length + '@src/a.ts'.length);
  });
  it('replaces only the current mention when the draft has several', () => {
    const text = 'a @x b @y';
    const trigger = detectTrigger(text, text.length)!;
    const result = applyMention(text, trigger, 'z.ts');
    expect(result.text).toBe('a @x b @z.ts');
    expect(result.text).toContain('@x');
    expect(result.caret).toBe('a @x b '.length + '@z.ts'.length);
  });
  it('keeps trailing text after the mention', () => {
    const text = '@a tail';
    const result = applyMention(text, detectTrigger(text, 2)!, 'file.ts');
    expect(result.text).toBe('@file.ts tail');
    expect(result.caret).toBe('@file.ts'.length);
  });
  it('does nothing for a non-mention trigger', () => {
    const trigger = detectTrigger('/new', 4)!;
    expect(applyMention('/new', trigger, 'a.ts')).toEqual({ text: '/new', caret: 0 });
  });
});

describe('filterFiles and collectFilePaths', () => {
  it('filters case-insensitively by path substring', () => {
    const paths = ['src/A.ts', 'docs/readme.md', 'src/component/Button.tsx'];
    expect(filterFiles(paths, 'a.TS')).toEqual(['src/A.ts']);
    expect(filterFiles(paths, 'button')).toEqual(['src/component/Button.tsx']);
    expect(filterFiles(paths, 'read')).toEqual(['docs/readme.md']);
  });
  it('returns every path for an empty query and nothing for a miss', () => {
    const paths = ['a.ts', 'b.ts'];
    expect(filterFiles(paths, '')).toEqual(paths);
    expect(filterFiles(paths, '   ')).toEqual(paths);
    expect(filterFiles(paths, 'zzz')).toEqual([]);
  });
  it(`caps the list at ${FILE_LIMIT} entries`, () => {
    const paths = Array.from({ length: 60 }, (_, index) => `f${index}.ts`);
    const result = filterFiles(paths, '');
    expect(result).toHaveLength(FILE_LIMIT);
    expect(result[0]).toBe('f0.ts');
    expect(result[FILE_LIMIT - 1]).toBe(`f${FILE_LIMIT - 1}.ts`);
  });
  it('flattens a workspace tree into file paths only', () => {
    const nodes: readonly TreeNode[] = [
      file('src', 'src', [file('a.ts', 'src/a.ts'), file('nested', 'src/nested', [file('b.ts', 'src/nested/b.ts')])]),
      file('README.md', 'README.md'),
    ];
    expect(collectFilePaths(nodes)).toEqual(['src/a.ts', 'src/nested/b.ts', 'README.md']);
    expect(collectFilePaths(undefined)).toEqual([]);
  });
});

describe('shellHintFor: `!` runs locally behind the permission gate', () => {
  it('returns the honest hint for drafts starting with `!`', () => {
    expect(shellHintFor('!ls')).toBe(SHELL_HINT);
    expect(shellHintFor('  !git status')).toBe(SHELL_HINT);
    expect(shellHintFor('!')).toBe(SHELL_HINT);
    // `!` 现在会真的执行（FR-N-036），提示里不再有“尚未接入”。
    expect(SHELL_HINT).not.toContain('尚未接入');
    expect(SHELL_HINT).toContain('执行');
    expect(SHELL_HINT).toContain('权限闸门');
  });
  it('returns null for anything else', () => {
    expect(shellHintFor('ls')).toBeNull();
    expect(shellHintFor('')).toBeNull();
    expect(shellHintFor('echo !')).toBeNull();
  });
});

describe('ComposerPalette static render', () => {
  it('renders the slash command panel with every command and a selected option', () => {
    const html = render();
    expect(html).toContain('role="listbox"');
    // 文案现在从目录取值（不再写死在组件里）。
    expect(html).toContain(`aria-label="${t('zh', 'palette.commandListLabel')}"`);
    for (const command of COMMANDS) expect(html).toContain(command.title);
    expect(html).toContain('aria-selected="true"');
    expect(html.match(/aria-selected="true"/g)).toHaveLength(1);
    expect(html).not.toContain('没有匹配的命令');
  });
  it('shows an explicit empty state when no command matches', () => {
    const html = render({ text: '/zzz', caret: 4 });
    expect(html).toContain('没有匹配的命令');
    expect(html).not.toContain('aria-selected="true"');
  });
  it('disables /stop when no turn is running', () => {
    const stopped = render({ text: '/stop', caret: 5, canStop: false });
    expect(stopped).toContain('aria-disabled="true"');
    const running = render({ text: '/stop', caret: 5, canStop: true });
    expect(running).toContain('aria-disabled="false"');
  });
  it('renders the mention panel with workspace files and filters by fragment', () => {
    const files = ['src/a.ts', 'docs/readme.md'];
    const all = render({ text: '@', caret: 1, files });
    expect(all).toContain('role="listbox"');
    expect(all).toContain('aria-label="文件引用"');
    expect(all).toContain('src/a.ts');
    expect(all).toContain('docs/readme.md');
    const filtered = render({ text: '@read', caret: 5, files });
    expect(filtered).toContain('docs/readme.md');
    expect(filtered).not.toContain('src/a.ts');
  });
  it('degrades honestly when the tree cannot be read', () => {
    expect(render({ text: '@', caret: 1, files: [] })).toContain('未取到工作区文件（可在会话详情查看）');
    const loading = render({ text: '@', caret: 1, files: [], filesLoading: true });
    expect(loading).toContain('正在读取工作区文件…');
    const failed = render({ text: '@', caret: 1, files: [], filesError: 'Host connection lost' });
    expect(failed).toContain('未取到工作区文件（可在会话详情查看）');
    expect(failed).not.toContain('Host connection lost');
  });
  it('renders nothing without a trigger, after the command word, or when disabled', () => {
    expect(render({ text: 'hello', caret: 5 })).toBe('');
    expect(render({ text: '/new ', caret: 5 })).toBe('');
    expect(render({ text: '/', caret: 1, disabled: true })).toBe('');
  });
});

describe('source contracts: palette wiring never hijacks the send path', () => {
  it('exposes listbox / option semantics and the required labels', () => {
    const source = read('src/renderer/composer-palette.tsx');
    expect(source).toContain('role="listbox"');
    // 标签来自文案目录（`t(lang, ...)`），组件里不再写死中文字面量。
    expect(source).toContain("t(lang, 'palette.commandListLabel')");
    expect(source).toContain("t(lang, 'palette.fileListLabel')");
    expect(source).toContain('role="option"');
    expect(source).toContain('aria-selected');
    expect(source).toContain('aria-expanded');
    expect(source).toContain('aria-activedescendant');
    expect(source).toContain("t(lang, 'palette.noCommand')");
    expect(source).toContain("t(lang, 'palette.noFiles')");
    expect(source).not.toContain('直接执行命令尚未接入');
    // 面板打开时 Enter 只作用于面板：在 window 捕获阶段 stopPropagation，Composer 的发送处理器收不到。
    expect(source).toContain('stopPropagation');
    expect(source).toContain("event.key === 'Escape'");
  });

  it('wires ComposerPalette into the composer while keeping Enter send / Shift+Enter intact', () => {
    const source = read('src/renderer/workbench.tsx');
    expect(source).toContain('ComposerPalette');
    expect(source).toContain('detectTrigger');
    expect(source).toContain('void w.send(text)');
    expect(source).toContain('Shift Enter 换行');
    expect(source).toContain('onSubmit={(text)');
    // `/permission` 聚焦真实存在的权限下拉。
    expect(source).toContain('id="composer-permission"');
    expect(source).toContain("document.getElementById('composer-permission')");
    // 命令动作只调用既有 Workbench API，绝不把命令文本当消息发送。
    const start = source.indexOf('const paletteAction');
    const end = source.indexOf('return <div className="conversation">', start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const paletteActionSource = source.slice(start, end);
    expect(paletteActionSource).not.toContain('w.send(');
    expect(paletteActionSource).toContain('w.createSession()');
    expect(paletteActionSource).toContain('w.stop()');
    expect(paletteActionSource).toContain('w.archive(');
    expect(paletteActionSource).toContain("w.setPage('usage')");
  });

  it('keeps the `@` data source read-only (workspace/tree via readTree)', () => {
    const source = read('src/renderer/workbench.tsx');
    expect(source).toContain('w.readTree(');
    expect(source).toContain('collectFilePaths');
    expect(source).not.toContain("from 'node:fs'");
  });
});
