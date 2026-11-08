/**
 * 跨目录一致性（`27` FR-N-037）。
 *
 * 桌面端文案现在分两个文件：
 *  - `i18n.ts`（`shell` / `palette` / `detail` / `relative` 的 `git` 在上轮已并入 git 前的位置）；
 *  - `i18n-views.ts`（`workbench` / `settings` / `usage`）。
 *
 * 为什么允许分两个文件：这两批是并行抽取的，硬合成一个 3000 行的文件只会让合并
 * 本身变成风险。但**分裂必须没有代价**——所以这个文件把两套目录放在一起断言：
 *
 *  1. 两边各自的键集中英完全对等；
 *  2. 两边的**未知键**行为完全一致（都是 `⟦path⟧`）；
 *  3. 两边的**插值**行为完全一致（缺参数保留 `{name}`，绝不出现 `undefined`）；
 *  4. 没有**重复键**——同一个 `a.b` 不允许两套目录都定义且内容不同，
 *     否则"改了其中一个"会变成难查的 bug。
 */

import { describe, expect, it } from 'vitest';
import { desktopMessages, t } from '../src/renderer/i18n.ts';
import { tv, viewsMessages } from '../src/renderer/i18n-views.ts';
import { agentsMessages, ta } from '../src/renderer/i18n-agents.ts';
import { mcpMessages, tm } from '../src/renderer/i18n-mcp.ts';

const flatten = (value: unknown, prefix = ''): string[] => {
  if (typeof value === 'string') return [prefix];
  if (value === null || typeof value !== 'object') return [];
  return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) =>
    flatten(child, prefix === '' ? key : `${prefix}.${key}`));
};

const CATALOGS = [
  { name: 'i18n.ts', read: desktopMessages, lookup: t, root: '' },
  { name: 'i18n-views.ts', read: viewsMessages, lookup: tv, root: '' },
  { name: 'i18n-agents.ts', read: agentsMessages, lookup: ta, root: '' },
  // MCP 目录用 `mcp.` 前缀寻址（`tm(lang, 'mcp.status.ready')`）。
  { name: 'i18n-mcp.ts', read: mcpMessages, lookup: tm, root: 'mcp.' },
] as const;

describe('两套目录的中英键集各自对等', () => {
  for (const catalog of CATALOGS) {
    it(`${catalog.name}：键集完全相同且都非空`, () => {
      const zh = flatten(catalog.read('zh')).sort();
      const en = flatten(catalog.read('en')).sort();
      expect(zh.length).toBeGreaterThan(20);
      expect(en).toEqual(zh);
      for (const path of zh) {
        expect(catalog.lookup('zh', `${catalog.root}${path}`)).not.toBe('');
        expect(catalog.lookup('en', `${catalog.root}${path}`)).not.toBe('');
      }
    });
  }
});

describe('两套目录的运行时语义完全一致', () => {
  it('未知键都显式可见，都不静默返回空串', () => {
    for (const catalog of CATALOGS) {
      expect(catalog.lookup('zh', 'definitely.not.a.key')).toBe('⟦definitely.not.a.key⟧');
      expect(catalog.lookup('en', 'definitely.not.a.key')).toBe('⟦definitely.not.a.key⟧');
    }
  });

  it('插值缺参数时都保留 {name}，都不出现 undefined', () => {
    // 取各自目录里第一个带占位符的键来验证，避免依赖具体键名。
    for (const catalog of CATALOGS) {
      const withVar = flatten(catalog.read('zh')).find((path) => catalog.lookup('zh', `${catalog.root}${path}`).includes('{'));
      if (withVar === undefined) continue;
      const text = catalog.lookup('zh', `${catalog.root}${withVar}`);
      expect(text).not.toContain('undefined');
      expect(text).toMatch(/\{\w+\}/);
    }
  });
});

describe('没有跨目录的重复键', () => {
  it('同一个键不会在多套目录里各定义一次', () => {
    // 四套目录两两之间都不能有同名键：否则"改了其中一个"会变成难查的 bug，
    // 而且读者无法判断该键到底归谁管。
    const seen = new Map<string, string>();
    const conflicts: string[] = [];
    for (const catalog of CATALOGS) {
      for (const path of flatten(catalog.read('zh'))) {
        const owner = seen.get(path);
        if (owner === undefined) seen.set(path, catalog.name);
        else conflicts.push(`${path}: ${owner} vs ${catalog.name}`);
      }
    }
    expect(conflicts).toEqual([]);
  });

  it('MCP 目录的 `mcp.` 前缀是它自己的命名空间，不与别的目录冲突', () => {
    // `mcp.*` 键在 `i18n-mcp.ts` 里叫 `status.ready`（不带前缀），
    // 寻址时才加前缀——所以这里按**带前缀**的完整路径比对。
    const others = new Set(
      [...flatten(desktopMessages('zh')), ...flatten(viewsMessages('zh')), ...flatten(agentsMessages('zh'))]
        .map((path) => `mcp.${path}`),
    );
    const overlap = flatten(mcpMessages('zh')).map((path) => `mcp.${path}`).filter((path) => others.has(path));
    expect(overlap).toEqual([]);
  });
});

describe('文案与内核行为的一致性（本轮核实的几处）', () => {
  it('「完全授权」的说明必须提到敏感路径仍会询问', () => {
    // 内核 `code/packages/core/src/permissions.ts` 明写：
    // "Sensitive paths ask in every mode, including bypass".
    // 文案若只说"跳过常规审批"而不提这一条，就是在暗示"完全不受限"。
    // 键在 `workbench.dialog.bypassBody`（确认框），先按目录定位再断言。
    const key = flatten(viewsMessages('zh')).find((path) => path.endsWith('.bypassBody'));
    expect(key).toBeDefined();
    expect(tv('zh', key!)).toContain('敏感路径');
    expect(tv('en', key!).toLowerCase()).toContain('sensitive');
  });

  it('欢迎页那句"会先询问你"只在会询问的档位下出现', () => {
    // acceptEdits 下工作区内写不问、bypass 下基本不问——无条件写这句是假话。
    const paths = flatten(viewsMessages('zh'));
    expect(paths).toContain('workbench.welcome.noticeAsking');
    expect(paths).toContain('workbench.welcome.noticeNotAsking');
  });
});
