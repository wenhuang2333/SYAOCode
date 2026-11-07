import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isValidElement, type ReactElement, type ReactNode } from 'react';
import type { ChannelConfig, ChannelInfo, UsageQuery } from '@syaocode/dhp';
import { UsagePage, presetUsageQuery, type UsagePageProps } from '../src/renderer/usage-page.tsx';
import { SettingsPage, type SettingsPageProps } from '../src/renderer/settings-page.tsx';

// A deliberately shallow hook harness for callback/state tests in the existing
// Node-only test environment. It does not emulate a browser, layout or DOM.
const hooks = vi.hoisted(() => ({ slots: [] as unknown[], cursor: 0, changed: false, effects: [] as (() => void)[] }));
vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react')>();
  return {
    ...actual,
    useState: (initial: unknown) => {
      const index = hooks.cursor++;
      if (!(index in hooks.slots)) hooks.slots[index] = typeof initial === 'function' ? initial() : initial;
      return [hooks.slots[index], (update: unknown) => {
        const next = typeof update === 'function' ? update(hooks.slots[index]) : update;
        if (!Object.is(hooks.slots[index], next)) hooks.changed = true;
        hooks.slots[index] = next;
      }];
    },
    useRef: (value: unknown) => {
      const index = hooks.cursor++;
      if (!(index in hooks.slots)) hooks.slots[index] = { current: value };
      return hooks.slots[index];
    },
    useId: () => `test-${hooks.cursor++}`,
    useEffect: (effect: () => void, dependencies: readonly unknown[]) => {
      const index = hooks.cursor++;
      const previous = hooks.slots[index] as readonly unknown[] | undefined;
      if (!previous || dependencies.some((value, i) => !Object.is(value, previous[i]))) hooks.effects.push(effect);
      hooks.slots[index] = dependencies;
    },
  };
});

type Props = Record<string, unknown> & { children?: ReactNode };
type Element = ReactElement<Props>;
function mount(render: () => React.JSX.Element) {
  let tree: React.JSX.Element;
  const refresh = (): React.JSX.Element => {
    for (let attempts = 0; attempts < 8; attempts++) {
      hooks.cursor = 0; hooks.changed = false; tree = render();
      hooks.effects.splice(0).forEach((effect) => effect());
      if (!hooks.changed) return tree;
    }
    throw new Error('Unstable shallow render');
  };
  refresh();
  const elements = (node: ReactNode): Element[] => {
    if (Array.isArray(node)) return node.flatMap(elements);
    if (!isValidElement<Props>(node)) return [];
    return [node, ...elements(node.props.children)];
  };
  const find = (predicate: (element: Element) => boolean): Element => {
    const result = elements(tree!).find(predicate);
    if (!result) throw new Error('Element not found');
    return result;
  };
  return { refresh, find, all: () => elements(tree!), text: () => text(tree!) };
}
function text(node: ReactNode): string {
  if (node == null || typeof node === 'boolean') return '';
  if (Array.isArray(node)) return node.map(text).join('');
  if (isValidElement<Props>(node)) return text(node.props.children);
  return String(node);
}
function call(element: Element, property: string, value?: unknown): void {
  (element.props[property] as (event?: unknown) => void)(value);
}
function click(view: ReturnType<typeof mount>, label: string): void {
  call(view.find((element) => element.type === 'button' && text(element).includes(label)), 'onClick'); view.refresh();
}
function fill(view: ReturnType<typeof mount>, label: string, value: string): void {
  call(view.find((element) => element.props['label'] === label), 'onChange', value); view.refresh();
}
function submit(view: ReturnType<typeof mount>): void {
  call(view.find((element) => element.type === 'form'), 'onSubmit', { preventDefault() {} }); view.refresh();
}
const channel: ChannelInfo = {
  id: 'provider', name: 'Provider', protocol: 'openai-compatible', apiKeyEnv: 'MY_API_KEY', models: [{ id: 'model-a', name: 'Model A' }],
  credentialReady: true, builtin: false, reasoningLevels: [],
};

