/**
 * 会话宿主：把一个内核 `Agent` 包装成 DHP 的会话。
 *
 * 关键设计：**Host 自己的投影也走 `@syaocode/dhp` 的同一套 fold 函数**。
 * 这样"服务端认为的状态"与"客户端算出的状态"不可能漂移——因为它们是同一份代码。
 * 这是三条铁律能被信任的实现基础。
 */

import {
  type Agent,
  type AgentEvent,
  type Message,
  type PermissionMode,
  type Usage,
} from '@syaocode/core';
import {
  applyDelta,
  emptySnapshot,
  type PendingInteraction,
  type ProjectionRow,
  type RunState,
  type SessionDelta,
  type SessionEvent,
  type SessionSnapshot,
  type DesktopSessionSummary,
} from '@syaocode/dhp';

/** 事件环大小：足够覆盖"客户端断线 30 秒"期间的补洞需求。 */
export const EVENT_RING_SIZE = 4096;

export interface SessionState {
  readonly sessionId: string;
  archived: boolean;
  title: string;
  readonly createdAt: number;
  updatedAt: number;
  readonly epoch: number;
  /**
   * 命令级 CAS 版本。**唯一真相是 `snapshot.revision`** —— 这里只做访问别名，
   * 避免出现"两个 revision 各自演化"的分裂（本项目真实踩过这个坑）。
   */
  snapshot: SessionSnapshot;
  /** 原始事件环（按 seq 升序），用于 `session/events` 补洞。 */
  events: SessionEvent[];
  /** 已被环丢弃的最小 seq（更早的请求只能回快照）。 */
  ringFloor: number;
  runState: RunState;
  turn: number;
  /** 当前正在执行的 turn 的执行 id（用于 `turn/stop` 的 expectedExecutionId）。 */
  executionId?: string;
  abort?: AbortController;
}

export type DeltaListener = (delta: SessionDelta) => void;

/**
 * 会话集合与事件分发。
 *
 * 有意不直接持有 Agent：Agent 由上层（`AgentFactory`）创建并注入，
 * 便于测试用 MockProvider 替换。
 */
export class SessionRegistry {
  private readonly states = new Map<string, SessionState>();
  private readonly listeners = new Map<string, Set<DeltaListener>>();

  constructor(private readonly now: () => number = Date.now, private readonly onChange: () => void = () => {}) {}

  restore(saved: { snapshot: SessionSnapshot; turn: number; archived: boolean }): SessionState {
    const old = saved.snapshot;
    const interrupted = old.runState !== 'idle' || old.pendingInteractions.length > 0;
    const rows: ProjectionRow[] = old.rows.map((r) => {
      if (r.kind === 'toolCall' && (r.state === 'running' || r.state === 'proposed')) return { ...r, state: 'error', resultText: 'Host interrupted; action was not replayed.' };
      if (r.kind === 'message' || r.kind === 'thinking') return { ...r, final: true };
      return r;
    });
    if (interrupted) rows.push({ kind: 'marker', key: `restart:${old.epoch + 1}`, seq: old.seq, tone: 'warn', text: 'Host restarted; previous run and approvals were interrupted.' });
    const snapshot: SessionSnapshot = { ...old, rows, epoch: old.epoch + 1, revision: old.revision + 1, runState: 'idle', pendingInteractions: [] };
    const s: SessionState = { sessionId: old.meta.sessionId, title: old.meta.title, createdAt: old.meta.createdAt, updatedAt: old.meta.updatedAt, epoch: snapshot.epoch, snapshot, events: [], ringFloor: snapshot.seq + 1, runState: 'idle', turn: saved.turn, archived: saved.archived };
    this.states.set(s.sessionId, s);
    return s;
  }

  create(params: {
    readonly sessionId: string;
    readonly title: string;
    readonly model: string;
    readonly permissionMode: string;
    readonly workspaceRoot: string;
  }): SessionState {
    const ts = this.now();
    const meta = {
      sessionId: params.sessionId,
      title: params.title,
      createdAt: ts,
      updatedAt: ts,
      permissionMode: params.permissionMode,
      model: params.model,
      workspaceRoot: params.workspaceRoot,
    };
    const state: SessionState = {
      sessionId: params.sessionId,
      archived: false,
      title: params.title,
      createdAt: ts,
      updatedAt: ts,
      epoch: 1,
      snapshot: emptySnapshot(meta),
      events: [],
      ringFloor: 1,
      runState: 'idle',
      turn: 0,
    };
    this.states.set(params.sessionId, state);
    return state;
  }

