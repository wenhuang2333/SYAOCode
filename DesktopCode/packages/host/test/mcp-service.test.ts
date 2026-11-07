/**
 * MCP 客户端服务（FR-N-001 / TC-N-017 / TC-N-020 / TC-N-021 等价断言）。
 *
 * 用**本地假 MCP 服务**（子进程跑一个 node 脚本，最小 JSON-RPC over stdio，
 * Content-Length 分帧）验证真实链路：add → tools/list → tools/call → remove。
 *
 * 假服务脚本写在 `os.tmpdir()` 里（不入库、不污染仓库），测试结束即删。
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Tool, ToolContext, ToolOutput } from '@syaocode/core';
import { nodeRuntime } from '@syaocode/node';
import { McpService } from '../src/mcp-service.ts';

/** 最小 MCP 服务：server/discover + tools/list + tools/call。 */
const FAKE_MCP_SOURCE = `
'use strict';

const TOOLS = [
  {
    name: 'echo',
    description: '回显传入的文本',
    inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'write_note',
    description: '记录一条笔记',
    inputSchema: { type: 'object', properties: { note: { type: 'string' } } },
  },
  {
    name: 'read_secret_env',
    description: '读取声明的环境变量',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'always_fail',
    description: '总是返回失败',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'crash',
    description: '响应后退出进程',
    inputSchema: { type: 'object', properties: {} },
  },
];

function send(message) {
  const body = Buffer.from(JSON.stringify(message), 'utf8');
  process.stdout.write('Content-Length: ' + body.length + '\\r\\n\\r\\n');
  process.stdout.write(body);
}

function ok(id, result) {
  send({ jsonrpc: '2.0', id: id, result: result });
}

function fail(id, code, message) {
  send({ jsonrpc: '2.0', id: id, error: { code: code, message: message } });
}

function handle(message) {
  const id = message.id;
  if (id === undefined) return;
  const method = message.method;
  const params = message.params || {};
  if (method === 'server/discover') {
    return ok(id, {
      supportedVersions: ['2026-07-28'],
      capabilities: { tools: { listChanged: false } },
      ttlMs: 300000,
      cacheScope: 'private',
      serverInfo: { name: 'fake-mcp', version: '0.0.1' },
    });
  }
  if (method === 'tools/list') {
    return ok(id, { ttlMs: 300000, cacheScope: 'private', tools: TOOLS });
  }
  if (method === 'tools/call') {
    const name = params.name;
    const args = params.arguments || {};
    if (name === 'echo') return ok(id, { content: [{ type: 'text', text: 'echo:' + String(args.text === undefined ? '' : args.text) }] });
    if (name === 'write_note') return ok(id, { content: [{ type: 'text', text: 'noted:' + String(args.note === undefined ? '' : args.note) }] });
    if (name === 'read_secret_env') return ok(id, { content: [{ type: 'text', text: 'env:' + String(process.env.FAKE_MCP_TOKEN || '') }] });
    if (name === 'always_fail') return ok(id, { isError: true, content: [{ type: 'text', text: '工具内部失败' }] });
    if (name === 'crash') {
      ok(id, { content: [{ type: 'text', text: 'bye' }] });
      setTimeout(function () { process.exit(7); }, 30);
      return undefined;
    }
    return fail(id, -32602, 'unknown tool: ' + name);
  }
  return fail(id, -32601, 'method not found: ' + method);
}

let buffer = Buffer.alloc(0);
process.stdin.on('data', function (chunk) {
  buffer = Buffer.concat([buffer, chunk]);
  for (;;) {
    const sep = buffer.indexOf('\\r\\n\\r\\n');
    if (sep === -1) return;
    const header = buffer.slice(0, sep).toString('ascii');
    const match = /content-length:\\s*(\\d+)/i.exec(header);
    if (match === null) {
      buffer = buffer.slice(sep + 4);
      continue;
    }
    const length = Number(match[1]);
    if (buffer.length < sep + 4 + length) return;
    const body = buffer.slice(sep + 4, sep + 4 + length).toString('utf8');
    buffer = buffer.slice(sep + 4 + length);
    handle(JSON.parse(body));
  }
});
process.stdin.on('end', function () { process.exit(0); });
`;

