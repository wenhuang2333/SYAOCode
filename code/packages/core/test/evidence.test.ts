import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  createAgent,
  discoverVerification,
  executeToolCall,
  lintClaims,
  MemoryReceiptStore,
  PermissionEngine,
  Redactor,
  runVerification,
  textContent,
  ToolRegistry,
  type Message,
  type ModelStreamEvent,
  type Provider,
  type Tool,
} from '../src';
import { fakeRuntime } from './helpers';

const writeTool: Tool<{ path: string; content: string }> = {
  name: 'write',
  description: 'write a file',
  inputSchema: z.object({ path: z.string(), content: z.string() }),
  risk: 'write',
  readOnly: false,
  concurrencySafe: false,
  permissionSubject: (input) => ({ path: input.path }),
  async execute(input, ctx) {
    await ctx.runtime.fs.writeFile(`${ctx.cwd}/${input.path}`, input.content);
    return { content: textContent(`wrote ${input.path}`) };
  },
};

const echo: Tool<{ text: string }> = {
  name: 'echo',
  description: 'echo',
  inputSchema: z.object({ text: z.string() }),
  risk: 'read',
  readOnly: true,
  concurrencySafe: true,
  async execute(input) {
    return { content: textContent(`echo:${input.text}`) };
  },
};

function scripted(script: Message[]): Provider {
  let turn = 0;
  return {
    id: 'scripted',
    capabilities: () => ({
      contextWindow: 100_000,
      maxOutputTokens: 4_096,
      parallelToolCalls: true,
      thinking: 'none',
      promptCache: 'none',
      vision: false,
      structuredOutput: true,
    }),
    async *stream(): AsyncGenerator<ModelStreamEvent> {
      const message = script[turn];
      turn += 1;
      if (message === undefined) throw new Error('script exhausted');
      yield { type: 'message_start', messageId: message.id };
      yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } };
      yield {
        type: 'message_stop',
        stopReason: message.content.some((b) => b.type === 'tool_use') ? 'tool_use' : 'end_turn',
        message,
      };
    },
  };
}

function msg(id: string, blocks: Message['content']): Message {
  return { id, role: 'assistant', content: blocks, meta: { createdAt: 0 } };
}

function writeThen(text: string): Provider {
  return scripted([
    msg('a1', [{ type: 'tool_use', id: 'c1', name: 'write', input: { path: 'src/a.ts', content: 'x' } }]),
    msg('a2', [{ type: 'text', text }]),
  ]);
}

describe('tool receipts and content-addressed output', () => {
  it('stores the full pre-truncation output and records the path', async () => {
    const rt = fakeRuntime({ '/ws/src/a.ts': 'old' });
    const store = new MemoryReceiptStore();
    const registry = new ToolRegistry();
    registry.register(writeTool);
    const engine = new PermissionEngine({ mode: 'bypass', rules: [], workspaceRoots: ['/ws'], runtime: rt });
    const redactor = new Redactor();
    redactor.register('super-secret-token', 'test-key');
    const receipts: unknown[] = [];
    const block = await executeToolCall(
      { id: 'c1', name: 'write', input: { path: 'src/a.ts', content: 'secret super-secret-token' } },
      registry,
      engine,
      rt,
      {
        cwd: '/ws',
        signal: new AbortController().signal,
        receipts: store,
        redactor,
        events: {
          onToolReceipt: (receipt) => receipts.push(receipt),
        },
      },
    );
    expect(block.isError).toBeUndefined();
    expect(receipts).toHaveLength(1);
    const receipt = receipts[0] as {
      outputRef: string;
      paths: string[];
      outputHash: string;
      truncated: boolean;
    };
    expect(receipt.paths).toEqual(['src/a.ts']);
    const stored = await store.get(receipt.outputRef);
    expect(stored).toBe('wrote src/a.ts');
    expect(receipt.truncated).toBe(false);
  });
});

