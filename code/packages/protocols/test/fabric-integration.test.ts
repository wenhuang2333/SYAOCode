/**
 * Fabric integration — the seam between the REAL kernel and the REAL edges.
 *
 * The contract suites (mcp/a2a/acp.contract.test.ts) use a fake dispatcher;
 * the kernel's own tests use fake adapters. This file wires the two together
 * for real, so the architecture claim "one kernel, three edges" is *proved*,
 * not asserted:
 *
 *   1. discovery → the fabric's registry contains the adapter's capability ids;
 *   2. a read capability round-trips and produces a receipt;
 *   3. a policy-denied capability never reaches the peer (call counter);
 *   4. the `lossy` notes the adapter reports land on the InvokeResult *and*
 *      on the receipt;
 *   5. an ACP reverse `fs/write_text_file` travels through the same governance
 *      path (allow → the editor is asked; deny → the editor is never asked).
 */

import { describe, expect, it } from 'vitest';
import { createFabric, type PolicyRule } from '@syaocode/rpc';
import { a2aAdapter } from '../src/a2a/index.js';
import { acpAdapter } from '../src/acp/index.js';
import { mcpAdapter } from '../src/mcp/index.js';
import { createLoopbackPair } from '../src/shared/transport.js';
import { JsonRpcConnection } from '../src/shared/jsonrpc.js';
import { createFakePeer } from './helpers/fake-peer.js';
import { createFakeRuntime } from './helpers/fake-runtime.js';
import type { A2aTask } from '../src/a2a/index.js';

const DEADLINE = (): string => new Date(Date.now() + 10_000).toISOString();

const ALLOW_READ: PolicyRule = {
  id: 'allow-mcp-read',
  priority: 10,
  effect: 'allow',
  match: { capabilities: ['mcp://local/tool/read_file'] },
  source: 'project',
  reason: 'read-only MCP tools are allowed',
};

const ALLOW_ACP_FS: PolicyRule = {
  id: 'allow-acp-fs-read',
  priority: 10,
  effect: 'allow',
  match: { capabilities: ['acp://editor1/fs/read_text_file'] },
  source: 'project',
  reason: 'the editor owns the filesystem; reads inside the workspace are allowed',
};

const ALLOW_A2A: PolicyRule = {
  id: 'allow-a2a-skill',
  priority: 10,
  effect: 'allow',
  match: { capabilities: ['a2a://remote/skill/echo'] },
  source: 'project',
  reason: 'the remote agent skill is allowed',
};

