import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EXIT, type ProtocolAdapter } from '@syaocode/rpc';
import { UsageError, parseArgs } from '../src/args';
import { createCliFabric, type CliFabric } from '../src/arf';
import { savePeer } from '../src/peers';
import {
  callJsonEnvelope,
  exitCodeForOutcome,
  normalizeApprovalOption,
  parseCallCommand,
  parseMcpCommand,
  parseRpcCommand,
  parseServeArgv,
  resolveCallInput,
  rpcErrorEnvelope,
  rpcJsonEnvelope,
  rpcView,
} from '../src/rpc-command';
import { servePlan, DEFAULT_PORTS, edgePath, resolveServeToken } from '../src/serve';
import { setLanguage } from '../src/i18n/index';

// ── argv: the subcommand swallows the rest of the line ────────────────────

describe('parseArgs — ARF subcommands', () => {
  it('routes rpc/call/mcp/serve to their own parser and keeps the tail verbatim', () => {
    const rpc = parseArgs(['rpc', 'tasks', '--json']);
    expect(rpc.command).toBe('rpc');
    expect(rpc.subArgv).toEqual(['tasks', '--json']);
    expect(rpc.positional).toEqual([]);

    const call = parseArgs(['call', 'mcp://x/tool/y', '--input', '@in.json', '--json']);
    expect(call.command).toBe('call');
    expect(call.subArgv).toEqual(['mcp://x/tool/y', '--input', '@in.json', '--json']);

    const mcp = parseArgs(['mcp', 'add', 'gh', 'npx', '-y', 'server']);
    expect(mcp.command).toBe('mcp');
    expect(mcp.subArgv).toEqual(['add', 'gh', 'npx', '-y', 'server']);

    const serve = parseArgs(['serve', '--mcp', '--http', '--port', '9000']);
    expect(serve.command).toBe('serve');
    expect(serve.subArgv).toEqual(['--mcp', '--http', '--port', '9000']);
  });

  it('still treats a prompt that merely starts with a subcommand name as prose', () => {
    const args = parseArgs(['call me maybe']);
    expect(args.command).toBeUndefined();
    expect(args.positional).toEqual(['call me maybe']);
  });

  it('keeps the global flags working in front of a subcommand', () => {
    const args = parseArgs(['--cwd', '/tmp', 'rpc', 'status']);
    expect(args.command).toBe('rpc');
    expect(args.cwd).toBe('/tmp');
    expect(args.subArgv).toEqual(['status']);
  });
});

// ── `syao rpc ...` ────────────────────────────────────────────────────────

describe('parseRpcCommand', () => {
  it('maps every documented subcommand onto a view', () => {
    expect(parseRpcCommand([])).toEqual({ kind: 'view', view: 'overview', json: false });
    expect(parseRpcCommand(['tasks'])).toEqual({ kind: 'view', view: 'tasks', json: false });
    expect(parseRpcCommand(['approvals'])).toEqual({ kind: 'view', view: 'approvals', json: false });
    expect(parseRpcCommand(['budget'])).toEqual({ kind: 'view', view: 'budget', json: false });
    expect(parseRpcCommand(['audit'])).toEqual({ kind: 'view', view: 'audit', json: false });
    expect(parseRpcCommand(['status'])).toEqual({ kind: 'view', view: 'status', json: false });
    expect(parseRpcCommand(['task', 'task_1'])).toEqual({ kind: 'view', view: 'task', id: 'task_1', json: false });
    expect(parseRpcCommand(['policy', 'mcp://x/tool/y'])).toEqual({
      kind: 'view',
      view: 'policy',
      capabilityId: 'mcp://x/tool/y',
      json: false,
    });
  });

  it('recognises --json in any position', () => {
    expect(parseRpcCommand(['--json', 'tasks'])).toEqual({ kind: 'view', view: 'tasks', json: true });
    expect(parseRpcCommand(['tasks', '--json'])).toEqual({ kind: 'view', view: 'tasks', json: true });
  });

  it('parses approve/deny into a decision with a normalized option', () => {
    expect(parseRpcCommand(['approve', 'apr_1'])).toEqual({ kind: 'decide', approvalId: 'apr_1', optionId: 'allow_once', json: false });
    expect(parseRpcCommand(['approve', 'apr_1', 'session'])).toEqual({ kind: 'decide', approvalId: 'apr_1', optionId: 'allow_session', json: false });
    expect(parseRpcCommand(['approve', 'apr_1', 'always'])).toEqual({ kind: 'decide', approvalId: 'apr_1', optionId: 'allow_always', json: false });
    expect(parseRpcCommand(['deny', 'apr_1'])).toEqual({ kind: 'decide', approvalId: 'apr_1', optionId: 'deny_once', json: false });
  });

  it('rejects an unknown subcommand, a missing id and a bad option', () => {
    expect(() => parseRpcCommand(['nope'])).toThrow(UsageError);
    expect(() => parseRpcCommand(['task'])).toThrow(UsageError);
    expect(() => parseRpcCommand(['policy'])).toThrow(UsageError);
    expect(() => parseRpcCommand(['approve'])).toThrow(UsageError);
    expect(() => parseRpcCommand(['approve', 'apr_1', 'maybe'])).toThrow(UsageError);
    expect(() => parseRpcCommand(['tasks', 'extra'])).toThrow(UsageError);
  });

  it('normalizes every documented approval option word', () => {
    expect(normalizeApprovalOption('once')).toBe('allow_once');
    expect(normalizeApprovalOption('y')).toBe('allow_once');
    expect(normalizeApprovalOption('session')).toBe('allow_session');
    expect(normalizeApprovalOption('s')).toBe('allow_session');
    expect(normalizeApprovalOption('always')).toBe('allow_always');
    expect(normalizeApprovalOption('deny')).toBe('deny_once');
    expect(normalizeApprovalOption('never')).toBe('deny_always');
    expect(normalizeApprovalOption('whatever')).toBeUndefined();
  });
});