beforeEach(() => {
  hooks.slots = []; hooks.cursor = 0; hooks.changed = false; hooks.effects = [];
  vi.useFakeTimers(); vi.setSystemTime(new Date(2026, 10, 6, 14));
  vi.stubGlobal('requestAnimationFrame', (callback: (time: number) => void) => { callback(0); return 1; });
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('UsagePage callback behavior (shallow, no browser)', () => {
  function setup() {
    const onQuery = vi.fn<(query: UsageQuery) => void>();
    let props: UsagePageProps = { report: undefined, channels: [], workspaces: [{ id: 'w', root: '/project/a', name: 'A', addedAt: 0 }], query: presetUsageQuery('7d'), loading: false, onQuery };
    const view = mount(() => UsagePage(props));
    return { view, onQuery, setQuery: (query: UsageQuery) => { props = { ...props, query }; view.refresh(); } };
  }
  it('queries today / seven / thirty days without querying on initial render', () => {
    const { view, onQuery } = setup(); expect(onQuery).not.toHaveBeenCalled();
    for (const [label, preset] of [['今天', 'today'], ['近 7 天', '7d'], ['近 30 天', '30d']] as const) {
      click(view, label); expect(onQuery).toHaveBeenLastCalledWith(presetUsageQuery(preset));
    }
  });
  it('applies project filters to the real query and preserves them in presets', () => {
    const { view, onQuery } = setup();
    call(view.find((element) => element.type === 'select'), 'onChange', { target: { value: '/project/a' } }); view.refresh();
    expect(onQuery).toHaveBeenLastCalledWith(presetUsageQuery('7d', '/project/a'));
    click(view, '今天'); expect(onQuery).toHaveBeenLastCalledWith(presetUsageQuery('today', '/project/a'));
    call(view.find((element) => element.type === 'select'), 'onChange', { target: { value: '' } }); view.refresh();
    expect(onQuery).toHaveBeenLastCalledWith(presetUsageQuery('today'));
  });
  it('shows an invalid-range message and does not call onQuery, even for a project change', () => {
    const { view, onQuery } = setup();
    const dates = () => view.all().filter((element) => element.type === 'input' && element.props['type'] === 'date');
    call(dates()[0]!, 'onChange', { target: { value: '2026-11-10' } }); view.refresh();
    expect(onQuery).not.toHaveBeenCalled(); expect(view.text()).toContain('开始日期不能晚于结束日期');
    call(view.find((element) => element.type === 'select'), 'onChange', { target: { value: '/project/a' } }); view.refresh();
    expect(onQuery).not.toHaveBeenCalled();
    call(dates()[1]!, 'onChange', { target: { value: '2026-11-10' } }); view.refresh();
    expect(onQuery).toHaveBeenCalledTimes(1);
    const sent = onQuery.mock.calls[0]![0]; expect(sent.workspaceRoot).toBe('/project/a'); expect(new Date(sent.to).getHours()).toBe(23);
  });
  it('updates metric locally and never queries different underlying data for chart tabs', () => {
    const { view, onQuery } = setup();
    click(view, '成本');
    expect(view.all().filter((element) => element.props['metric'] === 'cost')).toHaveLength(1);
    click(view, '请求数');
    expect(view.all().filter((element) => element.props['metric'] === 'requests')).toHaveLength(1);
    expect(onQuery).not.toHaveBeenCalled();
  });
  it('synchronizes inputs and preset when the parent changes the query', () => {
    const { view, setQuery, onQuery } = setup();
    setQuery(presetUsageQuery('today', '/project/a'));
    expect(view.find((element) => element.type === 'button' && text(element) === '今天').props['aria-pressed']).toBe(true);
    expect(view.find((element) => element.type === 'select').props['value']).toBe('/project/a');
    expect(onQuery).not.toHaveBeenCalled();
  });
});

describe('SettingsPage callback behavior (shallow, no browser)', () => {
  it('awaits persistence, prevents duplicate submission and only then reports success', async () => {
    let resolve!: () => void;
    const onSave = vi.fn((_config: ChannelConfig) => new Promise<void>((done) => { resolve = done; }));
    const view = mount(() => SettingsPage({ channels: [channel], saving: false, onSave }));
    fill(view, '渠道名称', 'Updated provider');
    submit(view); submit(view);
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave.mock.calls[0]![0].name).toBe('Updated provider');
    expect(view.text()).toContain('正在保存'); expect(view.text()).not.toContain('保存成功');
    expect(view.find((element) => element.props['className'] === 'settings-form-fields').props['disabled']).toBe(true);
    resolve(); await Promise.resolve(); view.refresh();
    expect(view.text()).toContain('保存成功'); expect(view.text()).not.toContain('正在保存');
  });
  it('surfaces rejected saves and preserves edits for retry', async () => {
    const onSave = vi.fn(async () => { throw new Error('Host connection lost'); });
    const view = mount(() => SettingsPage({ channels: [channel], saving: false, onSave }));
    fill(view, '渠道名称', 'Keep this edit'); submit(view); await Promise.resolve(); view.refresh();
    expect(view.text()).toContain('保存失败：Host connection lost');
    expect(view.find((element) => element.props['label'] === '渠道名称').props['value']).toBe('Keep this edit');
    expect(view.text()).not.toContain('保存成功');
  });
  it('rejects invalid fields before persistence', () => {
    const onSave = vi.fn(async () => {});
    const view = mount(() => SettingsPage({ channels: [channel], saving: false, onSave }));
    fill(view, '余额金额', 'not-a-number'); submit(view);
    expect(onSave).not.toHaveBeenCalled(); expect(view.text()).toContain('尚未保存任何更改');
    expect(view.find((element) => element.props['label'] === '余额金额').props['error']).toContain('有限的非负数');
  });
  it('adds, edits and removes model rows, submitting all remaining models', async () => {
    const onSave = vi.fn(async (_config: ChannelConfig) => {});
    const view = mount(() => SettingsPage({ channels: [channel], saving: false, onSave }));
    click(view, '添加模型');
    const fields = (label: string) => view.all().filter((element) => element.props['label'] === label);
    expect(fields('模型 ID')).toHaveLength(2);
    call(fields('模型 ID')[1]!, 'onChange', 'model-b'); view.refresh();
    call(fields('显示名称')[1]!, 'onChange', 'Model B'); view.refresh();
    call(fields('输出 (USD / 百万)')[1]!, 'onChange', '0'); view.refresh();
    submit(view); await Promise.resolve(); view.refresh();
    expect(onSave.mock.calls[0]![0].models.map((model) => model.id)).toEqual(['model-a', 'model-b']);
    expect(onSave.mock.calls[0]![0].models[1]!.outputPricePerMillion).toBe(0);
    click(view, '移除此模型'); expect(fields('模型 ID')).toHaveLength(1);
    expect(fields('模型 ID')[0]!.props['value']).toBe('model-b');
  });
  it('creates an editable ID, waits for props catalog updates and selects existing channels', async () => {
    const onSave = vi.fn(async (_config: ChannelConfig) => {});
    let props: SettingsPageProps = { channels: [channel], saving: false, onSave };
    const view = mount(() => SettingsPage(props));
    click(view, '新增');
    expect(view.find((element) => element.props['label'] === '渠道 ID').props['readOnly']).toBe(false);
    fill(view, '渠道 ID', 'new-channel'); fill(view, '渠道名称', 'New channel');
    fill(view, 'API Key 环境变量名', 'NEW_CHANNEL_KEY'); fill(view, '模型 ID', 'new-model'); fill(view, '显示名称', 'New model');
    submit(view); await Promise.resolve(); view.refresh();
    const catalog = () => view.find((element) => element.type === 'nav');
    expect(text(catalog())).not.toContain('New channel');
    const saved = onSave.mock.calls[0]![0];
    props = { ...props, channels: [channel, { ...saved, credentialReady: false, builtin: false, reasoningLevels: [] }] }; view.refresh();
    expect(text(catalog())).toContain('New channel');
    click(view, 'Provider'); expect(view.find((element) => element.props['label'] === '渠道 ID').props['value']).toBe('provider');
  });
  it('applies authoritative props that arrive while a save is pending', async () => {
    let resolve!: () => void;
    const onSave = vi.fn((_config: ChannelConfig) => new Promise<void>((done) => { resolve = done; }));
    let props: SettingsPageProps = { channels: [channel], saving: false, onSave };
    const view = mount(() => SettingsPage(props)); fill(view, '渠道名称', 'submitted name'); submit(view);
    props = { ...props, channels: [{ ...channel, name: 'Host canonical name' }] }; view.refresh();
    expect(view.find((element) => element.props['label'] === '渠道名称').props['value']).toBe('submitted name');
    resolve(); await Promise.resolve(); view.refresh();
    expect(view.find((element) => element.props['label'] === '渠道名称').props['value']).toBe('Host canonical name');
  });
  it('does not discard a dirty draft when the Host refreshes credential metadata', () => {
    let props: SettingsPageProps = { channels: [channel], saving: false, onSave: async () => {} };
    const view = mount(() => SettingsPage(props)); fill(view, '渠道名称', 'Unsaved name');
    props = { ...props, channels: [{ ...channel, credentialReady: false }] }; view.refresh();
    expect(view.find((element) => element.props['label'] === '渠道名称').props['value']).toBe('Unsaved name');
  });
});
