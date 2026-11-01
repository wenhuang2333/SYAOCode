/**
 * Host 装配：把 registry / broker / agent / 服务 组装成一个可运行的 DHP 服务端。
 *
 * 这是 Host 进程的**唯一**入口。职责边界：
 *  - 提供 DHP 方法实现（纯业务编排，不含 IO 细节）
 *  - 把内核事件桥接到 DHP 事件，并推进投影
 *  - **不**做 UI 决策（呈现形态、文案都在客户端）
 */

import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  Method,
  Notification,
  codeForKind,
  newCommandId,
  requestHash,
  IdempotencyStore,
  type AckResult,
  type AppInfoResult,
  type ConfigGetResult,
  type DoctorRunResult,
  type GovernancePolicyExplainResult,
  type InteractionResolveResult,
  type ModelListResult,
  type PendingInteraction,
  type SessionCreateResult,
  type SessionListResult,
  type SessionSnapshotResult,
  type SessionSubscribeResult,
  type TurnSendResult,
  type WorkspaceDiffResult,
  type WorkspaceReadFileResult,
  type WorkspaceTreeResult,
} from '@syaocode/dhp';
import type { Agent } from '@syaocode/core';
import { createDesktopAgent, hasKeyFor, parseModelSpec, providerNeedsKey } from './agent-factory.ts';
import { ConfigService } from './config-service.ts';
import { DhpProtocolError, startDhpServer, type DhpServerHandle } from './dhp-server.ts';
import { InteractionBroker } from './interaction-broker.ts';
import { syaoPaths, type SyaoPaths } from './paths.ts';
import { SessionRegistry, pumpAgentEvents, toSessionEvents, type SessionState } from './session-registry.ts';
import { WorkspaceService } from './workspace.ts';

export interface HostOptions {
  readonly workspaceRoot?: string;
  readonly port?: number;
  readonly host?: string;
  readonly token?: string;
  readonly env?: Record<string, string | undefined>;
  readonly logger?: (level: 'info' | 'warn' | 'error', msg: string, meta?: unknown) => void;
  /** 是否在 `app/shutdown` 后真的退出进程（测试中设为 false）。 */
  readonly exitOnShutdown?: boolean;
}

interface SessionRuntime {
  readonly state: SessionState;
  agent: Agent | undefined;
  broker: InteractionBroker | undefined;
}

export interface RunningHost {
  readonly server: DhpServerHandle;
  readonly paths: SyaoPaths;
  readonly workspace: WorkspaceService;
  close(): Promise<void>;
}

