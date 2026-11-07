/**
 * 页面级文案目录（`i18n-views.ts`，`27` FR-N-037）。
 *
 * 这个文件守着与 `i18n.test.ts` 同一套纪律，只是对象换成 workbench / settings / usage：
 *  1. 中英键集完全相同；
 *  2. 没有空串（空串会把"漏翻译"伪装成"设计如此"）；
 *  3. 未知键显式可见（`⟦path⟧`），不静默回退；
 *  4. 插值缺参数时保留 `{name}` 原样，不出现 `undefined`。
 *
 * 另外守住一条纪律：**已抽取的三个页面里不许再出现裸中文字面量**（注释里的中文不算）。
 */

import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { tv, viewsMessages, type ViewsMessages } from '../src/renderer/i18n-views.ts';
import { UsagePage } from '../src/renderer/usage-page.tsx';
import { SettingsPage } from '../src/renderer/settings-page.tsx';
import { PERMISSION_NAMES, names, pageNames, permissionNames, themeLabel } from '../src/renderer/workbench.tsx';
import { LANGUAGE_OPTIONS, MODEL_FIELD_LABELS, modelFieldLabels, languageOptions } from '../src/renderer/settings-page.tsx';
import { METRICS, metrics } from '../src/renderer/usage-page.tsx';

const flatten = (value: unknown, prefix = ''): string[] => {
  if (typeof value === 'string') return [prefix];
  if (value === null || typeof value !== 'object') return [];
  return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) =>
    flatten(child, prefix === '' ? key : `${prefix}.${key}`));
};

