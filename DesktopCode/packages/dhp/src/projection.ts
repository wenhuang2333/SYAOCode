/**
 * 会话投影（`00-基线` §8.3 三条铁律 / `06` §6）
 *
 * 事实源只有一个：Host 的会话日志。客户端只持**只读投影**。
 * 三条铁律是这套设计的全部价值所在——它们消除的是"UI 与内核状态静默分叉"：
 *
 *   1. snapshot **整体替换**，绝不 merge
 *   2. delta **仅在 `fromSeq === localSeq + 1`** 时应用；断档不猜、不补偿
 *   3. 断档时携当前水位重订阅，由服务端裁决回 snapshot 还是补洞
 *
 * 本文件只放**数据形状与纯函数**，没有任何 IO —— 因此可以在浏览器与 Node 中同构运行。
 */

/** 行类型。UI 的虚拟列表按 kind 选择渲染器。 */
export type ProjectionRowKind = 'message' | 'thinking' | 'toolCall' | 'marker' | 'steer';

export interface MessageRow {
  readonly kind: 'message';
  readonly key: string;
  readonly seq: number;
  readonly role: 'user' | 'assistant';
  readonly text: string;
  /** `message.complete` 之前为 false；之后为 true 且不再变化。 */
  readonly final: boolean;
  readonly stopReason?: string;
}

export interface ThinkingRow {
  readonly kind: 'thinking';
  readonly key: string;
  readonly seq: number;
  readonly text: string;
  readonly final: boolean;
  /** 折叠态（默认折叠；思考内容不占主视线）。 */
  readonly collapsed: boolean;
}

export interface ToolCallRow {
  readonly kind: 'toolCall';
  readonly key: string;
  readonly seq: number;
  readonly callId: string;
  readonly name: string;
  readonly input: unknown;
  readonly state: 'proposed' | 'running' | 'ok' | 'error';
  /** 进度提示（`tool.progress` 的最新一条）。 */
  readonly progress?: string;
  /** 结果文本（已截断）；完整内容走 `contentRef`。 */
  readonly resultText?: string;
  /** 结果内容为多模态时的块数（>0 表示有图片等非文本内容）。 */
  readonly resultBlocks?: number;
  readonly durationMs?: number;
}

export interface MarkerRow {
  readonly kind: 'marker';
  readonly key: string;
  readonly seq: number;
  readonly tone: 'info' | 'warn' | 'error' | 'success';
  readonly text: string;
}

/**
 * steer 行（`28-多轮steer行为契约` §5）。
 *
 * 一条 steer **只有一行**：`steer.queued` 建行（queued），后续
 * `steer.consumed` / `steer.not_consumed` 按 `steerId` 就地改状态。
 * 三种状态分别表示：已接受排队 / 已在安全边界注入模型历史 / 未注入（带原因）。
 *
 * 它不是用户消息的替身 —— steer 文本的**唯一真相**是内核注入的那条 user 消息；
 * 这一行只是过程状态（避免把"排队"误显示成"已发送"）。
 */
export interface SteerRow {
  readonly kind: 'steer';
  readonly key: string;
  readonly seq: number;
  readonly steerId: string;
  readonly text: string;
  readonly state: 'queued' | 'consumed' | 'notConsumed';
  /** 未注入原因（`aborted` / `max_turns` / `budget_exhausted` / `timeout` /
   *  `fatal_error` / `repeated_failure` / `closed` / `host_restarted`）。 */
  readonly reason?: string;
  /** 被消费到的轮次（consumed 态才有）。 */
  readonly turn?: number;
}

export type ProjectionRow = MessageRow | ThinkingRow | ToolCallRow | MarkerRow | SteerRow;

/** 待处理交互（审批 / 向导 / ask_user）。它是投影的一部分，因此重连后会自动恢复。 */
export interface PendingInteraction {
  readonly id: string;
  readonly kind: 'permission' | 'question' | 'plan';
  readonly createdAt: number;
  readonly expiresAt?: number;
  readonly sessionId: string;
  /** 展示所需的最小字段集（由 Host 归一化，客户端不做业务判断）。 */
  readonly subject: string;
  readonly risk: 'read' | 'write' | 'exec';
  readonly preview?: {
    readonly type: 'diff' | 'command' | 'path' | 'text';
    readonly text: string;
  };
  readonly options: readonly {
    readonly id: string;
    readonly label: string;
    readonly scope: 'once' | 'session' | 'project' | 'deny';
  }[];
  /** "为什么问我" —— 来自策略引擎，**不得**来自模型自述。 */
  readonly explain?: string;
  /** 敏感项不允许"本会话/本项目"记忆。 */
  readonly sensitive?: boolean;
}

