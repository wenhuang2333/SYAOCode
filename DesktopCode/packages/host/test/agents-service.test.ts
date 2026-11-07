/**
 * Agent 群三角色服务（FR-N-003 / TC-N-022 等价断言）。
 *
 * 覆盖：创建 / 编辑 / 删除 / 激活、激活后执行模型取 `common`、三角色可共用同一
 * 模型、删除激活群被拒、绑定格式校验、onChange 回调时机。
 */

import { describe, expect, it } from 'vitest';
import type { AgentGroup } from '@syaocode/dhp';
import { AgentsService, AgentsServiceError } from '../src/agents-service.ts';

const group = (name: string, roles: Record<'hyaki' | 'sota' | 'common', string>, extra: Partial<AgentGroup> = {}): AgentGroup => ({
  name,
  roles,
  active: false,
  createdAt: 1000,
  updatedAt: 1000,
  ...extra,
});

describe('agent 群三角色', () => {
  it('创建群：三角色各自绑定渠道:模型', async () => {
    const service = new AgentsService({});
    const saved = await service.save({
      name: '默认',
      roles: { hyaki: 'deepseek:deepseek-chat', sota: 'anthropic:claude-sonnet-4', common: 'mock:default' },
    });
    expect(saved.name).toBe('默认');
    expect(saved.roles.hyaki).toBe('deepseek:deepseek-chat');
    expect(saved.roles.sota).toBe('anthropic:claude-sonnet-4');
    expect(saved.roles.common).toBe('mock:default');
    expect(saved.active).toBe(false);
    const list = service.list();
    expect(list.groups).toHaveLength(1);
    expect(list.active).toBeNull();
    expect(service.executionModel()).toBeNull();
  });

  it('编辑同名群：覆盖角色绑定，保留创建时间', async () => {
    const service = new AgentsService({});
    const created = await service.save({ name: 'a', roles: { hyaki: 'mock:default', sota: 'mock:default', common: 'mock:default' } });
    const updated = await service.save({ name: 'a', roles: { hyaki: 'mock:cheap', sota: 'mock:smart', common: 'mock:default' } });
    expect(service.list().groups).toHaveLength(1);
    expect(updated.roles.hyaki).toBe('mock:cheap');
    expect(updated.roles.sota).toBe('mock:smart');
    expect(updated.createdAt).toBe(created.createdAt);
  });

  it('删除群：删除后从列表消失', async () => {
    const service = new AgentsService({});
    await service.save({ name: 'a', roles: { hyaki: 'mock:default', sota: 'mock:default', common: 'mock:default' } });
    await service.save({ name: 'b', roles: { hyaki: 'mock:default', sota: 'mock:default', common: 'mock:default' } });
    await expect(service.remove('a')).resolves.toEqual({ removed: true });
    expect(service.list().groups.map((g) => g.name)).toEqual(['b']);
  });

  it('激活后执行模型取 common 角色', async () => {
    const service = new AgentsService({});
    await service.save({
      name: '写作',
      roles: { hyaki: 'deepseek:deepseek-chat', sota: 'anthropic:claude-sonnet-4', common: 'openai-compatible:gpt-4o' },
    });
    const activated = await service.activate('写作');
    expect(activated).toEqual({ active: '写作', common: 'openai-compatible:gpt-4o' });
    expect(service.executionModel()).toBe('openai-compatible:gpt-4o');
    expect(service.list().active).toBe('写作');
    expect(service.list().groups[0]?.active).toBe(true);
  });

  it('三角色可以兼任同一个模型', async () => {
    const service = new AgentsService({});
    await service.save({ name: '省钱', roles: { hyaki: 'mock:default', sota: 'mock:default', common: 'mock:default' } });
    await service.activate('省钱');
    expect(service.executionModel()).toBe('mock:default');
    const groupInfo = service.list().groups[0];
    expect(groupInfo?.roles.hyaki).toBe('mock:default');
    expect(groupInfo?.roles.sota).toBe('mock:default');
    expect(groupInfo?.roles.common).toBe('mock:default');
  });

  it('删除当前激活的群被拒（必须先切换激活项）', async () => {
    const service = new AgentsService({});
    await service.save({ name: 'a', roles: { hyaki: 'mock:default', sota: 'mock:default', common: 'mock:default' } });
    await service.save({ name: 'b', roles: { hyaki: 'mock:default', sota: 'mock:default', common: 'mock:default' } });
    await service.activate('a');
    await expect(service.remove('a')).rejects.toMatchObject({ kind: 'agents_active_conflict' });
    expect(service.list().groups).toHaveLength(2);
    // 切到 b 之后 a 才能删
    await service.activate('b');
    await expect(service.remove('a')).resolves.toEqual({ removed: true });
    expect(service.list().groups.map((g) => g.name)).toEqual(['b']);
  });

  it('绑定必须非空且形如 渠道:模型（或 @模型档案）', async () => {
    const service = new AgentsService({});
    await expect(
      service.save({ name: 'x', roles: { hyaki: '', sota: 'mock:default', common: 'mock:default' } }),
    ).rejects.toMatchObject({ kind: 'agents_invalid' });
    await expect(
      service.save({ name: 'x', roles: { hyaki: 'mockdefault', sota: 'mock:default', common: 'mock:default' } }),
    ).rejects.toMatchObject({ kind: 'agents_invalid' });
    await expect(
      service.save({ name: 'x', roles: { hyaki: 'mock:', sota: 'mock:default', common: 'mock:default' } }),
    ).rejects.toMatchObject({ kind: 'agents_invalid' });
    await expect(
      service.save({ name: '', roles: { hyaki: 'mock:default', sota: 'mock:default', common: 'mock:default' } }),
    ).rejects.toMatchObject({ kind: 'agents_invalid' });
    // @档案 形态合法
    await expect(
      service.save({ name: 'x', roles: { hyaki: '@cheap', sota: '@smart', common: '@cheap' } }),
    ).resolves.toMatchObject({ name: 'x' });
  });

  it('onChange 在 save / remove / activate 之后触发', async () => {
    const calls: { groups: number; active: string | null }[] = [];
    const service = new AgentsService({
      onChange: (groups, active) => {
        calls.push({ groups: groups.length, active });
      },
    });
    await service.save({ name: 'a', roles: { hyaki: 'mock:default', sota: 'mock:default', common: 'mock:default' } });
    await service.save({ name: 'b', roles: { hyaki: 'mock:default', sota: 'mock:default', common: 'mock:default' } });
    await service.activate('a');
    await service.remove('b');
    expect(calls).toEqual([
      { groups: 1, active: null },
      { groups: 2, active: null },
      { groups: 2, active: 'a' },
      { groups: 1, active: 'a' },
    ]);
  });

  it('从持久化数据恢复：群与激活项都保留', () => {
    const service = new AgentsService({
      groups: [
        group('a', { hyaki: 'mock:cheap', sota: 'mock:smart', common: 'mock:default' }, { active: true }),
        group('b', { hyaki: 'mock:cheap', sota: 'mock:smart', common: 'mock:other' }),
      ],
      active: 'a',
    });
    expect(service.list().groups).toHaveLength(2);
    expect(service.list().active).toBe('a');
    expect(service.executionModel()).toBe('mock:default');
    expect(service.list().groups.find((g) => g.name === 'b')?.active).toBe(false);
  });

  it('激活项指向不存在的群时按未激活处理（不做假状态）', () => {
    const service = new AgentsService({ groups: [group('a', { hyaki: 'mock:a', sota: 'mock:a', common: 'mock:a' })], active: 'missing' });
    expect(service.list().active).toBeNull();
    expect(service.executionModel()).toBeNull();
  });

  it('错误类型带 kind，便于 host.ts 映射 DHP 错误码', async () => {
    const service = new AgentsService({});
    const error = await service.remove('nope').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AgentsServiceError);
    expect((error as AgentsServiceError).kind).toBe('agents_not_found');
  });
});