  get(sessionId: string): SessionState | undefined {
    return this.states.get(sessionId);
  }

  require(sessionId: string): SessionState {
    const s = this.states.get(sessionId);
    if (s === undefined) throw new Error(`unknown session: ${sessionId}`);
    return s;
  }

  list(): readonly DesktopSessionSummary[] {
    return [...this.states.values()]
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map((s) => ({
        sessionId: s.sessionId,
        title: s.title,
        createdAt: s.createdAt,
        updatedAt: s.updatedAt,
        turnCount: s.turn,
        workspaceRoot: s.snapshot.meta.workspaceRoot,
        model: s.snapshot.meta.model,
        permissionMode: s.snapshot.meta.permissionMode,
        runState: s.runState,
        archived: s.archived,
      }));
  }

  close(sessionId: string): boolean {
    this.listeners.delete(sessionId);
    return this.states.delete(sessionId);
  }

  rename(sessionId: string, title: string): void {
    const s = this.require(sessionId);
    s.title = title;
    s.updatedAt = this.now();
    s.snapshot = { ...s.snapshot, meta: { ...s.snapshot.meta, title, updatedAt: s.updatedAt } };
    this.onChange();
  }

  subscribe(sessionId: string, fn: DeltaListener): () => void {
    let set = this.listeners.get(sessionId);
    if (set === undefined) {
      set = new Set();
      this.listeners.set(sessionId, set);
    }
    set.add(fn);
    return () => {
      set?.delete(fn);
      if (set?.size === 0) this.listeners.delete(sessionId);
    };
  }

  subscriberCount(sessionId: string): number {
    return this.listeners.get(sessionId)?.size ?? 0;
  }

  /**
   * 追加一个事件：推进 seq、fold 进投影、入环、广播。
   *
   * **所有**状态变化都必须经这里，否则服务端与客户端会看到不同的历史。
   */
  append(sessionId: string, event: SessionEvent): SessionDelta {
    const state = this.require(sessionId);
    const seq = state.snapshot.seq + 1;

    const delta: SessionDelta = {
      sessionId,
      epoch: state.epoch,
      fromSeq: seq,
      toSeq: seq,
      events: [event],
    };

    const applied = applyDelta(state.snapshot, delta);
    if (!applied.ok) {
      // 服务端自己 fold 失败说明状态机有 bug —— 大声失败而不是悄悄继续。
      throw new Error(`host projection diverged: ${applied.reason}`);
    }
    state.snapshot = applied.snapshot;
    state.runState = applied.snapshot.runState;
    state.updatedAt = this.now();
    // **有意不 bump revision**：`revision` 守卫的是"命令级状态"（用于 CAS），
    // 不是流式事件。若每条 text.delta 都让 revision 前进，用户正要点的那张审批卡
    // 会因为"期间来了 3 个字"而变成 stale —— 这是不可接受的交互。
    // 流式一致性由 `seq` 保证，两者职责分离。

    state.events.push(event);
    if (state.events.length > EVENT_RING_SIZE) {
      const dropped = state.events.length - EVENT_RING_SIZE;
      state.events.splice(0, dropped);
      state.ringFloor += dropped;
    }

    this.emit(state, delta);
    this.onChange();
    return delta;
  }

  /** 一次性追加多个事件（合并帧场景）。 */
  appendBatch(sessionId: string, events: readonly SessionEvent[], coalesced = false): SessionDelta {
    const state = this.require(sessionId);
    const fromSeq = state.snapshot.seq + 1;
    const toSeq = fromSeq + events.length - 1;

    const delta: SessionDelta = {
      sessionId,
      epoch: state.epoch,
      fromSeq,
      toSeq,
      events: [...events],
      ...(coalesced ? { coalesced: true } : {}),
    };

    const applied = applyDelta(state.snapshot, delta);
    if (!applied.ok) throw new Error(`host projection diverged: ${applied.reason}`);
    state.snapshot = applied.snapshot;
    state.runState = applied.snapshot.runState;
    state.updatedAt = this.now();
    // 同 `append`：不 bump revision。

    state.events.push(...events);
    if (state.events.length > EVENT_RING_SIZE) {
      const dropped = state.events.length - EVENT_RING_SIZE;
      state.events.splice(0, dropped);
      state.ringFloor += dropped;
    }

    this.emit(state, delta);
    this.onChange();
    return delta;
  }

