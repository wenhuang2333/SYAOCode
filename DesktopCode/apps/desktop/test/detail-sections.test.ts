/**
 * 会话详情 6 分区（`27` §11.1 / §11.2）的界面契约测试。
 *
 * 风格与 `dashboard-pages.test.ts` 一致：**不引入浏览器/Playwright**。
 * 纯函数直接断言；组件用 `renderToStaticMarkup` 做静态标记断言（不是 DOM 测试）。
 */

import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { EMPTY_USAGE, type Artifact, type ChangesCoverage, type ContextInfo, type DiffHunk, type FileChange, type SessionChangeDiffResult, type SessionInspection, type SourceRef } from '@syaocode/dhp';
import {
  CHANGE_DIFF_UNAVAILABLE_TEXT, CHANGE_STATUS_LETTERS, ChangeDiffPanel, DETAIL_EMPTY_TEXT, DETAIL_SECTIONS, DetailPanel,
  artifactLineLabel, artifactSizeText, changeDiffNote, changeDiffStatsText, changeLineLabel, changeStatText, changeStatusLetter, changeStatusLabel,
  coverageNote, describeDiffError, formatChangeSummary, sourceCountText, sourceLineLabel, sourceTrustLabel, summarizeChanges,
} from '../src/renderer/detail-panel.tsx';

const ROOT = path.resolve(__dirname, '..');
const read = (p: string): string => readFileSync(path.join(ROOT, p), 'utf8');

const change = (overrides: Partial<FileChange> = {}): FileChange => ({
  path: 'src/a.ts', status: 'modified', added: 12, removed: 3, stat: 'exact', tool: 'edit', updatedAt: 1_760_000_000_000, ...overrides,
});

const artifact = (overrides: Partial<Artifact> = {}): Artifact => ({
  id: 'art-1', path: '/workspace/report.md', name: 'report.md', kind: 'report', sizeBytes: 2048, tool: 'write', createdAt: 1_760_000_000_000, ...overrides,
});

const source = (overrides: Partial<SourceRef> = {}): SourceRef => ({
  id: 'src-1', title: 'TypeScript 手册', url: 'https://www.typescriptlang.org/docs/', domain: 'typescriptlang.org',
  count: 3, tool: 'web_search', trust: 'extracted', verified: false, ...overrides,
});

const context: ContextInfo = {
  usedTokens: 4200, capacity: 128000, capacitySource: 'configured', source: 'estimated',
  segments: [{ name: '系统提示', tokens: 900 }, { name: '对话历史', tokens: 3300 }], capturedAt: 1_760_000_000_000, compression: 'unsupported',
};

const coverage = (overrides: Partial<ChangesCoverage> = {}): ChangesCoverage => ({ exact: true, bashUsed: false, note: null, ...overrides });

const inspection = (overrides: Partial<SessionInspection> = {}): SessionInspection => ({
  sessionId: 's-1',
  totals: EMPTY_USAGE,
  context,
  resources: [],
  changes: [],
  artifacts: [],
  sources: [],
  coverage: coverage(),
  ...overrides,
});

const render = (value: SessionInspection | undefined, overrides: Partial<Parameters<typeof DetailPanel>[0]> = {}): string => renderToStaticMarkup(createElement(DetailPanel, {
  inspection: value,
  snapshot: undefined,
  turnCount: 0,
  onClose: () => { throw new Error('Rendering must not close'); },
  onOpenPage: () => { throw new Error('Rendering must not navigate'); },
  ...overrides,
}));

describe('detail sections: fixed order and collapsible structure', () => {
  it('renders exactly six sections in the required order', () => {
    const html = render(inspection());
    const titles = [...html.matchAll(/class="detail-section-title">([^<]+)</g)].map((match) => match[1]);
    expect(titles).toEqual(['概览', '改动', '产出', '来源', '上下文', '能力']);
    expect(DETAIL_SECTIONS.map((section) => section.label)).toEqual(titles);
    expect(html.match(/<details class="detail-section"/g)).toHaveLength(6);
  });
  it('renders every section summary with an accessible name', () => {
    const html = render(inspection());
    for (const label of ['概览', '改动', '产出', '来源', '上下文', '能力']) {
      expect(html).toContain(`aria-label="${label}分区"`);
    }
  });
});