/** 先剥注释再扫描字符串字面量：注释里的中文是给人看的，不算用户可见文案。 */
const scan = (rel: string): string[] => {
  const text = readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');
  const code = text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  const literals = code.match(/(['"`])(?:\\.|(?!\1)[^\\])*\1/g) ?? [];
  return literals.filter((literal) => /[\u4e00-\u9fa5]/.test(literal));
};

describe('页面级文案目录', () => {
  it('中英键集完全相同', () => {
    const zh = flatten(viewsMessages('zh')).sort();
    const en = flatten(viewsMessages('en')).sort();
    expect(en).toEqual(zh);
  });

  it('三个命名空间各有足够条目（不是空壳）', () => {
    for (const ns of ['workbench', 'settings', 'usage'] as const) {
      expect(flatten(viewsMessages('zh')[ns] as unknown).length).toBeGreaterThan(20);
    }
  });

  it('每个键在中英两边都非空', () => {
    for (const path of flatten(viewsMessages('zh'))) {
      expect(tv('zh', path)).not.toBe('');
      expect(tv('en', path)).not.toBe('');
    }
  });

  it('未知键显式可见（不静默返回空串）', () => {
    expect(tv('zh', 'no.such.key')).toBe('⟦no.such.key⟧');
    expect(tv('en', 'workbench')).toBe('⟦workbench⟧');
    expect(tv('zh', 'workbench.nope.deeper')).toBe('⟦workbench.nope.deeper⟧');
  });

  it('插值用 {name} 占位，缺参数时保留原样而不是显示 undefined', () => {
    const text = tv('zh', 'workbench.sidebar.sessionCount', { count: 3 });
    expect(text).toContain('3');
    const missing = tv('zh', 'workbench.sidebar.sessionCount');
    expect(missing).toContain('{count}');
    expect(missing).not.toContain('undefined');
    // 多传参数不报错、不串位。
    expect(tv('zh', 'workbench.sidebar.sessionCount', { count: 2, extra: 'x' })).toContain('2');
  });

  it('英文侧不是中文复制（除语言自称外无中文）', () => {
    // `settings.language.zh` 是语言自称（"中文"），按惯例用本语言书写，属唯一豁免。
    const untranslated = flatten(viewsMessages('en'))
      .filter((path) => path !== 'settings.language.zh')
      .filter((path) => /[\u4e00-\u9fa5]/.test(tv('en', path)));
    expect(untranslated).toEqual([]);
  });

  it('类型约束：ViewsMessages 与目录形状一致', () => {
    const bundle: ViewsMessages = viewsMessages('zh');
    expect(bundle.workbench.nav.chat).not.toBe('');
    expect(bundle.settings.header.title).not.toBe('');
    expect(bundle.usage.header.title).not.toBe('');
  });
});

describe('已抽取页面不许再出现裸中文字面量', () => {
  it('workbench.tsx', () => {
    expect(scan('src/renderer/workbench.tsx')).toEqual([]);
  });

  it('settings-page.tsx', () => {
    expect(scan('src/renderer/settings-page.tsx')).toEqual([]);
  });

  it('usage-page.tsx', () => {
    expect(scan('src/renderer/usage-page.tsx')).toEqual([]);
  });
});

describe('页面文案随语言切换（而不是钉死在模块加载时）', () => {
  it('页面名与权限档位名在两种语言下不同，且键顺序固定', () => {
    const zhPages = pageNames('zh');
    const enPages = pageNames('en');
    expect(Object.keys(zhPages)).toEqual(Object.keys(enPages));
    expect(zhPages.chat).not.toBe(enPages.chat);
    expect(enPages.settings).toBe('Channels & settings');

    const zhPermission = permissionNames('zh');
    const enPermission = permissionNames('en');
    expect(Object.keys(zhPermission)).toEqual(['plan', 'strict', 'default', 'acceptEdits', 'bypass']);
    expect(zhPermission.bypass).not.toBe(enPermission.bypass);
  });

  it('保留的中文实例与 labels(\'zh\') 永远一致（不留两份会漂移的文案）', () => {
    expect(names).toEqual(pageNames('zh'));
    expect(PERMISSION_NAMES).toEqual(permissionNames('zh'));
    expect(LANGUAGE_OPTIONS).toEqual(languageOptions('zh'));
    expect(MODEL_FIELD_LABELS).toEqual(modelFieldLabels('zh'));
    expect(METRICS).toEqual(metrics('zh'));
    // 英文实例必须与中文不同（否则等于没翻译）。
    expect(pageNames('en')).not.toEqual(names);
    expect(permissionNames('en')).not.toEqual(PERMISSION_NAMES);
    expect(modelFieldLabels('en')).not.toEqual(MODEL_FIELD_LABELS);
    expect(metrics('en')).not.toEqual(METRICS);
  });

  it('外观偏好文案随语言变化', () => {
    expect(themeLabel('zh', 'system')).toBe('跟随系统');
    expect(themeLabel('en', 'system')).toBe('Follow system');
    expect(themeLabel('zh', 'dark')).not.toBe(themeLabel('en', 'dark'));
  });

  it('用量页在英文下渲染英文标签，不再混中文', () => {
    const html = renderToStaticMarkup(createElement(UsagePage, {
      report: undefined,
      channels: [],
      workspaces: [],
      query: { from: 0, to: 1 },
      loading: false,
      onQuery: () => { throw new Error('Rendering must not query'); },
      lang: 'en',
    }));
    expect(html).toContain('Usage');
    expect(html).toContain('Daily usage detail');
    expect(html).not.toContain('用量统计');
    expect(html).not.toContain('每日用量明细');
  });

  it('设置页在英文下渲染英文标签，不再混中文', () => {
    const html = renderToStaticMarkup(createElement(SettingsPage, {
      channels: [],
      saving: false,
      onSave: async () => { throw new Error('Rendering must not save'); },
      lang: 'en',
    }));
    expect(html).toContain('Channels and models');
    expect(html).toContain('My channels');
    expect(html).not.toContain('渠道与模型');
    expect(html).not.toContain('我的渠道');
  });
});

describe('文案承诺 vs 实际行为（本轮核实的几处）', () => {
  const workbench = readFileSync(new URL('../src/renderer/workbench.tsx', import.meta.url), 'utf8');
  const settings = readFileSync(new URL('../src/renderer/settings-page.tsx', import.meta.url), 'utf8');

  it('"完全授权"不得暗示完全不受限：确认框必须写明内核硬性拒绝仍生效', () => {
    // 权限引擎在 bypass 下仍会拒绝危险命令、仍会询问敏感路径；文案若只说"跳过审批"就是误导。
    expect(tv('zh', 'workbench.permission.bypass')).toBe('完全授权');
    expect(tv('zh', 'workbench.dialog.bypassBody')).toContain('内核硬性拒绝规则仍生效');
    expect(tv('en', 'workbench.dialog.bypassBody')).toMatch(/hard denial rules/i);
  });

  it('归档确认说"可在已归档中恢复"，会话树里必须真有该入口', () => {
    expect(tv('zh', 'workbench.dialog.archiveBody')).toContain('已归档');
    // 恢复入口：会话树有"已归档"分段 + "恢复会话"按钮，且调用 archive(false)。
    expect(workbench).toContain("tv(w.language, 'workbench.sessions.tabArchived')");
    expect(workbench).toContain("tv(w.language, 'workbench.sessions.restore')");
    expect(workbench).toContain('w.archive(s.sessionId, false)');
  });

  it('"需要授权的工具操作会先询问你"只在会询问的档位成立，不写死成无条件承诺', () => {
    // 诚实要求：这句话在 default/strict/plan 下成立；acceptEdits 只自动接受工作区内编辑；
    // bypass 跳过常规审批。文案本身不得声称"永远会问"。
    const notice = tv('zh', 'workbench.welcome.notice');
    expect(notice).toContain('需要授权的工具操作');
    expect(notice).not.toContain('永远');
    expect(notice).not.toContain('所有操作');
    // 权限下拉真实存在且 disabled 条件来自运行态，而不是永远可改。
    expect(workbench).toContain('id="composer-permission"');
    expect(workbench).toContain('disabled={disabled || !idle || w.mutating}');
  });

  it('"本地会话自动保存"对应的持久化确实由 Host 负责（渲染层不自己编）', () => {
    // 渲染层不得自己写 localStorage 冒充"已保存会话"；只有 Git 标签页偏好与主题走本地存储。
    expect(workbench).toContain("const GIT_TAB_KEY = 'syao:git-tab'");
    expect(workbench).not.toMatch(/localStorage\.setItem\('syao:(session|sessions)/);
    expect(tv('zh', 'workbench.sessions.emptyBody')).toContain('保存在本机');
  });

  it('连接横幅的三态与状态机一一对应（booting / reconnecting / error）', () => {
    expect(workbench).toContain("w.status === 'booting'");
    expect(workbench).toContain("w.status === 'reconnecting'");
    expect(tv('zh', 'workbench.banner.reconnecting')).toContain('不会自动重发操作');
    // 该承诺有实现依据：连接关闭时在途请求一律失败（不重放）。
    expect(readFileSync(new URL('../../../packages/client/src/connection.ts', import.meta.url), 'utf8'))
      .toContain('connection closed');
  });

  it('顶栏 Git 徽标在英文下不是中文（漏 lang 会退回默认中文）', () => {
    // `gitStatusBadge` 默认 lang='zh'；不显式传语言就会在英文界面漏出"N 个文件"。
    expect(workbench).toContain('gitStatusBadge(w.gitStatus, w.language)');
  });

  it('设置页"不保存任何真实密钥"与表单实现一致（没有 password 输入框）', () => {
    expect(settings).not.toContain('type="password"');
    expect(tv('zh', 'settings.save.onlyConfig')).toContain('不保存任何真实密钥');
    expect(tv('zh', 'settings.connection.apiKeyHelp')).toContain('变量名');
  });

  it('"清空配额字段可清除快照"与校验逻辑一致：留空是合法的', () => {
    expect(tv('zh', 'settings.snapshot.note')).toContain('清空');
    // 数值字段 required=false：留空不报错（否则"清空"根本做不到）。
    expect(settings).toMatch(/number\(model\[field\][^)]*false, false/);
  });
});
