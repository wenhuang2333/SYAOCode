import * as readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import {
  createAgent,
  estimateMessagesTokens,
  FileSessionStore,
  SyaoError,
  nodeRuntime,
  projectHashOf,
  Redactor,
  trimOldToolResults,
  type Agent,
  type AgentEvent,
  type PermissionDecision,
  type PermissionMode,
  type PermissionRequest,
  type PermissionRule,
  type Provider,
} from '@syaocode/core';
import { createBuiltinTools } from '@syaocode/tools';
import type { CliArgs } from './args.js';
import { resolvePermissionTier } from './args.js';
import { buildProvider, type ProviderSpec } from './provider-select.js';
import { helpText, parsePermissionArg, parseSlash, permissionModeShort, permissionTierPanel } from './slash.js';
import {
  catalogEntry,
  envFilePath,
  keyStatusOf,
  syaoHome,
  maskKey,
  PROVIDER_CATALOG,
  modelSpecLabel,
  providerLabel,
  readUserConfig,
  resolveDefaultModel,
  saveLanguage,
  writeEnvFile,
  writeUserConfig,
  parseEnvFile,
} from './model-config.js';
import { formatDoctor, runDoctor } from './doctor.js';
import { expandAtPaths, summarizeInput } from './prompt-utils.js';
import { buildCliContext } from './context.js';
import { costDataOf, costPanel } from './views.js';
import { readWorkspaceUsage, recordUsage, usageFilePath } from './usage-store.js';
import { getLanguage, isLang, languageName, t, type Lang } from './i18n/index.js';
import { userErrorMessage, userErrorText, userEventErrorText } from './error-text.js';

/**
 * Interactive REPL (FR-130 / FR-137 subset). Readline-based: streaming
 * rendering, terminal permission approval, @path expansion, !command shell
 * pass-through — every shell command still goes through the permission gate.
 */

const ANSI = {
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
};

export interface InteractiveOptions {
  args: CliArgs;
  initialPrompt?: string;
}

interface UsageTotals {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
  requests: number;
}

