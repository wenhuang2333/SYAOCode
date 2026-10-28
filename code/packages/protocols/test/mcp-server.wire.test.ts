/**
 * MCP server wire conformance (P-H1/H6/H8).
 *
 * Drives the REAL `McpServer` through the REAL `JsonRpcConnection` over a
 * loopback channel, and asserts what a third-party client actually observes:
 * the JSON-RPC error objects on the wire, not internal TypeScript types.
 */

import { describe, expect, it } from 'vitest';
import { MCP_ERROR_CODES } from '@syaocode/rpc';
import { McpClient } from '../src/mcp/client.js';
import { McpServer, requiresInput, type McpToolExecutor, type McpServerTool } from '../src/mcp/server.js';
import {
  MCP_HEADER_METHOD,
  MCP_HEADER_MISMATCH_CODE,
  MCP_HEADER_NAME,
  MCP_HEADER_PROTOCOL_VERSION,
  buildMcpHttpHeaders,
  checkMcpHttpHeaders,
} from '../src/mcp/http.js';
import { MCP_LOSSY, MCP_PROTOCOL_VERSION } from '../src/mcp/mapping.js';
import { createLoopbackPair } from '../src/shared/transport.js';
import { JsonRpcConnection } from '../src/shared/jsonrpc.js';
import { createFakeRuntime } from './helpers/fake-runtime.js';
import { buildContext } from './helpers/contract.js';

const SERVER_ID = 'srv';

const TOOLS: McpServerTool[] = [
  {
    name: 'echo',
    title: 'Echo',
    description: 'Echoes its input',
    inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
    annotations: { readOnlyHint: true },
  },
];

/** A tool executor that records calls and can request MRTR input. */
function executor(options?: { requireInputOnce?: boolean }): McpToolExecutor & { calls: unknown[] } {
  const calls: unknown[] = [];
  let asked = false;
  return {
    calls,
    async execute(request) {
      calls.push(request);
      if (options?.requireInputOnce === true && !asked) {
        asked = true;
        return requiresInput([{ id: 'q1', method: 'elicitation', message: 'need a value', schema: { enum: ['yes', 'no'] } }]);
      }
      return { outcome: 'succeeded', output: { echoed: request.input } };
    },
  };
}

interface Rig {
  server: McpServer;
  client: JsonRpcConnection;
  peer: McpServer;
  dispose(): Promise<void>;
}

async function rig(options?: {
  requireInputOnce?: boolean;
  allowLegacyClients?: boolean;
  tools?: McpServerTool[];
}): Promise<Rig & { executor: ReturnType<typeof executor> }> {
  const pair = createLoopbackPair({ labels: ['client', 'server'] });
  const runtime = createFakeRuntime();
  const exec = executor({ ...(options?.requireInputOnce !== undefined ? { requireInputOnce: options.requireInputOnce } : {}) });
  const server = new McpServer({
    runtime,
    channel: pair.b,
    serverId: SERVER_ID,
    tools: options?.tools ?? TOOLS,
    executor: exec,
    ...(options?.allowLegacyClients !== undefined ? { allowLegacyClients: options.allowLegacyClients } : {}),
  });
  const client = new JsonRpcConnection({ channel: pair.a, requestTimeoutMs: 1_000 });
  client.start();
  return {
    server,
    client,
    peer: server,
    executor: exec,
    dispose: async () => {
      await client.close();
      await server.close();
      await pair.close();
    },
  };
}

const META = {
  _meta: {
    'io.modelcontextprotocol/protocolVersion': MCP_PROTOCOL_VERSION,
    'io.modelcontextprotocol/clientCapabilities': {},
    'io.modelcontextprotocol/clientInfo': { name: 'test-client', version: '1' },
  },
};