const SECRET = 'top-secret-value';

let scriptDir = '';
let scriptPath = '';
const services: McpService[] = [];

beforeAll(async () => {
  scriptDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fake-mcp-'));
  scriptPath = path.join(scriptDir, 'fake-mcp.mjs');
  await fs.writeFile(scriptPath, FAKE_MCP_SOURCE, 'utf8');
});

afterAll(async () => {
  if (scriptDir !== '') await fs.rm(scriptDir, { recursive: true, force: true });
});

afterEach(async () => {
  for (const service of services.splice(0)) await service.close();
});

function newService(onChanged?: (serverId: string, status: string) => void): McpService {
  const service = new McpService({
    runtime: nodeRuntime(),
    env: { PATH: process.env.PATH ?? '', FAKE_MCP_TOKEN: SECRET },
    ...(onChanged === undefined ? {} : { onChanged: (serverId, status) => onChanged(serverId, status) }),
  });
  services.push(service);
  return service;
}

function toolContext(): ToolContext {
  return {
    runtime: nodeRuntime(),
    cwd: process.cwd(),
    signal: new AbortController().signal,
    progress: () => undefined,
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('等待条件超时');
}

/** MCP 工具一律返回一次性输出（不是流式生成器）。 */
async function callTool(tool: Tool | undefined, input: unknown): Promise<ToolOutput> {
  if (tool === undefined) throw new Error('工具不存在');
  const result = await tool.execute(input, toolContext());
  if (!('content' in result)) throw new Error('MCP 工具不应返回流式结果');
  return result;
}

describe('MCP 客户端服务', () => {
  it('未受信服务不启动、工具与重启都被拒（mcp_not_trusted）', async () => {
    const service = newService();
    const added = await service.add({
      name: 'fake',
      command: process.execPath,
      args: [scriptPath],
      trusted: false,
    });
    expect(added.server.trusted).toBe(false);
    expect(added.server.status).toBe('stopped');
    expect(added.server.toolCount).toBe(0);
    expect(service.list()).toHaveLength(1);
    // 未受信服务不产生任何可调用工具
    expect(service.toolDefinitions()).toEqual([]);
    await expect(service.tools(added.server.id)).rejects.toMatchObject({ kind: 'mcp_not_trusted' });
    await expect(service.restart(added.server.id)).rejects.toMatchObject({ kind: 'mcp_not_trusted' });
  }, 20_000);

  it('受信服务：add → 工具清单 → 工具定义可执行 → remove 后消失（TC-N-020）', async () => {
    const service = newService();
    const { server } = await service.add({
      name: 'fake',
      command: process.execPath,
      args: [scriptPath],
      trusted: true,
    });
    expect(server.status).toBe('ready');
    expect(server.transport).toBe('stdio');
    expect(server.toolCount).toBeGreaterThan(0);

    const listed = await service.tools(server.id);
    expect(listed.serverId).toBe(server.id);
    expect(listed.tools.map((tool) => tool.name)).toContain('echo');
    const echo = listed.tools.find((tool) => tool.name === 'echo');
    expect(echo?.readOnly).toBe(true);
    expect(echo?.description).toBe('回显传入的文本');
    expect(echo?.inputSchemaSummary).toContain('text');
    const writeNote = listed.tools.find((tool) => tool.name === 'write_note');
    expect(writeNote?.readOnly).toBe(false);

    const definitions = service.toolDefinitions();
    const echoTool = definitions.find((tool) => tool.name === `mcp__${server.id}__echo`);
    expect(echoTool).toBeDefined();
    expect(echoTool?.risk).toBe('read');
    expect(echoTool?.readOnly).toBe(true);
    expect(echoTool?.trust).toBe('untrusted');
    const writeTool = definitions.find((tool) => tool.name === `mcp__${server.id}__write_note`);
    expect(writeTool?.risk).toBe('write');
    expect(writeTool?.readOnly).toBe(false);

    const output = await callTool(echoTool, { text: '你好' });
    expect(output?.isError).toBeFalsy();
    expect(output?.content[0]).toEqual({ type: 'text', text: 'echo:你好' });

    await service.remove(server.id);
    expect(service.list()).toEqual([]);
    expect(service.toolDefinitions()).toEqual([]);
  }, 20_000);

  it('工具失败返回 isError，而不是抛未处理异常', async () => {
    const service = newService();
    const { server } = await service.add({ command: process.execPath, args: [scriptPath], trusted: true });
    const failTool = service.toolDefinitions().find((tool) => tool.name === `mcp__${server.id}__always_fail`);
    expect(failTool).toBeDefined();
    const output = await callTool(failTool, {});
    expect(output?.isError).toBe(true);
    expect(output?.content[0]).toEqual({ type: 'text', text: '工具内部失败' });
  }, 20_000);

  it('env 只允许变量名：值取自 Host 环境，值不出现在状态里（TC-N-017）', async () => {
    const service = newService();
    const { server } = await service.add({
      command: process.execPath,
      args: [scriptPath],
      trusted: true,
      envNames: ['FAKE_MCP_TOKEN'],
    });
    expect(server.status).toBe('ready');
    const envTool = service.toolDefinitions().find((tool) => tool.name === `mcp__${server.id}__read_secret_env`);
    const output = await callTool(envTool, {});
    expect(output?.content[0]).toEqual({ type: 'text', text: `env:${SECRET}` });
    // 状态与列表里只有变量名，绝没有值
    expect(JSON.stringify(service.list())).not.toContain(SECRET);
    // 变量名本身也必须合法
    await expect(
      service.add({ command: process.execPath, args: [scriptPath], trusted: true, envNames: ['TOKEN=abc'] }),
    ).rejects.toMatchObject({ kind: 'mcp_spawn_failed' });
  }, 20_000);

  it('stdio 命令不允许 shell 元字符；http 只允许 http/https', async () => {
    const service = newService();
    await expect(service.add({ command: 'node; rm -rf /', trusted: true })).rejects.toMatchObject({ kind: 'mcp_spawn_failed' });
    await expect(service.add({ command: 'node && echo', trusted: true })).rejects.toMatchObject({ kind: 'mcp_spawn_failed' });
    await expect(service.add({ command: '  ', trusted: true })).rejects.toMatchObject({ kind: 'mcp_spawn_failed' });
    await expect(service.add({ url: 'file:///etc/passwd', trusted: true })).rejects.toMatchObject({ kind: 'mcp_spawn_failed' });
    await expect(service.add({ trusted: true })).rejects.toMatchObject({ kind: 'mcp_spawn_failed' });
    expect(service.list()).toEqual([]);
  }, 20_000);

  it('进程崩溃：状态变 error、可重启，Host 不崩（TC-N-021）', async () => {
    const changes: { id: string; status: string }[] = [];
    const service = newService((serverId, status) => {
      changes.push({ id: serverId, status });
    });
    const { server } = await service.add({ command: process.execPath, args: [scriptPath], trusted: true });
    expect(server.status).toBe('ready');
    const crashTool = service.toolDefinitions().find((tool) => tool.name === `mcp__${server.id}__crash`);
    expect(crashTool).toBeDefined();
    await callTool(crashTool, {});

    await waitFor(() => service.list().some((item) => item.id === server.id && item.status === 'error'));
    const broken = service.list().find((item) => item.id === server.id);
    expect(broken?.status).toBe('error');
    expect(broken?.toolCount).toBe(0);
    expect(broken?.detail).toBeTruthy();
    expect(changes.some((change) => change.status === 'error')).toBe(true);
    // 崩溃后工具定义不再提供该服务的工具
    expect(service.toolDefinitions()).toEqual([]);

    const restarted = await service.restart(server.id);
    expect(restarted.status).toBe('ready');
    expect(restarted.toolCount).toBeGreaterThan(0);
    expect(service.toolDefinitions().some((tool) => tool.name === `mcp__${server.id}__echo`)).toBe(true);
  }, 30_000);

  it('未知服务 id 报 mcp_unavailable', async () => {
    const service = newService();
    await expect(service.tools('nope')).rejects.toMatchObject({ kind: 'mcp_unavailable' });
    await expect(service.remove('nope')).rejects.toMatchObject({ kind: 'mcp_unavailable' });
    await expect(service.restart('nope')).rejects.toMatchObject({ kind: 'mcp_unavailable' });
  }, 20_000);
});