  /**
   * 补洞分页（`session/events`）。返回 `undefined` 表示区间已不可用，
   * 客户端必须改走 `session/snapshot`（`gap_unrecoverable`）。
   */
  eventsBetween(sessionId: string, fromSeq: number, toSeq: number): SessionDelta | undefined {
    const state = this.require(sessionId);
    if (fromSeq < state.ringFloor) return undefined;
    if (toSeq < fromSeq) return { sessionId, epoch: state.epoch, fromSeq, toSeq: fromSeq - 1, events: [] };
    const slice = state.events.slice(fromSeq - state.ringFloor, toSeq - state.ringFloor + 1);
    return { sessionId, epoch: state.epoch, fromSeq, toSeq, events: slice };
  }

  /**
   * 显式推进 revision —— 只在**命令级**状态变化时调用：
   * 轮次被接受、交互被结算、配置/权限模式改变、重命名、关闭。
   */
  bumpRevision(sessionId: string): number {
    const state = this.require(sessionId);
    state.updatedAt = this.now();
    state.snapshot = { ...state.snapshot, revision: state.snapshot.revision + 1, meta: { ...state.snapshot.meta, updatedAt: state.updatedAt } };
    this.onChange();
    return state.snapshot.revision;
  }

  /**
   * 更新待决交互（由 broker 的通知驱动）。
   *
   * **不 bump revision**：待决交互的增加/移除由 `interaction/resolve` 命令驱动，
   * 那条命令自己会 bump。这里改的只是投影副本。
   */
  setPending(sessionId: string, pending: readonly PendingInteraction[]): void {
    const state = this.require(sessionId);
    state.runState = pending.length > 0 ? 'awaiting-approval' : state.runState === 'awaiting-approval' ? 'streaming' : state.runState;
    state.snapshot = { ...state.snapshot, pendingInteractions: pending, runState: state.runState };
    this.onChange();
  }

  patchMeta(sessionId: string, patch: { permissionMode?: string; model?: string }): void {
    const state = this.require(sessionId);
    state.snapshot = {
      ...state.snapshot,
      meta: { ...state.snapshot.meta, ...patch },
    };
  }

  private emit(state: SessionState, delta: SessionDelta): void {
    const set = this.listeners.get(state.sessionId);
    if (set === undefined) return;
    for (const fn of set) {
      try {
        fn(delta);
      } catch {
        // 单个订阅者失败不得影响其他订阅者（与 core 的 EventSink 约定一致）。
      }
    }
  }
}

// ── 内核事件 → DHP 事件 ─────────────────────────────────────────────────

/**
 * 把内核 `AgentEvent` 翻译成 DHP 的 `SessionEvent`（可能 0 条或多条）。
 *
 * **关键语义差异（必须知道）**：
 * 内核的 `session.end` 表示"这一次 `run()` 结束"，**不是**"会话被关闭"。
 * 桌面端的会话可以连续进行很多轮，所以这里把内核的 `session.end` 翻译成
 * DHP 的 `turn.end`（并在非正常结束时补一条 marker 说明原因）。
 * DHP 的 `session.end` 只由 `session/close` 产生。
 *
 * 其余规则：
 *  - 内核的 `Message` 内容块在此**扁平化为文本**（多模态由 `blocks` 计数表达）
 *  - 内核 envelope 的 `seq` **不**复用：DHP 的 `seq` 是会话级的，跨轮单调
 *  - 未知事件类型返回空数组（前向兼容：新内核事件不会打断旧 Host）
 */