export async function runInteractive(opts: InteractiveOptions): Promise<number> {
  const cwd = opts.args.cwd ?? process.cwd();
  const runtime = nodeRuntime();
  const redactor = new Redactor();
  const sessionStore = new FileSessionStore(runtime, `${syaoHome()}/sessions`, String(projectHashOf(cwd)));
  const { tools } = createBuiltinTools();
  const usageTotals: UsageTotals = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costUsd: 0,
    requests: 0,
  };
  // 工作区跨会话用量账本（~/.syaocode/usage/<hash>.json），/cost 的数据源
  let workspaceUsage = readWorkspaceUsage(cwd);
  let usagePersistWarned = false;

  let spec: ProviderSpec = (() => {
    const resolved = resolveDefaultModel(opts.args.model);
    return { provider: resolved.provider, model: resolved.name };
  })();
  const tier = resolvePermissionTier(opts.args, readUserConfig().permissionMode);
  let permissionMode: PermissionMode = tier.mode;
  let pendingResume: string | undefined;
  const sessionRules: PermissionRule[] = [
    ...opts.args.allowedTools.map((tool) => ({ effect: 'allow' as const, tool, source: 'user' as const })),
    ...opts.args.disallowedTools.map((tool) => ({ effect: 'deny' as const, tool, source: 'user' as const })),
  ];

  const rl = readline.createInterface({ input, output, prompt: promptOf() });
  const isTTY = input.isTTY === true;
  let rlClosed = false;
  rl.on('close', () => {
    rlClosed = true;
  });
  const safePrompt = () => {
    if (!rlClosed) rl.prompt(true);
  };
  let lastSigint = 0;
  let activeAbort: AbortController | undefined;
  let agent = createCurrentAgent();

  function promptOf(): string {
    return ANSI.cyan(`syao (${modelSpecLabel(spec)}) ❯ `);
  }

  function createCurrentAgent(resumeSessionId?: string): Agent {
    const provider: Provider & { model: string } = buildProvider(spec);
    redactor.register(process.env.DEEPSEEK_API_KEY ?? '', 'deepseek-key');
    redactor.register(process.env.ANTHROPIC_API_KEY ?? '', 'anthropic-key');
    redactor.register(process.env.OPENAI_API_KEY ?? '', 'openai-key');
    const created = createAgent({
      provider,
      model: provider.model,
      cwd,
      context: buildCliContext(cwd),
      tools,
      permissionMode,
      rules: sessionRules,
      permissionHandler: terminalPermissionHandler,
      session: sessionStore,
      runtime,
      limits: {
        ...(opts.args.maxTurns !== undefined ? { maxTurns: opts.args.maxTurns } : {}),
        ...(opts.args.maxBudgetUsd !== undefined ? { maxBudgetUsd: opts.args.maxBudgetUsd } : {}),
      },
    });
    if (resumeSessionId !== undefined) {
      pendingResume = resumeSessionId;
    }
    return created;
  }

  async function terminalPermissionHandler(req: PermissionRequest): Promise<PermissionDecision> {
    const preview = previewOfRequest(req);
    if (!isTTY) {
      // Headless (piped stdin): BR-042 — ask resolves to deny, never block.
      output.write(ANSI.yellow(`${t('permission.headless', { preview })}\n`));
      return { decision: 'deny', message: 'Non-interactive session: approval unavailable (SY-CLI-002). Pre-approve via /permissions allow or --allowed-tools.' };
    }
    output.write(`\n${ANSI.yellow(t('permission.request'))} ${preview}\n`);
    rl.resume();
    if (rlClosed) return { decision: 'deny', message: t('permission.inputClosed') };
    const answer = (await rl.question(t('permission.prompt'))).trim().toLowerCase();
    rl.pause();
    if (answer === 'y') return { decision: 'allow' };
    if (answer === 's') return { decision: 'allow', remember: 'session' };
    return { decision: 'deny', message: t('permission.deniedByUser') };
  }

  function previewOfRequest(req: PermissionRequest): string {
    const s = req.subject;
    if (s.command !== undefined) return t('permission.subject.command', { tool: req.tool, command: ANSI.bold(s.command), risk: req.risk });
    if (s.path !== undefined) return t('permission.subject.path', { tool: req.tool, path: ANSI.bold(s.path), risk: req.risk });
    if (s.url !== undefined) return t('permission.subject.url', { tool: req.tool, url: ANSI.bold(s.url), risk: req.risk });
    return t('permission.subject.generic', { tool: req.tool, risk: req.risk });
  }

  // ── run one turn ───────────────────────────────────────────────────────

  async function runTurn(prompt: string): Promise<void> {
    const expanded = await expandAtPaths(prompt);
    activeAbort = new AbortController();
    rl.pause();
    const resumeId = pendingResume;
    pendingResume = undefined;
    let inText = false;
    try {
      const stream = agent.run(expanded, { signal: activeAbort.signal, ...(resumeId !== undefined ? { sessionId: resumeId } : {}) });
      for (;;) {
        const r = await stream.next();
        if (r.done) {
          const summary = r.value;
          if (summary.endReason !== 'completed' && summary.endReason !== 'aborted') {
            output.write(`\n${ANSI.yellow(t('error.turnEnded', { reason: summary.endReason }))}\n`);
          }
          break;
        }
        const ev = r.value;
        handleEvent(ev);
      }
    } catch (e) {
      output.write('\n');
      output.write(ANSI.red(`${userErrorText(e)}\n`));
    } finally {
      if (inText) output.write('\n');
      activeAbort = undefined;
      output.write('\n');
      rl.resume();
      rl.setPrompt(promptOf());
      safePrompt();
    }

    function handleEvent(ev: AgentEvent): void {
      switch (ev.type) {
        case 'text.delta':
          inText = true;
          output.write(ev.text);
          break;
        case 'tool.start':
          if (inText) {
            output.write('\n');
            inText = false;
          }
          output.write(ANSI.dim(`  ⚙ ${ev.name} ${summarizeInput(ev.input)}\n`));
          break;
        case 'tool.result': {
          const first = ev.content.find((c) => c.type === 'text');
          const text = first !== undefined && first.type === 'text' ? first.text : '';
          const oneline = text.split('\n').slice(0, 2).join(' ⏎ ').slice(0, 160);
          output.write(ev.isError ? ANSI.red(`  ✖ ${oneline}\n`) : ANSI.dim(`  ✔ ${oneline}\n`));
          break;
        }
        case 'usage': {
          usageTotals.inputTokens += ev.usage.inputTokens;
          usageTotals.outputTokens += ev.usage.outputTokens;
          usageTotals.cacheReadTokens += ev.usage.cacheReadTokens ?? 0;
          usageTotals.cacheWriteTokens += ev.usage.cacheWriteTokens ?? 0;
          usageTotals.requests += 1;
          if (ev.costUsd !== undefined) usageTotals.costUsd += ev.costUsd;
          // 记账到工作区账本（跨会话累计，按 provider:model 拆分）
          try {
            workspaceUsage = recordUsage(cwd, { provider: spec.provider, model: spec.model }, ev.usage, ev.costUsd);
          } catch (e) {
            if (!usagePersistWarned) {
              usagePersistWarned = true;
              output.write(
                ANSI.yellow(
                  `  ${t('cost.persistFailed', { detail: e instanceof Error ? e.message : String(e) })}\n`,
                ),
              );
            }
          }
          break;
        }
        case 'budget.warning':
          output.write(ANSI.yellow(`  ${t('error.budget', { pct: Math.round(ev.ratio * 100) })}\n`));
          break;
        case 'error':
          const msg = `${ev.error.code} ${userEventErrorText(ev.error.code, ev.error.message)}`;
          output.write(ev.fatal ? ANSI.red(`  ✖ ${msg}\n`) : ANSI.yellow(`  ⚠ ${msg}\n`));
          break;
        default:
          break;
      }
    }
  }

  function summarizeInput(input: unknown): string {
    const json = JSON.stringify(input ?? {});
    return json.length > 80 ? `${json.slice(0, 77)}…` : json;
  }

  /** @path expansion (FR-134): attach referenced file contents to the prompt. */
  async function expandAtPaths(prompt: string): Promise<string> {
    const refs = [...prompt.matchAll(/(?:^|\s)@([^\s]+)/g)].map((m) => m[1]!).slice(0, 8);
    if (refs.length === 0) return prompt;
    const parts: string[] = [prompt];
    for (const ref of refs) {
      const abs = ref.startsWith('/') ? ref : `${cwd}/${ref}`;
      try {
        const content = await runtime.fs.readFile(abs);
        const truncated = content.split('\n').slice(0, 500).join('\n');
        parts.push(`--- @${ref} ---\n${truncated}${content.split('\n').length > 500 ? `\n${t('repl.truncated')}` : ''}`);
      } catch {
        parts.push(`--- @${ref} --- ${t('repl.fileSkipped')}`);
      }
    }
    return parts.join('\n\n');
  }

  /** !command (FR-134): propose a shell command; still permission-gated. */
  async function runBangCommand(command: string): Promise<void> {
    const engine = agent.engine;
    const outcome = await engine.checkSubject('bash', 'exec', { command });
    if (outcome.outcome === 'deny') {
      output.write(ANSI.red(`${t('error.denied', { code: outcome.error.code, message: outcome.error.modelMessage ?? userEventErrorText(outcome.error.code, outcome.error.message) })}\n`));
      return;
    }
    const proc = runtime.shell.spawn('/bin/sh', ['-c', command], { cwd, timeoutMs: 60_000 });
    let out = '';
    const collect = async (s: AsyncIterable<string>) => {
      for await (const line of s) out += `${line}\n`;
    };
    const code = await Promise.all([proc.exited, collect(proc.stdout), collect(proc.stderr)]).then(([c]) => c);
    output.write(ANSI.dim(`${t('error.exitCode', { code })}\n${out.slice(0, 2000)}`));
  }

  // ── slash handlers ─────────────────────────────────────────────────────

  async function handleSlash(cmd: { name: string; args: string[] }): Promise<void> {
    switch (cmd.name) {
      case '/help':
        output.write(`${helpText(cmd.args[0])}\n`);
        return;
      case '/exit':
      case '/quit':
        throw new ExitRepl();
      case '/model':
        await cmdModel(cmd.args);
        return;
      case '/permission':
      case '/permissions':
        cmdPermissions(cmd.args, cmd.name);
        return;
      case '/status':
        cmdStatus();
        return;
      case '/cost':
        cmdCost();
        return;
      case '/tools':
        cmdTools();
        return;
      case '/compact':
        cmdCompact();
        return;
      case '/language':
        await cmdLanguage(cmd.args);
        return;
      case '/clear':
        agent = createCurrentAgent();
        output.write(ANSI.green(`${t('clear.done')}\n`));
        return;
      case '/resume':
        await cmdResume(cmd.args);
        return;
      case '/doctor':
        output.write(`${formatDoctor(runDoctor(cwd))}\n`);
        return;
      case '/setup':
      case '/manage':
        output.write(ANSI.yellow(`${t('config.tuiOnly', { cmd: cmd.name })}\n`));
        return;
      case '/agents':
      case '/mcp':
      case '/goal':
      case '/rewind': {
        const doc = {
          '/agents': t('milestone.agents'),
          '/mcp': t('milestone.mcp'),
          '/goal': t('milestone.goal'),
          '/rewind': t('milestone.rewind'),
        }[cmd.name];
        output.write(ANSI.yellow(`${t('milestone.placeholder', { cmd: cmd.name, doc })}\n`));
        return;
      }
      default:
        output.write(ANSI.yellow(`${t('config.unknownCommand', { cmd: cmd.name })}\n`));
        return;
    }
  }

  /** /language：切换 CLI 语言；写入配置后立即退出，下次启动生效 */
  async function cmdLanguage(args: string[]): Promise<void> {
    const raw = args[0]?.trim().toLowerCase();
    let target: Lang | undefined;
    if (raw !== undefined) {
      if (!isLang(raw)) {
        output.write(ANSI.yellow(`${t('language.invalid', { value: args[0] ?? '' })}\n`));
        return;
      }
      target = raw;
    } else if (isTTY) {
      output.write(`${t('language.current', { lang: languageName(getLanguage()) })}\n`);
      output.write(`${t('language.option1')}\n${t('language.option2')}\n`);
      const pick = (await rl.question(t('language.choose'))).trim().toLowerCase();
      target = pick === '2' || pick === 'zh' ? 'zh' : pick === '1' || pick === 'en' ? 'en' : undefined;
      if (target === undefined) {
        output.write(ANSI.yellow(`${t('language.invalid', { value: pick })}\n`));
        return;
      }
    } else {
      output.write(`${t('language.current', { lang: languageName(getLanguage()) })}\n${t('language.panelHint')}\n`);
      return;
    }
    if (target === getLanguage()) {
      output.write(`${t('language.already', { lang: languageName(target) })}\n`);
      return;
    }
    output.write(ANSI.yellow(`${t('language.warning')}\n`));
    const confirm = (await rl.question(t('language.confirm', { lang: languageName(target) }))).trim().toLowerCase();
    if (confirm !== 'y' && confirm !== 'yes') {
      output.write(`${t('language.cancelled')}\n`);
      return;
    }
    saveLanguage(target);
    output.write(ANSI.green(`${t('language.saved', { lang: languageName(target) })}\n`));
    throw new ExitRepl();
  }

  async function cmdModel(args: string[]): Promise<void> {
    const sub = args[0];
    if (sub === undefined || sub === 'show') {
      const entry = catalogEntry(spec.provider);
      const key = entry !== undefined && entry.apiKeyEnv !== undefined ? keyStatusOf(entry) : undefined;
      output.write(
        [
          t('model.current', { model: ANSI.bold(modelSpecLabel(spec)) }),
          entry !== undefined ? t('model.endpoint', { url: entry.baseUrl === '' ? t('common.offline') : entry.baseUrl }) : '',
          key !== undefined
            ? t('model.keyLine', {
                status: key.set
                  ? t('model.keySetSource', { env: entry?.apiKeyEnv ?? '', source: key.source === 'env-file' ? '~/.syaocode/env' : 'process env' })
                  : t('model.keyUnset', { env: entry?.apiKeyEnv ?? '' }),
              })
            : t('model.keyNotNeeded'),
          '',
          t('model.usageShort'),
        ].filter((l) => l !== '').join('\n') + '\n',
      );
      return;
    }
    if (sub === 'list') {
      const rows = PROVIDER_CATALOG.map((p) => {
        const key = p.apiKeyEnv !== undefined ? keyStatusOf(p) : { set: true, source: 'none' as const };
        return `  ${(p.id + ':' + p.models.join('|')).padEnd(44)} ${providerLabel(p)}  ${t('common.keySet', { mark: key.set ? ANSI.green(t('common.yesMark')) : ANSI.yellow(t('common.noMark')) })}`;
      });
      output.write(`${t('model.catalog')}\n${rows.join('\n')}\n${t('model.switchHint')}\n`);
      return;
    }
    if (sub === 'use') {
      const target = args[1];
      if (target === undefined || !target.includes(':')) {
        output.write(ANSI.yellow(`${t('model.useUsage')}\n`));
        return;
      }
      const [providerId, name] = target.split(':');
      const entry = catalogEntry(providerId ?? '');
      if (entry === undefined) {
        output.write(ANSI.red(`${t('model.unknownProvider', { provider: providerId ?? '' })}\n`));
        return;
      }
      if (entry.needsKey && !keyStatusOf(entry).set) {
        output.write(ANSI.yellow(`${t('model.needKey', { provider: providerId ?? '', env: entry.apiKeyEnv ?? '' })}\n`));
        return;
      }
      const previousProvider = spec.provider;
      const history = [...agent.history];
      spec = { provider: providerId ?? 'mock', model: name ?? 'default' };
      const previousMode = agent.engine.mode;
      permissionMode = previousMode;
      agent = createCurrentAgent();
      agent.engine.setMode(previousMode);
      const acrossMock = (previousProvider === 'mock') !== (spec.provider === 'mock');
      if (!acrossMock) agent.history.push(...history);
      writeUserConfig({ ...readUserConfig(), model: { provider: spec.provider, name: spec.model } });
      output.write(ANSI.green(`${t(acrossMock ? 'model.switchedFresh' : 'model.switched', { provider: spec.provider, model: spec.model })}\n`));
      return;
    }
    if (sub === 'config') {
      await cmdModelConfig(args[1]);
      return;
    }
    output.write(ANSI.yellow(`${t('model.usage')}\n`));
  }

  async function cmdModelConfig(providerId?: string): Promise<void> {
    if (!isTTY) {
      output.write(ANSI.yellow(`${t('config.replOnly')}\n`));
      return;
    }
    let entry = providerId !== undefined ? catalogEntry(providerId) : undefined;
    if (providerId !== undefined && entry === undefined) {
      output.write(ANSI.red(`${t('config.unknownProviderList', { provider: providerId, list: PROVIDER_CATALOG.map((p) => p.id).join(', ') })}\n`));
      return;
    }
    if (entry === undefined) {
      output.write(`${t('config.pickProvider')}\n`);
      PROVIDER_CATALOG.forEach((p, i) => output.write(`  ${i + 1}. ${p.id.padEnd(18)} ${providerLabel(p)}\n`));
      const pick = (await rl.question(t('config.indexPrompt'))).trim();
      entry = PROVIDER_CATALOG[Number(pick || '1') - 1] ?? PROVIDER_CATALOG[0]!;
    }
    if (entry === undefined) return;
    const models = entry.models;
    output.write(`${t('config.models', { models: models.join(' / ') })}\n`);
    const modelAnswer = (await rl.question(t('config.modelPrompt', { default: models[0] ?? '' }))).trim();
    const model = modelAnswer !== '' ? modelAnswer : models[0]!;
    let baseUrl = entry.baseUrl;
    if (entry.baseUrl !== '') {
      const urlAnswer = (await rl.question(t('config.baseUrlPrompt', { default: entry.baseUrl }))).trim();
      if (urlAnswer !== '') baseUrl = urlAnswer;
    }
    const config = readUserConfig();
    config.model = { provider: entry.id, name: model, ...(entry.apiKeyEnv !== undefined ? { apiKeyEnv: entry.apiKeyEnv } : {}) };
    if (baseUrl !== entry.baseUrl) config.model.baseUrl = baseUrl;
    writeUserConfig(config);

    if (entry.apiKeyEnv !== undefined) {
      const keyAnswer = (await rl.question(t('config.apiKeyPrompt'))).trim();
      if (keyAnswer !== '') {
        const existing = parseEnvFile(await readFileSafe(envFilePath()) ?? '');
        existing[entry.apiKeyEnv] = keyAnswer;
        writeEnvFile(existing);
        process.env[entry.apiKeyEnv] = keyAnswer;
        output.write(ANSI.green(`${t('config.keySaved', { masked: maskKey(keyAnswer) })}\n`));
      }
    }
    const previousProvider = spec.provider;
    spec = { provider: entry.id, model };
    const history = [...agent.history];
    const previousMode = agent.engine.mode;
    agent = createCurrentAgent();
    agent.engine.setMode(previousMode);
    if ((previousProvider === 'mock') === (entry.id === 'mock')) agent.history.push(...history);
    output.write(ANSI.green(`${t('config.done', { provider: entry.id, model })}\n`));
  }

  function cmdPermissions(args: string[], invokedAs = '/permissions'): void {
    if (args.length === 0) {
      const rules = sessionRules.length > 0
        ? sessionRules.map((r) => `  ${r.effect.padEnd(5)} ${r.tool}${r.match?.command !== undefined ? `  cmd=${r.match.command}` : ''}${r.match?.path !== undefined ? `  path=${r.match.path}` : ''}`).join('\n')
        : t('config.rulesNone');
      output.write(
        [
          t('config.permissionSummary', { mode: ANSI.bold(agent.engine.mode), tier: tierLabelOf(agent.engine.mode) }),
          ...permissionTierPanel(agent.engine.mode),
          t('config.rulesTitle'),
          rules,
          t('config.adjust', { invoked: invokedAs }),
        ].join('\n') + '\n',
      );
      return;
    }
    if (args[0] === 'mode') {
      const mode = args[1];
      if (mode !== 'strict' && mode !== 'default' && mode !== 'acceptEdits' && mode !== 'plan' && mode !== 'bypass') {
        output.write(ANSI.yellow(`${t('config.invalidMode')}\n`));
        return;
      }
      agent.engine.setMode(mode);
      permissionMode = mode;
      output.write(ANSI.green(`${t('config.modeSwitched', { mode })}\n`));
      return;
    }
    if ((args[0] === 'allow' || args[0] === 'deny') && args[1] !== undefined) {
      const rule: PermissionRule = { effect: args[0], tool: args[1], source: 'user' };
      sessionRules.push(rule);
      agent.engine.addRules([rule]);
      output.write(ANSI.green(`${t('config.ruleAdded', { effect: args[0] ?? '', tool: args[1] ?? '' })}\n`));
      return;
    }
    // 直接切换档位：/permission strict | YAO | SI（大小写不敏感）
    const tier = parsePermissionArg(args[0]!);
    if (tier !== null) {
      agent.engine.setMode(tier.mode);
      permissionMode = tier.mode;
      output.write(
        ANSI.green(t('tier.switched', { key: tier.key, label: permissionModeShort(tier.mode) })) +
          ANSI.dim(`${t('tier.sessionOnly')}\n`),
      );
      return;
    }
    output.write(ANSI.yellow(`${t('tier.usage', { invoked: invokedAs })}\n`));
  }

  function cmdStatus(): void {
    const contextTokens = estimateMessagesTokens(agent.history, agent.registry.definitions());
    const windowSize = safeContextWindow();
    const turns = agent.history.filter((m) => m.role === 'assistant').length;
    output.write(
      [
        t('repl.status.session', { id: agent.sessionId }),
        t('repl.status.model', { model: modelSpecLabel(spec) }),
        t('repl.status.mode', { mode: agent.engine.mode }),
        t('repl.status.turns', { turns, messages: agent.history.length }),
        t('repl.status.context', { used: contextTokens, window: windowSize, pct: ((contextTokens / windowSize) * 100).toFixed(1) }),
        t('repl.status.requests', { requests: usageTotals.requests, input: usageTotals.inputTokens, output: usageTotals.outputTokens }),
      ].join('\n') + '\n',
    );
  }

  function safeContextWindow(): number {
    try {
      return buildProvider(spec).capabilities(spec.model).contextWindow;
    } catch {
      return 128_000;
    }
  }

  function cmdCost(): void {
    output.write(`${costPanel(costDataOf(workspaceUsage, usageTotals, usageFilePath(cwd))).join('\n')}\n`);
  }

  function cmdTools(): void {
    const rows = agent.registry.list().map(
      (tool) =>
        t('repl.toolsRow', {
          name: tool.name.padEnd(8),
          risk: tool.risk.padEnd(7),
          access: tool.readOnly ? t('repl.readOnly') : t('repl.writable'),
          safe: tool.concurrencySafe ? t('repl.concurrentSafe') : '',
        }),
    );
    output.write(`${t('repl.tools')}\n${rows.join('\n')}\n`);
  }

  function cmdCompact(): void {
    const before = estimateMessagesTokens(agent.history, agent.registry.definitions());
    const compacted = trimOldToolResults(agent.history, 6);
    agent.history.length = 0;
    agent.history.push(...compacted);
    const after = estimateMessagesTokens(agent.history, agent.registry.definitions());
    output.write(ANSI.green(`${t('repl.compacted', { before, after })}\n`));
  }

  async function cmdResume(args: string[]): Promise<void> {
    const sessions = await sessionStore.list({ limit: 5 });
    if (args[0] === undefined) {
      if (sessions.length === 0) {
        output.write(`${t('resume.none')}\n`);
        return;
      }
      output.write(`${t('resume.recent')}\n`);
      for (const s of sessions) {
        output.write(`  ${s.sessionId.padEnd(42)} ${new Date(s.updatedAt).toLocaleString()}  ${t('resume.entries', { n: s.entryCount })}\n`);
      }
      return;
    }
    const target = sessions.find((s) => s.sessionId === args[0]);
    if (target === undefined) {
      output.write(ANSI.yellow(`${t('resume.notFound', { id: args[0] ?? '' })}\n`));
      return;
    }
    agent = createCurrentAgent(target.sessionId);
    output.write(ANSI.green(`${t('resume.restored', { id: target.sessionId })}\n`));
  }

  // ── main loop ──────────────────────────────────────────────────────────

  process.on('SIGINT', () => {
    const now = Date.now();
    if (activeAbort !== undefined) {
      activeAbort.abort(new Error('SIGINT'));
      output.write(ANSI.yellow(`\n${t('repl.cancelled')}\n`));
      return;
    }
    if (now - lastSigint < 2000) {
      rl.close();
      process.exit(130);
    }
    lastSigint = now;
    output.write(ANSI.yellow(`\n${t('repl.exitHint')}\n`));
    safePrompt();
  });

  output.write(banner(tierLabelOf(tier.mode)));
  if (!isTTY) output.write(ANSI.dim(`${t('repl.pipeNotice')}\n`));

  safePrompt();

  if (opts.initialPrompt !== undefined && opts.initialPrompt.trim().length > 0) {
    await runTurn(opts.initialPrompt);
  }

  try {
    for await (const line of rl) {
      const trimmed = line.trim();
      if (trimmed === '') {
        safePrompt();
        continue;
      }
      const slash = parseSlash(trimmed);
      if (slash !== null) {
        try {
          await handleSlash(slash);
        } catch (e) {
          if (e instanceof ExitRepl) break;
          throw e;
        }
        safePrompt();
        continue;
      }
      if (trimmed.startsWith('!')) {
        await runBangCommand(trimmed.slice(1));
        safePrompt();
        continue;
      }
      await runTurn(trimmed);
    }
  } finally {
    output.write(ANSI.dim(`\n${t('goodbye')}\n`));
    rl.close();
  }
  return 0;
}

class ExitRepl extends Error {}

function banner(tierText: string): string {
  return [
    ANSI.bold(t('banner.title')),
    ANSI.dim(t('banner.tier', { tier: tierText })),
    ANSI.dim(t('banner.hint')),
    '',
  ].join('\n');
}

export function tierLabelOf(mode: 'strict' | 'default' | 'acceptEdits' | 'plan' | 'bypass'): string {
  switch (mode) {
    case 'strict': return t('tier.long.strict');
    case 'default': return t('tier.long.default');
    case 'acceptEdits': return t('tier.long.acceptEdits');
    case 'plan': return t('tier.long.plan');
    case 'bypass': return t('tier.long.bypass');
  }
}

async function readFileSafe(path: string): Promise<string | undefined> {
  try {
    const { readFileSync } = await import('node:fs');
    return readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
}
