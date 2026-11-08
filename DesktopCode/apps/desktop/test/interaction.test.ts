/**
 * 真实窗口交互的**契约**（执行在 `scripts/verify-interaction.mjs`）。
 *
 * 这里守的是"交互验证本身可信"：
 *  - 断言的是 DOM 真实状态（`<html data-theme>`、焦点、受控值回流），
 *    不是"点了没报错"；
 *  - 输入走 React 的 onChange 回流，而不是 Playwright 的按键注入
 *    （无头 Electron 里按键不产生字符，那是驱动限制，必须写清楚）；
 *  - 主题档位会持久化，断言不能依赖"重跑时的初始档位"；
 *  - 缺 Playwright / Electron 时跳过且不打印通过。
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (rel: string): string => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');
const script = read('../../scripts/verify-interaction.mjs');
const useHook = read('src/renderer/use-workbench.ts');

describe('交互验证脚本', () => {
  it('断言真实 DOM 状态，而不是"操作没抛错"', () => {
    expect(script).toContain('document.documentElement.dataset.theme');
    expect(script).toContain("document.activeElement");
    expect(script).toContain('INTERACTION: OK');
  });

  it('先建会话再测输入：没有会话时输入区是禁用的（正确行为）', () => {
    // 会话存在前 textarea disabled；直接测输入会得到"点不动"，那是误判。
    expect(script).toContain('能新建会话');
    const createIdx = script.indexOf('能新建会话');
    const focusIdx = script.indexOf('输入区可获得焦点');
    expect(createIdx).toBeGreaterThan(-1);
    expect(focusIdx).toBeGreaterThan(createIdx);
  });

  it('输入验证走 React onChange 回流，并写明为何不用 keyboard.type', () => {
    expect(script).toContain('dispatchEvent(new Event(\'input\'');
    expect(script).toContain('无头 Electron');
    expect(script).not.toMatch(/keyboard\.type\(/);
  });

  it('主题断言不依赖重跑时的初始档位（偏好会持久化）', () => {
    expect(script).toContain('按钮标签与实际生效主题一致');
    // 必须按"是否进入深色"循环，而不是固定点几次。
    expect(script).toContain("includes('深色')");
  });

  it('缺 Playwright / Electron 时跳过并说明，不伪装通过', () => {
    expect(script).toContain('SKIP: playwright not installed');
    expect(script).toContain('SKIP: electron binary not found');
    expect(script).toContain('INTERACTION: OK');
  });

  it('用隔离 HOME，避免污染真实用户数据', () => {
    expect(script).toContain('mkdtemp');
    expect(script).toMatch(/HOME:\s*home/);
  });
});

describe('流式对话的真实窗口验证（N-18）', () => {
  it('用 mock 渠道跑完整闭环：不需要密钥、不联网', () => {
    // 这条检查覆盖"输入 → 发送 → Host 跑一轮 → 事件回流 → 渲染"，
    // 静态渲染测试完全覆盖不到。
    expect(script).toContain('流式对话：用户消息进入时间线');
    expect(script).toContain('流式对话：助手回复渲染到时间线');
    expect(script).toContain('流式对话：结束后不再显示流式指示');
    // 必须是 mock 渠道（离线剧本），否则会依赖真实厂商密钥。
    expect(script).toContain('mock');
  });

  it('断言真实 DOM：用户行 / 助手行 / 流式指示消失', () => {
    expect(script).toContain('.msg-user');
    expect(script).toContain('.msg-assistant .content');
    expect(script).toContain('.streaming-dot');
  });

  it('保留成功路径截图，便于人眼复核真实界面', () => {
    expect(script).toContain('liwen-interaction.png');
    expect(script).toContain('截图');
  });
});

describe('桌面端默认语言的取舍（避免中英混排）', () => {
  it('只有用户显式选过语言才跟随 config，否则用桌面默认值', () => {
    // 内核默认 en，而桌面文案绝大多数仍是中文：直接跟随会得到混排界面。
    expect(useHook).toContain('DESKTOP_DEFAULT_LANGUAGE');
    expect(useHook).toMatch(/sources\['language'\]\s*!==\s*'default'/);
  });
});