export interface SessionMeta {
  readonly sessionId: string;
  readonly title: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly permissionMode: string;
  readonly model: string;
  readonly workspaceRoot: string;
}

export interface SessionSnapshot {
  readonly meta: SessionMeta;
  readonly rows: readonly ProjectionRow[];
  /** 投影已应用到的事件序号。 */
  readonly seq: number;
  /** 日志世代：Host 重建日志时递增，客户端据此丢弃全部缓存。 */
  readonly epoch: number;
  /** CAS 基线：写命令必须带这个值。 */
  readonly revision: number;
  readonly pendingInteractions: readonly PendingInteraction[];
  /** 运行态（由事件流驱动，不由 ACK 驱动）。 */
  readonly runState: RunState;
}

export type RunState = 'idle' | 'streaming' | 'awaiting-approval' | 'stopping';

/** 一个事件帧。`coalesced` 为 true 时，水位必须用 `toSeq` 推进，**不能**用 `events.length`。 */
export interface SessionDelta {
  readonly sessionId: string;
  readonly epoch: number;
  readonly fromSeq: number;
  readonly toSeq: number;
  /** 可合并事件合并后，此处可能只有 1 条而 `toSeq > fromSeq`。 */
  readonly coalesced?: boolean;
  readonly events: readonly SessionEvent[];
}

/**
 * 会话事件：内核 `AgentEventBody` 的**传输形态**。
 * 与内核事件一一对应，但去掉了内核专用的 envelope 字段（由 `seq`/`epoch` 承担）。
 */
export type SessionEvent =
  | { readonly type: 'session.start'; readonly permissionMode: string }
  | { readonly type: 'turn.start'; readonly turn: number }
  | { readonly type: 'text.delta'; readonly text: string }
  | { readonly type: 'thinking.delta'; readonly text: string }
  | { readonly type: 'message.complete'; readonly role: 'user' | 'assistant'; readonly text: string; readonly stopReason: string }
  | { readonly type: 'tool.proposed'; readonly callId: string; readonly name: string; readonly input: unknown }
  | { readonly type: 'tool.start'; readonly callId: string; readonly name: string; readonly input: unknown }
  | { readonly type: 'tool.progress'; readonly callId: string; readonly note: string }
  | { readonly type: 'tool.result'; readonly callId: string; readonly name: string; readonly text: string; readonly blocks: number; readonly isError: boolean; readonly durationMs: number }
  | { readonly type: 'permission.request'; readonly id: string; readonly interaction: PendingInteraction }
  | { readonly type: 'permission.result'; readonly id: string; readonly decision: 'allow' | 'deny'; readonly by: string }
  | { readonly type: 'tool.receipt'; readonly receiptId: string; readonly toolName: string; readonly outputRef: string; readonly hash: string }
  | { readonly type: 'verification.start'; readonly command: string; readonly index: number; readonly total: number }
  | { readonly type: 'verification.result'; readonly ok: boolean; readonly detail: string }
  | { readonly type: 'usage'; readonly inputTokens: number; readonly outputTokens: number; readonly costUsd?: number }
  | { readonly type: 'budget.warning'; readonly kind: 'tokens' | 'cost' | 'turns'; readonly ratio: number }
  | { readonly type: 'steer.queued'; readonly steerId: string; readonly text: string; readonly executionId: string }
  | { readonly type: 'steer.consumed'; readonly steerId: string; readonly text: string; readonly turn: number }
  | { readonly type: 'steer.not_consumed'; readonly steerId: string; readonly text: string; readonly reason: string }
  | { readonly type: 'error'; readonly code: string; readonly message: string; readonly fatal: boolean }
  | { readonly type: 'turn.end'; readonly turn: number }
  | { readonly type: 'session.end'; readonly reason: string; readonly errorCode?: string };

/**
 * 可合并事件（`06` §8.1）。合并**只在订阅者队列上**发生，事实日志永远是原始粒度。
 */
export const COALESCIBLE_EVENTS: readonly SessionEvent['type'][] = [
  'text.delta',
  'thinking.delta',
  'tool.progress',
] as const;