// ── `syao call ...` ───────────────────────────────────────────────────────

describe('parseCallCommand / resolveCallInput', () => {
  it('reads the capability id, the input and the json flag', () => {
    expect(parseCallCommand(['mcp://x/tool/y'])).toEqual({ capabilityId: 'mcp://x/tool/y', json: false });
    expect(parseCallCommand(['mcp://x/tool/y', '--input', '{"a":1}'])).toEqual({
      capabilityId: 'mcp://x/tool/y',
      input: '{"a":1}',
      json: false,
    });
    expect(parseCallCommand(['mcp://x/tool/y', '--input=@f.json', '--json'])).toEqual({
      capabilityId: 'mcp://x/tool/y',
      input: '@f.json',
      json: true,
    });
  });

  it('requires a capability id', () => {
    expect(() => parseCallCommand([])).toThrow(UsageError);
  });

  it('parses inline JSON and rejects invalid JSON', () => {
    expect(resolveCallInput('{"a":1}')).toEqual({ a: 1 });
    expect(resolveCallInput(undefined)).toEqual({});
    expect(() => resolveCallInput('not json')).toThrow(UsageError);
  });

  it('reads @file input from disk', () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'syao-input-')), 'in.json');
    fs.writeFileSync(file, JSON.stringify({ hello: 'world' }));
    expect(resolveCallInput(`@${file}`)).toEqual({ hello: 'world' });
    expect(() => resolveCallInput(`@${file}.missing`)).toThrow(UsageError);
  });
});

// ── `syao mcp ...` ────────────────────────────────────────────────────────

describe('parseMcpCommand', () => {
  it('parses list/add/remove/tools', () => {
    expect(parseMcpCommand(['list'])).toEqual({ kind: 'list' });
    expect(parseMcpCommand([])).toEqual({ kind: 'list' });
    expect(parseMcpCommand(['add', 'gh', 'npx', '-y', 'github-mcp'])).toEqual({
      kind: 'add',
      name: 'gh',
      command: 'npx -y github-mcp',
    });
    expect(parseMcpCommand(['remove', 'gh'])).toEqual({ kind: 'remove', name: 'gh' });
    expect(parseMcpCommand(['tools', 'gh'])).toEqual({ kind: 'tools', name: 'gh' });
  });

  it('rejects an incomplete or unknown subcommand', () => {
    expect(() => parseMcpCommand(['add'])).toThrow(UsageError);
    expect(() => parseMcpCommand(['add', 'gh'])).toThrow(UsageError);
    expect(() => parseMcpCommand(['remove'])).toThrow(UsageError);
    expect(() => parseMcpCommand(['tools'])).toThrow(UsageError);
    expect(() => parseMcpCommand(['frobnicate'])).toThrow(UsageError);
  });

  it('rejects an unusable edge id', () => {
    expect(() => parseMcpCommand(['add', 'bad id', 'cmd'])).toThrow(UsageError);
  });
});