describe('verification discovery', () => {
  it('redacts verification output before evidence storage', async () => {
    const store = new MemoryReceiptStore();
    const redactor = new Redactor();
    redactor.register('super-secret-value', 'test-key');
    const runtime = fakeRuntime({}, { shell: () => ({ code: 0, stdout: 'log super-secret-value' }) });
    const [result] = await runVerification(
      runtime,
      '/ws',
      [{ command: 'pnpm test', source: 'config', scope: 'full' }],
      store,
      { redactor },
    );
    expect(result?.outputRef).toBeDefined();
    const stored = await store.get(result!.outputRef!);
    expect(stored).not.toContain('super-secret-value');
    expect(stored).toContain('[REDACTED:test-key]');
  });

  it('uses package scripts and the lockfile package manager', async () => {
    const rt = fakeRuntime({
      '/ws/package.json': JSON.stringify({ scripts: { test: 'vitest run', typecheck: 'tsc --noEmit' } }),
      '/ws/pnpm-lock.yaml': '',
    });
    const commands = await discoverVerification(rt, '/ws');
    expect(commands.map((c) => c.command)).toEqual(['pnpm run test', 'pnpm run typecheck']);
  });

  it('.syaocode/verify.json overrides discovery', async () => {
    const rt = fakeRuntime({
      '/ws/package.json': JSON.stringify({ scripts: { test: 'vitest run' } }),
      '/ws/.syaocode/verify.json': JSON.stringify({ commands: [{ command: 'make check', scope: 'related' }] }),
    });
    const commands = await discoverVerification(rt, '/ws');
    expect(commands).toEqual([{ command: 'make check', source: 'config', scope: 'related' }]);
  });
});