/**
 * 不可丢事件（`06` §8.2）。任何背压级别下都不得丢弃、不得合并。
 * 判据：这些事件承载**状态转移**或**审计证据**，丢失造成语义错误而非"少显示一段文字"。
 */
export const NON_DROPPABLE_EVENTS: readonly SessionEvent['type'][] = [
  'session.start',
  'turn.start',
  'message.complete',
  'tool.proposed',
  'tool.start',
  'tool.result',
  'tool.receipt',
  'permission.request',
  'permission.result',
  'verification.start',
  'verification.result',
  'budget.warning',
  // steer 的三种状态转移是"过程证据"：丢掉会让用户永远看到 queued（或看不到未注入原因）。
  'steer.queued',
  'steer.consumed',
  'steer.not_consumed',
  'error',
  'turn.end',
  'session.end',
] as const;

export function isCoalescible(type: SessionEvent['type']): boolean {
  return COALESCIBLE_EVENTS.includes(type);
}

export function isDroppable(type: SessionEvent['type']): boolean {
  return !NON_DROPPABLE_EVENTS.includes(type);
}

/**
 * 合并规则（`06` §8.1）：
 *  - `text.delta` / `thinking.delta` 拼接文本（顺序可逆，无信息损失）
 *  - `tool.progress` 保留最新 note（中间态消失，可接受）
 */
export function coalesceEvents(events: readonly SessionEvent[]): SessionEvent[] {
  const out: SessionEvent[] = [];
  let text = '';
  let thinking = '';
  let progress: { callId: string; note: string } | undefined;

  const flush = (): void => {
    if (text !== '') {
      out.push({ type: 'text.delta', text });
      text = '';
    }
    if (thinking !== '') {
      out.push({ type: 'thinking.delta', text: thinking });
      thinking = '';
    }
    if (progress !== undefined) {
      out.push({ type: 'tool.progress', callId: progress.callId, note: progress.note });
      progress = undefined;
    }
  };

  for (const ev of events) {
    if (ev.type === 'text.delta') {
      // 文本与进度交错时先冲刷，保证顺序语义。
      if (progress !== undefined) flush();
      text += ev.text;
    } else if (ev.type === 'thinking.delta') {
      if (text !== '' || progress !== undefined) flush();
      thinking += ev.text;
    } else if (ev.type === 'tool.progress') {
      if (text !== '' || thinking !== '') flush();
      if (progress !== undefined && progress.callId !== ev.callId) flush();
      progress = { callId: ev.callId, note: ev.note };
    } else {
      flush();
      out.push(ev);
    }
  }
  flush();
  return out;
}

// ── 三条铁律的客户端实现（纯函数，便于测试）─────────────────────────────

export type ApplyResult =
  | { readonly ok: true; readonly snapshot: SessionSnapshot }
  | { readonly ok: false; readonly action: 'resubscribe'; readonly reason: string };

/**
 * 铁律 1：snapshot **整体替换**。
 * 这里刻意不提供"字段级合并"的入口——只允许整体替换，让分叉在类型层就不可表达。
 */
export function applySnapshot(prev: SessionSnapshot | undefined, next: SessionSnapshot): SessionSnapshot {
  void prev; // 前一份被丢弃是**设计意图**，不是疏忽
  return next;
}

/**
 * 铁律 2 + 3：delta 仅在衔接时应用；断档时要求重订阅（携水位）。
 *
 * 判定顺序（不可调换）：
 *   1. epoch 不同 → 必须重订阅（日志换了世代，本地缓存全部作废）
 *   2. `fromSeq !== localSeq + 1` → 断档，必须重订阅
 *   3. 满足前两条 → 逐事件 fold 进投影
 */
export function applyDelta(prev: SessionSnapshot, delta: SessionDelta): ApplyResult {
  if (delta.epoch !== prev.epoch) {
    return { ok: false, action: 'resubscribe', reason: `epoch changed: ${prev.epoch} → ${delta.epoch}` };
  }
  if (delta.fromSeq !== prev.seq + 1) {
    return {
      ok: false,
      action: 'resubscribe',
      reason: `gap: expected fromSeq ${prev.seq + 1}, got ${delta.fromSeq}`,
    };
  }

  let rows: ProjectionRow[] = [...prev.rows];
  let pending: readonly PendingInteraction[] = prev.pendingInteractions;
  let runState: RunState = prev.runState;

  for (const ev of delta.events) {
    const folded = foldEvent(rows, pending, runState, ev, delta.toSeq);
    rows = folded.rows;
    pending = folded.pending;
    runState = folded.runState;
  }
  return {
    ok: true,
    snapshot: {
      ...prev,
      rows,
      pendingInteractions: pending,
      runState,
      // `revision` **原样透传**：它守卫的是命令级状态（CAS），
      // 由服务端在"命令被接受/交互被结算"时显式推进。
      // 若这里随每条流式事件递增，用户正要点的那张审批卡会因为
      // "期间来了几个字"而变成 stale —— 不可接受的交互。
      // 流式一致性由 `seq` 保证，两者职责分离。
      revision: prev.revision,
      seq: delta.toSeq,
      meta: { ...prev.meta, updatedAt: Date.now() },
    },
  };
}

