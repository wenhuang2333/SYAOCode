/**
 * 交互代理：把内核的 `PermissionHandler`（一个阻塞的 Promise）桥接成 DHP 的
 * `permission.request` 事件 + 客户端 `interaction/resolve` 命令。
 *
 * 这是整个桌面端最容易出错的地方，所以规则写死在这里：
 *
 *  1. **超时 fail-closed**：内核等审批最多 10 分钟；我们的超时**必须小于**它，
 *     否则内核先超时，用户后点"允许"会得到一个"已结算"的困惑错误。
 *  2. **结算幂等**：同一个 interaction 只能被结算一次；第二次返回
 *     `interaction_settled`（-32021），**不**改变第一次的结论。
 *  3. **`recheck` 不算结算**：用户要求"重新评估"时，同一个 interaction 保持
 *     未决，只把轮次 +1，避免 UI 上出现"我点了重评但卡片消失"。
 *  4. **敏感项不可记忆**：`sensitive: true` 时拒绝 `session`/`project`，
 *     降级为 `once`（与 CLI 行为一致，见 `00` §6.4）。
 */

import type { PermissionDecision, PermissionRequest, ToolRisk } from '@syaocode/core';
import type { PendingInteraction } from '@syaocode/dhp';

/** 审批超时。内核侧是 10 分钟，这里留 30 秒余量，保证**我们**先超时。 */
export const INTERACTION_TIMEOUT_MS = 9 * 60 * 1000;

export interface InteractionRecord {
  readonly interaction: PendingInteraction;
  /** 内核请求原文（结算时要按它生成 `PermissionDecision`）。 */
  readonly request: PermissionRequest;
  readonly round: number;
  settled: boolean;
  /** 每次 recheck 递增；用于作废旧轮次的迟到回答。 */
  revision: number;
}

export type ResolveOutcome =
  | { readonly ok: true; readonly decision: PermissionDecision }
  | { readonly ok: false; readonly kind: 'interaction_settled' | 'capability_not_found'; readonly message: string };

type EmitFn = (interaction: PendingInteraction) => void;

/**
 * 待决交互的登记处。
 *
 * 有意做成**无 IO** 的纯逻辑 + 注入的 emit 回调，这样能脱离 WebSocket 单测。
 */
export class InteractionBroker {
  private readonly records = new Map<string, InteractionRecord>();
  /** 等待结算的 resolver：`id → resolve`。 */
  private readonly waiters = new Map<string, (d: PermissionDecision) => void>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(
    private readonly emit: EmitFn,
    private readonly opts: {
      readonly sessionId: string;
      readonly now?: () => number;
      readonly timeoutMs?: number;
    },
  ) {}

  /**
   * 内核调用入口。返回的 Promise 在客户端结算或超时后 resolve。
   *
   * 注意：**永远不 reject**。内核只认 `PermissionDecision`；
   * 抛异常会让整轮对话失败，而用户只是没点按钮。
   */
  handle(req: PermissionRequest): Promise<PermissionDecision> {
    const existing = this.records.get(req.id);
    if (existing !== undefined && !existing.settled) {
      // 同一 id 重入（内核 recheck 路径）：保持原卡片，轮次 +1。
      const next: InteractionRecord = {
        ...existing,
        round: (req.round ?? existing.round) + (req.round === undefined ? 0 : 0),
        revision: existing.revision + 1,
      };
      this.records.set(req.id, next);
      return new Promise<PermissionDecision>((resolve) => {
        this.waiters.set(req.id, resolve);
      });
    }

    const interaction = toPendingInteraction(req, this.opts.sessionId, this.opts.now ?? Date.now);
    const record: InteractionRecord = {
      interaction,
      request: req,
      round: req.round ?? 0,
      settled: false,
      revision: 1,
    };
    this.records.set(req.id, record);
    this.emit(interaction);

    return new Promise<PermissionDecision>((resolve) => {
      this.waiters.set(req.id, resolve);

      const timeoutMs = this.opts.timeoutMs ?? INTERACTION_TIMEOUT_MS;
      const timer = setTimeout(() => {
        // 超时按 fail-closed 处理：拒绝，并给用户一条可理解的说明。
        this.settle(req.id, {
          decision: 'deny',
          remember: 'once',
          message: `审批超时（${Math.round(timeoutMs / 60000)} 分钟无响应），已自动拒绝`,
        });
      }, timeoutMs);
      // 不阻止进程退出（Host 关停时不必等审批超时）。
      timer.unref?.();
      this.timers.set(req.id, timer);
    });
  }

