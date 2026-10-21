import { beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  activateAgentGroup,
  availableModelRefs,
  deleteAgentGroup,
  getAgentGroup,
  listAgentGroups,
  saveAgentGroup,
  type AgentGroup,
} from '../src/model-config';
import {
  groupSteps,
  newGroupSentinel,
  moveSelection,
  newGroupWizard,
  optionsOf,
  renderGroupWizard,
  setGroupPrefillProvider,
  setGroupWizardDeps,
  submitStep,
} from '../src/tui/agent-wizard';

function isolatedHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'syao-agents-'));
}

function group(over: Partial<AgentGroup> = {}): AgentGroup {
  return { hyaki: 'deepseek:deepseek-chat', sota: 'anthropic:claude-sonnet-4', common: 'deepseek:deepseek-chat', createdAt: 1, updatedAt: 2, ...over };
}

describe('agent 群数据层（/set-agents · /model · --agents）', () => {
  let home: string;
  beforeEach(() => {
    home = isolatedHome();
  });

  it('save/list/get/delete；激活群把 common 写入当前模型并记录 activeAgentGroup', () => {
    saveAgentGroup('cheap', group(), home);
    expect(Object.keys(listAgentGroups(home))).toEqual(['cheap']);
    expect(getAgentGroup('cheap', home)?.sota).toBe('anthropic:claude-sonnet-4');

    const res = activateAgentGroup('cheap', home);
    expect(res.ok).toBe(true);
    expect(res.common).toBe('deepseek:deepseek-chat');
    const cfg = JSON.parse(fs.readFileSync(path.join(home, '.syaocode', 'config.json'), 'utf8')) as { model: { provider: string; name: string }; activeAgentGroup: string };
    expect(cfg.model).toEqual({ provider: 'deepseek', name: 'deepseek-chat' });
    expect(cfg.activeAgentGroup).toBe('cheap');

    expect(deleteAgentGroup('cheap', home)).toBe(true);
    const after = JSON.parse(fs.readFileSync(path.join(home, '.syaocode', 'config.json'), 'utf8')) as { activeAgentGroup?: string };
    expect(after.activeAgentGroup).toBeUndefined();
  });

  it('同一模型可担任多个角色（三角色同模型合法保存并激活）', () => {
    const solo = group({ hyaki: 'mock:default', sota: 'mock:default', common: 'mock:default' });
    saveAgentGroup('solo', solo, home);
    expect(getAgentGroup('solo', home)).toEqual(solo);
    const res = activateAgentGroup('solo', home);
    expect(res.ok).toBe(true);
    expect(res.common).toBe('mock:default');
  });

  it('availableModelRefs：内置 Provider 模型 + @档案', () => {
    const refs = availableModelRefs(home);
    expect(refs).toContain('mock:default');
    expect(refs).toContain('deepseek:deepseek-chat');
    expect(refs).toContain('anthropic:claude-sonnet-4');
    expect(refs.every((r) => r.includes(':') || r.startsWith('@'))).toBe(true);
  });
});

describe('tui/agent-wizard 群向导', () => {
  beforeEach(() => {
    setGroupWizardDeps({
      groupNames: () => ['existing'],
      modelRefs: () => ['mock:default', 'deepseek:deepseek-chat', 'anthropic:claude-sonnet-4'],
    });
    setGroupPrefillProvider((name) =>
      name === 'existing'
        ? { hyaki: 'mock:default', sota: 'anthropic:claude-sonnet-4', common: 'deepseek:deepseek-chat' }
        : {},
    );
  });

  it('步骤结构：目标→命名→三角色', () => {
    expect(groupSteps().map((s) => s.id)).toEqual(['target', 'name', 'hyaki', 'sota', 'common']);
  });

  it('有群时先选目标：选已有群进入编辑并预填角色与高亮', () => {
    let w = newGroupWizard();
    expect(optionsOf(w)).toEqual(['existing', newGroupSentinel()]);
    const r = submitStep(w, '');
    expect(r.state.editing).toBe('existing');
    expect(r.state.answers.hyaki).toBe('mock:default');
    // 进入 sota 步后高亮预填的 anthropic
    let s = r.state;
    s = submitStep(s, '').state; // name 回车沿用
    expect(s.stepIdx).toBe(2); // hyaki 步
    s = submitStep(s, '').state; // hyaki 沿用（选中 mock:default）
    expect(s.stepIdx).toBe(3);
    expect(optionsOf(s)[s.selIdx]).toBe('anthropic:claude-sonnet-4');
  });

  it('新建群完整流程：命名→三角色选择（允许同模型多角色）→done', () => {
    let w = newGroupWizard();
    w = moveSelection(w, 1); // 选中 ＋ create a new group
    expect(optionsOf(w)[w.selIdx]).toBe(newGroupSentinel());
    let r = submitStep(w, '');
    expect(r.state.stepIdx).toBe(1); // name
    r = submitStep(r.state, 'team');
    expect(r.state.answers.name).toBe('team');
    r = submitStep(r.state, ''); // hyaki = 第一项 mock:default
    r = submitStep(r.state, ''); // sota = 第一项 mock:default（同模型多角色）
    expect(r.done).toBe(false);
    r = submitStep(r.state, ''); // common
    expect(r.done).toBe(true);
    expect(r.state.answers).toMatchObject({ name: 'team', hyaki: 'mock:default', sota: 'mock:default', common: 'mock:default' });
  });

  it('校验：空名/非法名/重名报错；移动选择循环', () => {
    let w = newGroupWizard();
    w = moveSelection(w, 1);
    let r = submitStep(w, '');
    r = submitStep(r.state, '');
    expect(r.state.error).toContain('required');
    r = submitStep(r.state, 'has space');
    expect(r.state.error).toContain('group name');
    r = submitStep(r.state, 'existing');
    expect(r.state.error).toContain('already exists');
    // 循环选择
    let s = { ...r.state, stepIdx: 2, selIdx: 0 } as typeof r.state;
    expect(moveSelection(s, -1).selIdx).toBe(2);
    expect(moveSelection(s, 1).selIdx).toBe(1);
  });

  it('渲染：等宽、三态标记、角色标签、选项窗口', () => {
    const lines = renderGroupWizard(newGroupWizard(), 68);
    const plain = lines.map((l) => l.replace(/\x1b\[[0-9;]*m/g, ''));
    const w0 = plain[0]!.length;
    for (const l of plain) expect(l.length).toBe(w0);
    const text = plain.join('\n');
    expect(text).toContain('hyaki');
    expect(text).toContain('sota');
    expect(text).toContain('common');
    expect(text).toContain('◉');
    expect(text).toContain('set agents');
  });
});
