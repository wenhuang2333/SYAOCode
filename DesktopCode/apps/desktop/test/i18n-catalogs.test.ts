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

import { readdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
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


describe('渲染层的 .ts 文件也不能藏裸中文（此前的盲区）', () => {
  // 之前的扫描只覆盖 `.tsx`，漏掉了 `use-workbench.ts`（16 条运行期错误文案）、
  // `format.ts`（亿/万、未知大小）与 `theme.ts`（主题标签）。
  // 后果是：用户切到英文后，界面整体是英文，**唯独出错的红色横幅还是中文**。
  const CATALOG_FILES = new Set(['i18n.ts', 'i18n-views.ts', 'i18n-agents.ts', 'i18n-mcp.ts']);
  const RENDERER_DIR = fileURLToPath(new URL('../src/renderer/', import.meta.url));

  it('除文案目录外，renderer 下的 .ts 文件没有裸中文字面量', () => {
    const offenders: string[] = [];
    for (const name of readdirSync(RENDERER_DIR)) {
      if (!name.endsWith('.ts') || CATALOG_FILES.has(name)) continue;
      const raw = readFileSync(path.join(RENDERER_DIR, name), 'utf8');
      const code = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      const literals = code.match(/(['"`])(?:\\.|(?!\1)[^\\])*\1/g) ?? [];
      const chinese = literals.filter((literal) => /[\u4e00-\u9fa5]/.test(literal));
      if (chinese.length > 0) offenders.push(`${name}: ${chinese.slice(0, 3).join(' ')}`);
    }
    expect(offenders).toEqual([]);
  });

  it('错误文案随语言切换（不是只有界面文案切换）', () => {
    // 这批是运行期错误，会直接进顶部红色横幅。
    expect(tv('zh', 'errors.runtimeNotConnected')).toMatch(/[\u4e00-\u9fa5]/);
    expect(tv('en', 'errors.runtimeNotConnected')).not.toMatch(/[\u4e00-\u9fa5]/);
    expect(tv('en', 'errors.desktopBridgeMissing')).toContain('LIWENCode');
  });
});


describe('Electron 验证脚本被中断时要收掉子进程', () => {
  // 若脚本被 Ctrl-C 杀掉而没走 finally，Electron 会变成孤儿进程占着单实例锁，
  // 下一次运行报 "Target page ... has been closed" —— 看起来像功能坏了。
  const files = ['../../../scripts/verify-interaction.mjs', '../../../scripts/verify-real-window.mjs', '../../../scripts/verify-steer.mjs'];
  for (const rel of files) {
    it(`${rel.split('/').pop()} 注册了 SIGINT/SIGTERM 清理`, () => {
      const source = readFileSync(new URL(rel, import.meta.url), 'utf8');
      expect(source).toContain("process.once('SIGINT'");
      expect(source).toContain("process.once('SIGTERM'");
      expect(source).toContain('closeOnSignal');
    });
  }
});
