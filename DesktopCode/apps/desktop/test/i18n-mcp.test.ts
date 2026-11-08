/**
 * MCP 服务页文案目录（`27` FR-N-001）。
 *
 * 与其它三套目录同一套纪律，外加一条**安全性**纪律：
 * `trust.untrustedNotice` 是本页最重要的承诺——未受信服务**不会启动、不会把工具
 * 暴露给模型**。这句只能照着 Host 的实际行为写，不允许被"弱化"成"建议谨慎"。
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { mcpMessages, tm } from '../src/renderer/i18n-mcp.ts';

const PAGE = readFileSync(new URL('../src/renderer/mcp-page.tsx', import.meta.url), 'utf8');

const flatten = (value: unknown, prefix = ''): string[] => {
  if (typeof value === 'string') return [prefix];
  if (value === null || typeof value !== 'object') return [];
  return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) =>
    flatten(child, prefix === '' ? key : `${prefix}.${key}`));
};

describe('MCP 文案目录', () => {
  it('中英键集完全相同且都非空', () => {
    const zh = flatten(mcpMessages('zh')).sort();
    const en = flatten(mcpMessages('en')).sort();
    expect(zh.length).toBeGreaterThan(40);
    expect(en).toEqual(zh);
    for (const path of zh) {
      expect(tm('zh', `mcp.${path}`)).not.toBe('');
      expect(tm('en', `mcp.${path}`)).not.toBe('');
    }
  });

  it('未知键显式可见，插值缺参保留原样', () => {
    expect(tm('zh', 'mcp.nope.nope')).toBe('⟦mcp.nope.nope⟧');
    expect(tm('zh', 'mcp.error.envValueNotAllowed')).not.toContain('undefined');
  });

  it('五种服务状态都非空且互不相同（未知状态不假装是 idle）', () => {
    const statuses = ['idle', 'starting', 'ready', 'error', 'stopped', 'unknown'];
    const zh = statuses.map((key) => tm('zh', `mcp.status.${key}`));
    const en = statuses.map((key) => tm('en', `mcp.status.${key}`));
    expect(new Set(zh).size).toBe(statuses.length);
    expect(new Set(en).size).toBe(statuses.length);
    // 未知状态必须**独立**，不能复用 idle 的说法。
    expect(zh[5]).not.toBe(zh[0]);
    expect(en[5]).not.toBe(en[0]);
  });

  it('页面里不再有裸中文字面量', () => {
    const code = PAGE
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    const literals = code.match(/(['"`])(?:\\.|(?!\1)[^\\])*\1/g) ?? [];
    expect(literals.filter((literal) => /[\u4e00-\u9fa5]/.test(literal))).toEqual([]);
  });
});

describe('安全性承诺不能被弱化', () => {
  it('未受信服务的说明必须写明"不会启用"与"不暴露给模型"', () => {
    // Host 侧 `mcp-service.ts`：`trusted !== true` 的服务既不执行工具，
    // 也不出现在 `toolDefinitions()` 里（mcp_not_trusted）。
    const zh = tm('zh', 'mcp.trust.untrustedNotice');
    const en = tm('en', 'mcp.trust.untrustedNotice');
    expect(zh).toContain('不会');
    expect(zh).toContain('模型');
    expect(en.toLowerCase()).toContain('not');
    expect(en.toLowerCase()).toContain('model');
  });

  it('受信标记与未受信标记是相反的说法，不能是同一个词', () => {
    expect(tm('zh', 'mcp.trust.trusted')).not.toBe(tm('zh', 'mcp.trust.untrusted'));
    expect(tm('en', 'mcp.trust.trusted')).not.toBe(tm('en', 'mcp.trust.untrusted'));
  });

  it('环境变量只填名字：文案必须说明不回显值', () => {
    const zh = tm('zh', 'mcp.form.envNote');
    const en = tm('en', 'mcp.form.envNote');
    expect(zh).toContain('不回显');
    expect(en.toLowerCase()).toContain('never');
  });
});
