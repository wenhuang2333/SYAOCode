/**
 * 渲染层 steer 交互（N-2 / FR-N-032，`28-多轮steer行为契约` §6）。
 *
 * 覆盖四类证据：
 *  1. **动作层**：带 `expectedExecutionId` 调 `turn/steer`；执行 id 未知时拒绝（不伪造排队）；
 *     失败原因走错误横幅（`perform`），不只写控制台。
 *  2. **输入区**：运行中按钮/提示表达「作为补充指令排队」；`!` 本地命令分支保持不变。
 *  3. **状态清理**：`session.end` 与重连后清执行 id；queued 行只来自 Host 事件（无本地乐观行）。
 *  4. **取证脚本**：`verify:steer` 的 SKIP / SSE stub / 核心断言契约（真实执行见脚本）。
 *
 * 组件断言用 `renderToStaticMarkup`（与既有测试同风格，不引入 jsdom）。
 */

import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { SessionSnapshot } from '@liwencode/dhp';
import { Conversation } from '../src/renderer/workbench.tsx';
import { steerTargetFor, type Workbench } from '../src/renderer/use-workbench.ts';
import { tv } from '../src/renderer/i18n-views.ts';

const ROOT = path.resolve(__dirname, '..');
const read = (rel: string): string => readFileSync(path.join(ROOT, rel), 'utf8');

const useHook = read('src/renderer/use-workbench.ts');
const view = read('src/renderer/workbench.tsx');
const script = read('../../scripts/verify-steer.mjs');

const snapshot = (runState: SessionSnapshot['runState'], rows: SessionSnapshot['rows'] = []): SessionSnapshot => ({
  meta: {
    sessionId: 's-1',
    title: '测试会话',
    createdAt: 1,
    updatedAt: 2,
    permissionMode: 'default',
    model: 'steer-stub:steer-stub',
    workspaceRoot: '/tmp/liwen-steer',
  },
  rows,
  seq: 1,
  epoch: 1,
  revision: 1,
  pendingInteractions: [],
  runState,
});

const workbench = (overrides: Partial<Record<string, unknown>> = {}): Workbench => ({
  language: 'zh',
  status: 'ready',
  sessionId: 's-1',
  loadingSession: false,
  draft: '',
  setDraft: () => undefined,
  mutating: false,
  workspaceRoot: '/tmp/liwen-steer',
  snapshot: snapshot('streaming'),
  error: '',
  setError: () => undefined,
  readTree: async () => ({ root: '/tmp/liwen-steer', nodes: [] }),
  openWorkspace: () => undefined,
  createSession: () => undefined,
  stop: () => undefined,
  archive: () => undefined,
  configure: () => undefined,
  resolve: () => undefined,
  send: () => undefined,
  steer: () => undefined,
  runShellCommand: async () => ({ sessionId: 's-1', command: 'ls', exitCode: 0, stdout: '', stderr: '', truncated: false, timedOut: false, durationMs: 1 }),
  ...overrides,
} as unknown as Workbench);

const render = (w: Workbench): string =>
  renderToStaticMarkup(createElement(Conversation, { w, confirm: () => undefined, onSlot: () => undefined }));

describe('steerTargetFor：执行 id 的硬闸门', () => {
  it('空闲 / 未知快照 → idle（不排队）', () => {
    expect(steerTargetFor('idle', 'exec-1')).toEqual({ ok: false, reason: 'idle' });
    expect(steerTargetFor(undefined, 'exec-1')).toEqual({ ok: false, reason: 'idle' });
  });

  it('运行中但执行 id 未知（重连后）→ 拒绝，绝不本地伪造排队', () => {
    expect(steerTargetFor('streaming', undefined)).toEqual({ ok: false, reason: 'unknown-execution' });
    expect(steerTargetFor('awaiting-approval', '')).toEqual({ ok: false, reason: 'unknown-execution' });
  });

  it('运行中且执行 id 已知 → 带上 expectedExecutionId', () => {
    expect(steerTargetFor('streaming', 'exec-1')).toEqual({ ok: true, executionId: 'exec-1' });
    expect(steerTargetFor('awaiting-approval', 'exec-2')).toEqual({ ok: true, executionId: 'exec-2' });
  });
});

