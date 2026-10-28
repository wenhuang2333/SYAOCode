import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CanonicalError, EXIT, type InvokeResult, type ProtocolAdapter } from '@syaocode/rpc';
import { createCliFabric, errorText, exitCodeForError, getCliFabric, disposeCliFabric, hasCliFabric, isLoopbackHost, tierDefaultEffect, tierPolicyRules, type CliFabric } from '../src/arf';
import { setLanguage } from '../src/i18n/index';

let tmp: string;
const made: CliFabric[] = [];

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'syao-arf-'));
  setLanguage('en');
});

afterEach(async () => {
  for (const cli of made.splice(0)) await cli.dispose();
  if (hasCliFabric()) await disposeCliFabric();
  fs.rmSync(tmp, { recursive: true, force: true });
});

function cli(opts: Parameters<typeof createCliFabric>[0] = {}): CliFabric {
  const created = createCliFabric({ cwd: tmp, permissionMode: 'default', ...opts });
  made.push(created);
  return created;
}

/** Minimal MCP edge: one discoverable write capability, no network. */
function fakeEdge(): ProtocolAdapter {
  return {
    protocol: 'mcp',
    version: 'test-1',
    capabilities: () => ({
      protocol: 'mcp',
      version: 'test-1',
      supports: {
        session: false,
        task: false,
        streaming: false,
        push: false,
        approvalOptions: true,
        artifacts: false,
        reverseCalls: false,
        cancellation: false,
      },
      lossy: ['mcp-legacy'],
    }),
    discover: async () => [
      { id: 'mcp://fake/tool/write_note', kind: 'tool', displayName: 'write_note', declaredRisk: 'write' },
    ],
    invoke: async () => ({ outcome: 'succeeded', output: { written: true }, lossy: ['untrusted-content'] }),
    health: async () => 'healthy',
    close: async () => undefined,
  };
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error('condition not reached in time');
    await sleep(5);
  }
}

// ── pure policy derivation ────────────────────────────────────────────────

describe('policy derived from the CLI tier', () => {
  it('maps every tier onto a bundle default effect', () => {
    expect(tierDefaultEffect('bypass')).toBe('allow');
    expect(tierDefaultEffect('default')).toBe('ask');
    expect(tierDefaultEffect('acceptEdits')).toBe('ask');
    expect(tierDefaultEffect('plan')).toBe('deny');
    expect(tierDefaultEffect('strict')).toBe('deny');
  });

  it('turns session rules into session-layer rules and keeps them ordered', () => {
    const rules = tierPolicyRules('default', [
      { effect: 'allow', tool: 'read', source: 'user' },
      { effect: 'deny', tool: 'bash', match: { command: 'rm *' }, source: 'user' },
    ]);
    expect(rules).toHaveLength(2);
    expect(rules[0]!.priority).toBeLessThan(rules[1]!.priority);
    expect(rules[0]!.source).toBe('session');
    expect(rules[0]!.match.capabilities).toEqual(['read']);
    expect(rules[1]!.match.commands).toEqual(['rm *']);
  });

  it('adds an explicit ask rule for the strict tier', () => {
    const rules = tierPolicyRules('strict');
    expect(rules.some((r) => r.effect === 'ask' && r.id === 'cli-tier-strict')).toBe(true);
  });

  it('never lets a session rule widen a deny (deny wins by construction)', () => {
    const rules = tierPolicyRules('bypass', [{ effect: 'allow', tool: 'bash', source: 'user' }]);
    // bypass only adds the user's allow rule; the kernel's deny precedence is
    // what makes it safe, so the CLI must not synthesise an allow-all rule.
    expect(rules.every((r) => r.effect !== 'deny')).toBe(true);
    expect(rules[0]!.match.capabilities).toEqual(['bash']);
  });
});

describe('isLoopbackHost', () => {
  it('accepts loopback spellings and rejects routable addresses', () => {
    for (const host of ['127.0.0.1', 'localhost', '::1', '[::1]', '127.0.0.2']) {
      expect(isLoopbackHost(host), host).toBe(true);
    }
    for (const host of ['0.0.0.0', '10.0.0.5', 'example.com', '::']) {
      expect(isLoopbackHost(host), host).toBe(false);
    }
  });
});

// ── the fabric itself ─────────────────────────────────────────────────────

