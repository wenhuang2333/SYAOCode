import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createAgent, type AgentEvent, type Message, type PermissionHandler, type Tool, type ToolContext } from '@syaocode/core';
import { nodeRuntime } from '@syaocode/node';
import { createBuiltinTools, FileStateTracker } from '@syaocode/tools';
import { MockProvider, mockText, mockToolUse } from '@syaocode/testing';
import { z } from 'zod';
import type { CliArgs } from '../src/args';
import { EXIT_OK, EXIT_PERM, runPrint } from '../src/run';
import { disposeCliFabric } from '../src/arf';
import { governanceReport, installMainPathGovernance } from '../src/arf-main-path';
import { setLanguage } from '../src/i18n/index';

/**
 * Regression: the MAIN agent path is governed by the ARF kernel.
 *
 * Before task-8, `syao -p` / TUI / REPL tool calls went through core's
 * pipeline only: the run produced no kernel receipt, no audit link and no
 * budget reservation (05-实现评估与结论 §4). These tests drive the real
 * `runPrint` entry point (and the real agent loop) and assert on the evidence
 * the fabric now holds.
 */

let tmp: string;
let home: string;
const savedEnv = new Map<string, string | undefined>();

function setEnv(key: string, value: string | undefined): void {
  if (!savedEnv.has(key)) savedEnv.set(key, process.env[key]);
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'syao-arf-main-'));
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'syao-arf-home-'));
  setLanguage('en');
  setEnv('HOME', home);
  setEnv('SYAO_MODEL', 'mock:default');
});

afterEach(async () => {
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  savedEnv.clear();
  await disposeCliFabric();
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.rmSync(home, { recursive: true, force: true });
});

function cliArgs(cwd: string): CliArgs {
  return {
    positional: [],
    print: true,
    outputFormat: 'json',
    si: false,
    yao: false,
    allowedTools: [],
    disallowedTools: [],
    cwd,
    verbose: false,
    noBoot: true,
    subArgv: [],
  };
}

/** Run the real `syao -p` entry point and capture its stdout. */
async function runPrintCaptured(
  prompt: string,
  script: Message[],
  args: Partial<CliArgs> = {},
): Promise<{ code: number; stdout: string }> {
  process.env.SYAO_MOCK_SCRIPT = JSON.stringify(script);
  const chunks: string[] = [];
  const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown): boolean => {
    chunks.push(String(chunk));
    return true;
  });
  const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation((): boolean => true);
  try {
    const code = await runPrint({ ...cliArgs(tmp), ...args }, prompt);
    return { code, stdout: chunks.join('') };
  } finally {
    spy.mockRestore();
    errSpy.mockRestore();
  }
}

function readCall(path: string): Message[] {
  return [mockToolUse('a1', [{ id: 'c1', name: 'read', input: { path } }]), mockText('a2', 'read it')];
}