export function toSessionEvents(ev: AgentEvent): SessionEvent[] {
  switch (ev.type) {
    case 'session.start':
      return [{ type: 'session.start', permissionMode: ev.permissionMode }];
    case 'turn.start':
      return [{ type: 'turn.start', turn: ev.turn }];
    case 'text.delta':
      return [{ type: 'text.delta', text: ev.text }];
    case 'thinking.delta':
      return [{ type: 'thinking.delta', text: ev.text }];
    case 'message.complete':
      return [
        {
          type: 'message.complete',
          role: ev.message.role,
          text: blocksToText(ev.message.content),
          stopReason: ev.stopReason,
        },
      ];
    case 'tool.proposed':
      return [{ type: 'tool.proposed', callId: ev.call.id, name: ev.call.name, input: ev.call.input }];
    case 'tool.start':
      return [{ type: 'tool.start', callId: ev.callId, name: ev.name, input: ev.input }];
    case 'tool.progress':
      return [{ type: 'tool.progress', callId: ev.callId, note: ev.note }];
    case 'tool.result': {
      const text = blocksToText(ev.content);
      return [
        {
          type: 'tool.result',
          callId: ev.callId,
          name: ev.name,
          text,
          blocks: ev.content.length,
          isError: ev.isError,
          durationMs: ev.durationMs,
        },
      ];
    }
    case 'tool.receipt':
      return [
        {
          type: 'tool.receipt',
          receiptId: ev.receipt.callId,
          toolName: ev.receipt.tool,
          outputRef: ev.receipt.outputRef ?? '',
          hash: ev.receipt.outputHash,
        },
      ];
    case 'verification.start':
      return [{ type: 'verification.start', command: ev.command, index: ev.index, total: ev.total }];
    case 'verification.result':
      return [
        {
          type: 'verification.result',
          ok: ev.result.exitCode === 0,
          detail: `${ev.result.command}（exit ${ev.result.exitCode}）`,
        },
      ];
    case 'usage':
      return [
        {
          type: 'usage',
          inputTokens: ev.usage.inputTokens,
          outputTokens: ev.usage.outputTokens,
          ...(ev.costUsd !== undefined ? { costUsd: ev.costUsd } : {}),
        },
      ];
    case 'budget.warning':
      return [{ type: 'budget.warning', kind: ev.kind, ratio: ev.ratio }];
    case 'error':
      return [{ type: 'error', code: ev.error.code, message: ev.error.message, fatal: ev.fatal }];
    case 'turn.end':
      return [{ type: 'turn.end', turn: ev.turn }];
    case 'session.end': {
      // 一次 run 结束 → 结束当前轮次；非正常结束时补一条 marker 让用户知道原因。
      const out: SessionEvent[] = [{ type: 'turn.end', turn: 0 }];
      if (ev.reason !== 'completed') {
        out.push({
          type: 'error',
          code: ev.error?.code ?? `SY-LOOP-${ev.reason}`,
          message: `本轮以 ${ev.reason} 结束`,
          fatal: false,
        });
      }
      return out;
    }
    // 审批事件由 broker 负责产生（它们携带 UI 需要的归一化字段），
    // 这里**不**重复翻译，避免出现两条来源不同的审批卡片。
    case 'permission.request':
    case 'permission.result':
      return [];
    default:
      return [];
  }
}

/** 内容块扁平化为纯文本。图片等非文本内容以占位符表示（`blocks` 计数另给）。 */
function blocksToText(blocks: readonly Message['content'][number][]): string {
  const parts: string[] = [];
  for (const b of blocks) {
    if (b.type === 'text') parts.push(b.text);
    else if (b.type === 'image') parts.push('[image]');
  }
  return parts.join('');
}

/** 从内核 `Usage` 累计（会话级）。 */
export function addUsage(total: Usage, next: Usage): Usage {
  return {
    inputTokens: total.inputTokens + next.inputTokens,
    outputTokens: total.outputTokens + next.outputTokens,
  };
}

/** 便捷：把 `AgentEvent` 流接到 registry（供 Host 的 turn 执行器使用）。 */
export async function pumpAgentEvents(
  agent: Agent,
  registry: SessionRegistry,
  sessionId: string,
  input: string | Message[],
  signal: AbortSignal,
  hooks: {
    readonly onPending: (pending: readonly PendingInteraction[]) => void;
    readonly pendingOf: () => readonly PendingInteraction[];
  },
): Promise<{ endReason: string; finalText: string; permissionDenied: boolean }> {
  // No sessionId option: history is seeded exactly once by Host, never reloaded by run().
  for await (const ev of agent.run(input, { signal })) {
    for (const mapped of toSessionEvents(ev)) {
      // Kernel turns are internal tool iterations. Only Host finally ends the run.
      if (mapped.type === 'turn.end') continue;
      registry.append(sessionId, mapped.type === 'error' ? { ...mapped, fatal: false } : mapped);
      if (mapped.type === 'permission.request' || mapped.type === 'permission.result') hooks.onPending(hooks.pendingOf());
    }
  }

  const st = registry.require(sessionId);
  return {
    endReason: st.runState === 'idle' ? 'completed' : 'aborted',
    finalText: lastAssistantText(st.snapshot.rows),
    permissionDenied: false,
  };
}

function lastAssistantText(rows: readonly ProjectionRow[]): string {
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const r = rows[i];
    if (r !== undefined && r.kind === 'message' && r.role === 'assistant') return r.text;
  }
  return '';
}

export type { PermissionMode };