describe('createCliFabric', () => {
  it('returns a working fabric bound to the CLI workspace and tenant', async () => {
    const c = cli({ tools: false });
    const status = await c.fabric.status();
    expect(status.tenantId).toBe('syaocode-local');
    expect(status.capabilityCount).toBe(0);
    expect(status.pendingApprovals).toBe(0);
    expect(c.workspaceRoots).toEqual([tmp]);
    expect(c.cwd).toBe(tmp);

    // A session (and therefore the budget account) is created on first use.
    const session = await c.ensureSession();
    expect(session.workspaceRoots).toEqual([tmp]);
    const accounts = await c.fabric.budget.list();
    expect(accounts.map((a) => a.id)).toContain(session.budgetId);

    // No listener, no network: discovery is a no-op on a bare fabric.
    expect(await c.fabric.discover()).toEqual([]);
  });

  it('mounts an edge, discovers its capabilities and executes a governed call', async () => {
    const c = cli({ permissionMode: 'bypass', tools: false });
    await c.fabric.mount(fakeEdge(), { providerId: 'fake', risk: 'write' });
    const caps = await c.fabric.discover();
    expect(caps.map((cap) => cap.id)).toEqual(['mcp://fake/tool/write_note']);

    const result = await c.call({ capabilityId: 'mcp://fake/tool/write_note', input: { text: 'hi' } });
    expect(result.outcome).toBe('succeeded');
    expect(result.receiptId).toBeTruthy();
    expect(result.taskId).toBeTruthy();
    expect(result.lossy).toContain('untrusted-content');

    // Exactly one receipt per invocation, and it is readable back.
    const receipts = await c.fabric.stores.receipts.listByTask(result.taskId);
    expect(receipts).toHaveLength(1);
    expect(receipts[0]!.id).toBe(result.receiptId);
    expect(receipts[0]!.capabilityId).toBe('mcp://fake/tool/write_note');
  });

  it('maps an unregistered capability onto capability_not_found and exit code 7', async () => {
    const c = cli({ tools: false });
    let thrown: unknown;
    try {
      await c.call({ capabilityId: 'mcp://nobody/tool/nope', input: {} });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(CanonicalError);
    const err = thrown as CanonicalError;
    expect(err.kind).toBe('capability_not_found');
    expect(err.exitCode).toBe(EXIT.UNAVAILABLE);
    expect(err.exitCode).toBe(7);
    expect(exitCodeForError(thrown)).toBe(7);
    expect(errorText(thrown)).toContain('not registered');
  });

  it('decides a pending approval exactly once (single winner, I9)', async () => {
    const c = cli({ permissionMode: 'default', approvalTimeoutMs: 250, tools: false });
    await c.fabric.mount(fakeEdge(), { providerId: 'fake', risk: 'write' });

    // `default` asks for a remote write, so the call parks on an approval.
    const pending: Promise<InvokeResult> = c.call({ capabilityId: 'mcp://fake/tool/write_note', input: {} });
    await waitFor(() => c.pendingApprovals.length > 0);
    const id = c.pendingApprovals[0]!.id;
    expect(await c.fabric.approvals.listPending()).toHaveLength(1);

    const [first, second] = await Promise.all([
      c.decideApproval(id, 'allow_once', 'user:a'),
      c.decideApproval(id, 'allow_session', 'user:b'),
    ]);
    expect([first, second].filter(Boolean)).toHaveLength(1);
    expect(c.decidedApprovals.has(id)).toBe(true);

    // The parked call resumes either way — it never hangs.
    const result = await pending.catch((e: unknown) => e);
    expect(result).toBeDefined();
    if (first === true) expect((result as InvokeResult).outcome).toBe('succeeded');
    else expect(CanonicalError.is(result)).toBe(true);
  });

  it('fails closed when nobody answers an approval', async () => {
    const c = cli({ permissionMode: 'default', approvalTimeoutMs: 30, tools: false });
    await c.fabric.mount(fakeEdge(), { providerId: 'fake', risk: 'write' });
    const result = await c.call({ capabilityId: 'mcp://fake/tool/write_note', input: {} }).catch((e: unknown) => e);
    expect(CanonicalError.is(result)).toBe(true);
    expect((result as CanonicalError).kind).toBe('denied');
    expect(exitCodeForError(result)).toBe(EXIT.DENIED);
  });

  it('reports every pending approval through the presentApproval hook', async () => {
    const seen: string[] = [];
    const c = cli({
      permissionMode: 'default',
      approvalTimeoutMs: 200,
      tools: false,
      presentApproval: (record) => {
        seen.push(record.id);
      },
    });
    await c.fabric.mount(fakeEdge(), { providerId: 'fake', risk: 'write' });
    const pending = c.call({ capabilityId: 'mcp://fake/tool/write_note', input: {} }).catch((e: unknown) => e);
    await waitFor(() => seen.length > 0);
    expect(seen).toHaveLength(1);
    await c.decideApproval(seen[0]!, 'deny_once');
    await pending;
    expect(c.pendingApprovals).toHaveLength(0);
  });

  it('keeps a per-process singleton, and disposal forgets it', async () => {
    expect(hasCliFabric()).toBe(false);
    const first = getCliFabric({ cwd: tmp });
    expect(getCliFabric({ cwd: tmp })).toBe(first);
    expect(hasCliFabric()).toBe(true);
    await disposeCliFabric();
    expect(hasCliFabric()).toBe(false);
    const second = getCliFabric({ cwd: tmp });
    expect(second).not.toBe(first);
    await second.dispose();
  });
});