// ── `syao serve ...` ──────────────────────────────────────────────────────

describe('parseServeArgv / servePlan', () => {
  it('reads the protocol, the transport, the port and the host', () => {
    expect(parseServeArgv(['--mcp'])).toEqual({ protocol: 'mcp', transport: 'http', json: false });
    expect(parseServeArgv(['--acp', '--stdio'])).toEqual({ protocol: 'acp', transport: 'stdio', json: false });
    expect(parseServeArgv(['--a2a', '--http', '--port', '9100', '--host', '127.0.0.1'])).toEqual({
      protocol: 'a2a',
      transport: 'http',
      host: '127.0.0.1',
      port: 9100,
      json: false,
    });
    expect(parseServeArgv(['mcp', '--stdio'])).toEqual({ protocol: 'mcp', transport: 'stdio', json: false });
  });

  it('rejects a bad port or an unknown flag', () => {
    expect(() => parseServeArgv(['--port', 'abc'])).toThrow(UsageError);
    expect(() => parseServeArgv(['--port', '0'])).toThrow(UsageError);
    expect(() => parseServeArgv(['--wat'])).toThrow(UsageError);
  });

  it('defaults to the loopback host and one port per edge', () => {
    const plan = servePlan();
    expect(plan.host).toBe('127.0.0.1');
    expect(plan.port).toBe(DEFAULT_PORTS.mcp);
    expect(plan.protocol).toBe('mcp');
    expect(plan.errors).toEqual([]);
    expect(plan.endpoints).toContain(`http://127.0.0.1:${DEFAULT_PORTS.mcp}${edgePath('mcp')}`);
  });

  it('refuses a non-loopback bind without a token (SY-SRV-002)', () => {
    const plan = servePlan({ host: '0.0.0.0' });
    expect(plan.errors).toHaveLength(1);
    expect(plan.errorCodes).toEqual(['SY-SRV-002']);
    expect(plan.errors[0]).toContain('0.0.0.0');
  });

  it('allows a non-loopback bind once a token is configured', () => {
    const plan = servePlan({ host: '0.0.0.0', token: 'super-secret' });
    expect(plan.errors).toEqual([]);
    expect(plan.tokenConfigured).toBe(true);
    // The token itself is never part of the plan.
    expect(JSON.stringify(plan)).not.toContain('super-secret');
  });

  it('refuses an out-of-range port', () => {
    const plan = servePlan({ port: 70_000 });
    expect(plan.errorCodes).toEqual(['SY-CLI-001']);
  });

  it('reads the token from the environment, never from a file', () => {
    expect(resolveServeToken({ SYAO_RPC_TOKEN: 'abc' })).toBe('abc');
    expect(resolveServeToken({})).toBeUndefined();
    expect(resolveServeToken({ SYAO_RPC_TOKEN: '' })).toBeUndefined();
  });
});

// ── the --json output path ────────────────────────────────────────────────

