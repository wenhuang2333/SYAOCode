import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { costDataOf, costPanel } from '../src/views';
import { emptyUsage, readWorkspaceUsage, recordUsage, usageFilePath } from '../src/usage-store';

/**
 * 工作区维度用量账本：/cost 输出的是该工作区**跨会话**累计（按 provider:model
 * 分模型），不再是本次会话。账本位于 ~/.syaocode/usage/<hash>.json，以工作区
 * 绝对路径为索引；损坏按空账本处理。
 */

const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');

describe('工作区用量账本', () => {
  let home: string;
  let wsA: string;
  let wsB: string;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'syao-usage-'));
    wsA = path.join(home, 'project-a');
    wsB = path.join(home, 'project-b');
  });
  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('首次记账创建账本文件并写入总量 + 分模型明细', () => {
    const ws = recordUsage(
      wsA,
      { provider: 'deepseek', model: 'deepseek-chat' },
      { inputTokens: 1000, outputTokens: 200, cacheReadTokens: 300 },
      0.01,
      { home },
    );
    expect(ws.totals).toEqual({
      requests: 1,
      inputTokens: 1000,
      outputTokens: 200,
      cacheReadTokens: 300,
      cacheWriteTokens: 0,
      costUsd: 0.01,
    });
    expect(Object.keys(ws.models)).toEqual(['deepseek:deepseek-chat']);
    expect(ws.models['deepseek:deepseek-chat']!.provider).toBe('deepseek');

    const raw = JSON.parse(fs.readFileSync(usageFilePath(wsA, home), 'utf8')) as {
      v: number;
      workspaces: Record<string, { workspace: string; totals: { inputTokens: number } }>;
    };
    expect(raw.v).toBe(1);
    expect(raw.workspaces[wsA]!.workspace).toBe(wsA);
    expect(raw.workspaces[wsA]!.totals.inputTokens).toBe(1000);
  });

  it('跨会话累计：再次记账累加，且按模型分开统计', () => {
    const first = { inputTokens: 100, outputTokens: 10 };
    recordUsage(wsA, { provider: 'deepseek', model: 'deepseek-chat' }, first, 0.001, { home });
    recordUsage(wsA, { provider: 'deepseek', model: 'deepseek-chat' }, { inputTokens: 200, outputTokens: 20 }, 0.002, { home });
    const ws = recordUsage(wsA, { provider: '@team', model: 'gpt-4o' }, { inputTokens: 400, outputTokens: 40 }, 0.02, { home });

    expect(ws.totals.requests).toBe(3);
    expect(ws.totals.inputTokens).toBe(700);
    expect(ws.totals.outputTokens).toBe(70);
    expect(ws.totals.costUsd).toBeCloseTo(0.023, 6);
    expect(ws.models['deepseek:deepseek-chat']!.requests).toBe(2);
    expect(ws.models['deepseek:deepseek-chat']!.inputTokens).toBe(300);
    expect(ws.models['@team:gpt-4o']!.requests).toBe(1);

    // 重新读取（等价于下次启动）：累计值仍在
    expect(readWorkspaceUsage(wsA, home)).toEqual(ws);
  });

  it('不同工作区各自独立记账', () => {
    recordUsage(wsA, { provider: 'mock', model: 'default' }, { inputTokens: 50, outputTokens: 5 }, undefined, { home });
    expect(readWorkspaceUsage(wsB, home).totals.requests).toBe(0);
    expect(readWorkspaceUsage(wsA, home).totals.requests).toBe(1);
  });

  it('-p 一次运行的多次请求按 requests 计数', () => {
    const ws = recordUsage(wsA, { provider: 'mock', model: 'default' }, { inputTokens: 30, outputTokens: 3 }, undefined, {
      requests: 3,
      home,
    });
    expect(ws.totals.requests).toBe(3);
    expect(ws.models['mock:default']!.requests).toBe(3);
  });

  it('未提供定价时费用为 0，且不影响 token 累计', () => {
    const ws = recordUsage(wsA, { provider: 'mock', model: 'default' }, { inputTokens: 10, outputTokens: 1 }, undefined, { home });
    expect(ws.totals.costUsd).toBe(0);
    expect(ws.totals.inputTokens).toBe(10);
  });

  it('账本损坏时按空账本处理，并可重新建立', () => {
    const file = usageFilePath(wsA, home);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{ not json at all');
    expect(readWorkspaceUsage(wsA, home).totals.requests).toBe(0);

    const ws = recordUsage(wsA, { provider: 'mock', model: 'default' }, { inputTokens: 7, outputTokens: 1 }, undefined, { home });
    expect(ws.totals.requests).toBe(1);
    expect(() => JSON.parse(fs.readFileSync(file, 'utf8'))).not.toThrow();
  });

  it('写入为原子替换：目录中不留 .tmp 残留', () => {
    recordUsage(wsA, { provider: 'mock', model: 'default' }, { inputTokens: 1, outputTokens: 1 }, undefined, { home });
    const dir = path.dirname(usageFilePath(wsA, home));
    expect(fs.readdirSync(dir).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });

  it('costDataOf + costPanel：工作区路径 / 分模型表 / 本次会话', () => {
    const ws = recordUsage(
      wsA,
      { provider: 'deepseek', model: 'deepseek-chat' },
      { inputTokens: 1000, outputTokens: 200, cacheReadTokens: 300 },
      0.01,
      { home },
    );
    const data = costDataOf(ws, { requests: 1, inputTokens: 40, outputTokens: 8, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.0004 }, usageFilePath(wsA, home));
    expect(data.workspace).toBe(wsA);
    expect(data.models.map((m) => m.label)).toEqual(['deepseek:deepseek-chat']);

    const text = costPanel(data).map(strip).join('\n');
    expect(text).toContain('project-a');
    expect(text).toContain('deepseek:deepseek-chat');
    expect(text).toContain('$0.0100');
    expect(text.toLowerCase()).toContain('workspace total');
    expect(text.toLowerCase()).toContain('this session');
  });

  it('过长工作区路径保留尾部（面板宽度不溢出）', () => {
    const long = `/very/long/prefix/${'x'.repeat(80)}/project-z`;
    const data = costDataOf(
      { workspace: long, createdAt: 1, updatedAt: 1, totals: emptyUsage(), models: {} },
      { requests: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 },
      '/x/y.json',
    );
    const text = costPanel(data).map(strip).join('\n');
    expect(text).toContain('…');
    expect(text).toContain('project-z');
    expect(text).not.toContain(long);
  });

  it('分模型行按总 token 降序', () => {
    recordUsage(wsA, { provider: 'mock', model: 'small' }, { inputTokens: 10, outputTokens: 1 }, undefined, { home });
    const ws = recordUsage(wsA, { provider: 'deepseek', model: 'big' }, { inputTokens: 9000, outputTokens: 500 }, undefined, { home });
    const data = costDataOf(ws, { requests: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 }, usageFilePath(wsA, home));
    expect(data.models.map((m) => m.label)).toEqual(['deepseek:big', 'mock:small']);
  });

  it('空账本：/cost 显示尚无记录而非报错', () => {
    const data = costDataOf(readWorkspaceUsage(wsB, home), { requests: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 }, usageFilePath(wsB, home));
    const text = costPanel(data).map(strip).join('\n');
    expect(text).toContain('project-b');
    expect(text.toLowerCase()).toContain('no usage recorded yet');
  });
});