describe('mcp server · discovery', () => {
  it('answers server/discover with versions, capabilities, ttlMs and cacheScope', async () => {
    const r = await rig();
    const result = (await r.client.request('server/discover', { _meta: META._meta })) as Record<string, unknown>;
    expect(result['supportedVersions']).toContain(MCP_PROTOCOL_VERSION);
    expect(result['capabilities']).toMatchObject({ tools: { listChanged: false } });
    expect(typeof result['ttlMs']).toBe('number');
    expect(result['cacheScope']).toBe('private');
    expect(result['serverInfo']).toBeTruthy();
    await r.dispose();
  });

  it('rejects a request whose protocolVersion is not supported (-32022)', async () => {
    const r = await rig();
    await expect(
      r.client.request('server/discover', {
        _meta: { ...META._meta, 'io.modelcontextprotocol/protocolVersion': '1999-01-01' },
      }),
    ).rejects.toMatchObject({ code: -32022 });
    await r.dispose();
  });

  it('lists tools with their JSON Schema and untrusted annotations', async () => {
    const r = await rig();
    const result = (await r.client.request('tools/list', { _meta: META._meta })) as {
      tools: { name: string; inputSchema: unknown; annotations?: Record<string, unknown> }[];
    };
    expect(result.tools).toHaveLength(1);
    expect(result.tools[0]?.name).toBe('echo');
    expect(result.tools[0]?.inputSchema).toEqual(TOOLS[0]?.inputSchema);
    // G8: annotations travel, but they are never a permission input.
    expect(result.tools[0]?.annotations).toEqual({ readOnlyHint: true });
    await r.dispose();
  });
});

describe('mcp server · tools/call', () => {
  it('returns a complete result and routes through the executor', async () => {
    const r = await rig();
    const result = (await r.client.request('tools/call', { name: 'echo', arguments: { text: 'hi' }, _meta: META._meta })) as {
      resultType: string;
      content: { type: string; text: string }[];
      structuredContent: unknown;
      isError?: boolean;
    };
    expect(result.resultType).toBe('complete');
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toEqual({ echoed: { text: 'hi' } });
    expect(r.executor.calls).toHaveLength(1);
    await r.dispose();
  });

  it('reports a tool failure as isError, not as a JSON-RPC error', async () => {
    const pair = createLoopbackPair();
    const runtime = createFakeRuntime();
    const server = new McpServer({
      runtime,
      channel: pair.b,
      serverId: SERVER_ID,
      tools: TOOLS,
      executor: {
        async execute() {
          return { outcome: 'failed', error: { kind: 'remote_error', message: 'boom', retryable: false } };
        },
      },
    });
    const client = new JsonRpcConnection({ channel: pair.a, requestTimeoutMs: 1_000 });
    client.start();
    const result = (await client.request('tools/call', { name: 'echo', arguments: {}, _meta: META._meta })) as {
      isError: boolean;
      content: { text: string }[];
    };
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('boom');
    await client.close();
    await server.close();
    await pair.close();
  });

  it('answers an unknown tool with -32602 and does not call the executor', async () => {
    const r = await rig();
    await expect(r.client.request('tools/call', { name: 'nope', arguments: {}, _meta: META._meta })).rejects.toMatchObject({ code: -32602 });
    expect(r.executor.calls).toHaveLength(0);
    await r.dispose();
  });

  it('answers an unknown method with -32601', async () => {
    const r = await rig();
    await expect(r.client.request('does/not/exist', { _meta: META._meta })).rejects.toMatchObject({ code: -32601 });
    await r.dispose();
  });
});

describe('mcp server · MRTR', () => {
  it('round-trips input_required and echoes requestState verbatim', async () => {
    const r = await rig({ requireInputOnce: true });

    const first = (await r.client.request('tools/call', { name: 'echo', arguments: { text: 'hi' }, _meta: META._meta })) as {
      resultType: string;
      requestState: string;
      inputRequests: { id: string }[];
    };
    expect(first.resultType).toBe('input_required');
    expect(typeof first.requestState).toBe('string');
    expect(first.inputRequests).toHaveLength(1);

    // The retry MUST echo the exact token.
    const second = (await r.client.request('tools/call', {
      name: 'echo',
      arguments: { text: 'hi' },
      requestState: first.requestState,
      inputResponses: { q1: 'yes' },
      _meta: META._meta,
    })) as { resultType: string; structuredContent: unknown };
    expect(second.resultType).toBe('complete');
    expect(second.structuredContent).toEqual({ echoed: { text: 'hi' } });
    // The executor saw the answers.
    expect(r.executor.calls[1]).toMatchObject({ inputResponses: { q1: 'yes' } });
    await r.dispose();
  });

  it('fails closed with the requestStateInvalid code on a tampered requestState', async () => {
    const r = await rig({ requireInputOnce: true });
    const first = (await r.client.request('tools/call', { name: 'echo', arguments: {}, _meta: META._meta })) as { requestState: string };
    await expect(
      r.client.request('tools/call', { name: 'echo', arguments: {}, requestState: `${first.requestState}-tampered`, _meta: META._meta }),
    ).rejects.toMatchObject({ code: MCP_ERROR_CODES.requestStateInvalid });
    expect(r.executor.calls).toHaveLength(1);
    await r.dispose();
  });

  it('fails closed with the requestStateInvalid code when requestState was never issued', async () => {
    const r = await rig();
    await expect(
      r.client.request('tools/call', { name: 'echo', arguments: {}, requestState: 'never-issued', _meta: META._meta }),
    ).rejects.toMatchObject({ code: MCP_ERROR_CODES.requestStateInvalid });
    expect(r.executor.calls).toHaveLength(0);
    await r.dispose();
  });

  it('rejects a replayed requestState (single use)', async () => {
    const r = await rig({ requireInputOnce: true });
    const first = (await r.client.request('tools/call', { name: 'echo', arguments: {}, _meta: META._meta })) as { requestState: string };
    await r.client.request('tools/call', { name: 'echo', arguments: {}, requestState: first.requestState, inputResponses: {}, _meta: META._meta });
    await expect(
      r.client.request('tools/call', { name: 'echo', arguments: {}, requestState: first.requestState, inputResponses: {}, _meta: META._meta }),
    ).rejects.toMatchObject({ code: MCP_ERROR_CODES.requestStateInvalid });
    await r.dispose();
  });
});