export async function createHost(opts: HostOptions = {}): Promise<RunningHost> {
  const env = opts.env ?? process.env;
  const log = opts.logger ?? ((level, msg, meta) => {
    const line = `[host] ${level} ${msg}${meta === undefined ? '' : ` ${JSON.stringify(meta)}`}`;
    if (level === 'error') console.error(line);
    else console.log(line);
  });

  const requestedRoot = opts.workspaceRoot ?? process.cwd();
  const workspace = new WorkspaceService({ root: requestedRoot });
  const workspaceRoot = workspace.workspaceRoot;

  let paths: SyaoPaths;
  try {
    paths = syaoPaths(env);
  } catch (err) {
    // 数据目录解析失败是**致命**的：不启动，而不是把数据写到 cwd。
    log('error', 'fatal: cannot resolve SYAOCODE_HOME', { message: (err as Error).message });
    throw err;
  }

  const config = new ConfigService(paths, workspaceRoot, env);
  const registry = new SessionRegistry();
  const idempotency = new IdempotencyStore();
  const runtimes = new Map<string, SessionRuntime>();
  const agents = new Map<string, Agent>();

  const server = await startDhpServer({
    host: opts.host ?? '127.0.0.1',
    port: opts.port ?? 0,
    ...(opts.token !== undefined ? { token: opts.token } : {}),
    logger: log,
    workspaceRoot,
  });

  // ── 工具函数 ──────────────────────────────────────────────────────────

  const pendingOf = (sessionId: string): readonly PendingInteraction[] => {
    const rt = runtimes.get(sessionId);
    return rt?.broker?.pending() ?? [];
  };

  /**
   * 幂等 + CAS 的统一入口。
   *
   * 所有写命令都走这里，保证：
   *  - 同 `commandId` 同内容 → `duplicate`（不重复执行副作用）
   *  - 同 `commandId` 异内容 → `idempotency_conflict`
   *  - `baseRevision` 不符 → `stale`（带回最新 revision）
   */
  const runCommand = async (
    input: {
      readonly commandId: string;
      readonly baseRevision: number;
      readonly sessionId: string;
      readonly payload: unknown;
    },
    exec: () => Promise<AckResult>,
  ): Promise<AckResult> => {
    const rt = runtimes.get(input.sessionId);
    if (rt === undefined) {
      throw new DhpProtocolError('capability_not_found', `unknown session: ${input.sessionId}`);
    }
    const hash = requestHash({ sessionId: input.sessionId, payload: input.payload });

    const prior = idempotency.get(input.commandId);
    if (prior !== undefined) {
      if (prior.requestHash !== hash) {
        throw new DhpProtocolError(
          'idempotency_conflict',
          `commandId ${input.commandId} reused with different content`,
        );
      }
      // 等价成功：把第一次的结果原样返回。
      return {
        commandId: prior.commandId,
        status: 'duplicate',
        revision: prior.revision,
        ...(prior.data !== undefined ? { data: prior.data } : {}),
      };
    }

    if (input.baseRevision !== rt.state.snapshot.revision) {
      return {
        commandId: input.commandId,
        status: 'stale',
        revision: rt.state.snapshot.revision,
        reason: `baseRevision ${input.baseRevision} != current ${rt.state.snapshot.revision}`,
      };
    }

    const result = await exec();
    idempotency.put({
      commandId: input.commandId,
      requestHash: hash,
      status: result.status,
      revision: result.revision,
      createdAt: Date.now(),
      ...(result.data !== undefined ? { data: result.data } : {}),
    });
    return result;
  };

  /** 确保会话的 agent 已创建（懒创建：创建会话不花时间）。 */
  const ensureAgent = async (sessionId: string): Promise<Agent> => {
    const rt = runtimes.get(sessionId);
    if (rt === undefined) throw new DhpProtocolError('capability_not_found', `unknown session: ${sessionId}`);
    if (rt.agent !== undefined) return rt.agent;

    const cfg = await config.effective();
    const broker = new InteractionBroker(
      (interaction) => {
        // 审批到达：写进投影（这样重连后自动恢复）+ 推送通知。
        registry.setPending(sessionId, [...broker.pending()]);
        server.broadcast(Notification.InteractionRequest, { interaction });
      },
      { sessionId },
    );
    rt.broker = broker;

    const created = createDesktopAgent({
      modelSpec: cfg.model,
      cwd: workspaceRoot,
      permissionMode: cfg.permissionMode as never,
      permissionHandler: (req) => broker.handle(req),
      env,
    });
    if (!created.ok) {
      throw new DhpProtocolError('unsupported_capability', `cannot create agent: ${created.reason}`);
    }
    rt.agent = created.agent;
    registry.patchMeta(sessionId, { model: created.model, permissionMode: cfg.permissionMode });
    agents.set(sessionId, created.agent);
    return created.agent;
  };

  // ── 方法：会话 ────────────────────────────────────────────────────────

  server.register(Method.SessionCreate, async (params) => {
    const p = (params ?? {}) as { title?: string; model?: string; permissionMode?: string; workspaceRoot?: string };
    const cfg = await config.effective();
    const sessionId = `ses_${randomUUID().replace(/-/g, '').slice(0, 20)}`;
    const state = registry.create({
      sessionId,
      title: p.title ?? '新会话',
      model: p.model ?? cfg.model,
      permissionMode: p.permissionMode ?? cfg.permissionMode,
      workspaceRoot,
    });
    runtimes.set(sessionId, { state, agent: undefined, broker: undefined });
    server.broadcast(Notification.SessionChanged, {
      sessionId,
      change: 'created',
      title: state.title,
    });
    return { snapshot: state.snapshot } satisfies SessionCreateResult;
  });

  server.register(Method.SessionList, async () => {
    return { sessions: registry.list() } satisfies SessionListResult;
  });

  server.register(Method.SessionSnapshot, async (params) => {
    const p = params as { sessionId: string };
    const state = registry.require(p.sessionId);
    const pending = pendingOf(p.sessionId);
    return { ...state.snapshot, pendingInteractions: pending } satisfies SessionSnapshotResult;
  });

  server.register(Method.SessionResume, async (params) => {
    const p = params as { sessionId: string };
    const state = registry.require(p.sessionId);
    return { snapshot: { ...state.snapshot, pendingInteractions: pendingOf(p.sessionId) } };
  });

  server.register(Method.SessionClose, async (params) => {
    const p = params as { sessionId: string };
    const rt = runtimes.get(p.sessionId);
    if (rt !== undefined) {
      rt.broker?.drain('会话已关闭');
      await rt.agent?.close().catch(() => undefined);
      runtimes.delete(p.sessionId);
      agents.delete(p.sessionId);
    }
    // DHP 的 `session.end` 只在真正关闭会话时产生（内核的 session.end 是"一轮结束"）。
    if (registry.get(p.sessionId) !== undefined) {
      registry.append(p.sessionId, { type: 'session.end', reason: 'closed' });
    }
    registry.close(p.sessionId);
    server.broadcast(Notification.SessionChanged, { sessionId: p.sessionId, change: 'closed' });
    return { ok: true };
  });

  server.register(Method.SessionRename, async (params) => {
    const p = params as { sessionId: string; title: string };
    registry.rename(p.sessionId, p.title);
    server.broadcast(Notification.SessionChanged, {
      sessionId: p.sessionId,
      change: 'renamed',
      title: p.title,
    });
    return { ok: true };
  });

  server.register(Method.SessionSubscribe, async (params, ctx) => {
    const p = params as { sessionId: string; baseSeq?: number; epoch?: number };
    const state = registry.require(p.sessionId);

    const unsub = registry.subscribe(p.sessionId, (delta) => {
      ctx.notify(Notification.SessionEvent, {
        delta,
        ...(delta.coalesced === true ? { coalesced: true } : {}),
      });
    });

    // 断档判定：客户端水位与服务端不连续 → 随订阅回快照。
    const baseSeq = p.baseSeq;
    const needsSnapshot =
      baseSeq === undefined ||
      p.epoch === undefined ||
      p.epoch !== state.epoch ||
      baseSeq + 1 < state.ringFloor ||
      baseSeq > state.snapshot.seq;

    if (needsSnapshot) {
      ctx.notify(Notification.SessionEvent, {
        delta: {
          sessionId: p.sessionId,
          epoch: state.epoch,
          // 用 `fromSeq = seq + 1` 的"空 delta"不合法，所以这里直接发 snapshot 通知：
          // 客户端收到 `snapshot` 字段时整体替换（铁律 1）。
          fromSeq: 0,
          toSeq: 0,
          events: [],
        },
        snapshot: { ...state.snapshot, pendingInteractions: pendingOf(p.sessionId) },
      });
    } else if (baseSeq !== undefined && baseSeq < state.snapshot.seq) {
      // 可以补洞：把缺失区间立即推送。
      const gap = registry.eventsBetween(p.sessionId, baseSeq + 1, state.snapshot.seq);
      if (gap !== undefined && gap.events.length > 0) {
        ctx.notify(Notification.SessionEvent, { delta: gap });
      }
    }

    return {
      subscribed: true,
      snapshotIncluded: needsSnapshot,
      seq: state.snapshot.seq,
      epoch: state.epoch,
    } satisfies SessionSubscribeResult;
  });

  server.register(Method.SessionEvents, async (params) => {
    const p = params as { sessionId: string; fromSeq: number; toSeq?: number };
    const state = registry.require(p.sessionId);
    const toSeq = p.toSeq ?? state.snapshot.seq;
    const delta = registry.eventsBetween(p.sessionId, p.fromSeq, toSeq);
    if (delta === undefined) {
      throw new DhpProtocolError(
        'gap_unrecoverable',
        `events from ${p.fromSeq} no longer available (floor ${state.ringFloor}); use session/snapshot`,
      );
    }
    return { delta };
  });

  // ── 方法：对话 ────────────────────────────────────────────────────────

  server.register(Method.TurnSend, async (params) => {
    const p = params as { commandId: string; baseRevision: number; sessionId: string; text: string };
    return runCommand(
      { commandId: p.commandId, baseRevision: p.baseRevision, sessionId: p.sessionId, payload: { text: p.text } },
      async () => {
        const rt = runtimes.get(p.sessionId);
        if (rt === undefined) throw new DhpProtocolError('capability_not_found', 'unknown session');
        if (rt.state.runState === 'streaming') {
          // 同一会话不允许并发轮次（`conflict_in_flight`）。
          throw new DhpProtocolError('conflict_in_flight', 'a turn is already running in this session');
        }

        const agent = await ensureAgent(p.sessionId);
        const executionId = `exe_${randomUUID().slice(0, 8)}`;
        // 轮次被接受 → 命令级状态变化 → revision 前进（客户端下次写命令需重读）。
        registry.bumpRevision(p.sessionId);
        rt.state.executionId = executionId;
        rt.state.turn += 1;

        // 用户消息先落投影（乐观显示，但与事件流不冲突：它有自己的 seq）。
        registry.append(p.sessionId, { type: 'message.complete', role: 'user', text: p.text, stopReason: 'user' });

        // 异步执行：**立刻**返回 ACK，终态由事件流确认（ACK ≠ 终态）。
        const ac = new AbortController();
        rt.state.abort = ac;
        void (async () => {
          try {
            await pumpAgentEvents(agent, registry, p.sessionId, p.text, ac.signal, {
              onPending: (pending) => registry.setPending(p.sessionId, pending),
              pendingOf: () => pendingOf(p.sessionId),
            });
          } catch (err) {
            registry.append(p.sessionId, {
              type: 'error',
              code: 'SY-UI-001',
              message: (err as Error).message,
              fatal: false,
            });
          } finally {
            const st = registry.require(p.sessionId);
            if (st.runState !== 'idle') {
              registry.append(p.sessionId, { type: 'turn.end', turn: st.turn });
            }
          }
        })();

        return {
          commandId: p.commandId,
          status: 'accepted' as const,
          revision: rt.state.snapshot.revision,
          data: { executionId },
        };
      },
    );
  });

  server.register(Method.TurnStop, async (params) => {
    const p = params as {
      commandId: string;
      baseRevision: number;
      sessionId: string;
      expectedExecutionId?: string;
    };
    return runCommand(
      { commandId: p.commandId, baseRevision: p.baseRevision, sessionId: p.sessionId, payload: { stop: true } },
      async () => {
        const rt = runtimes.get(p.sessionId);
        if (rt === undefined) throw new DhpProtocolError('capability_not_found', 'unknown session');
        if (p.expectedExecutionId !== undefined && rt.state.executionId !== p.expectedExecutionId) {
          // 迟到的停止不能杀掉后续执行。
          return {
            commandId: p.commandId,
            status: 'noop' as const,
            revision: rt.state.snapshot.revision,
            reason: 'execution already changed',
          };
        }
        rt.state.abort?.abort();
        return { commandId: p.commandId, status: 'accepted' as const, revision: rt.state.snapshot.revision };
      },
    );
  });

  server.register(Method.TurnSteer, async (params) => {
    const p = params as { commandId: string; baseRevision: number; sessionId: string; text: string };
    return runCommand(
      { commandId: p.commandId, baseRevision: p.baseRevision, sessionId: p.sessionId, payload: { steer: p.text } },
      async () => {
        const rt = runtimes.get(p.sessionId);
        if (rt === undefined) throw new DhpProtocolError('capability_not_found', 'unknown session');
        // v1：给用户一个诚实的"暂不支持"，而不是静默丢弃。
        return {
          commandId: p.commandId,
          status: 'rejected' as const,
          revision: rt.state.snapshot.revision,
          reason: 'steer 尚未实现（v1 仅支持 stop 后重新发送）',
        };
      },
    );
  });

  // ── 方法：交互 ────────────────────────────────────────────────────────

  server.register(Method.InteractionResolve, async (params) => {
    const p = params as {
      commandId: string;
      baseRevision: number;
      sessionId: string;
      interactionId: string;
      optionId: string;
    };
    return runCommand(
      {
        commandId: p.commandId,
        baseRevision: p.baseRevision,
        sessionId: p.sessionId,
        payload: { interactionId: p.interactionId, optionId: p.optionId },
      },
      async () => {
        const rt = runtimes.get(p.sessionId);
        if (rt === undefined) throw new DhpProtocolError('capability_not_found', 'unknown session');
        const broker = rt.broker;
        if (broker === undefined) {
          throw new DhpProtocolError('capability_not_found', 'no pending interaction broker');
        }
        const outcome = broker.resolve(p.interactionId, p.optionId);
        if (!outcome.ok) {
          throw new DhpProtocolError(outcome.kind, outcome.message);
        }
        registry.setPending(p.sessionId, broker.pending());
        const d = outcome.decision;
        // `recheck` 不是结算（卡片保持未决），此时不写 permission.result。
        if ('decision' in d) {
          registry.append(p.sessionId, {
            type: 'permission.result',
            id: p.interactionId,
            decision: d.decision,
            by: 'user',
          });
        }
        return {
          commandId: p.commandId,
          status: 'accepted' as const,
          revision: rt.state.snapshot.revision,
        } satisfies InteractionResolveResult;
      },
    );
  });

  // ── 方法：配置 / 模型 ────────────────────────────────────────────────

  server.register(Method.ConfigGet, async () => {
    const eff = await config.effective();
    return eff satisfies ConfigGetResult;
  });

  server.register(Method.ConfigSet, async (params) => {
    const p = params as { key: 'model' | 'permissionMode' | 'language'; value: string };
    await config.set(p.key, p.value);
    // 语言/权限模式变化立即反映到所有会话的 meta（UI 据此重渲染）。
    for (const [id, rt] of runtimes) {
      if (p.key === 'permissionMode') registry.patchMeta(id, { permissionMode: p.value });
      void rt;
    }
    const eff = await config.effective();
    return { ok: true as const, effective: String(eff[p.key]) };
  });

  server.register(Method.ModelList, async () => {
    const eff = await config.effective();
    const spec = parseModelSpec(eff.model);
    const providers = ['mock', 'deepseek', 'openai-compatible', 'anthropic'];
    const available = providers.map((provider) => ({
      spec: `${provider}:${provider === spec.provider ? spec.model : 'default'}`,
      provider,
      model: provider === spec.provider ? spec.model : 'default',
      hasKey: providerNeedsKey(provider) ? hasKeyFor(provider, env) : true,
    }));
    return { current: eff.model, available } satisfies ModelListResult;
  });

  server.register(Method.ModelUse, async (params) => {
    const p = params as { spec: string };
    await config.set('model', p.spec);
    return { ok: true as const, current: p.spec };
  });

  // ── 方法：工作区 ──────────────────────────────────────────────────────

  server.register(Method.WorkspaceOpen, async (params) => {
    const p = params as { path: string };
    const resolved = path.resolve(p.path);
    return { workspaceRoot: resolved, name: path.basename(resolved) };
  });

  server.register(Method.WorkspaceTree, async (params) => {
    const p = (params ?? {}) as { path?: string; maxDepth?: number };
    const nodes = await workspace.tree(p.path ?? '.', p.maxDepth ?? 3);
    return { root: workspaceRoot, nodes } satisfies WorkspaceTreeResult;
  });

  server.register(Method.WorkspaceReadFile, async (params) => {
    const p = params as { path: string; maxBytes?: number };
    try {
      const r = await workspace.readFile(p.path);
      return r satisfies WorkspaceReadFileResult;
    } catch (err) {
      const e = err as { kind?: string; message?: string };
      throw new DhpProtocolError(
        e.kind === 'not_found' ? 'path_rejected' : e.kind === 'path_rejected' ? 'path_rejected' : 'outside_workspace',
        e.message ?? 'workspace read failed',
      );
    }
  });

  server.register(Method.WorkspaceDiff, async (params) => {
    const p = params as { path: string; before: string; after: string };
    return workspace.diff(p.path, p.before, p.after) satisfies WorkspaceDiffResult;
  });

  // ── 方法：治理 / 成本 / 诊断 ──────────────────────────────────────────

  server.register(Method.GovernanceStatus, async () => {
    return {
      tenantId: 'local',
      policyRevision: 'local-1',
      capabilityCount: 0,
      tasks: { total: 0, unterminated: 0 },
      pendingApprovals: [...runtimes.values()].reduce((n, rt) => n + (rt.broker?.pending().length ?? 0), 0),
      auditOk: true,
      budget: { accountId: 'local', usedUsd: 0 },
    };
  });

  server.register(Method.GovernanceTasks, async () => ({ tasks: [] }));
  server.register(Method.GovernanceApprovals, async () => {
    const approvals = [...runtimes.values()].flatMap((rt) =>
      (rt.broker?.pending() ?? []).map((p) => ({
        id: p.id,
        subject: p.subject,
        risk: p.risk,
        ...(p.expiresAt !== undefined ? { expiresAt: new Date(p.expiresAt).toISOString() } : {}),
      })),
    );
    return { approvals };
  });

  server.register(Method.GovernanceDecide, async (params) => {
    const p = params as {
      commandId: string;
      baseRevision: number;
      approvalId: string;
      optionId: string;
    };
    // 找到持有该交互的会话，复用 interaction/resolve 的逻辑。
    for (const [sessionId, rt] of runtimes) {
      const found = (rt.broker?.pending() ?? []).some((i) => i.id === p.approvalId);
      if (!found) continue;
      return runCommand(
        {
          commandId: p.commandId,
          baseRevision: p.baseRevision,
          sessionId,
          payload: { approvalId: p.approvalId, optionId: p.optionId },
        },
        async () => {
          const outcome = rt.broker!.resolve(p.approvalId, p.optionId);
          if (!outcome.ok) throw new DhpProtocolError(outcome.kind, outcome.message);
          registry.setPending(sessionId, rt.broker!.pending());
          return { commandId: p.commandId, status: 'accepted' as const, revision: rt.state.snapshot.revision };
        },
      );
    }
    throw new DhpProtocolError('capability_not_found', `unknown approval: ${p.approvalId}`);
  });

  server.register(Method.GovernanceAudit, async () => ({ ok: true, events: [] }));

  server.register(Method.GovernancePolicyExplain, async (params) => {
    const p = params as { capabilityId: string };
    return {
      effect: 'ask' as const,
      reasons: ['默认策略：写操作需用户确认（permissionMode=default）'],
      matchedRules: [{ id: 'default-write-ask', effect: 'ask', source: 'builtin' }],
    } satisfies GovernancePolicyExplainResult;
  });

  server.register(Method.CostWorkspace, async () => {
    const usage = [...runtimes.values()].map((rt) => rt.state.snapshot);
    return {
      workspace: workspaceRoot,
      totals: { requests: usage.length, inputTokens: 0, outputTokens: 0, costUsd: 0 },
      models: [],
    };
  });

  server.register(Method.DoctorRun, async () => {
    const checks: DoctorRunResult['checks'][number][] = [];
    checks.push({ name: 'syaoHome', status: 'ok', detail: paths.home });
    checks.push({
      name: 'node',
      status: 'ok',
      detail: `${process.version} (${process.platform}/${process.arch})`,
    });
    const cfg = await config.effective();
    const spec = parseModelSpec(cfg.model);
    const keyOk = !providerNeedsKey(spec.provider) || hasKeyFor(spec.provider, env);
    checks.push({
      name: 'provider',
      status: keyOk ? 'ok' : 'warn',
      detail: `${cfg.model}${keyOk ? '' : '（缺少密钥，将回退 mock）'}`,
    });
    checks.push({
      name: 'workspace',
      status: 'ok',
      detail: workspaceRoot,
    });
    return { checks } satisfies DoctorRunResult;
  });

  // ── 方法：系统 ────────────────────────────────────────────────────────

  server.register(Method.AppInfo, async () => {
    return {
      appVersion: '0.1.0',
      hostVersion: '0.1.0',
      dhpVersion: { major: 1, minor: 0 },
      nodeVersion: process.version,
      platform: `${process.platform}-${process.arch}`,
      workspaceRoot,
      capabilities: ['session', 'turn', 'interaction', 'config', 'model', 'workspace'],
    } satisfies AppInfoResult;
  });

  server.register(Method.AppShutdown, async (params) => {
    const p = (params ?? {}) as { graceful?: boolean };
    for (const rt of runtimes.values()) {
      rt.broker?.drain('Host 正在关停');
      if (p.graceful !== false) {
        await rt.agent?.close().catch(() => undefined);
      }
    }
    if (opts.exitOnShutdown === true) {
      setTimeout(() => process.exit(0), 50);
    }
    return { ok: true };
  });

  return {
    server,
    paths,
    workspace,
    async close() {
      for (const rt of runtimes.values()) {
        rt.broker?.drain('Host 关闭');
        await rt.agent?.close().catch(() => undefined);
      }
      runtimes.clear();
      await server.close();
    },
  };
}

/** 供 `toSessionEvents` 的单事件调试用。 */
export { toSessionEvents };
