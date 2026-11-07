/**
 * Agent 群三角色服务（FR-N-003）。
 *
 * 语义与 CLI 的 `/set-agents`（`code/packages/cli/src/model-config.ts`）一致，
 * 但**不复用**那份代码——`host` 不依赖 `cli`，桌面端自行实现同一套语义：
 *  - 三个角色：`hyaki`（提取总结）/ `sota`（思考规划）/ `common`（落实执行）；
 *  - 每个角色绑定一个 `渠道:模型` 字符串；
 *  - **同一个模型可以兼任多个角色**（低成本场景三角色同模型）；
 *  - 群可创建 / 编辑 / 删除 / 激活；
 *  - **激活后当前会话的执行模型取 `common`**（`executionModel()`）。
 *
 * 分层边界（`27` §5.6 / §6）：
 *  - 本服务只做**结构校验**（非空 + 基本格式）。模型规格是否真实存在，由
 *    host.ts 用 `workbench.model()` 校验——服务层无权知道宿主配置了哪些渠道。
 *  - **不持久化**：状态写入由 host.ts 负责（state-v2 的 `agentGroups` /
 *    `agentActive`），本服务通过 `onChange` 把最新快照交出去。
 *  - 删除**不得**删掉当前激活的群（必须先切换激活项）。
 */

import type { AgentGroup, AgentRole, AgentsListResult, AgentsSaveParams } from '@syaocode/dhp';

/** 三角色的固定顺序（与 `27` §5.1 一致）。 */
export const AGENT_ROLE_ORDER: readonly AgentRole[] = ['hyaki', 'sota', 'common'];

/** 角色 → 一句话说明（给界面做 tooltip 用，不参与逻辑）。 */
export const AGENT_ROLE_LABELS: Readonly<Record<AgentRole, string>> = {
  hyaki: '提取与总结（建议低成本模型）',
  sota: '思考与规划（建议高能力模型）',
  common: '落实与执行（建议均衡模型）',
};

export interface AgentGroupInput {
  name: string;
  roles: Record<'hyaki' | 'sota' | 'common', string>;
}

export interface AgentsServiceOptions {
  /** 初始群列表（通常来自 host.ts 从 state-v2 读出的数据）。 */
  groups?: readonly AgentGroup[];
  /** 当前激活的群名。 */
  active?: string | null;
  /** 变更回调：save / remove / activate 之后触发（host.ts 在此持久化）。 */
  onChange?: (groups: readonly AgentGroup[], active: string | null) => void | Promise<void>;
}

/** 服务层失败语义。host.ts 负责映射成 DHP 错误码。 */
export type AgentsFailureKind = 'agents_not_found' | 'agents_active_conflict' | 'agents_invalid';

export class AgentsServiceError extends Error {
  readonly kind: AgentsFailureKind;

  constructor(kind: AgentsFailureKind, message: string) {
    super(message);
    this.name = 'AgentsServiceError';
    this.kind = kind;
  }
}

/**
 * 模型绑定的基本格式。
 *
 *  - `provider:model`（渠道:模型）——主形态；
 *  - `@profile` —— 自定义模型档案（与 CLI 的 `/set-agents` 一致）。
 *
 * 这里只做**格式**校验；模型是否真实可用由 host.ts 判定。
 */
const BINDING_PATTERN = /^[^:\s]+:[^:\s]+$/;
const PROFILE_PATTERN = /^@[A-Za-z0-9][A-Za-z0-9_.-]*$/;

export class AgentsService {
  private groups: AgentGroup[] = [];
  private active: string | null = null;
  private readonly onChange: ((groups: readonly AgentGroup[], active: string | null) => void | Promise<void>) | undefined;

  constructor(opts: AgentsServiceOptions) {
    this.onChange = opts.onChange;
    for (const group of opts.groups ?? []) {
      this.groups.push(cloneGroup(group));
    }
    const requested = opts.active ?? null;
    // 激活项必须指向真实存在的群；否则视为未激活（不做假状态）。
    this.active = requested !== null && this.groups.some((g) => g.name === requested) ? requested : null;
    this.syncActiveFlags();
  }

