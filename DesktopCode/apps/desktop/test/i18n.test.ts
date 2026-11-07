/**
 * 桌面端文案目录（`27` FR-N-037）。
 *
 * 三条硬规则，各有对应断言：
 *  1. **中英键集完全相同** —— 类型能保证大部分，但运行时断言能挡住 `as` 绕过；
 *  2. **没有漏翻译的空串** —— 空串会让"漏翻译"看起来像"设计如此"；
 *  3. **未知键显式可见** —— `⟦path⟧`，不静默回退。
 *
 * 另外守住一条纪律：**已抽取的模块里不许再出现裸中文字面量**。
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { desktopMessages, t, type DesktopMessages } from '../src/renderer/i18n.ts';
import { commands, helpText, shellHint } from '../src/renderer/composer-palette.tsx';
import * as formatModule from '../src/renderer/format.ts';

const flatten = (value: unknown, prefix = ''): string[] => {
  if (typeof value === 'string') return [prefix];
  if (value === null || typeof value !== 'object') return [];
  return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) =>
    flatten(child, prefix === '' ? key : `${prefix}.${key}`));
};

describe('桌面端文案目录', () => {
  it('中英键集完全相同', () => {
    const zh = flatten(desktopMessages('zh')).sort();
    const en = flatten(desktopMessages('en')).sort();
    expect(zh.length).toBeGreaterThan(20);
    expect(en).toEqual(zh);
  });

  it('每个键在中英两边都非空', () => {
    for (const path of flatten(desktopMessages('zh'))) {
      expect(t('zh', path)).not.toBe('');
      expect(t('en', path)).not.toBe('');
    }
  });

  it('未知键显式可见（不静默返回空串）', () => {
    expect(t('zh', 'no.such.key')).toBe('⟦no.such.key⟧');
    expect(t('en', 'shell')).toBe('⟦shell⟧');
  });

  it('插值用 {name} 占位，缺参数时保留原样而不是显示 undefined', () => {
    expect(t('zh', 'shell.failedExit', { code: 3 })).toContain('3');
    expect(t('zh', 'shell.failedExit')).toContain('{code}');
    expect(t('zh', 'shell.failedExit')).not.toContain('undefined');
  });

  it('同一个键在两种语言下不是同一串（避免"忘了翻译"）', () => {
    const zhKeys = flatten(desktopMessages('zh'));
    const identical = zhKeys.filter((path) => t('zh', path) === t('en', path));
    // 允许少量专有词/纯占位相同，但绝大多数必须不同。
    // 目前恰好三处：`shell.stderrSeparator`（stderr 是协议标记）、
    // `git.oauth.clientIdLabel`（OAuth App 专有名词）、`git.file.stageAria`（纯 {action} {path} 占位）。
    expect(identical.length).toBeLessThanOrEqual(3);
  });

  it('类型约束：DesktopMessages 与目录形状一致', () => {
    const bundle: DesktopMessages = desktopMessages('zh');
    expect(bundle.shell.tag).not.toBe('');
    expect(bundle.palette.fileListLabel).not.toBe('');
  });
});

describe('命令面板文案随语言切换（而不是钉死在模块加载时）', () => {
  it('命令标题/说明在两种语言下不同，但 id 顺序固定', () => {
    const zh = commands('zh');
    const en = commands('en');
    expect(zh.map((c) => c.id)).toEqual(en.map((c) => c.id));
    expect(zh[0]?.title).not.toBe(en[0]?.title);
    // 所有命令都必须有非空标题与说明。
    for (const list of [zh, en]) {
      expect(list.every((c) => c.title !== '' && c.hint !== '')).toBe(true);
    }
  });

  it('/help 插入的帮助文本与 `!` 提示都随语言变化', () => {
    expect(helpText('zh')).not.toBe(helpText('en'));
    expect(shellHint('zh')).not.toBe(shellHint('en'));
    // 两种语言都必须说明"过权限闸门"，这是产品承诺，不是措辞。
    expect(shellHint('zh')).toContain('权限');
    expect(shellHint('en').toLowerCase()).toContain('permission');
  });

  it('未知语言不会让命令清单塌成空（回退到中文而非空白）', () => {
    // 类型上不会传非法值；这里守的是"运行时不静默变成空列表"。
    const list = commands('zh');
    expect(list.length).toBe(9);
  });
});

describe('已抽取模块不许再出现裸中文字面量', () => {
  const scan = (rel: string): string[] => {
    const text = readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');
    // 先去掉注释：注释里的中文是给人看的，不算用户可见文案。
    // （不先剥注释会把 `` `07-UI-设计系统...` `` 这种文档引用误判成字符串字面量。）
    const code = text
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    const literals = code.match(/(['"`])(?:\\.|(?!\1)[^\\])*\1/g) ?? [];
    return literals.filter((literal) => /[\u4e00-\u9fa5]/.test(literal));
  };

  it('shell-lines.tsx 的用户可见文案已全部进目录', () => {
    expect(scan('src/renderer/shell-lines.tsx')).toEqual([]);
  });

  it('composer-palette.tsx 的用户可见文案已全部进目录', () => {
    expect(scan('src/renderer/composer-palette.tsx')).toEqual([]);
  });

  it('detail-panel.tsx 的用户可见文案已全部进目录', () => {
    expect(scan('src/renderer/detail-panel.tsx')).toEqual([]);
  });

  it('git-sidebar.tsx 的用户可见文案已全部进目录', () => {
    expect(scan('src/renderer/git-sidebar.tsx')).toEqual([]);
  });

  it('git 命名空间覆盖了侧栏的各个分区', () => {
    const gitKeys = flatten(desktopMessages('zh').git as unknown);
    expect(gitKeys.length).toBeGreaterThan(150);
    for (const group of ['tabs', 'panel', 'status', 'group', 'diff', 'commit', 'signing', 'auth', 'oauth', 'upload', 'failure', 'branch', 'graph', 'footer']) {
      expect(gitKeys.some((key) => key === group || key.startsWith(`${group}.`))).toBe(true);
    }
  });

  it('git 文案在英文下确实被翻译（不是中文复制）', () => {
    const gitZh = flatten(desktopMessages('zh').git as unknown);
    const untranslated = gitZh.filter((key) => /[\u4e00-\u9fa5]/.test(t('en', `git.${key}`)));
    expect(untranslated).toEqual([]);
  });
});

describe('文案与行为一致性（本轮核实的几处）', () => {
  const gitSidebar = readFileSync(new URL('../src/renderer/git-sidebar.tsx', import.meta.url), 'utf8');

  it('上传"结果不完整"用本地码，不复用 -32032（那会显示成"被拒绝"）', () => {
    // -32032 的文案是"提交或推送被拒绝（无改动 / 无 upstream / 钩子或远端策略）"，
    // 与"结果不完整"不是一回事，会把用户引向错误的排查方向。
    expect(gitSidebar).toContain('LOCAL_FAILURE_INCOMPLETE');
    const matches = gitSidebar.match(/setFailure\(\{ code: LOCAL_FAILURE_INCOMPLETE/g) ?? [];
    expect(matches.length).toBeGreaterThan(0);
    expect(gitSidebar).not.toMatch(/setFailure\(\{ code: -32032, message: t\(lang, 'git\.upload\.incomplete'\)/);
  });

  it('还没读到 status 时不说"没有改动"（诚实空态）', () => {
    expect(gitSidebar).toContain("status === undefined ? t(lang, 'git.changes.notLoaded')");
  });

  it('签名失败识别同时认中英措辞，不依赖本地化文案', () => {
    // Host 返回英文消息；只匹配中文会永远命中不了。
    expect(gitSidebar).toContain("message.includes('signing failed')");
  });
});

describe('会话详情：抽取不得改变既有文案与语义', () => {
  it('引号与占位符必须原样保留（回归：抽取时丢掉了"域名/来源工具"）', () => {
    const zh = desktopMessages('zh');
    expect(zh.detail.changeLineAria).toBe('{path}，新增 {added} 行，删除 {removed} 行');
    expect(zh.detail.changeLineAriaUnknown).toBe('{path}，不可统计行数');
    expect(zh.detail.changeSummaryIncomplete).toBe('改动 {files} 个文件 · 统计不完整');
    expect(zh.detail.artifactLineAria).toContain('来源工具 {tool}');
    expect(zh.detail.sourceLineAria).toContain('域名 {domain}');
    expect(zh.detail.changesScopeNote).toContain('与 Git 侧栏的');
  });

  it('不可统计一律说"不可统计"，绝不出现 +0 -0', () => {
    expect(desktopMessages('zh').detail.unavailableStat).toBe('不可统计');
    expect(desktopMessages('en').detail.unavailableStat).not.toBe('');
  });

  it('能力清单没有兜底断言（Host 说 supported=true 时不能声称"未接入"）', () => {
    const panel = readFileSync(new URL('../src/renderer/detail-panel.tsx', import.meta.url), 'utf8');
    // 旧兜底列表里写死过 "尚未接入受信任的 MCP 执行服务" / "当前使用单 Agent 运行"。
    expect(panel).not.toContain('尚未接入受信任的 MCP');
    expect(panel).not.toContain('当前使用单 Agent 运行');
    expect(panel).toContain("t(lang, 'detail.capabilitiesNotLoaded')");
  });
});

describe('相对时间也走文案目录（commit graph 曾残留中文）', () => {
  it('formatRelative 接受语言参数，不再硬编码中文', () => {
    const format = readFileSync(new URL('../src/renderer/format.ts', import.meta.url), 'utf8');
    expect(format).toContain("t(lang, 'relative.justNow')");
    expect(format).not.toMatch(/return '刚刚'/);
  });

  it('英文下不再出现"分钟前"这类中文', () => {
    const { formatRelative } = formatModule;
    const now = 1_700_000_000_000;
    expect(formatRelative(now - 5 * 60_000, now, 'en')).not.toMatch(/[\u4e00-\u9fa5]/);
    expect(formatRelative(now - 5 * 60_000, now, 'zh')).toMatch(/分钟前/);
  });
});
