#!/usr/bin/env node
/**
 * 启动 Electron 桌面应用（需先 `pnpm build`）。
 *
 * 关键：**必须**清掉 `ELECTRON_RUN_AS_NODE`。
 * 若该变量在环境里，`electron .` 会以纯 Node 模式运行，
 * `require('electron')` 返回 undefined，应用"双击没反应"却不报错。
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.resolve(here, '../apps/desktop');
const electronBin = path.resolve(here, '../node_modules/.bin/electron');

const env = { ...process.env };
delete env['ELECTRON_RUN_AS_NODE'];

const child = spawn(electronBin, ['.'], { cwd: appDir, stdio: 'inherit', env });
child.on('exit', (code) => process.exit(code ?? 0));
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => child.kill(sig));
