/**
 * 会话详情 6 分区（`27` §11.1 / §11.2）的界面契约测试。
 *
 * 风格与 `dashboard-pages.test.ts` 一致：**不引入浏览器/Playwright**。
 * 纯函数直接断言；组件用 `renderToStaticMarkup` 做静态标记断言（不是 DOM 测试）。
 */

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { EMPTY_USAGE, type Artifact, type ChangesCoverage, type ContextInfo, type FileChange, type SessionInspection, type SourceRef } from '@syaocode/dhp';
import {
  CHANGE_STATUS_LETTERS, DETAIL_EMPTY_TEXT, DETAIL_SECTIONS, DetailPanel,
  artifactLineLabel, artifactSizeText, changeLineLabel, changeStatText, changeStatusLetter, changeStatusLabel,
  coverageNote, formatChangeSummary, sourceCountText, sourceLineLabel, sourceTrustLabel, summarizeChanges,
} from '../src/renderer/detail-panel.tsx';

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

const render = (value: SessionInspection | undefined): string => renderToStaticMarkup(createElement(DetailPanel, {
  inspection: value,
  snapshot: undefined,
  turnCount: 0,
  onClose: () => { throw new Error('Rendering must not close'); },
  onOpenPage: () => { throw new Error('Rendering must not navigate'); },
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
