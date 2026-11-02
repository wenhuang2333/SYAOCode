#!/usr/bin/env node
/**
 * 启动 Electron 桌面应用（需先 `pnpm build`）。
 *
 * 关键 1：**必须**清掉 `ELECTRON_RUN_AS_NODE`。
 * 若该变量在环境里，`electron .` 会以纯 Node 模式运行，
 * `require('electron')` 返回 undefined，应用"双击没反应"却不报错。
 *
 * 关键 2：Electron 是 `apps/desktop` 的 devDependency，pnpm 的隔离 node_modules
 * 不会把它提升到工作区根的 `node_modules/.bin/electron`。旧版脚本硬编码了根路径，
 * 在干净安装的机器上必然 `spawn ... ENOENT`。这里按 pnpm 的真实布局逐级解析。
 */
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const appDir = path.resolve(root, 'apps/desktop');

/**
 * 解析 Electron 可执行文件（不是 node_modules/.bin 里的 shell 包装）。
 * 在纯 Node 中 `require('electron')` 会返回二进制绝对路径。
 */
function resolveElectronBin() {
  try {
    const req = createRequire(path.join(appDir, 'package.json'));
    const bin = req('electron');
    if (typeof bin === 'string' && existsSync(bin)) return bin;
  } catch {
    // 落到下面的候选路径
  }

  const candidates = [
    path.join(appDir, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'),
    path.join(appDir, 'node_modules/electron/dist/electron'),
    path.join(appDir, 'node_modules/.bin/electron'),
    path.join(root, 'node_modules/.bin/electron'),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }

  console.error(
    [
      '[dev:desktop] 找不到 Electron 可执行文件。',
      '',
      '通常是依赖没装全：pnpm ≥10 默认拦截 electron 的 postinstall，',
      '表现为 "pnpm install 成功退出但 Electron 二进制没下载"。',
      '',
      '修复：',
      '  cd DesktopCode && corepack pnpm install',
      '  若仍失败：node node_modules/.pnpm/electron@*/node_modules/electron/install.js',
      '            或 cd apps/desktop && corepack pnpm exec electron --version',
    ].join('\n'),
  );
  process.exit(1);
}

const electronBin = resolveElectronBin();

const env = { ...process.env };
delete env['ELECTRON_RUN_AS_NODE'];

const child = spawn(electronBin, ['.'], { cwd: appDir, stdio: 'inherit', env });
child.on('error', (err) => {
  console.error(`[dev:desktop] 启动 Electron 失败：${err.message}`);
  process.exit(1);
});
child.on('exit', (code) => process.exit(code ?? 0));
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => child.kill(sig));