describe('fabric · MCP edge', () => {
  it('discovers, governs and receipts a real MCP call', async () => {
    const runtime = createFakeRuntime();
    const pair = createLoopbackPair({ labels: ['client', 'mcp-server'] });
    const peer = createFakePeer(pair.b);
    const calls: string[] = [];

    peer.on('server/discover', () => ({
      supportedVersions: ['2026-07-28'],
      capabilities: { tools: { listChanged: false } },
      ttlMs: 60_000,
      cacheScope: 'private',
    }));
    peer.on('tools/list', () => ({
      tools: [
        { name: 'read_file', title: 'Read file', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } },
        { name: 'delete_repo', title: 'Delete repo', inputSchema: { type: 'object' }, annotations: { destructiveHint: true } },
      ],
    }));
    peer.on('tools/call', (params) => {
      calls.push((params as { name?: string }).name ?? '');
      return { resultType: 'complete', content: [{ type: 'text', text: 'file body' }] };
    });

    const fabric = createFabric({
      runtime,
      tenantId: 'acme',
      workspaceRoots: ['/repo'],
      policy: { defaultEffect: 'deny', rules: [ALLOW_READ] },
    });

    const adapter = mcpAdapter({ runtime, channel: pair.a, serverId: 'local' });
    await fabric.mount(adapter, { providerId: 'local', risk: 'read' });

    // 1. discovery lands in the registry.
    const capabilities = await fabric.capabilities();
    const ids = capabilities.map((capability) => capability.id);
    expect(ids).toContain('mcp://local/tool/read_file');
    expect(ids).toContain('mcp://local/tool/delete_repo');
    // The registry owns the effective risk; the peer's annotations are advisory.
    expect(capabilities.find((capability) => capability.id === 'mcp://local/tool/read_file')?.risk).toBe('read');

    // 2. a read round-trips through the real dispatcher and issues a receipt.
    const result = await fabric.call({
      capabilityId: 'mcp://local/tool/read_file',
      input: { path: '/repo/a.txt' },
      protocol: 'mcp',
      deadlineAt: DEADLINE(),
    });
    expect(result.outcome).toBe('succeeded');
    expect(result.receiptId).toBeTruthy();
    expect(calls).toEqual(['read_file']);
    // Without `structuredContent` the adapter passes the MCP content blocks on.
    const output = result.output as { type: string; text: string }[];
    expect(output[0]?.text).toBe('file body');

    const receipt = await fabric.stores.receipts.get(result.receiptId);
    expect(receipt?.capabilityId).toBe('mcp://local/tool/read_file');
    expect(receipt?.inputHash).toBeTruthy();
    expect(receipt?.outcome).toBe('succeeded');
    expect(receipt?.policy.effect).toBe('allow');

    // 3. a denied capability never reaches the peer.
    await expect(
      fabric.call({
        capabilityId: 'mcp://local/tool/delete_repo',
        input: { repo: 'acme/app' },
        protocol: 'mcp',
        deadlineAt: DEADLINE(),
      }),
    ).rejects.toMatchObject({ kind: 'denied' });
    expect(calls).toEqual(['read_file']);

    // The audit chain recorded the denial.
    const audit = await fabric.audit.list({ limit: 50 });
    expect(audit.some((event) => event.action === 'policy.decide' && event.outcome === 'denied')).toBe(true);
    expect((await fabric.audit.verify('acme')).ok).toBe(true);

    await fabric.close();
    await peer.close();
    await pair.close();
  });

  it('surfaces the adapter lossy notes on the result and on the receipt', async () => {
    const runtime = createFakeRuntime();
    const pair = createLoopbackPair({ labels: ['client', 'legacy-mcp'] });
    const peer = createFakePeer(pair.b);

    // A legacy peer: no `server/discover`, so the adapter falls back to
    // `initialize` and records `lossy: ['mcp-legacy']` (01 §2.1 / G9).
    peer.on('initialize', () => ({ protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: 'legacy', version: '1' } }));
    peer.on('tools/list', () => ({ tools: [{ name: 'read_file', inputSchema: { type: 'object' } }] }));
    peer.on('tools/call', () => ({ resultType: 'complete', content: [{ type: 'text', text: 'legacy body' }] }));

    const fabric = createFabric({
      runtime,
      tenantId: 'acme',
      workspaceRoots: ['/repo'],
      policy: { defaultEffect: 'deny', rules: [ALLOW_READ] },
    });
    await fabric.mount(mcpAdapter({ runtime, channel: pair.a, serverId: 'local' }), { providerId: 'local', risk: 'read' });

    const result = await fabric.call({
      capabilityId: 'mcp://local/tool/read_file',
      input: { path: '/repo/a.txt' },
      protocol: 'mcp',
      deadlineAt: DEADLINE(),
    });

    expect(result.outcome).toBe('succeeded');
    expect(result.lossy).toContain('mcp-legacy');
    const receipt = await fabric.stores.receipts.get(result.receiptId);
    expect(receipt?.lossy).toContain('mcp-legacy');
    // The mounted edge advertises the same gap in its capabilities.
    const status = await fabric.status();
    expect(status.adapters[0]?.lossy).toContain('mcp-legacy');

    await fabric.close();
    await peer.close();
    await pair.close();
  });
});