describe('mcp server · legacy era', () => {
  it('serves the legacy initialize handshake when allowed', async () => {
    const r = await rig({ allowLegacyClients: true });
    const result = (await r.client.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'old', version: '1' },
    })) as Record<string, unknown>;
    expect(result['protocolVersion']).toBe(MCP_PROTOCOL_VERSION);
    expect(result['serverInfo']).toBeTruthy();
    await r.dispose();
  });

  it('answers initialize with -32601 when the legacy era is disabled', async () => {
    const r = await rig();
    await expect(r.client.request('initialize', {})).rejects.toMatchObject({ code: -32601 });
    await r.dispose();
  });
});

describe('mcp server · Streamable HTTP headers (04 M13)', () => {
  it('builds the mandatory headers from the body', () => {
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'echo' } });
    const headers = buildMcpHttpHeaders(body, { protocolVersion: MCP_PROTOCOL_VERSION });
    expect(headers[MCP_HEADER_PROTOCOL_VERSION]).toBe(MCP_PROTOCOL_VERSION);
    expect(headers[MCP_HEADER_METHOD]).toBe('tools/call');
    expect(headers[MCP_HEADER_NAME]).toBe('echo');
  });

  it('accepts a matching header set', () => {
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'echo' } });
    const headers = buildMcpHttpHeaders(body, { protocolVersion: MCP_PROTOCOL_VERSION });
    expect(checkMcpHttpHeaders(headers, body).ok).toBe(true);
  });

  it('answers 400 + -32020 on a method mismatch', () => {
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'echo' } });
    const headers = { ...buildMcpHttpHeaders(body, { protocolVersion: MCP_PROTOCOL_VERSION }), [MCP_HEADER_METHOD]: 'tools/list' };
    const check = checkMcpHttpHeaders(headers, body);
    expect(check.ok).toBe(false);
    expect(check.status).toBe(400);
    expect(check.code).toBe(MCP_HEADER_MISMATCH_CODE);
    expect(check.code).toBe(-32020);
  });

  it('answers 400 + -32020 on a name or version mismatch', () => {
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'echo' } });
    const base = buildMcpHttpHeaders(body, { protocolVersion: MCP_PROTOCOL_VERSION });

    const badName = checkMcpHttpHeaders({ ...base, [MCP_HEADER_NAME]: 'other' }, body);
    expect(badName).toMatchObject({ ok: false, status: 400, code: -32020 });

    const badVersion = checkMcpHttpHeaders({ ...base, [MCP_HEADER_PROTOCOL_VERSION]: '2024-11-05' }, body);
    expect(badVersion).toMatchObject({ ok: false, status: 400, code: -32020 });
  });

  it('exposes the guard on the server so a host cannot skip it', () => {
    const pair = createLoopbackPair();
    const runtime = createFakeRuntime();
    const server = new McpServer({ runtime, channel: pair.b, serverId: SERVER_ID, tools: TOOLS, executor: executor() });
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    expect(server.checkHttpRequest(buildMcpHttpHeaders(body), body).ok).toBe(true);
    expect(server.checkHttpRequest({ [MCP_HEADER_METHOD]: 'tools/call', [MCP_HEADER_PROTOCOL_VERSION]: MCP_PROTOCOL_VERSION }, body)).toMatchObject({
      ok: false,
      code: -32020,
    });
    void pair.close();
  });
});