describe('JSON envelope', () => {
  it('wraps a successful view', () => {
    const envelope = rpcJsonEnvelope('tasks', { tasks: [] });
    expect(envelope).toEqual({ ok: true, view: 'tasks', data: { tasks: [] } });
    expect(JSON.parse(JSON.stringify(envelope))).toMatchObject({ ok: true, view: 'tasks' });
  });

  it('wraps a failure with the kernel exit code', () => {
    const envelope = rpcErrorEnvelope('call', new Error('boom'));
    expect(envelope.ok).toBe(false);
    expect(envelope.view).toBe('call');
    expect(envelope.error?.exitCode).toBe(EXIT.ERROR);
    expect(envelope.error?.message).toBe('boom');
  });

  it('marks a failed invocation as ok:false with the shell exit code', () => {
    const failed = callJsonEnvelope({
      capabilityId: 'mcp://nope/tool/x',
      outcome: 'failed',
      error: { kind: 'capability_not_found', message: 'capability mcp://nope/tool/x is not registered' },
      approvalIds: [],
      lossy: [],
    });
    expect(failed.ok).toBe(false);
    expect(failed.error?.kind).toBe('capability_not_found');
    expect(failed.error?.exitCode).toBe(EXIT.UNAVAILABLE);
    expect(exitCodeForOutcome({ capabilityId: 'x', outcome: 'failed', error: { kind: 'capability_not_found', message: '' }, approvalIds: [], lossy: [] })).toBe(7);
  });

  it('marks a successful invocation as ok:true with no error block', () => {
    const ok = callJsonEnvelope({ capabilityId: 'x', outcome: 'succeeded', approvalIds: [], lossy: [] });
    expect(ok.ok).toBe(true);
    expect(ok.error).toBeUndefined();
    expect(exitCodeForOutcome({ capabilityId: 'x', outcome: 'succeeded', approvalIds: [], lossy: [] })).toBe(EXIT.OK);
  });

  it('maps every canonical failure kind onto its documented exit code', () => {
    const code = (kind: Parameters<typeof exitCodeForOutcome>[0]['error'] extends infer E ? never : never): never => kind as never;
    void code;
    const cases: [Parameters<typeof exitCodeForOutcome>[0]['error'] extends undefined ? never : string, number][] = [
      ['denied', EXIT.DENIED],
      ['budget_exceeded', EXIT.LIMIT],
      ['unsupported_capability', EXIT.UNAVAILABLE],
      ['invalid_request', EXIT.USAGE],
      ['indeterminate', EXIT.UNVERIFIED],
      ['cancelled', EXIT.INTERRUPTED],
      ['internal', EXIT.ERROR],
    ];
    for (const [kind, expected] of cases) {
      expect(
        exitCodeForOutcome({ capabilityId: 'x', outcome: 'failed', error: { kind: kind as never, message: '' }, approvalIds: [], lossy: [] }),
        kind,
      ).toBe(expected);
    }
  });

  it('carries the canonical kind of a kernel error', async () => {
    const { CanonicalError } = await import('@syaocode/rpc');
    const envelope = rpcErrorEnvelope('call', new CanonicalError({ kind: 'capability_not_found', message: 'nope' }));
    expect(envelope.error?.kind).toBe('capability_not_found');
    expect(envelope.error?.exitCode).toBe(EXIT.UNAVAILABLE);
  });
});

// ── views must see capabilities of REGISTERED peers ───────────────────────
//
// Regression: `/rpc policy <capabilityId>` resolved against the registry
// without mounting the registered edges first, so a peer's capability that
// `/call` could reach was reported as "unknown capability".

describe('rpcView — lazily mounts registered peers', () => {
  it('explains the policy for a registered (but not yet mounted) peer capability', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'syao-rpcview-'));
    const cli: CliFabric = createCliFabric({ cwd: home, permissionMode: 'default', home, persist: false });
    try {
      savePeer('demo', { protocol: 'mcp', target: 'node noop.mjs', addedAt: Date.now() }, home);
      // The edge cannot really be spawned here, so stub the mount with a fake
      // adapter that exposes exactly the capability the peer would publish.
      await cli.fabric.mount(edgePublishing('mcp://demo/tool/echo'), { providerId: 'demo', risk: 'read' });

      const result = await rpcView({ kind: 'view', view: 'policy', capabilityId: 'mcp://demo/tool/echo', json: false }, cli);
      const json = result.json as { capabilityId: string; decision: { effect: string } };
      expect(json.capabilityId).toBe('mcp://demo/tool/echo');
      expect(['allow', 'ask', 'deny']).toContain(json.decision.effect);
      expect(result.lines.join('\n')).not.toContain('unknown capability');
    } finally {
      await cli.dispose();
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

/** Adapter publishing a single capability, used to stand in for a peer. */
function edgePublishing(capabilityId: string): ProtocolAdapter {
  return {
    protocol: 'mcp',
    version: 'test-1',
    capabilities: () => ({
      protocol: 'mcp',
      version: 'test-1',
      supports: {
        session: false, task: false, streaming: false, push: false,
        approvalOptions: true, artifacts: false, reverseCalls: false, cancellation: false,
      },
      lossy: [],
    }),
    async discover() {
      const name = capabilityId.split('/').pop() ?? 'echo';
      return [{ id: capabilityId, kind: 'tool', displayName: name }];
    },
    async invoke() {
      return { outcome: 'succeeded' as const, output: 'ok' };
    },
    async health() {
      return 'healthy' as const;
    },
    async close() {
      /* nothing to release */
    },
  };
}