describe('change summary and change rows (§11.2)', () => {
  it('summarizes three files as "改动 3 个文件 · +42 -7"', () => {
    const changes = [
      change({ path: 'src/a.ts', added: 12, removed: 3 }),
      change({ path: 'src/b.ts', added: 30, removed: 4 }),
      change({ path: 'src/c.ts', added: 0, removed: 0, status: 'added' }),
    ];
    expect(formatChangeSummary(changes)).toBe('改动 3 个文件 · +42 -7');
    expect(summarizeChanges(changes)).toEqual({ files: 3, added: 42, removed: 7, unavailable: 0 });
  });
  it('never invents numbers for an empty change list', () => {
    expect(formatChangeSummary([])).toBe('改动 0 个文件');
    expect(summarizeChanges([])).toEqual({ files: 0, added: 0, removed: 0, unavailable: 0 });
  });
  it('marks the total as incomplete when any entry is unavailable (no fake 0)', () => {
    const changes = [change(), change({ path: 'bin/data.bin', added: null, removed: null, stat: 'unavailable' })];
    const summary = formatChangeSummary(changes);
    expect(summary).toBe('改动 2 个文件 · 统计不完整');
    expect(summary).not.toContain('+0');
    expect(summarizeChanges(changes)).toEqual({ files: 2, added: null, removed: null, unavailable: 1 });
  });
  it('shows "+N -M" text and the exact aria-label for a statted row', () => {
    const value = change({ path: 'src/a.ts', added: 12, removed: 3 });
    expect(changeStatText(value)).toBe('+12 -3');
    expect(changeLineLabel(value)).toBe('src/a.ts，新增 12 行，删除 3 行');
  });
  it('shows "不可统计" (never 0) for an unavailable row', () => {
    const value = change({ path: 'bin/data.bin', added: null, removed: null, stat: 'unavailable' });
    expect(changeStatText(value)).toBe('不可统计');
    expect(changeStatText(value)).not.toBe('+0 -0');
    expect(changeLineLabel(value)).toBe('bin/data.bin，不可统计行数');
  });
  it('maps statuses to A / M / D / R letters with Chinese labels', () => {
    expect(CHANGE_STATUS_LETTERS).toEqual({ added: 'A', modified: 'M', deleted: 'D', renamed: 'R' });
    expect(changeStatusLetter(change({ status: 'added' }))).toBe('A');
    expect(changeStatusLetter(change({ status: 'modified' }))).toBe('M');
    expect(changeStatusLetter(change({ status: 'deleted' }))).toBe('D');
    expect(changeStatusLetter(change({ status: 'renamed' }))).toBe('R');
    expect(changeStatusLabel(change({ status: 'deleted' }))).toBe('删除');
  });
  it('uses "?" as the left marker for unavailable stats (§11.2 table)', () => {
    const value = change({ path: 'bin/data.bin', status: 'modified', added: null, removed: null, stat: 'unavailable' });
    expect(changeStatusLetter(value)).toBe('?');
    expect(changeStatusLabel(value)).toBe('修改');
  });
  it('renders the collapsed summary, per-file aria-labels and both +N/-M segments', () => {
    const html = render(inspection({
      changes: [change({ path: 'src/a.ts', added: 12, removed: 3 }), change({ path: 'src/b.ts', status: 'added', added: 30, removed: 0 })],
    }));
    expect(html).toContain('改动 2 个文件 · +42 -3');
    expect(html).toContain('aria-label="src/a.ts，新增 12 行，删除 3 行"');
    expect(html).toContain('aria-label="src/b.ts，新增 30 行，删除 0 行"');
    expect(html).toContain('change-stat-add');
    expect(html).toContain('change-stat-del');
    expect(html).toContain('>+12</span>');
    expect(html).toContain('>-3</span>');
    expect(html).not.toContain('不可统计');
  });
  it('renders "不可统计" for unavailable rows and never renders a fake 0', () => {
    const html = render(inspection({
      changes: [change({ path: 'bin/data.bin', added: null, removed: null, stat: 'unavailable' })],
    }));
    expect(html).toContain('不可统计');
    expect(html).toContain('aria-label="bin/data.bin，不可统计行数"');
    expect(html).not.toContain('+0 -0');
    expect(html).not.toContain('change-stat-add');
  });
  it('shows the bash coverage note at the top of the changes section', () => {
    expect(coverageNote(coverage({ exact: false, bashUsed: true, note: '命令改动未逐文件统计' }))).toBe('命令改动未逐文件统计');
    expect(coverageNote(coverage({ exact: true, bashUsed: false, note: '不应显示' }))).toBe('');
    expect(coverageNote(coverage({ bashUsed: true, note: null }))).toBe('命令改动未逐文件统计');
    const html = render(inspection({ coverage: coverage({ exact: false, bashUsed: true, note: '命令改动未逐文件统计' }) }));
    expect(html).toContain('命令改动未逐文件统计');
    expect(html).toContain('detail-coverage-note');
  });
});

