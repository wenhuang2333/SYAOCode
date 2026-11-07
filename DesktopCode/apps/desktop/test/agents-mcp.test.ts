/**
 * Agent 群 / MCP 服务两页（`27` FR-N-001 / FR-N-003）的界面契约测试。
 *
 * 与 `dashboard-pages.test.ts` 同一风格：纯函数 + `renderToStaticMarkup` 静态断言，
 * **不引入浏览器/Playwright**。
 */

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { AgentsListResult, McpServerInfo } from '@syaocode/dhp';
import {
  AGENT_EXECUTION_ROLE, AGENT_ROLE_LABELS, AgentsPage, agentRoleLabel, agentsSummary, createAgentDraft, modelBindingLabel, validateAgentDraft,
} from '../src/renderer/agents-page.tsx';
import {
  MCP_UNTRUSTED_NOTICE, McpPage, createMcpDraft, envNamesText, mcpLossyText, mcpStatusLabel, mcpToolCountText, mcpToolLabel, mcpTransportLabel,
  parseArgs, parseEnvNames, validateMcpDraft,
} from '../src/renderer/mcp-page.tsx';
import { WorkbenchView } from '../src/renderer/workbench.tsx';
import type { Workbench } from '../src/renderer/use-workbench.ts';

const agents: AgentsListResult = {
  active: 'default',
  groups: [
    { name: 'default', roles: { hyaki: 'provider:model-a', sota: 'provider:model-b', common: 'provider:model-c' }, active: true, createdAt: 1, updatedAt: 2 },
    { name: 'review', roles: { hyaki: 'provider:model-a', sota: 'provider:model-a', common: 'provider:model-b' }, active: false, createdAt: 1, updatedAt: 2 },
  ],
};

const server = (overrides: Partial<McpServerInfo> = {}): McpServerInfo => ({
  id: 'mcp-1', name: 'filesystem', transport: 'stdio', status: 'ready', toolCount: 3, lossy: [], trusted: true,
  detail: null, command: 'npx', url: null, updatedAt: 1, ...overrides,
});

describe('Agent 群：三角色与执行模型 common (TC-N-022)', () => {
  it('always reports the execution model from the common role', () => {
    expect(AGENT_EXECUTION_ROLE).toBe('common');
    expect(AGENT_ROLE_LABELS.common).toContain('common');
    expect(agentRoleLabel('common')).toBe('common · 执行验证');
    expect(agentsSummary(agents)).toBe('当前激活群：default · 执行模型（common）：provider:model-c');
    expect(agentsSummary(undefined)).toBe('尚未激活任何 Agent 群，当前按单 Agent 运行。');
    expect(agentsSummary({ groups: [], active: null })).toContain('尚未激活');
    expect(agentsSummary({ groups: [], active: 'gone' })).toContain('找不到该群配置');
  });
  it('validates name and 渠道:模型 bindings', () => {
    expect(validateAgentDraft(createAgentDraft()).ok).toBe(false);
    const errors = validateAgentDraft({ name: '', hyaki: '', sota: 'no-colon', common: '' });
    if (errors.ok) throw new Error('expected invalid draft');
    expect(errors.errors['name']).toBeDefined();
    expect(errors.errors['hyaki']).toBeDefined();
    expect(errors.errors['sota']).toBeDefined();
    expect(errors.errors['common']).toBeDefined();
    const valid = validateAgentDraft({ name: ' default ', hyaki: 'p:a', sota: 'p:b', common: 'p:c' });
    expect(valid.ok).toBe(true);
    if (valid.ok) {
      expect(valid.params.name).toBe('default');
      expect(valid.params.roles).toEqual({ hyaki: 'p:a', sota: 'p:b', common: 'p:c' });
    }
    const duplicate = validateAgentDraft({ name: 'default', hyaki: 'p:a', sota: 'p:b', common: 'p:c' }, { existing: ['default'] });
    expect(duplicate.ok).toBe(false);
  });
  it('renders groups, the active marker and the execution-model tag', () => {
    const html = renderToStaticMarkup(createElement(AgentsPage, {
      result: agents, channels: [], loading: false, error: '', busy: false,
      onSave: async () => { throw new Error('Rendering must not save'); },
      onDelete: async () => { throw new Error('Rendering must not delete'); },
      onActivate: async () => { throw new Error('Rendering must not activate'); },
    }));
    expect(html).toContain('default');
    expect(html).toContain('review');
    expect(html).toContain('当前激活');
    expect(html).toContain('执行模型');
    expect(html).toContain('provider:model-c');
    expect(html).toContain('hyaki · 提取摘要');
    expect(html).toContain('sota · 规划评审');
    expect(html).toContain('common · 执行验证');
  });
  it('renders an explicit empty state before any group exists', () => {
    const html = renderToStaticMarkup(createElement(AgentsPage, {
      result: { groups: [], active: null }, channels: [], loading: false, error: '', busy: false,
      onSave: async () => {}, onDelete: async () => {}, onActivate: async () => {},
    }));
    expect(html).toContain('尚未配置任何 Agent 群');
    expect(html).toContain('尚未激活任何 Agent 群');
  });
});