interface FoldState {
  readonly rows: ProjectionRow[];
  readonly pending: readonly PendingInteraction[];
  readonly runState: RunState;
}

/**
 * 单事件 fold。**纯函数**：相同输入必然得到相同输出（可属性测试）。
 * `seq` 用帧的 `toSeq` —— 因为合并帧里 `events.length` 与序号区间不再相等。
 */
function foldEvent(
  rows: ProjectionRow[],
  pending: readonly PendingInteraction[],
  runState: RunState,
  ev: SessionEvent,
  seq: number,
): FoldState {
  // 流式行只追加到"最后一条内容行"：steer 行是过程注记，可能追加在流式消息之后，
  // 但它**不得**把同一条 assistant 消息切成两行（否则时间线上会出现重复的半截消息）。
  const last = lastContentRow(rows);

  switch (ev.type) {
    case 'text.delta': {
      // 追加到当前未完成的 assistant 行；没有就新建。
      if (last !== undefined && last.row.kind === 'message' && last.row.role === 'assistant' && !last.row.final) {
        const next: MessageRow = { ...last.row, text: last.row.text + ev.text, seq };
        const copy = [...rows];
        copy[last.index] = next;
        return { rows: copy, pending, runState: 'streaming' };
      }
      const row: MessageRow = {
        kind: 'message',
        key: `m:${seq}`,
        seq,
        role: 'assistant',
        text: ev.text,
        final: false,
      };
      return { rows: [...rows, row], pending, runState: 'streaming' };
    }

    case 'thinking.delta': {
      if (last !== undefined && last.row.kind === 'thinking' && !last.row.final) {
        const next: ThinkingRow = { ...last.row, text: last.row.text + ev.text, seq };
        const copy = [...rows];
        copy[last.index] = next;
        return { rows: copy, pending, runState: 'streaming' };
      }
      const row: ThinkingRow = {
        kind: 'thinking',
        key: `t:${seq}`,
        seq,
        text: ev.text,
        final: false,
        collapsed: true,
      };
      return { rows: [...rows, row], pending, runState: 'streaming' };
    }

    case 'message.complete': {
      // 收尾当前行；若类型不匹配则补建（`05` DD-D-302：补建错行好过丢内容）。
      if (last !== undefined && last.row.kind === 'message' && !last.row.final) {
        const next: MessageRow = {
          ...last.row,
          text: ev.text !== '' ? ev.text : last.row.text,
          final: true,
          seq,
        };
        const copy = [...rows];
        copy[last.index] = next;
        return { rows: copy, pending, runState };
      }
      const row: MessageRow = {
        kind: 'message',
        key: `m:${seq}`,
        seq,
        role: ev.role,
        text: ev.text,
        final: true,
        ...(ev.stopReason !== '' ? { stopReason: ev.stopReason } : {}),
      };
      return { rows: [...rows, row], pending, runState };
    }

    case 'tool.proposed':
    case 'tool.start': {
      // 同一个 callId 已有行则更新（proposed → running）。
      const idx = rows.findIndex((r) => r.kind === 'toolCall' && r.callId === ev.callId);
      if (idx >= 0) {
        const cur = rows[idx] as ToolCallRow;
        const next: ToolCallRow = { ...cur, state: 'running', seq };
        const copy = [...rows];
        copy[idx] = next;
        return { rows: copy, pending, runState: 'streaming' };
      }
      const row: ToolCallRow = {
        kind: 'toolCall',
        key: `c:${ev.callId}`,
        seq,
        callId: ev.callId,
        name: ev.name,
        input: ev.input,
        state: ev.type === 'tool.start' ? 'running' : 'proposed',
      };
      return { rows: [...rows, row], pending, runState: 'streaming' };
    }

    case 'tool.progress': {
      const idx = rows.findIndex((r) => r.kind === 'toolCall' && r.callId === ev.callId);
      if (idx < 0) return { rows, pending, runState };
      const cur = rows[idx] as ToolCallRow;
      const copy = [...rows];
      copy[idx] = { ...cur, progress: ev.note, seq };
      return { rows: copy, pending, runState };
    }

    case 'tool.result': {
      const idx = rows.findIndex((r) => r.kind === 'toolCall' && r.callId === ev.callId);
      const state: ToolCallRow['state'] = ev.isError ? 'error' : 'ok';
      if (idx < 0) {
        // 缺 `tool.start` 的孤儿结果：补建一行，不让内容消失。
        const row: ToolCallRow = {
          kind: 'toolCall',
          key: `c:${ev.callId}`,
          seq,
          callId: ev.callId,
          name: ev.name,
          input: undefined,
          state,
          resultText: ev.text,
          resultBlocks: ev.blocks,
          durationMs: ev.durationMs,
        };
        return { rows: [...rows, row], pending, runState };
      }
      const cur = rows[idx] as ToolCallRow;
      const copy = [...rows];
      copy[idx] = {
        ...cur,
        state,
        resultText: ev.text,
        resultBlocks: ev.blocks,
        durationMs: ev.durationMs,
        seq,
      };
      return { rows: copy, pending, runState };
    }

    case 'permission.request': {
      // 审批是**投影的一部分**，所以重连后自动恢复（基线 §6.4 理由）。
      const exists = pending.some((p) => p.id === ev.id);
      const next = exists ? pending : [...pending, ev.interaction];
      return { rows, pending: next, runState: 'awaiting-approval' };
    }

    case 'permission.result': {
      const next = pending.filter((p) => p.id !== ev.id);
      const row: MarkerRow = {
        kind: 'marker',
        key: `k:${seq}`,
        seq,
        tone: ev.decision === 'allow' ? 'success' : 'warn',
        text: `${ev.decision === 'allow' ? '已允许' : '已拒绝'}（${ev.by}）`,
      };
      return {
        rows: [...rows, row],
        pending: next,
        runState: next.length > 0 ? 'awaiting-approval' : 'streaming',
      };
    }

    case 'turn.start':
      return { rows, pending, runState: 'streaming' };

    case 'turn.end':
      // 终态只由事件流确认，不由 ACK 确认。
      return { rows: finishOpenRows(rows, seq), pending, runState: 'idle' };

    case 'session.end': {
      const tone: MarkerRow['tone'] =
        ev.reason === 'completed' ? 'success' : ev.reason === 'aborted' ? 'warn' : 'error';
      const row: MarkerRow = { kind: 'marker', key: `k:${seq}`, seq, tone, text: `会话结束（${ev.reason}）` };
      return { rows: [...finishOpenRows(rows, seq), row], pending, runState: 'idle' };
    }

    case 'verification.start': {
      const row: MarkerRow = {
        kind: 'marker',
        key: `k:${seq}`,
        seq,
        tone: 'info',
        text: `验证 ${ev.index}/${ev.total}：${ev.command}`,
      };
      return { rows: [...rows, row], pending, runState };
    }

    case 'verification.result': {
      const row: MarkerRow = {
        kind: 'marker',
        key: `k:${seq}`,
        seq,
        tone: ev.ok ? 'success' : 'error',
        text: `验证${ev.ok ? '通过' : '失败'}：${ev.detail}`,
      };
      return { rows: [...rows, row], pending, runState };
    }

    case 'steer.queued': {
      // 建行（同 steerId 重复到达时按幂等更新，不新增第二行）。
      const idx = findSteerRow(rows, ev.steerId);
      if (idx >= 0) {
        const cur = rows[idx] as SteerRow;
        const copy = [...rows];
        copy[idx] = { ...cur, text: ev.text, state: 'queued', seq };
        return { rows: copy, pending, runState };
      }
      const row: SteerRow = {
        kind: 'steer',
        key: `s:${ev.steerId}`,
        seq,
        steerId: ev.steerId,
        text: ev.text,
        state: 'queued',
      };
      return { rows: [...rows, row], pending, runState };
    }

    case 'steer.consumed': {
      // 把同 steerId 的行置为 consumed 并记 turn；找不到就补建（重启后补记不得丢事件）。
      const idx = findSteerRow(rows, ev.steerId);
      if (idx >= 0) {
        const cur = rows[idx] as SteerRow;
        const copy = [...rows];
        copy[idx] = { ...cur, state: 'consumed', turn: ev.turn, seq };
        return { rows: copy, pending, runState };
      }
      const row: SteerRow = {
        kind: 'steer',
        key: `s:${ev.steerId}`,
        seq,
        steerId: ev.steerId,
        text: ev.text,
        state: 'consumed',
        turn: ev.turn,
      };
      return { rows: [...rows, row], pending, runState };
    }

    case 'steer.not_consumed': {
      // 未注入必须带原因 —— 丢原因等于让用户无法判断"为什么没发出去"。
      const idx = findSteerRow(rows, ev.steerId);
      if (idx >= 0) {
        const cur = rows[idx] as SteerRow;
        const copy = [...rows];
        copy[idx] = { ...cur, state: 'notConsumed', reason: ev.reason, seq };
        return { rows: copy, pending, runState };
      }
      const row: SteerRow = {
        kind: 'steer',
        key: `s:${ev.steerId}`,
        seq,
        steerId: ev.steerId,
        text: ev.text,
        state: 'notConsumed',
        reason: ev.reason,
      };
      return { rows: [...rows, row], pending, runState };
    }

    case 'error': {
      const row: MarkerRow = {
        kind: 'marker',
        key: `k:${seq}`,
        seq,
        tone: 'error',
        text: `${ev.code} ${ev.message}`,
      };
      return {
        rows: [...rows, row],
        pending,
        runState: ev.fatal ? 'idle' : runState,
      };
    }

    case 'budget.warning': {
      const row: MarkerRow = {
        kind: 'marker',
        key: `k:${seq}`,
        seq,
        tone: 'warn',
        text: `${ev.kind} 预算已用 ${Math.round(ev.ratio * 100)}%`,
      };
      return { rows: [...rows, row], pending, runState };
    }

    case 'tool.receipt':
      // 回执不改用户可见的行（它是审计证据），但**必须**推进水位。
      return { rows, pending, runState };

    case 'session.start':
    case 'usage':
      return { rows, pending, runState };
  }
}