describe('输入区：运行中提交 = 作为补充指令排队', () => {
  it('运行中按钮是"作为补充指令排队"，并显示排队提示', () => {
    const html = render(workbench());
    expect(html).toContain('作为补充指令排队');
    expect(html).toContain('data-submit-mode="steer"');
    expect(html).toContain('composer-steer-hint');
    expect(html).toContain(tv('zh', 'workbench.conversation.steerHint'));
    // 不得看起来像启动第二个并发执行。
    expect(html).not.toMatch(/data-submit-mode="send"/);
  });

  it('空闲时仍是普通发送，不显示排队语义', () => {
    const html = render(workbench({ snapshot: snapshot('idle') }));
    expect(html).toContain(`>${tv('zh', 'workbench.conversation.enterHint')}<`);
    expect(html).toContain('data-submit-mode="send"');
    expect(html).not.toContain('composer-steer-hint');
  });

  it('快照尚未加载时不能误显示排队文案（没有会话不等于运行中）', () => {
    const html = render(workbench({ snapshot: undefined }));
    expect(html).toContain('data-submit-mode="send"');
    expect(html).not.toContain('composer-steer-hint');
  });

  it('`!` 本地命令分支仍在 steer 分支之前（shell 命令不是 steer）', () => {
    const shell = view.indexOf('isShellCommand(text)');
    const steer = view.indexOf('w.steer(text)');
    const send = view.indexOf('w.send(text)');
    expect(shell).toBeGreaterThan(-1);
    expect(steer).toBeGreaterThan(shell);
    expect(send).toBeGreaterThan(steer);
  });

  it('运行中不再用 runState 把输入区整体禁用（否则无法提交 steer）', () => {
    // 旧实现把 busy 设为 runState !== idle，按钮直接点不动——那样 steer 永远发不出去。
    expect(view).not.toContain('busy={w.mutating || (Boolean(w.sessionId) && !idle) || shellBusy}');
  });

  it('断线且存在 queued 行时显示"状态未确认"', () => {
    const queued = [{ kind: 'steer', key: 's:st-1', seq: 2, steerId: 'st-1', text: '补充', state: 'queued' }] as SessionSnapshot['rows'];
    const html = render(workbench({ status: 'reconnecting', snapshot: snapshot('streaming', queued) }));
    expect(html).toContain(tv('zh', 'workbench.conversation.steerUnconfirmed'));
  });
});

describe('动作层：turn/steer + expectedExecutionId + 失败可见', () => {
  it('调用 Method.TurnSteer 并携带 expectedExecutionId', () => {
    expect(useHook).toContain('Method.TurnSteer');
    expect(useHook).toContain('expectedExecutionId: target.executionId');
  });

  it('执行 id 未知时拒绝并提示（不伪造 queued 行）', () => {
    expect(useHook).toContain("'workbench.conversation.steerNoExecution'");
    // 本地不得凭空造 steer.queued 事件：queued 行只来自 Host。
    expect(useHook).not.toContain("type: 'steer.queued'");
  });

  it('失败（rejected / noop / invalid_request / 队列满）显示给用户', () => {
    // 统一走 perform：错误进顶部横幅（setError），不是 console。
    expect(useHook).toContain('const steer = useCallback((text: string) => perform(async () => {');
    expect(useHook).toContain("'workbench.conversation.steerFailed'");
    expect(useHook).toContain("result.status === 'noop'");
    expect(useHook).toContain("'workbench.conversation.steerExecutionChanged'");
    expect(useHook).not.toMatch(/console\.(?:warn|error|log)\([^)]*steer/);
  });

  it('只有 accepted / duplicate 才清草稿（noop 已提前抛错）', () => {
    expect(useHook).toContain('setDrafts((prev) => ({ ...prev, [sid]: prev[sid]?.trim() === trimmed ? \'\' : prev[sid] ?? \'\' }));');
  });
});

