/**
 * 启动冒烟的**契约**（真实进程验证在 `scripts/smoke-electron.mjs`）。
 *
 * 这里守的是"冒烟本身不能说谎"：
 *  - 每项检查都必须来自日志里的正向证据，不能靠"进程没退出"推断；
 *  - 缺 Electron / 缺构建产物时必须跳过并说明，绝不打印 OK；
 *  - 正常启动路径不得带 `--headless-smoke` 的副作用。
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (rel: string): string => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');
const script = read('../../scripts/smoke-electron.mjs');
const main = read('src/main/index.ts');
const preload = read('src/preload/index.ts');
const renderer = read('src/renderer/use-workbench.ts');

describe('启动冒烟脚本', () => {
  it('覆盖 electron → host → dhp → renderer 的每一环，且都要求正向证据', () => {
    // 脚本里这些是**正则字面量**（方括号被转义），按源码形态断言。
    expect(script).toContain('host ready on port');
    expect(script).toContain('dhp: listening');
    expect(script).toContain('window ready-to-show');
    expect(script).toContain('dhp: connection open');
    expect(script).toContain('dhp: hello');
    expect(script).toContain('SMOKE:READY');
    // 六项检查缺一不可。
    expect(script.split('\n').filter((line) => /^\s+\['.*',\s*\/.*\/\],?$/.test(line)).length).toBe(6);
    // 退出码不能当通过条件。
    expect(script).toContain('SMOKE: OK');
    expect(script).toContain("failures === 0 ? 0 : 1");
  });

  it('必须跑在构建产物上，而不是 TS 源', () => {
    expect(script).toContain('dist/main/index.js');
    expect(script).toContain('pnpm build');
  });

  it('用隔离的 HOME，避免污染真实用户数据', () => {
    expect(script).toContain('mkdtemp');
    expect(script).toMatch(/HOME:\s*home/);
    expect(script).toContain('状态写入隔离 HOME');
  });

  it('清掉 ELECTRON_RUN_AS_NODE（否则应用会以纯 Node 模式静默失败）', () => {
    expect(script).toContain('delete env[');
    expect(script).toContain('ELECTRON_RUN_AS_NODE');
  });

  it('缺 Electron 或构建产物时跳过并说明，不伪装通过', () => {
    expect(script).toContain('SKIP: electron binary not found');
    expect(script).toContain('SKIP: apps/desktop/dist/main/index.js missing');
    const skips = script.split('process.exit(0)').length - 1;
    expect(skips).toBeGreaterThanOrEqual(2);
  });
});

describe('冒烟钩子不得影响正常启动', () => {
  it('主进程只在 --headless-smoke 时注册通道', () => {
    expect(main).toContain("process.argv.includes('--headless-smoke')");
    // 注册必须在该条件内：用花括号包住，不能裸写在函数体里。
    const idx = main.indexOf("process.argv.includes('--headless-smoke')");
    const after = main.slice(idx, idx + 400);
    expect(after).toContain("ipcMain.handle('smoke:renderer-ready'");
  });

  it('渲染层只在真正 ready 时回报，且忽略通道不存在', () => {
    expect(renderer).toMatch(/if \(s === 'ready'\) void window\.liwen\?\.smoke\?\.rendererReady\(\)\.catch/);
  });

  it('preload 只暴露 rendererReady 一个方法', () => {
    expect(preload).toContain("ipcRenderer.invoke('smoke:renderer-ready')");
    expect(preload).not.toMatch(/smoke:\s*\{[^}]*quit|smoke:\s*\{[^}]*exec/);
  });
});