describe('main path → ARF kernel (task-8)', () => {
  it('a normal `syao -p` run leaves a receipt, an audit link and a settled budget reservation', async () => {
    fs.writeFileSync(path.join(tmp, 'note.txt'), 'hello kernel\n');
    const { code, stdout } = await runPrintCaptured('read note.txt', readCall('note.txt'));
    expect(code).toBe(EXIT_OK);

    const payload = JSON.parse(stdout) as {
      finalText: string;
      governance: Awaited<ReturnType<typeof governanceReport>>;
    };
    expect(payload.finalText).toBe('read it');

    // ── receipt: exactly one governed invocation, chained per task ──
    expect(payload.governance.receipts).toHaveLength(1);
    const receipt = payload.governance.receipts[0]!;
    expect(receipt.capabilityId).toBe('local://tools/read');
    expect(receipt.outcome).toBe('succeeded');
    expect(payload.governance.tasks).toContain(receipt.taskId);

    // ── audit: policy decision + invocation outcome, hash-chained ──
    const actions = payload.governance.audit.map((a) => a.action);
    expect(actions).toContain('policy.decide');
    expect(actions).toContain('invocation.succeeded');
    const invocation = payload.governance.audit.find((a) => a.action === 'invocation.succeeded')!;
    expect(invocation.prevHash).toBeDefined();
    expect(payload.governance.auditChainOk).toBe(true);

    // ── budget: reserved before dispatch, settled after ──
    expect(payload.governance.budget.reservations).toHaveLength(1);
    const reservation = payload.governance.budget.reservations[0]!;
    expect(reservation.state).toBe('settled');
    expect(reservation.accountId).toBe('default');
    expect(reservation.accountChain).toEqual(['tenant:syaocode-local', 'default']);
    expect(payload.governance.budget.accounts.map((a) => a.id)).toContain('default');
  }, 60_000);

  it('a denied tool call still leaves an ARF receipt with outcome `denied`', async () => {
    // `write` in the default tier needs approval; the headless policy denies
    // (BR-042), and the kernel records the refusal as evidence (I5).
    const script = [mockToolUse('a1', [{ id: 'c1', name: 'write', input: { path: 'x.txt', content: 'nope' } }]), mockText('a2', 'done')];
    const { code, stdout } = await runPrintCaptured('write x.txt', script);

    // Same exit code as a local permission denial (BR-042 / EXIT_PERM).
    expect(code).toBe(EXIT_PERM);

    const payload = JSON.parse(stdout) as {
      permissionDenied: boolean;
      governance: Awaited<ReturnType<typeof governanceReport>>;
    };
    expect(payload.permissionDenied).toBe(true);
    const denied = payload.governance.receipts.find((r) => r.capabilityId === 'local://tools/write');
    expect(denied).toBeDefined();
    expect(denied!.outcome).toBe('denied');
    // A refusal is audited too, and never reaches the budget ledger.
    expect(payload.governance.audit.map((a) => a.action)).toContain('approval.denied');
    expect(payload.governance.budget.reservations).toHaveLength(0);
    // The tool never ran: no write happened.
    expect(fs.existsSync(path.join(tmp, 'x.txt'))).toBe(false);
  }, 60_000);

  it('keeps the agent event stream (tool.start / tool.result / tool.receipt) and links the receipt', async () => {
    fs.writeFileSync(path.join(tmp, 'note.txt'), 'hello\n');
    const runtime = nodeRuntime();
    const builtins = createBuiltinTools();
    const governance = installMainPathGovernance({
      tools: builtins.tools,
      fileState: builtins.fileState,
      permissionMode: 'bypass',
      rules: [],
      cwd: tmp,
      runtime,
    });
    const provider = new MockProvider({ script: readCall('note.txt') });
    const agent = createAgent({
      provider,
      model: 'mock',
      cwd: tmp,
      tools: governance.tools,
      permissionMode: 'bypass',
      runtime,
      governor: governance.governor,
    });
    governance.bindEngine(agent.engine);

    const events: AgentEvent[] = [];
    const stream = agent.run('read note.txt');
    for (;;) {
      const step = await stream.next();
      if (step.done) break;
      events.push(step.value);
    }

    const types = events.map((e) => e.type);
    expect(types).toContain('tool.start');
    expect(types).toContain('tool.result');
    expect(types).toContain('tool.receipt');
    // Ordering preserved: start → receipt → result (core's pipeline order).
    expect(types.indexOf('tool.start')).toBeLessThan(types.indexOf('tool.receipt'));
    expect(types.indexOf('tool.receipt')).toBeLessThan(types.indexOf('tool.result'));

    const receiptEvent = events.find((e) => e.type === 'tool.receipt');
    expect(receiptEvent).toBeDefined();
    const link = receiptEvent!.type === 'tool.receipt' ? receiptEvent!.receipt.governance : undefined;
    expect(link).toBeDefined();
    expect(link!.outcome).toBe('succeeded');

    // The linked receipt really exists in the fabric's store.
    const stored = await governance.cli().fabric.stores.receipts.get(link!.receiptId, governance.cli().tenantId);
    expect(stored?.capabilityId).toBe('local://tools/read');

    await governance.dispose();
  }, 60_000);

  it('a denied call emits no tool.start (parity with a local permission denial)', async () => {
    const runtime = nodeRuntime();
    const builtins = createBuiltinTools();
    const denyAll: PermissionHandler = async () => ({ decision: 'deny', message: 'nope' });
    const governance = installMainPathGovernance({
      tools: builtins.tools,
      fileState: builtins.fileState,
      permissionMode: 'default',
      rules: [],
      cwd: tmp,
      runtime,
    });
    const provider = new MockProvider({
      script: [mockToolUse('a1', [{ id: 'c1', name: 'write', input: { path: 'x.txt', content: 'no' } }]), mockText('a2', 'ok')],
    });
    const agent = createAgent({
      provider,
      model: 'mock',
      cwd: tmp,
      tools: governance.tools,
      permissionMode: 'default',
      permissionHandler: denyAll,
      runtime,
      governor: governance.governor,
    });
    governance.bindEngine(agent.engine);

    const events: AgentEvent[] = [];
    const stream = agent.run('write x.txt');
    for (;;) {
      const step = await stream.next();
      if (step.done) break;
      events.push(step.value);
    }

    expect(events.some((e) => e.type === 'tool.start')).toBe(false);
    const result = events.find((e) => e.type === 'tool.result');
    expect(result !== undefined && result.type === 'tool.result' && result.isError).toBe(true);
    // The agent sees the SAME denial text the local gate produced.
    const text = result !== undefined && result.type === 'tool.result' ? String((result.content[0] as { text?: string }).text) : '';
    expect(text).toContain('nope');

    const report = await governanceReport(governance.cli());
    expect(report.receipts.some((r) => r.outcome === 'denied')).toBe(true);
    await governance.dispose();
  }, 60_000);

  it('answers the kernel `ask` through the same permission handler (remember: session survives)', async () => {
    const runtime = nodeRuntime();
    const builtins = createBuiltinTools();
    const governance = installMainPathGovernance({
      tools: builtins.tools,
      fileState: builtins.fileState,
      permissionMode: 'default',
      rules: [],
      cwd: tmp,
      runtime,
    });
    let prompts = 0;
    const allowOnce: PermissionHandler = async () => {
      prompts += 1;
      return { decision: 'allow', remember: 'session' };
    };
    // `default` tier asks for writes; the handler answers "allow for session",
    // which the engine records as a path-scoped rule — the second write to the
    // SAME path must not ask again, exactly as it behaved before the kernel
    // was in the loop.
    const script: Message[] = [
      mockToolUse('a1', [{ id: 'c1', name: 'write', input: { path: 'a.txt', content: 'first' } }]),
      mockToolUse('a2', [{ id: 'c2', name: 'write', input: { path: 'a.txt', content: 'second' } }]),
      mockText('a3', 'done'),
    ];
    const agent = createAgent({
      provider: new MockProvider({ script }),
      model: 'mock',
      cwd: tmp,
      tools: governance.tools,
      permissionMode: 'default',
      permissionHandler: allowOnce,
      runtime,
      governor: governance.governor,
    });
    governance.bindEngine(agent.engine);

    const stream = agent.run('write twice');
    for (;;) {
      const step = await stream.next();
      if (step.done) break;
    }

    expect(prompts).toBe(1);
    expect(fs.readFileSync(path.join(tmp, 'a.txt'), 'utf8')).toBe('second');

    const report = await governanceReport(governance.cli());
    expect(report.receipts.filter((r) => r.capabilityId === 'local://tools/write')).toHaveLength(2);
    expect(report.receipts.every((r) => r.outcome === 'succeeded')).toBe(true);
    await governance.dispose();
  }, 60_000);

  it('hands the tool the model\u2019s own input (no kernel-side rewrite of what it writes)', async () => {
    const runtime = nodeRuntime();
    const builtins = createBuiltinTools();
    const governance = installMainPathGovernance({
      tools: builtins.tools,
      fileState: builtins.fileState,
      permissionMode: 'bypass',
      rules: [],
      cwd: tmp,
      runtime,
    });
    // The kernel scrubs what LEAVES it; the input of a local tool is the
    // model's own instruction and must arrive byte-for-byte. `API_KEY=…` is
    // exactly the pattern the CLI redactor rewrites in outputs.
    const content = 'API_KEY=abc123\nTOKEN=deadbeef\n';
    const agent = createAgent({
      provider: new MockProvider({ script: [mockToolUse('a1', [{ id: 'c1', name: 'write', input: { path: 'config.txt', content } }]), mockText('a2', 'ok')] }),
      model: 'mock',
      cwd: tmp,
      tools: governance.tools,
      permissionMode: 'bypass',
      runtime,
      governor: governance.governor,
    });
    governance.bindEngine(agent.engine);
    const stream = agent.run('write config.txt');
    for (;;) {
      const step = await stream.next();
      if (step.done) break;
    }
    expect(fs.readFileSync(path.join(tmp, 'config.txt'), 'utf8')).toBe(content);
    await governance.dispose();
  }, 60_000);

  it('propagates the run abort signal into the kernel-dispatched tool', async () => {
    const runtime = nodeRuntime();
    let sawAbort = false;
    // The kernel executor supplies a never-aborting default signal; the
    // governor must restore the caller's so Ctrl-C still stops a child process.
    const slow: Tool = {
      name: 'slow',
      description: 'waits for the abort signal',
      inputSchema: z.object({}),
      risk: 'read',
      readOnly: true,
      concurrencySafe: true,
      timeoutMs: 60_000,
      async execute(_input: unknown, ctx: ToolContext) {
        await new Promise<void>((resolve) => {
          if (ctx.signal.aborted) {
            sawAbort = true;
            resolve();
            return;
          }
          ctx.signal.addEventListener(
            'abort',
            () => {
              sawAbort = true;
              resolve();
            },
            { once: true },
          );
        });
        return { content: [{ type: 'text', text: 'aborted' }] };
      },
    };
    const governance = installMainPathGovernance({
      tools: [slow],
      fileState: new FileStateTracker(),
      permissionMode: 'bypass',
      rules: [],
      cwd: tmp,
      runtime,
    });
    const agent = createAgent({
      provider: new MockProvider({
        script: [mockToolUse('a1', [{ id: 'c1', name: 'slow', input: {} }]), mockText('a2', 'done')],
      }),
      model: 'mock',
      cwd: tmp,
      tools: governance.tools,
      permissionMode: 'bypass',
      runtime,
      governor: governance.governor,
    });
    governance.bindEngine(agent.engine);

    const controller = new AbortController();
    const stream = agent.run('go', { signal: controller.signal });
    const timer = setTimeout(() => controller.abort(new Error('SIGINT')), 100);
    try {
      for (;;) {
        const step = await stream.next();
        if (step.done) break;
      }
    } finally {
      clearTimeout(timer);
    }
    expect(sawAbort).toBe(true);
    await governance.dispose();
  }, 60_000);

  it('applies a hot tier switch to the very next call', async () => {
    fs.writeFileSync(path.join(tmp, 'n.txt'), 'hello\n');
    const runtime = nodeRuntime();
    const builtins = createBuiltinTools();
    const governance = installMainPathGovernance({
      tools: builtins.tools,
      fileState: builtins.fileState,
      permissionMode: 'bypass',
      rules: [],
      cwd: tmp,
      runtime,
    });
    let prompts = 0;
    const denyAll: PermissionHandler = async () => {
      prompts += 1;
      return { decision: 'deny', message: 'blocked' };
    };
    // The SAME call twice: switching the tier mid-run must change the verdict
    // of the second one (the kernel caches `allow` decisions and the cache key
    // carries no tier, so the bundle swap has to drop it).
    const script: Message[] = [
      mockToolUse('a1', [{ id: 'c1', name: 'read', input: { path: 'n.txt' } }]),
      mockToolUse('a2', [{ id: 'c2', name: 'read', input: { path: 'n.txt' } }]),
      mockText('a3', 'done'),
    ];
    const agent = createAgent({
      provider: new MockProvider({ script }),
      model: 'mock',
      cwd: tmp,
      tools: governance.tools,
      permissionMode: 'bypass',
      runtime,
      permissionHandler: denyAll,
      governor: governance.governor,
    });
    governance.bindEngine(agent.engine);

    const stream = agent.run('read twice');
    for (;;) {
      const step = await stream.next();
      if (step.done) break;
      if (step.value.type === 'tool.receipt') {
        agent.engine.setMode('strict');
        governance.cli().setPermissionTier('strict');
      }
    }

    expect(prompts).toBe(1);
    const report = await governanceReport(governance.cli());
    expect(report.receipts.map((r) => r.outcome)).toEqual(['succeeded', 'denied']);
    await governance.dispose();
  }, 60_000);
});