describe('mcp · OAuth 2.1 / PRM is declared unsupported (04 M20)', () => {
  it('marks an HTTP edge lossy and fails closed on a 401', async () => {
    const runtime = createFakeRuntime({
      http: async () => ({
        status: 401,
        headers: { 'www-authenticate': 'Bearer resource_metadata="https://peer/.well-known/oauth-protected-resource"' },
        async text() {
          return 'unauthorized';
        },
      }),
    });
    const { createHttpMcpAdapter } = await import('../src/mcp/index.js');
    const adapter = createHttpMcpAdapter({ runtime, serverId: SERVER_ID, url: 'https://peer.example/mcp' });

    expect(adapter.capabilities().lossy).toContain(MCP_LOSSY.oauthUnsupported);

    const payload = await adapter.invoke(
      {
        invocationId: 'inv_1',
        taskId: 'task_1',
        sessionId: 'ses_1',
        tenantId: 'ten_1',
        capability: {
          id: 'mcp://srv/tool/echo',
          kind: 'tool',
          protocol: 'mcp',
          displayName: 'echo',
          risk: 'read',
          sideEffect: 'none',
          dataClass: 'internal',
          visibility: 'full',
          reversible: true,
          provider: { id: 'srv', protocol: 'mcp', endpoint: 'https://peer.example/mcp', trust: 'verified', health: 'healthy', ttlMs: 1000, lastSeenAt: 'now' },
        },
        endpoint: 'https://peer.example/mcp',
        input: {},
        inputHash: 'h',
        principal: { id: 'user:test', kind: 'user', tenantId: 'ten_1', scopes: [], trustTier: 'first_party' },
        protocol: 'mcp',
        direction: 'outbound',
        obligations: [],
        visibility: 'full',
      },
      buildContext({ runtime, deadlineMs: 5_000 }),
    );

    expect(payload.outcome).toBe('failed');
    expect(payload.error?.kind).toBe('unauthenticated');
    expect(payload.lossy).toContain(MCP_LOSSY.oauthUnsupported);
    await adapter.close();
  });
});

describe('mcp · McpClient against the real server', () => {
  it('discovers and calls through the typed client', async () => {
    const pair = createLoopbackPair();
    const runtime = createFakeRuntime();
    const server = new McpServer({ runtime, channel: pair.b, serverId: SERVER_ID, tools: TOOLS, executor: executor() });
    const client = new McpClient({ runtime, channel: pair.a, serverId: SERVER_ID });
    const capabilities = await client.discover();
    expect(capabilities.map((capability) => capability.id)).toContain('mcp://srv/tool/echo');
    const call = await client.callTool('echo', { text: 'yo' });
    expect(call.result.resultType).toBe('complete');
    await client.close();
    await server.close();
    await pair.close();
  });
});

// ── modern-era result envelope (found by real interop, not by self-tests) ──
//
// The official @modelcontextprotocol/client@2.4.0 rejected our server three
// times before it would connect: the HTTP body carried stdio Content-Length
// framing, list results lacked `resultType`, and list results lacked the
// `ttlMs`/`cacheScope` cache hints plus `inputSchema` on every tool. None of
// those were visible to a client that shared our own assumptions — which is
// exactly the point the v0.4 audit made about self-referential tests.

describe('mcp server · modern-era result envelope', () => {
  it('every list result carries resultType and the cache hints', async () => {
    const r = await rig();
    const tools = (await r.client.request('tools/list', { _meta: META._meta })) as Record<string, unknown>;
    expect(tools.resultType).toBe('complete');
    expect(typeof tools.ttlMs).toBe('number');
    expect(typeof tools.cacheScope).toBe('string');

    const resources = (await r.client.request('resources/list', { _meta: META._meta })) as Record<string, unknown>;
    expect(resources.resultType).toBe('complete');
    expect(typeof resources.ttlMs).toBe('number');

    const prompts = (await r.client.request('prompts/list', { _meta: META._meta })) as Record<string, unknown>;
    expect(prompts.resultType).toBe('complete');
    expect(typeof prompts.ttlMs).toBe('number');
    await r.dispose();
  });

  it('every published tool carries an inputSchema object', async () => {
    const r = await rig();
    const tools = (await r.client.request('tools/list', { _meta: META._meta })) as {
      tools: { name: string; inputSchema?: unknown }[];
    };
    expect(tools.tools.length).toBeGreaterThan(0);
    for (const tool of tools.tools) {
      expect({ name: tool.name, hasSchema: typeof tool.inputSchema === 'object' }).toEqual({
        name: tool.name,
        hasSchema: true,
      });
    }
    await r.dispose();
  });
});
