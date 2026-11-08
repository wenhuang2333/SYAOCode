/**
 * 真实模型 / 真实窗口验证脚本的**契约**（执行在 `scripts/verify-real-*.mjs`）。
 *
 * 这些脚本平时不跑（要密钥、要联网），所以这里守住它们的性质，
 * 免得哪天它们变成"永远跳过、永远说 OK"的空壳：
 *
 *  1. 缺密钥 / 缺 Playwright / 缺构建产物时**跳过**并说明，绝不打印通过；
 *  2. 密钥**只从环境变量读**，脚本里不出现任何硬编码密钥；
 *  3. 断言的是**真实**证据（真实回复内容、确实经历过流式），
 *     不是"请求没报错"；
 *  4. 真实端点会多返回 `reasoning_content` —— 思维链必须单独成行，
 *     这一条是 mock 覆盖不到的，必须在脚本里显式检查。
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (rel: string): string => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');
const model = read('../../scripts/verify-real-model.mjs');
const window_ = read('../../scripts/verify-real-window.mjs');
const both = model + window_;

describe('真实模型验证脚本', () => {
  it('缺环境变量时跳过并说明，不伪装通过', () => {
    expect(model).toContain('SKIP: set REAL_API_KEY, REAL_BASE_URL and REAL_MODEL');
    expect(model).toContain('process.exit(0)');
    expect(model).toContain('REAL MODEL: OK');
  });

  it('密钥只从环境变量读，脚本里没有任何硬编码密钥', () => {
    expect(model).toContain("process.env['REAL_API_KEY']");
    // 形如 sk- 的密钥字面量绝不能出现在脚本里。
    expect(both).not.toMatch(/sk-[A-Za-z0-9_-]{12,}/);
  });

  it('断言的是真实内容，不是"没报错"', () => {
    expect(model).toContain("assistant?.text?.trim() === 'PONG'");
    // 必须确认这一轮**确实经历过流式**，否则一次性返回也算通过。
    expect(model).toContain('sawStreaming');
    expect(model).toContain('这一轮确实经历了流式');
  });

  it('思维链必须单独成行（真实端点才有，mock 覆盖不到）', () => {
    expect(model).toContain("r.kind === 'thinking'");
    expect(model).toContain('推理内容单独成行（不混进正文）');
    expect(window_).toContain('推理内容没有混进正文');
  });

  it('等一轮结束看 runState，而不是 ACK（ACK 只说明命令被接受）', () => {
    expect(model).toContain("snap?.runState === 'idle'");
    expect(model).toContain("snap?.runState === 'streaming'");
  });
});

describe('真实窗口验证脚本', () => {
  it('缺 Playwright / Electron / 构建产物时跳过', () => {
    expect(window_).toContain('SKIP: playwright not installed');
    expect(window_).toContain('SKIP: electron binary not found');
    expect(window_).toContain('SKIP: apps/desktop/dist/main/index.js missing');
  });

  it('用 SYAOCODE_HOME（Host 只认这个变量名），不是 SYAO_HOME', () => {
    // 写成 SYAO_HOME 时 Host 会回退到 os.homedir()/.syaocode，
    // 于是读到另一份配置——这个坑真实踩过。
    expect(window_).toContain('SYAOCODE_HOME: home');
    expect(window_).not.toContain('SYAO_HOME: home');
  });

  it('配置在启动前持久化，用的是同一份 HOME 与工作区', () => {
    expect(window_).toContain('seedConfiguration');
    expect(window_).toContain("'config/set'");
    expect(window_).toContain("'channel/save'");
    // 工作区必须与 Electron 启动时一致（= apps/desktop）。
    expect(window_).toContain('const workspace = APP;');
  });

  it('在真实窗口里做真实交互，不是只截图', () => {
    expect(window_).toContain('page.locator');
    expect(window_).toContain('真实回复出现在时间线上');
    expect(window_).toContain('结束后不再显示流式指示');
  });
});
