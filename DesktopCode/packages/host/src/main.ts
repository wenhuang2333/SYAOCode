#!/usr/bin/env node
/**
 * `syao host` —— 独立启动 DHP Host。
 *
 * 这是 Host 进程的**唯一**入口。两个调用方：
 *  1. Electron 壳（`utilityProcess` 拉起，`ELECTRON_RUN_AS_NODE=1`）
 *  2. 开发时的"纯 Host 模式"（`pnpm dev:host`）——调试 DHP 协议最方便的方式
 *
 * 生命周期（`00-基线` §6.3）：
 *   启动 → 监听 → ready 帧 → 运行 → shutdown 帧 → flush → 退出
 *
 * 启动失败必须**大声失败**：stderr 尾部会被壳采集并展示给用户。
 */

import { createHost } from '@syaocode/host';

interface HostArgs {
  readonly port: number;
  readonly host: string;
  readonly workspaceRoot: string;
  readonly token: string | undefined;
}

function parseArgs(argv: readonly string[]): HostArgs {
  let port = 0;
  let host = '127.0.0.1';
  let workspaceRoot = process.cwd();
  let token: string | undefined;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = (): string => {
      const v = argv[i + 1];
      if (v === undefined) throw new Error(`missing value for ${arg}`);
      i += 1;
      return v;
    };
    switch (arg) {
      case '--port':
        port = Number.parseInt(next(), 10);
        break;
      case '--host':
        host = next();
        break;
      case '--cwd':
        workspaceRoot = next();
        break;
      case '--token':
        token = next();
        break;
      case '--help':
      case '-h':
        process.stdout.write(
          'Usage: syao-host [--host 127.0.0.1] [--port 0] [--cwd <dir>] [--token <hex>]\n',
        );
        process.exit(0);
        break;
      default:
        if (arg !== undefined && arg.startsWith('--')) {
          throw new Error(`unknown option: ${arg}`);
        }
    }
  }
  return { port, host, workspaceRoot, token };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  const running = await createHost({
    host: args.host,
    port: args.port,
    workspaceRoot: args.workspaceRoot,
    ...(args.token !== undefined ? { token: args.token } : {}),
    exitOnShutdown: true,
  });

  // `ready` 帧是壳判定"Host 就绪"的**唯一**依据（不轮询 HTTP）。
  process.send?.({
    type: 'ready',
    url: running.server.url,
    port: running.server.port,
    token: running.server.token,
    workspaceRoot: running.workspace.workspaceRoot,
  } as unknown as Record<string, unknown>);

  console.log(
    `[host] ready url=${running.server.url} workspace=${running.workspace.workspaceRoot}`,
  );

  const shutdown = async (): Promise<void> => {
    try {
      await running.close();
    } finally {
      process.send?.({ type: 'shutdown-complete' } as unknown as Record<string, unknown>);
      process.exit(0);
    }
  };

  // 壳发来的 shutdown 帧。
  process.on('message', (msg: unknown) => {
    const m = msg as { type?: string };
    if (m?.type === 'shutdown') void shutdown();
  });

  // 父进程消失 → 自行退出（防孤儿进程）。
  process.on('disconnect', () => {
    void running.close().finally(() => process.exit(0));
  });

  for (const sig of ['SIGTERM', 'SIGINT'] as const) {
    process.on(sig, () => {
      void shutdown();
    });
  }
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  // 致命错误走 stderr；壳会采集尾部并展示。
  console.error(`[host] fatal: ${message}`);
  process.send?.({ type: 'fatal', message } as unknown as Record<string, unknown>);
  process.exit(1);
});