describe('verdict + claim linter (Evidence MVP)', () => {
  it('verification after a write supports "tests pass" and "modified file"', async () => {
    const store = new MemoryReceiptStore();
    const runtime = fakeRuntime(
      { '/ws/src/a.ts': 'old' },
      { shell: () => ({ code: 0, stdout: 'Tests  3 passed (3)' }) },
    );
    const agent = createAgent({
      provider: writeThen('All tests pass. Modified src/a.ts.'),
      model: 'm',
      cwd: '/ws',
      tools: [writeTool],
      permissionMode: 'bypass',
      runtime,
      receipts: store,
      verification: { enabled: true, commands: ['pnpm test'] },
    });
    const summary = await agent.runOnce('go');
    expect(summary.endReason).toBe('completed');
    expect(summary.verdict).toBe('verified');
    expect(summary.claims.map((c) => [c.kind, c.status])).toEqual([
      ['tests', 'supported'],
      ['file_change', 'supported'],
    ]);
    expect(summary.verification?.results[0]?.testStats?.passed).toBe(3);
    expect(summary.verification?.results[0]?.outputRef).toMatch(/^mem:\/\//);
  });

  it('a failing verification turns the run into verification_failed', async () => {
    const runtime = fakeRuntime({ '/ws/src/a.ts': 'old' }, { shell: () => ({ code: 1, stderr: 'Tests 1 failed' }) });
    const agent = createAgent({
      provider: writeThen('All tests pass.'),
      model: 'm',
      cwd: '/ws',
      tools: [writeTool],
      permissionMode: 'bypass',
      runtime,
      receipts: new MemoryReceiptStore(),
      verification: { enabled: true, commands: ['pnpm test'] },
    });
    const summary = await agent.runOnce('go');
    expect(summary.verdict).toBe('failed');
    expect(summary.endReason).toBe('verification_failed');
    expect(summary.claims[0]?.status).toBe('unsupported');
  });

  it('a claim without fresh evidence is unsupported; a pre-write test run is stale', () => {
    const receipt = (over: Record<string, unknown>) => ({
      callId: 'c1',
      tool: 'bash',
      timestamp: 1000,
      durationMs: 0,
      inputHash: 'i',
      outputHash: 'o',
      outputChars: 1,
      truncated: false,
      isError: false,
      trust: 'workspace' as const,
      sandbox: 'none' as const,
      command: 'pnpm test',
      exitCode: 0,
      testStats: { total: 1, passed: 1, failed: 0, skipped: 0 },
      ...over,
    });
    const claims = lintClaims('All tests pass.', [], undefined);
    expect(claims[0]?.status).toBe('unsupported');

    const stale = lintClaims(
      'All tests pass.',
      [receipt({ timestamp: 500 }), receipt({ callId: 'c2', tool: 'write', command: undefined, timestamp: 900, paths: ['a.ts'] })],
      undefined,
    );
    expect(stale[0]?.status).toBe('stale');
  });

  it('repository-discovered commands are not executed without verify init', async () => {
    let called = 0;
    const runtime = fakeRuntime(
      {
        '/ws/package.json': JSON.stringify({ scripts: { test: 'vitest run' } }),
        '/ws/pnpm-lock.yaml': '',
      },
      {
        shell: () => {
          called += 1;
          return { code: 0, stdout: 'Tests 1 passed (1)' };
        },
      },
    );
    const agent = createAgent({
      provider: writeThen('done'),
      model: 'm',
      cwd: '/ws',
      tools: [writeTool],
      permissionMode: 'bypass',
      runtime,
      receipts: new MemoryReceiptStore(),
      verification: { enabled: true },
    });
    const summary = await agent.runOnce('go');
    expect(called).toBe(0);
    expect(summary.verdict).toBe('not_run');
    expect(summary.verificationNote).toContain('syao verify init');
  });

  it('refuses a dangerous verification command even when explicitly configured', async () => {
    let called = 0;
    const runtime = fakeRuntime(
      { '/ws/src/a.ts': 'old' },
      {
        shell: () => {
          called += 1;
          return { code: 0 };
        },
      },
    );
    const agent = createAgent({
      provider: writeThen('done'),
      model: 'm',
      cwd: '/ws',
      tools: [writeTool],
      permissionMode: 'bypass',
      runtime,
      receipts: new MemoryReceiptStore(),
      verification: { enabled: true, commands: ['rm -rf /'] },
    });
    const summary = await agent.runOnce('go');
    expect(called).toBe(0);
    expect(summary.verificationNote).toContain('dangerous');
    expect(summary.verdict).toBe('not_run');
  });

  it('baseline failures make a "fixed" claim verifiable', async () => {
    let calls = 0;
    const runtime = fakeRuntime(
      { '/ws/src/a.ts': 'old' },
      {
        shell: () => {
          calls += 1;
          return calls === 1 ? { code: 1, stderr: 'Tests 1 failed' } : { code: 0, stdout: 'Tests 1 passed (1)' };
        },
      },
    );
    const agent = createAgent({
      provider: writeThen('Fixed the bug.'),
      model: 'm',
      cwd: '/ws',
      tools: [writeTool],
      permissionMode: 'bypass',
      runtime,
      receipts: new MemoryReceiptStore(),
      verification: { enabled: true, commands: ['pnpm test'], baseline: true },
    });
    const summary = await agent.runOnce('go');
    expect(summary.verification?.baseline).toHaveLength(1);
    expect(summary.claims.find((c) => c.kind === 'fixed')?.status).toBe('supported');
    expect(summary.verdict).toBe('verified');
  });

  it('verification pass with an unsupported claim yields unverified, not completed', async () => {
    const runtime = fakeRuntime({ '/ws/src/a.ts': 'old' }, { shell: () => ({ code: 0, stdout: 'ok' }) });
    const agent = createAgent({
      provider: writeThen('Fixed the bug.'),
      model: 'm',
      cwd: '/ws',
      tools: [writeTool],
      permissionMode: 'bypass',
      runtime,
      receipts: new MemoryReceiptStore(),
      verification: { enabled: true, commands: ['pnpm test'] },
    });
    const summary = await agent.runOnce('go');
    expect(summary.verdict).toBe('unverified');
    expect(summary.endReason).toBe('unverified');
  });
});