  /** 群列表 + 当前激活项。 */
  list(): AgentsListResult {
    return { groups: this.groups.map((group) => cloneGroup(group)), active: this.active };
  }

  /** 创建或覆盖同名群；覆盖时保留 `createdAt`。 */
  async save(params: AgentsSaveParams): Promise<AgentGroup> {
    const name = params.name.trim();
    if (name === '') {
      throw new AgentsServiceError('agents_invalid', 'agent 群名不能为空');
    }
    if (name.length > 64) {
      throw new AgentsServiceError('agents_invalid', 'agent 群名过长（最多 64 个字符）');
    }
    const roles = validateRoles(params.roles);
    const now = Date.now();
    const existing = this.groups.find((group) => group.name === name);
    const saved: AgentGroup = existing === undefined
      ? { name, roles, active: false, createdAt: now, updatedAt: now }
      : { ...existing, roles, updatedAt: now };
    if (existing === undefined) {
      this.groups.push(saved);
    } else {
      this.groups = this.groups.map((group) => (group.name === name ? saved : group));
    }
    this.syncActiveFlags();
    await this.notify();
    return cloneGroup(saved);
  }

  /** 删除群；**不能**删掉当前激活的群。 */
  async remove(name: string): Promise<{ removed: true }> {
    const target = this.groups.find((group) => group.name === name.trim());
    if (target === undefined) {
      throw new AgentsServiceError('agents_not_found', `agent 群 ${name} 不存在`);
    }
    if (this.active === target.name) {
      throw new AgentsServiceError('agents_active_conflict', '不能删除当前激活的 agent 群，请先切换到其它群或取消激活');
    }
    this.groups = this.groups.filter((group) => group.name !== target.name);
    await this.notify();
    return { removed: true };
  }

  /** 激活群；激活后当前会话的执行模型取 `common` 角色。 */
  async activate(name: string): Promise<{ active: string; common: string }> {
    const target = this.groups.find((group) => group.name === name.trim());
    if (target === undefined) {
      throw new AgentsServiceError('agents_not_found', `agent 群 ${name} 不存在`);
    }
    this.active = target.name;
    this.syncActiveFlags();
    await this.notify();
    return { active: target.name, common: target.roles.common };
  }

  /** 当前会话的执行模型：激活群的 `common` 角色；未激活 → `null`。 */
  executionModel(): string | null {
    if (this.active === null) return null;
    const group = this.groups.find((candidate) => candidate.name === this.active);
    if (group === undefined) return null;
    return group.roles.common;
  }

  // ── 内部 ──────────────────────────────────────────────────────────────

  /** `active` 标记是 `active` 字段的唯一所有者：只由 `this.active` 派生。 */
  private syncActiveFlags(): void {
    this.groups = this.groups.map((group) =>
      group.active === (group.name === this.active) ? group : { ...group, active: group.name === this.active },
    );
  }

  private async notify(): Promise<void> {
    if (this.onChange === undefined) return;
    await this.onChange(this.groups.map((group) => cloneGroup(group)), this.active);
  }
}

// ── 校验 ────────────────────────────────────────────────────────────────

function validateRoles(roles: Readonly<Record<AgentRole, string>>): Record<AgentRole, string> {
  const out = {} as Record<AgentRole, string>;
  for (const role of AGENT_ROLE_ORDER) {
    const value = roles[role];
    if (typeof value !== 'string' || value.trim() === '') {
      throw new AgentsServiceError('agents_invalid', `角色 ${role} 必须绑定一个模型（渠道:模型）`);
    }
    const trimmed = value.trim();
    if (!BINDING_PATTERN.test(trimmed) && !PROFILE_PATTERN.test(trimmed)) {
      throw new AgentsServiceError(
        'agents_invalid',
        `角色 ${role} 的模型规格不合法：${trimmed}（应为 渠道:模型 或 @模型档案）`,
      );
    }
    out[role] = trimmed;
  }
  return out;
}

function cloneGroup(group: AgentGroup): AgentGroup {
  return { ...group, roles: { ...group.roles } };
}
