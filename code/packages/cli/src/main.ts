#!/usr/bin/env node
import { rulesFromConfig, SyaoError } from '@syaocode/core';
import { nodeRuntime } from '@syaocode/node';
import { usageText, parseArgs, UsageError } from './args.js';
import { EXIT_OK, EXIT_USAGE, runPrint } from './run.js';
import { formatDoctor, runDoctor } from './doctor.js';
import { runInteractive } from './interactive.js';
import { runTui } from './tui/tui.js';
import { activateAgentGroup, loadSecretsIntoEnv, savedLanguage } from './model-config.js';
import { setLanguage, t } from './i18n/index.js';
import { loadCliConfig } from './effective-config.js';
import { runVerifyInit } from './verify-command.js';
import { createCliFabric, type CliFabric } from './arf.js';
import { createArgvApprovalPresenter, runCallArgv, runMcpArgv, runRpcArgv, runServeArgv } from './rpc-command.js';
import { EXIT } from '@syaocode/rpc';

export const VERSION = 'syao v0.2.0-dev (SYAOCode trusted foundation + Evidence MVP)';

/** Wait for the stdout/stderr pipes to drain before an explicit exit. */
async function flushOutput(): Promise<void> {
  const streams = [process.stdout, process.stderr];
  await Promise.all(
    streams.map(
      (s) =>
        new Promise<void>((resolve) => {
          if (s.writableLength === 0) {
            resolve();
            return;
          }
          s.once('drain', () => resolve());
        }),
    ),
  );
}

async function main(argv: string[]): Promise<number> {
  // Merge ~/.syaocode/env (0600) into process env first — never overrides
  // real env vars; secrets never reach sessions or logs (BR-023/FR-121).
  loadSecretsIntoEnv();
  // 语言必须在任何输出前确定：配置文件 > 默认英语（/language 写入，下次启动生效）
  setLanguage(savedLanguage());

  let args;
  try {
    args = parseArgs(argv);
  } catch (e) {
    if (e instanceof UsageError) {
      process.stderr.write(`${e.message}\n\n${usageText()}`);
      return EXIT_USAGE;
    }
    throw e;
  }

  if (args.command === 'version') {
    process.stdout.write(`${VERSION}\n`);
    return EXIT_OK;
  }
  if (args.command === 'help') {
    process.stdout.write(usageText());
    return EXIT_OK;
  }
  if (args.command === 'doctor') {
    const checks = runDoctor(args.cwd ?? process.cwd());
    process.stdout.write(`${formatDoctor(checks)}\n`);
    return checks.some((c) => c.status === 'fail') ? EXIT_USAGE : EXIT_OK;
  }
  if (args.command === 'verify') {
    return runVerifyInit(args);
  }
  if (args.command === 'config') {
    const runtime = nodeRuntime();
    const config = await loadCliConfig(args, runtime);
    if (args.configSub === 'path') {
      process.stdout.write(`user:    ${process.env.HOME ?? ''}/.syaocode/config.json\n`);
      process.stdout.write(`project: ${args.cwd ?? process.cwd()}/.syaocode/config.json\n`);
      return EXIT_OK;
    }
    if (args.configSub === 'get') {
      const key = args.positional[1];
      if (key === undefined) {
        process.stderr.write(`${t('config.requiresKey')}\n`);
        return EXIT_USAGE;
      }
      const value = (config as unknown as Record<string, unknown>)[key];
      process.stdout.write(`${value === undefined ? '(unset)' : JSON.stringify(value)}\n`);
      return EXIT_OK;
    }
    process.stdout.write(`${JSON.stringify(config, null, 2)}\n`);
    return EXIT_OK;
  }

  // ── ARF governance surface (v0.3): rpc / call / mcp / serve ──────────────
  // These never enter the agent loop: each builds (or reuses) the process
  // fabric, runs one command and exits with the kernel's exit code.
  if (
    args.command === 'rpc' ||
    args.command === 'call' ||
    args.command === 'mcp' ||
    args.command === 'serve'
  ) {
    const config = await loadCliConfig(args, nodeRuntime());
    let cliRef: CliFabric | undefined;
    const cli = createCliFabric({
      cwd: args.cwd ?? process.cwd(),
      permissionMode: config.permissionMode,
      rules: rulesFromConfig(config),
      ...(config.limits.maxBudgetUsd !== undefined ? { maxBudgetUsd: config.limits.maxBudgetUsd } : {}),
      presentApproval: async (record) => {
        await createArgvApprovalPresenter(() => cliRef, io)(record);
      },
    });
    cliRef = cli;
    const io = {
      out: (text: string) => process.stdout.write(text),
      err: (text: string) => process.stderr.write(text),
    };
    try {
      const code =
        args.command === 'rpc' ? await runRpcArgv(args, cli, io)
        : args.command === 'call' ? await runCallArgv(args, cli, io)
        : args.command === 'mcp' ? await runMcpArgv(args, cli, io)
        : await runServeArgv(args, cli, io);
      // The kernel keeps a five-minute approval timer alive after a decision,
      // and a mounted MCP edge keeps a child pipe open: neither may hold the
      // shell open after the command is done, so the argv path exits itself.
      await cli.dispose();
      await flushOutput();
      process.exit(code);
    } catch (e) {
      await cli.dispose();
      throw e;
    }
  }

  // --agents <name>: 激活已保存的 agent 群（common 角色作为执行模型）
  if (args.agents !== undefined && args.model === undefined) {
    const res = activateAgentGroup(args.agents);
    if (!res.ok) {
      process.stderr.write(`warning: agent group '${args.agents}' not found (SY-CLI-001). Run /set-agents after entering syao.\n`);
    }
  }

  // agent run
  const prompt = args.positional.join(' ');
  if (!args.print) {
    // TTY（交互终端）→ TUI：启动粒子动画 + 常驻输入界面（FR-137/TUI）；
    // 非 TTY（管道）→ readline REPL：无动画、权限按无人值守策略拒绝（BR-042）。
    const isTTY = process.stdin.isTTY === true && process.stdout.isTTY === true;
    if (isTTY) {
      return runTui({ args, ...(prompt !== '' ? { initialPrompt: prompt } : {}) });
    }
    return runInteractive({ args, ...(prompt !== '' ? { initialPrompt: prompt } : {}) });
  }
  if (prompt === '') {
    process.stderr.write(`${t('args.promptRequired')}\n`);
    return EXIT_USAGE;
  }
  return runPrint(args, prompt);
}

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((e) => {
    if (SyaoError.is(e)) {
      process.stderr.write(`fatal: ${e.code} ${e.message}\n`);
      process.exitCode = e.code === 'SY-CFG-001' || e.code === 'SY-CFG-002' ? 2 : 1;
    } else {
      process.stderr.write(`fatal: ${e instanceof Error ? e.message : String(e)}\n`);
      process.exitCode = 1;
    }
  });