describe('MCP 服务：状态、工具数、lossy 与受信开关', () => {
  it('labels transport, status, tool count and lossy capabilities honestly', () => {
    expect(mcpTransportLabel('stdio')).toContain('stdio');
    expect(mcpTransportLabel('http')).toContain('http');
    expect(mcpStatusLabel('ready')).toBe('就绪');
    expect(mcpStatusLabel('error')).toBe('不可用');
    expect(mcpToolCountText(server())).toBe('3 个工具');
    expect(mcpToolCountText(server({ status: 'error', toolCount: 0 }))).toContain('未知');
    expect(mcpLossyText(server())).toBe('无已知能力损失');
    expect(mcpLossyText(server({ lossy: ['resources', 'prompts'] }))).toBe('能力损失：resources、prompts');
    expect(envNamesText(['HOME', 'GITHUB_TOKEN'])).toBe('环境变量名：HOME、GITHUB_TOKEN');
    expect(envNamesText([])).toBe('未声明环境变量');
    expect(mcpToolLabel({ name: 'read_file', description: '读取文件', inputSchemaSummary: '', readOnly: true })).toContain('只读');
  });
  it('parses args and env names, rejecting values instead of names', () => {
    expect(parseArgs('-y @modelcontextprotocol/server-filesystem "/tmp/a b"')).toEqual(['-y', '@modelcontextprotocol/server-filesystem', '/tmp/a b']);
    expect(parseEnvNames('HOME, GITHUB_TOKEN  PATH')).toEqual(['HOME', 'GITHUB_TOKEN', 'PATH']);
    const invalid = validateMcpDraft({ ...createMcpDraft(), command: 'npx', envNames: 'GITHUB_TOKEN=secret' });
    expect(invalid.ok).toBe(false);
    if (!invalid.ok) expect(invalid.errors['envNames']).toContain('只填写环境变量名');
  });
  it('validates stdio commands and http endpoints', () => {
    expect(validateMcpDraft({ ...createMcpDraft(), command: 'npx', args: '-y server' }).ok).toBe(true);
    expect(validateMcpDraft({ ...createMcpDraft(), command: '', args: '' }).ok).toBe(false);
    expect(validateMcpDraft({ ...createMcpDraft(), transport: 'http', url: 'http://example.com/mcp' }).ok).toBe(false);
    expect(validateMcpDraft({ ...createMcpDraft(), transport: 'http', url: 'http://localhost:3000/mcp' }).ok).toBe(true);
    expect(validateMcpDraft({ ...createMcpDraft(), transport: 'http', url: 'https://user:token@example.com/mcp' }).ok).toBe(false);
    expect(validateMcpDraft({ ...createMcpDraft(), transport: 'http', url: 'https://example.com/mcp' }).ok).toBe(true);
  });
  it('keeps only env variable names in the submitted params', () => {
    const result = validateMcpDraft({ ...createMcpDraft(), name: 'fs', command: 'npx', args: '-y fs', envNames: 'HOME', trusted: true });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.params).toEqual({ name: 'fs', trusted: true, command: 'npx', args: ['-y', 'fs'], envNames: ['HOME'] });
      expect(JSON.stringify(result.params)).not.toContain('HOME=');
    }
  });
  it('renders the list with an explicit untrusted warning', () => {
    const html = renderToStaticMarkup(createElement(McpPage, {
      servers: [server(), server({ id: 'mcp-2', name: 'remote', transport: 'http', trusted: false, url: 'https://example.com/mcp', status: 'stopped', toolCount: 0 })],
      loading: false, error: '', busy: false,
      onAdd: async () => { throw new Error('Rendering must not add'); },
      onRemove: async () => { throw new Error('Rendering must not remove'); },
      onRestart: async () => { throw new Error('Rendering must not restart'); },
      onTools: async () => { throw new Error('Rendering must not read tools'); },
    }));
    expect(html).toContain('filesystem');
    expect(html).toContain('remote');
    expect(html).toContain('未受信');
    expect(html).toContain(MCP_UNTRUSTED_NOTICE);
    expect(html).toContain('无已知能力损失');
    expect(html).toContain('3 个工具');
    expect(html).toContain('环境变量名（只填名字，值来自 Host 启动环境）');
    expect(html).toContain('添加 MCP 服务');
  });
  it('renders an explicit empty state with no servers', () => {
    const html = renderToStaticMarkup(createElement(McpPage, {
      servers: [], loading: false, error: '', busy: false,
      onAdd: async () => {}, onRemove: async () => {}, onRestart: async () => {}, onTools: async () => [],
    }));
    expect(html).toContain('尚未添加任何 MCP 服务');
  });
});

describe('workbench shell smoke render (no browser)', () => {
  it('renders the shell with the right column collapsed and the Git trigger present', () => {
    const values: Record<string, unknown> = {
      status: 'ready', error: '', page: 'chat', draft: '', sessionId: '', workspaceRoot: '/workspace',
      // 语言来自 Host 的 config/get；桩里给 zh，与默认行为一致。
      language: 'zh',
      snapshot: undefined, inspection: undefined, overview: undefined, loadingSession: false, mutating: false,
      query: { from: 0, to: 0 }, report: undefined, loadingUsage: false,
      gitStatus: undefined, gitBranches: undefined, gitGraph: undefined, gitRemotes: undefined, gitAuth: undefined,
      gitPreflight: undefined, gitUpload: undefined, gitDiff: undefined, gitError: '', gitLoading: false,
      mcpServers: [], mcpLoading: false, mcpError: '', agents: undefined, agentsLoading: false, agentsError: '',
    };
    const workbench = new Proxy(values, {
      get: (target, property) => (property in target ? target[property as string] : () => undefined),
    }) as unknown as Workbench;
    const html = renderToStaticMarkup(createElement(WorkbenchView, { w: workbench }));
    expect(html).toContain('aria-label="Git 侧栏，认证状态未知"');
    expect(html).toContain('aria-label="切换会话详情"');
    // 右栏默认收起：既不渲染 Git 侧栏，也不渲染会话详情。
    expect(html).not.toContain('aria-label="Git 侧栏"');
    expect(html).not.toContain('aria-label="会话详情"');
    expect(html).toContain('MCP 服务');
    expect(html).toContain('Agent 群');
  });
});