describe('状态清理：停止 / 归档 / 重连后不遗留错误 queued 标识', () => {
  it('session.end 时清掉执行 id（turn.end 可能是 steer 续轮，不能当结束）', () => {
    expect(useHook).toContain("if (d.events.some((e) => e.type === 'session.end')) executions.current.delete(sid);");
  });

  it('重连 / 断线时清空执行 id 映射（无法确认就显示未确认）', () => {
    expect(useHook).toContain("if (s !== 'ready') executions.current.clear();");
  });

  it('归档会话时清掉该会话的执行 id', () => {
    expect(useHook).toContain('executions.current.delete(sid);');
  });
});

describe('文案：steer 键进入 workbench 目录且中英对等', () => {
  const keys = [
    'workbench.conversation.steerSend',
    'workbench.conversation.steerPlaceholder',
    'workbench.conversation.steerHint',
    'workbench.conversation.steerFailed',
    'workbench.conversation.steerNotRunning',
    'workbench.conversation.steerNoExecution',
    'workbench.conversation.steerExecutionChanged',
    'workbench.conversation.steerUnconfirmed',
  ] as const;

  it('每个键中英都非空且不是未知键占位', () => {
    for (const key of keys) {
      expect(tv('zh', key)).not.toBe('');
      expect(tv('en', key)).not.toBe('');
      expect(tv('zh', key)).not.toContain('⟦');
      expect(tv('en', key)).not.toContain('⟦');
    }
  });

  it('steerFailed 保留 {reason} 插值，让 Host 的可操作原因能显示', () => {
    expect(tv('zh', 'workbench.conversation.steerFailed')).toContain('{reason}');
    expect(tv('en', 'workbench.conversation.steerFailed')).toContain('{reason}');
    expect(tv('zh', 'workbench.conversation.steerFailed', { reason: '队列已满' })).toContain('队列已满');
  });
});

describe('真实窗口取证脚本（verify:steer）的契约', () => {
  it('缺 Playwright / Electron / 构建产物时 SKIP，且不打印通过', () => {
    expect(script).toContain('SKIP: playwright not installed');
    expect(script).toContain('SKIP: electron binary not found');
    expect(script).toContain('SKIP: apps/desktop/dist/main/index.js missing');
    expect(script).toContain('STEER: OK');
  });

  it('用隔离 HOME + LIWENCODE_HOME（Host 只认这个变量名）', () => {
    expect(script).toContain('mkdtemp');
    expect(script).toContain('LIWENCODE_HOME: home');
    expect(script).not.toContain('LIWEN_HOME: home');
  });

  it('本地 OpenAI 兼容 SSE stub：能精确控制流式输出并记录每次请求', () => {
    expect(script).toContain('createServer');
    expect(script).toContain('text/event-stream');
    expect(script).toContain('chat/completions');
    expect(script).toContain('requests.push');
  });

  it('核心断言：第二轮模型请求的 messages 里确实出现 steer 文本，且在首轮 assistant 之后', () => {
    expect(script).toContain('secondRequest');
    expect(script).toContain('STEER_TEXT');
    expect(script).toContain('messages');
    expect(script).toContain('steerIndex');
    expect(script).toContain('assistantIndex');
    expect(script).toContain('steerIndex > assistantIndex');
  });

  it('界面闭环断言：已排队 → 已注入 / 未注入、runState 归位、无未捕获异常', () => {
    expect(script).toContain('data-steer-state');
    expect(script).toContain('.steer-queued');
    expect(script).toContain('.steer-consumed');
    expect(script).toContain('.steer-notConsumed');
    expect(script).toContain("includes('空闲')");
    expect(script).toContain('pageerror');
  });

  it('被中断时收掉 Electron 子进程（避免孤儿占单实例锁）', () => {
    expect(script).toContain("process.once('SIGINT'");
    expect(script).toContain("process.once('SIGTERM'");
    expect(script).toContain('closeOnSignal');
  });

  it('package.json 注册了 verify:steer，且走 tsx（脚本要 import Host/Client 的 TS 源码）', () => {
    const pkg = JSON.parse(read('../../package.json')) as { scripts: Record<string, string> };
    expect(pkg.scripts['verify:steer']).toContain('scripts/verify-steer.mjs');
    expect(pkg.scripts['verify:steer']).toContain('tsx');
  });
});
