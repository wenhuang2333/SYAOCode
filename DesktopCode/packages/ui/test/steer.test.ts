/**
 * steer 的共享组件行为（`28-多轮steer行为契约` §5/§6）。
 *
 * 这里守三件事：
 *  1. 运行中提交 = 「作为补充指令排队」，且**等待审批时仍可排队**（审批不被绕过）；
 *  2. steer 行三种状态可区分、未注入**必须**显示原因，且不与普通 user 行混淆；
 *  3. 文案来自 `i18n`，共享组件不硬编码业务文案。
 *
 * 不引入 jsdom：用 `renderToStaticMarkup` 做静态标记断言（与既有测试同风格）。
 */

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { ProjectionRow, SteerRow } from '@liwencode/dhp';
import { Composer, canSubmitComposer } from '../src/composer.tsx';
import { Timeline, steerStateLabel } from '../src/timeline.tsx';
import { messages } from '../src/i18n.ts';

const zh = messages('zh');
const en = messages('en');

const steerRow = (overrides: Partial<SteerRow> = {}): SteerRow => ({
  kind: 'steer',
  key: 's:st-1',
  seq: 7,
  steerId: 'st-1',
  text: '顺便补一句：不要改 README。',
  state: 'queued',
  ...overrides,
});

describe('canSubmitComposer：运行中提交的闸门', () => {
  it('普通发送：等待审批时禁止提交', () => {
    expect(canSubmitComposer({ value: 'hi', awaitingApproval: true })).toBe(false);
  });

  it('steer：等待审批时**仍可**排队（排队不是批准，`28` §2 硬规则 3）', () => {
    expect(canSubmitComposer({ value: 'hi', awaitingApproval: true, steerMode: true })).toBe(true);
  });

  it('空文本 / 禁用 / 忙 时都不能提交', () => {
    expect(canSubmitComposer({ value: '   ' })).toBe(false);
    expect(canSubmitComposer({ value: 'hi', disabled: true })).toBe(false);
    expect(canSubmitComposer({ value: 'hi', busy: true })).toBe(false);
    expect(canSubmitComposer({ value: 'hi', steerMode: true, busy: true })).toBe(false);
  });
});

describe('Composer：运行中的按钮与占位必须表达"排队"', () => {
  const render = (steerMode: boolean, awaitingApproval = false, value = '补充指令'): string =>
    renderToStaticMarkup(createElement(Composer, {
      value,
      onChange: () => undefined,
      onSubmit: () => undefined,
      m: zh,
      steerMode,
      awaitingApproval,
      steerSubmitLabel: '作为补充指令排队',
      steerPlaceholder: '运行中：输入补充指令',
    }));

  it('steer 模式的按钮文案是"作为补充指令排队"，不是"发送"', () => {
    const html = render(true);
    expect(html).toContain('作为补充指令排队');
    expect(html).toContain('data-submit-mode="steer"');
    // 不能看起来像启动第二个并发执行：占位也必须是 steer 文案。
    expect(html).toContain('运行中：输入补充指令');
    expect(html).toContain('composer-steer');
  });

  it('send 模式仍是普通"发送"', () => {
    const html = render(false);
    expect(html).toContain(`>${zh.send}<`);
    expect(html).toContain('data-submit-mode="send"');
    expect(html).not.toContain('composer-steer');
  });

  it('等待审批时 steer 按钮仍可用（只显示待审批徽标）', () => {
    const html = render(true, true);
    const button = html.slice(html.indexOf('<button'), html.indexOf('</button>'));
    expect(button).not.toContain('disabled');
    expect(html).toContain('等待审批');
  });

  it('send 模式等待审批时按钮禁用（不能把审批当消息绕过）', () => {
    const html = render(false, true);
    const button = html.slice(html.indexOf('<button'), html.indexOf('</button>'));
    expect(button).toContain('disabled');
  });
});

describe('Timeline：steer 行三种状态', () => {
  const render = (rows: readonly ProjectionRow[]): string =>
    renderToStaticMarkup(createElement(Timeline, { rows, m: zh }));

  it('queued：显示"已排队"，与 user 消息区分', () => {
    const html = render([steerRow()]);
    expect(html).toContain('data-steer-state="queued"');
    expect(html).toContain('steer-queued');
    expect(html).toContain(zh.steerQueued);
    expect(html).toContain(zh.steerRow);
    // 不得伪装成普通用户消息。
    expect(html).not.toContain('msg-user');
    expect(html).not.toContain(`>${zh.you}<`);
  });

  it('consumed：显示"已注入"与被消费到的轮次', () => {
    const html = render([steerRow({ state: 'consumed', turn: 3 })]);
    expect(html).toContain('data-steer-state="consumed"');
    expect(html).toContain(zh.steerConsumedTurn.replace('{turn}', '3'));
  });

  it('notConsumed：必须显示原因', () => {
    const html = render([steerRow({ state: 'notConsumed', reason: 'aborted' })]);
    expect(html).toContain('data-steer-state="notConsumed"');
    expect(html).toContain(zh.steerNotConsumedReason.replace('{reason}', 'aborted'));
    expect(html).toContain('aborted');
  });

  it('notConsumed 且 Host 没给原因：不编造，显示"原因未知"', () => {
    const html = render([steerRow({ state: 'notConsumed' })]);
    expect(html).toContain(zh.steerNotConsumedUnknown);
  });

  it('steerStateLabel 是纯函数，三种状态互不相同', () => {
    const labels = new Set([
      steerStateLabel(zh, steerRow()),
      steerStateLabel(zh, steerRow({ state: 'consumed', turn: 1 })),
      steerStateLabel(zh, steerRow({ state: 'notConsumed', reason: 'timeout' })),
    ]);
    expect(labels.size).toBe(3);
  });

  it('同一列表里 steer 行不会切断其它行（顺序按投影）', () => {
    const rows: ProjectionRow[] = [
      { kind: 'message', key: 'm:1', seq: 1, role: 'user', text: '开始', final: true },
      steerRow({ seq: 2 }),
      { kind: 'message', key: 'm:3', seq: 3, role: 'assistant', text: '继续', final: true },
    ];
    const html = render(rows);
    expect(html.indexOf('开始')).toBeLessThan(html.indexOf(zh.steerRow));
    expect(html.indexOf(zh.steerRow)).toBeLessThan(html.indexOf('继续'));
  });
});

describe('steer 文案：中英对等且不硬编码在组件里', () => {
  it('三种状态与原因文案在 zh/en 都存在且不同', () => {
    for (const key of ['steerRow', 'steerQueued', 'steerConsumed', 'steerConsumedTurn', 'steerNotConsumedReason', 'steerNotConsumedUnknown'] as const) {
      expect(zh[key]).not.toBe('');
      expect(en[key]).not.toBe('');
    }
    expect(zh.steerQueued).not.toBe(en.steerQueued);
    expect(zh.steerNotConsumedUnknown).not.toBe(en.steerNotConsumedUnknown);
  });
});