  /**
   * 客户端结算。
   *
   * `optionId` 语义：`once` / `session` / `project` / `deny`。
   */
  resolve(id: string, optionId: string): ResolveOutcome {
    const record = this.records.get(id);
    if (record === undefined) {
      return { ok: false, kind: 'capability_not_found', message: `unknown interaction ${id}` };
    }
    if (record.settled) {
      // 幂等：返回第一次的结论，不重复 emit。
      return { ok: false, kind: 'interaction_settled', message: `interaction ${id} already settled` };
    }

    if (optionId === 'deny') {
      this.settle(id, { decision: 'deny', remember: 'once' });
      return { ok: true, decision: { decision: 'deny', remember: 'once' } };
    }

    // 记忆范围：敏感项一律降级为 once（不可记忆）。
    let remember: 'once' | 'session' | 'project' = 'once';
    if (optionId === 'session') remember = record.interaction.sensitive === true ? 'once' : 'session';
    else if (optionId === 'project') remember = record.interaction.sensitive === true ? 'once' : 'project';

    const decision: PermissionDecision = { decision: 'allow', remember };
    this.settle(id, decision);
    return { ok: true, decision };
  }

  /** 会话关闭 / Host 关停时，把所有待决项按拒绝结算，避免内核永久阻塞。 */
  drain(reason: string): void {
    for (const [id, record] of this.records) {
      if (record.settled) continue;
      this.settle(id, { decision: 'deny', remember: 'once', message: reason });
    }
  }

  /** 当前待决项（重连后随 snapshot 一起下发）。 */
  pending(): readonly PendingInteraction[] {
    return [...this.records.values()].filter((r) => !r.settled).map((r) => r.interaction);
  }

  private settle(id: string, decision: PermissionDecision): void {
    const record = this.records.get(id);
    if (record === undefined || record.settled) return;
    record.settled = true;

    const timer = this.timers.get(id);
    if (timer !== undefined) {
      clearTimeout(timer);
      this.timers.delete(id);
    }
    const waiter = this.waiters.get(id);
    if (waiter !== undefined) {
      this.waiters.delete(id);
      waiter(decision);
    }
  }
}

/** 归一化为客户端展示所需的最小字段集（客户端不做业务判断）。 */
export function toPendingInteraction(
  req: PermissionRequest,
  sessionId: string,
  now: () => number,
): PendingInteraction {
  const createdAt = now();
  const subject = req.subject;
  const subjectText =
    subject.command !== undefined
      ? subject.command
      : subject.path !== undefined
        ? subject.path
        : subject.url !== undefined
          ? subject.url
          : req.tool;

  const options: PendingInteraction['options'] = [
    { id: 'once', label: '允许一次', scope: 'once' },
    { id: 'session', label: '允许本会话', scope: 'session' },
    { id: 'project', label: '允许本项目', scope: 'project' },
    { id: 'deny', label: '拒绝', scope: 'deny' },
  ];

  // 敏感项只保留"允许一次 / 拒绝"（`00` §6.4 硬规则）。
  const visibleOptions =
    req.sensitive === true ? options.filter((o) => o.scope === 'once' || o.scope === 'deny') : options;

  return {
    id: req.id,
    kind: 'permission',
    createdAt,
    expiresAt: createdAt + INTERACTION_TIMEOUT_MS,
    sessionId,
    subject: subjectText,
    risk: normalizeRisk(req.risk),
    ...(req.reason !== '' ? { explain: req.reason } : {}),
    ...(req.sensitive === true ? { sensitive: true } : {}),
    ...(subject.command !== undefined
      ? { preview: { type: 'command' as const, text: subject.command } }
      : subject.path !== undefined
        ? { preview: { type: 'path' as const, text: subject.path } }
        : {}),
    options: visibleOptions,
  };
}

/**
 * 把内核的 5 种 risk 收敛为 UI 的 3 档。
 * `network` 归入 `exec`（它有副作用），`meta` 归入 `read`（它不改外部状态）。
 */
function normalizeRisk(risk: ToolRisk): PendingInteraction['risk'] {
  switch (risk) {
    case 'read':
      return 'read';
    case 'meta':
      return 'read';
    case 'write':
      return 'write';
    case 'exec':
      return 'exec';
    case 'network':
      return 'exec';
  }
}
