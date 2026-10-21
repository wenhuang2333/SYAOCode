import { describe, expect, it } from 'vitest';
import { bar, badge, kv, panel, section, table } from '../src/tui/panel';
import { costPanel, doctorPanel, modelPanel, permissionsPanel, statusPanel, toolsPanel } from '../src/views';

const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');

describe('tui/panel 通用面板', () => {
  it('panel：圆角边框、等宽、标题居中、超宽内容截断', () => {
    const lines = panel('demo', ['hello', 'a'.repeat(200)], { maxWidth: 40 });
    const plain = lines.map(strip);
    expect(plain[0]!.startsWith('╭')).toBe(true);
    expect(plain[plain.length - 1]!.startsWith('╰')).toBe(true);
    const w = plain[0]!.length;
    for (const l of plain) expect(l.length).toBe(w);
    expect(plain[0]).toContain('demo');
    expect(w).toBeLessThanOrEqual(40);
  });

  it('table：列宽按显示宽度对齐、分隔线、行尾不留空白', () => {
    const lines = table(['name', 'value'], [['a', '中文'], ['longer', 'x']]);
    const plain = lines.map(strip);
    // 分隔线长度 = 各列宽 + 间隔
    expect(plain[1]!.startsWith('─')).toBe(true);
    // 数据行按列对齐：'a' 与 'longer' 后第二列起点相同
    const col2 = (row: string) => row.indexOf('中文') >= 0 ? row.indexOf('中文') : row.indexOf('x');
    expect(col2(plain[2]!)).toBe(col2(plain[3]!));
  });

  it('bar / badge / kv / section 输出可见文本', () => {
    expect(strip(bar(0.5, 10))).toBe('█████░░░░░');
    expect(strip(bar(2, 4))).toBe('████'); // clamp
    expect(strip(badge('strict', 196))).toContain('strict');
    expect(strip(kv('model', 'mock:default'))).toContain('mock:default');
    expect(strip(section('usage'))).toContain('USAGE');
  });
});

describe('views 信息面板', () => {
  it('statusPanel：会话/进度/上下文条', () => {
    const lines = statusPanel({
      sessionId: 'ses-1',
      model: 'mock:default',
      mode: 'strict',
      tier: '严格档',
      activeGroup: 'cheap',
      turns: 3,
      historyCount: 7,
      contextTokens: 640,
      contextWindow: 128_000,
      requests: 2,
      inputTokens: 100,
      outputTokens: 40,
    });
    const text = lines.map(strip).join('\n');
    expect(text).toContain('ses-1');
    expect(text).toContain('@cheap');
    expect(text).toContain('turns');
    expect(text).toContain('context');
  });

  it('costPanel：工作区累计 + 按模型 + 本次会话', () => {
    const text = costPanel({
      workspace: '/tmp/ws',
      since: 1_700_000_000_000,
      file: '/home/u/.syaocode/usage/123.json',
      totals: { requests: 5, inputTokens: 1000, outputTokens: 500, cacheReadTokens: 2000, cacheWriteTokens: 0, costUsd: 0.0123 },
      models: [
        {
          label: 'deepseek:deepseek-chat',
          requests: 5,
          inputTokens: 1000,
          outputTokens: 500,
          cacheReadTokens: 2000,
          cacheWriteTokens: 0,
          costUsd: 0.0123,
        },
      ],
      session: { requests: 2, inputTokens: 400, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.002 },
    })
      .map(strip)
      .join('\n');
    expect(text).toContain('/tmp/ws');
    expect(text).toContain('deepseek:deepseek-chat');
    expect(text).toContain('$0.0123');
    expect(text).toContain('input');
    expect(text).toContain('output');
    expect(text.toLowerCase()).toContain('this session');
  });

  it('toolsPanel / permissionsPanel / doctorPanel', () => {
    const tools = toolsPanel([{ name: 'read', risk: 'read', readOnly: true, concurrencySafe: true }]).map(strip).join('\n');
    expect(tools).toContain('read');
    expect(tools).toContain('yes');
    const perms = permissionsPanel('default', '部分权限', [{ effect: 'deny', tool: 'bash' }]).map(strip).join('\n');
    expect(perms).toContain('deny');
    expect(perms).toContain('bash');
    const doc = doctorPanel([
      { name: 'node', status: 'ok', detail: 'v22' },
      { name: 'keys', status: 'fail', detail: 'missing' },
    ]).map(strip).join('\n');
    expect(doc).toContain('node');
    expect(doc.toLowerCase()).toContain('1 check(s) failed');
  });

  it('modelPanel：当前模型 + 内置 + 档案 + agent 群三段', () => {
    const text = modelPanel({
      current: 'mock:default',
      activeGroup: 'cheap',
      catalog: [{ id: 'mock', label: 'Mock', models: ['default'], keySet: true }],
      profiles: [{ name: 'myprov', protocol: 'OpenAI ChatCompletion', model: 'm1', keySet: true }],
      groups: [{ name: 'cheap', hyaki: 'mock:default', sota: 'mock:default', common: 'mock:default' }],
    })
      .map(strip)
      .join('\n');
    expect(text).toContain('mock:default');
    expect(text).toContain('@myprov');
    expect(text).toContain('@cheap');
    expect(text).toContain('hyaki');
  });
});