describe('artifacts and sources sections', () => {
  it('renders name / kind / size / tool for each artifact', () => {
    expect(artifactSizeText(artifact())).toBe('2.0 KB');
    expect(artifactSizeText(artifact({ sizeBytes: null }))).toBe('未知大小');
    expect(artifactLineLabel(artifact())).toBe('report.md，报告，2.0 KB，来源工具 write');
    const html = render(inspection({ artifacts: [artifact(), artifact({ id: 'art-2', name: 'chart.png', kind: 'image', sizeBytes: 1024 })] }));
    expect(html).toContain('report.md');
    expect(html).toContain('chart.png');
    expect(html).toContain('报告');
    expect(html).toContain('图片');
    expect(html).toContain('来源工具 write');
    expect(html).toContain('aria-label="report.md，报告，2.0 KB，来源工具 write"');
  });
  it('marks unverified sources visibly and never claims verification', () => {
    expect(sourceTrustLabel(source({ verified: false, trust: 'extracted' }))).toBe('未验证');
    expect(sourceTrustLabel(source({ verified: false, trust: 'declared' }))).toBe('未验证（来源声明）');
    expect(sourceTrustLabel(source({ verified: true, trust: 'verified' }))).toBe('已验证');
    expect(sourceTrustLabel(source({ verified: false, trust: 'verified' }))).toBe('未验证');
    expect(sourceCountText(source())).toBe('出现 3 次');
    expect(sourceLineLabel(source())).toBe('TypeScript 手册，域名 typescriptlang.org，出现 3 次，未验证');
    const html = render(inspection({ sources: [source()] }));
    expect(html).toContain('未验证');
    expect(html).toContain('source-trust-unverified');
    expect(html).toContain('typescriptlang.org');
    expect(html).toContain('出现 3 次');
    expect(html).not.toContain('已验证');
  });
  it('renders an explicit verified badge only when the source is verified', () => {
    const html = render(inspection({ sources: [source({ verified: true, trust: 'verified' })] }));
    expect(html).toContain('已验证');
    expect(html).toContain('source-trust-verified');
  });
});

describe('honest empty states (TC-N-025)', () => {
  it('shows a dedicated empty state for changes, artifacts and sources', () => {
    const html = render(inspection());
    expect(html).toContain(DETAIL_EMPTY_TEXT.changes);
    expect(html).toContain(DETAIL_EMPTY_TEXT.artifacts);
    expect(html).toContain(DETAIL_EMPTY_TEXT.sources);
    expect(html).toContain('本会话没有文件改动');
    expect(html).toContain('本会话没有产出文件');
    expect(html).toContain('本会话没有参考来源');
    expect(html).not.toContain('+0 -0');
  });
  it('renders the same empty states when the inspection has not arrived yet', () => {
    const html = render(undefined);
    expect(html).toContain('本会话没有文件改动');
    expect(html).toContain('本会话没有产出文件');
    expect(html).toContain('本会话没有参考来源');
    expect(html).toContain('尚未采集');
  });
  it('keeps the session-scope disclaimer separate from the Git working-tree scope', () => {
    const html = render(inspection({ changes: [change()] }));
    expect(html).toContain('与 Git 侧栏的');
    expect(html).toContain('工作区未提交改动');
    expect(html).toContain('互不相加');
  });
});