/** 最后一条"内容行"（跳过 steer 过程注记）及其下标。 */
function lastContentRow(rows: ProjectionRow[]): { row: ProjectionRow; index: number } | undefined {
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const row = rows[i];
    if (row !== undefined && row.kind !== 'steer') return { row, index: i };
  }
  return undefined;
}

/** 按 `steerId` 找 steer 行（一条 steer 只有一行）。 */
function findSteerRow(rows: ProjectionRow[], steerId: string): number {
  return rows.findIndex((r) => r.kind === 'steer' && r.steerId === steerId);
}

/** 把未收尾的行标记为 final（会话结束时不留"永远流式中"的行）。 */
function finishOpenRows(rows: ProjectionRow[], seq: number): ProjectionRow[] {
  return rows.map((r) => {
    if (r.kind === 'message' && !r.final) return { ...r, final: true, seq };
    if (r.kind === 'thinking' && !r.final) return { ...r, final: true, seq };
    if (r.kind === 'toolCall' && (r.state === 'running' || r.state === 'proposed')) {
      return { ...r, state: 'error' as const, seq };
    }
    return r;
  });
}

/** 空投影（新建会话时）。 */
export function emptySnapshot(meta: SessionMeta, epoch = 1): SessionSnapshot {
  return {
    meta,
    rows: [],
    seq: 0,
    epoch,
    revision: 1,
    pendingInteractions: [],
    runState: 'idle',
  };
}

/**
 * 最小内容块形状。
 *
 * **有意不从 `@liwencode/core` 导入**：DHP 是传输协议，不应依赖内核。
 * 内核的 `ContentBlock` 结构上兼容这个类型，因此调用方可直接传入。
 * 这样 `@liwencode/dhp` 保持"零 node、零内核"依赖，可在浏览器中原样打包。
 */
export interface TextBlockLike {
  readonly type: string;
  readonly text?: string;
}

/** 从内容块提取纯文本（用于工具结果的内联展示）。 */
export function textOfBlocks(blocks: readonly TextBlockLike[]): string {
  return blocks
    .map((b) => (b.type === 'text' ? (b.text ?? '') : b.type === 'image' ? '[image]' : ''))
    .filter((s) => s !== '')
    .join('\n');
}