describe('fabric · A2A edge', () => {
  it('governs a remote agent skill like any other capability', async () => {
    const runtime = createFakeRuntime();
    const pair = createLoopbackPair({ labels: ['client', 'a2a-agent'] });
    const peer = createFakePeer(pair.b);
    const calls: string[] = [];

    peer.on('GetExtendedAgentCard', () => ({
      name: 'Remote',
      description: 'A remote agent',
      version: '1.0.0',
      supportedInterfaces: [{ url: 'http://127.0.0.1:8931', protocolBinding: 'JSONRPC', protocolVersion: '1.0' }],
      capabilities: { streaming: true },
      defaultInputModes: ['text/plain'],
      defaultOutputModes: ['text/plain'],
      skills: [{ id: 'echo', name: 'Echo', description: 'echoes' }],
    }));
    peer.on('SendMessage', () => {
      calls.push('SendMessage');
      const task: A2aTask = {
        id: 'a2a-task-1',
        contextId: 'ctx-1',
        kind: 'task',
        status: { state: 'TASK_STATE_COMPLETED', timestamp: new Date(0).toISOString() },
        artifacts: [],
      };
      return task;
    });

    const fabric = createFabric({
      runtime,
      tenantId: 'acme',
      workspaceRoots: ['/repo'],
      policy: { defaultEffect: 'deny', rules: [ALLOW_A2A] },
    });
    await fabric.mount(a2aAdapter({ runtime, channel: pair.a, agentId: 'remote', tenantId: 'acme' }), { providerId: 'remote' });

    const capabilities = await fabric.capabilities();
    expect(capabilities.map((capability) => capability.id)).toContain('a2a://remote/skill/echo');

    const result = await fabric.call({
      capabilityId: 'a2a://remote/skill/echo',
      input: 'hello',
      protocol: 'a2a',
      deadlineAt: DEADLINE(),
    });
    expect(result.outcome).toBe('succeeded');
    expect(calls).toEqual(['SendMessage']);
    // G3: a remote task is opaque, and the loss travels with the result.
    expect(result.lossy).toContain('a2a-remote-task-opaque');

    await fabric.close();
    await peer.close();
    await pair.close();
  });
});

describe('fabric · ACP edge', () => {
  it('routes a reverse fs call through the same governance path', async () => {
    const runtime = createFakeRuntime();
    const pair = createLoopbackPair({ labels: ['agent', 'editor'] });
    const peer = createFakePeer(pair.b);
    const calls: string[] = [];

    peer.on('fs/read_text_file', () => {
      calls.push('fs/read_text_file');
      return { content: 'editor side body' };
    });

    const connection = new JsonRpcConnection({ channel: pair.a });
    connection.start();
    const adapter = acpAdapter({
      runtime,
      connection,
      clientId: 'editor1',
      sessionId: 'acp-session-1',
      clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } },
    });

    const fabric = createFabric({
      runtime,
      tenantId: 'acme',
      workspaceRoots: ['/repo'],
      policy: { defaultEffect: 'deny', rules: [ALLOW_ACP_FS] },
    });
    await fabric.mount(adapter, { providerId: 'editor1' });

    // The client-owned capabilities are discovered and registered.
    const capabilities = await fabric.capabilities();
    expect(capabilities.map((capability) => capability.id)).toContain('acp://editor1/fs/read_text_file');

    // Allowed → the editor is asked, through the same dispatcher.
    const result = await fabric.call({
      capabilityId: 'acp://editor1/fs/read_text_file',
      input: { sessionId: 'acp-session-1', path: '/repo/a.txt' },
      protocol: 'acp',
      direction: 'reverse',
      deadlineAt: DEADLINE(),
    });
    expect(result.outcome).toBe('succeeded');
    expect(calls).toEqual(['fs/read_text_file']);
    expect((result.output as { content: string }).content).toBe('editor side body');

    // Denied → the editor is NEVER asked (the policy runs before dispatch).
    await expect(
      fabric.call({
        capabilityId: 'acp://editor1/fs/write_text_file',
        input: { sessionId: 'acp-session-1', path: '/repo/a.txt', content: 'x' },
        protocol: 'acp',
        direction: 'reverse',
        deadlineAt: DEADLINE(),
      }),
    ).rejects.toMatchObject({ kind: 'denied' });
    expect(calls).toEqual(['fs/read_text_file']);

    await fabric.close();
    await connection.close();
    await peer.close();
    await pair.close();
  });
});