describe('session-scope change diff (N-11 / FR-N-011)', () => {
  const diff = (overrides: Partial<SessionChangeDiffResult> = {}): SessionChangeDiffResult => ({
    sessionId: 's-1', path: 'src/a.ts', status: 'modified', hunks: [], added: 12, removed: 3, truncated: false, unavailable: null, ...overrides,
  });

  const hunk: DiffHunk = {
    oldStart: 1, newStart: 1,
    lines: [
      { kind: 'ctx', text: 'const a = 1;' },
      { kind: 'del', text: 'const b = 2;' },
      { kind: 'add', text: 'const b = 3;' },
    ],
  };

  const renderDiff = (result: SessionChangeDiffResult): string => renderToStaticMarkup(createElement(ChangeDiffPanel, { result }));

  it('makes change rows expandable only when onLoadDiff is provided', () => {
    const withLoader = render(inspection({ changes: [change()] }), { onLoadDiff: async () => diff() });
    expect(withLoader).toContain('change-row-button');
    expect(withLoader).toContain('aria-expanded="false"');
    expect(withLoader).toContain('点击查看只读 diff');
    expect(withLoader).toContain('aria-controls');
    // 原生 button：Enter / Space 天然可触发，不需要额外键盘处理。
    expect(withLoader).toContain('type="button"');
    expect(withLoader).toContain('class="change-row change-row-button"');

    const withoutLoader = render(inspection({ changes: [change()] }));
    expect(withoutLoader).not.toContain('aria-expanded');
    expect(withoutLoader).not.toContain('change-row-button');
    // 未提供 onLoadDiff 时保留原来的不可点击行与 aria-label。
    expect(withoutLoader).toContain('aria-label="src/a.ts，新增 12 行，删除 3 行"');
  });

  it('renders a distinct human note for every unavailable reason and never an empty diff', () => {
    const reasons = ['binary', 'too_large', 'no_snapshot', 'deleted'] as const;
    for (const reason of reasons) {
      const html = renderDiff(diff({ unavailable: reason }));
      expect(html).toContain(CHANGE_DIFF_UNAVAILABLE_TEXT[reason]);
      expect(html).not.toContain('<pre');
      expect(html).toContain('+12 -3');
      expect(html).toContain(`data-unavailable="${reason}"`);
    }
    expect(new Set(reasons.map((reason) => CHANGE_DIFF_UNAVAILABLE_TEXT[reason])).size).toBe(4);
  });

  it('renders hunks with add / del / ctx classes for an available diff', () => {
    const html = renderDiff(diff({ hunks: [hunk] }));
    expect(html).toContain('change-diff-hunk');
    expect(html).toContain('@@ -1 +1 @@');
    expect(html).toContain('change-diff-line-add');
    expect(html).toContain('change-diff-line-del');
    expect(html).toContain('change-diff-line-ctx');
    // 会话口径与工作区口径不能看起来像同一个东西。
    expect(html).not.toContain('git-diff-hunk');
  });

  it('shows a loading note and an error note instead of a blank region', () => {
    const loading = renderToStaticMarkup(createElement(ChangeDiffPanel, { loading: true }));
    expect(loading).toContain('正在读取会话 diff');
    expect(loading).not.toContain('<pre');
    const failed = renderToStaticMarkup(createElement(ChangeDiffPanel, { error: describeDiffError({ kind: 'capability_not_found' }) }));
    expect(failed).toContain('本会话没有记录过这个路径的改动');
    expect(failed).not.toContain('<pre');
  });

  it('keeps changeDiffNote distinct per reason and empty for a plain diff', () => {
    for (const reason of ['binary', 'too_large', 'no_snapshot', 'deleted'] as const) {
      expect(changeDiffNote(diff({ unavailable: reason }))).toBe(CHANGE_DIFF_UNAVAILABLE_TEXT[reason]);
    }
    expect(changeDiffNote(diff({ hunks: [hunk] }))).toBe('');
    expect(changeDiffNote(diff({ hunks: [hunk], truncated: true }))).toContain('只显示前一部分');
    expect(changeDiffNote(diff())).toContain('没有产生文本差异');
    expect(changeDiffStatsText(diff())).toBe('+12 -3');
    expect(describeDiffError(new Error('Host 未连接'))).toContain('读取 diff 失败');
  });

  it('source contracts: uses session/change-diff and never reuses Git worktree diff classes', () => {
    const detailSource = read('src/renderer/detail-panel.tsx');
    expect(detailSource).not.toContain('git-diff-hunk');
    expect(detailSource).toContain('change-diff-hunk');
    expect(detailSource).toContain('aria-expanded');
    const hookSource = read('src/renderer/use-workbench.ts');
    expect(hookSource).toContain('FeatureMethod.SessionChangeDiff');
    const workbenchSource = read('src/renderer/workbench.tsx');
    expect(workbenchSource).toContain('onLoadDiff');
    expect(workbenchSource).toContain('w.sessionChangeDiff(');
  });
});
