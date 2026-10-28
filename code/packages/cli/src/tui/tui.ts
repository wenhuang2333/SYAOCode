/**
 * 常驻 TUI 编码界面（FR-130 / FR-137 / TUI 需求）。
 *
 * 布局（自上而下）：
 *   ── 流式输出区（自然滚动，text.delta 直接追加）
 *   ┌─ syao (provider:model) · 档位 ────┐  ← 输入框（边框）
 *   │ ❯ 输入…                             │
 *   └─────────────────────────────────────┘
 *    模型 …  上下文 …  轮次 N:M  速度 …  缓存 …  总token …
 *
 * 实现要点：
 * - 底部锚定：ESC7（保存光标）/ ESC8（恢复）+ ESC[J（清除下方），
 *   输出文本在 chrome 上方追加时先撤下 chrome、写完再重画。
 * - chrome 帧差分渲染（消除闪烁）：同高/收缩帧只原位重写变化行（收缩帧贴原帧
 *   底部、上方多余行清空；内容未变时零写入），增高帧才全量重画；整帧写入用
 *   synchronized update（DEC 2026）包裹，支持它的终端原子交换。
 * - 输入：raw 模式 + LineEditor（CJK 安全、历史、光标块）。
 * - 权限审批 / 交互式提问复用同一编辑器（mode 切换，问题显示在框标题）。
 * - 状态栏：StatusTracker 实时指标，150ms 定时刷新（差分渲染下仅变化行重写）。
 */

import { stdin as input, stdout as output } from 'node:process';
import {
  createAgent,
  estimateMessagesTokens,
  FileSessionStore,
  SyaoError,
  projectHashOf,
  Redactor,
  rulesFromConfig,
  trimOldToolResults,
  type Agent,
  type AgentEvent,
  type PermissionDecision,
  type PermissionMode,
  type PermissionRequest,
  type PermissionRule,
  type Provider,
} from '@syaocode/core';
import { nodeRuntime } from '@syaocode/node';
import { createFileReceiptStore } from '@syaocode/node';
import { createBuiltinTools } from '@syaocode/tools';
import type { CliArgs } from '../args.js';
import { resolvePermissionTier } from '../args.js';
import { buildProvider, type ProviderSpec } from '../provider-select.js';
import { buildCliContext } from '../context.js';
import { PhaseTracker, phaseLine } from './phase.js';
import { cliModelSpec, createCliRedactor, loadCliConfig } from '../effective-config.js';
import { getLanguage, isLang, languageName, t, type Lang } from '../i18n/index.js';
import { userErrorMessage, userEventErrorText } from '../error-text.js';
import {
  commandDocs,
  helpText,
  isAvailableDoc,
  parseInlinePermissionSetting,
  parsePermissionAnswer,
  parsePermissionArg,
  parseSlash,
  permissionModeShort,
  permissionTierPanel,
  type InlinePermissionChange,
} from '../slash.js';
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
} from '../model-config.js';
import { formatDoctor, runDoctor } from '../doctor.js';
import { expandAtPaths, summarizeInput } from '../prompt-utils.js';
import { readWorkspaceUsage, recordUsage, usageFilePath, type WorkspaceUsage } from '../usage-store.js';
import { BootAnimation, bootSupported } from './boot.js';
import { LineEditor } from './editor.js';
import { StatusTracker, formatStatusLine } from './status.js';
import { displayWidth, padToWidth, truncateToWidth } from './width.js';
import {
  BRACKET_PASTE_ON,
  detectDarkBackground,
  incompleteEscapeSuffix,
  installTerminalGuards,
  isTinyTerminal,
  sanitizeInputChunk,
  setDarkTheme,
  toAscii,
  type GuardHandle,
} from './terminal.js';
import { renderPanel, welcomeSupported } from './welcome.js';
import { suggestCommands, exactIndex, paletteWindow, type CommandHint } from './palette.js';
import {
  newWizard,
  renderWizard,
  selectOptions,
  submitAnswer,
  wizardIsSecret,
  wizardIsSelect,
  wizardQuestion,
  setExistingNamesProvider,
  type WizardState,
} from './setup-wizard.js';
import {
  deleteProfile,
  listProfiles,
  profileKeyStatus,
  saveProfile,
  PROTOCOL_LABELS,
  AUTH_FIELD_LABELS,
  type ModelProfile,
  AGENT_ROLES,
  ROLE_META,
  activateAgentGroup,
  availableModelRefs,
  deleteAgentGroup,
  getAgentGroup,
  listAgentGroups,
  refToModelConfig,
  saveAgentGroup,
  type AgentGroup,
  type AgentRole,
} from '../model-config.js';
import {
  groupSummary,
  moveSelection,
  newGroupWizard,
  optionsOf as groupOptions,
  questionOf as groupQuestion,
  renderGroupWizard,
  setGroupPrefillProvider,
  setGroupWizardDeps,
  submitStep as submitGroupStep,
  isSelectStep as groupIsSelect,
  type GroupWizardState,
} from './agent-wizard.js';
import { C, panel, section, table } from './panel.js';
import {
  costDataOf,
  costPanel,
  doctorPanel,
  helpPanel,
  managePanel,
  modelPanel,
  permissionsPanel,
  statusPanel,
  toolsPanel,
} from '../views.js';
import type { CliFabric } from '../arf.js';
import { installMainPathGovernance } from '../arf-main-path.js';
import {
  handleApproveSlash,
  handleCallSlash,
  handlePeerSlash,
  handleRpcSlash,
  handleServeSlash,
  type SlashConsole,
} from '../rpc-command.js';

const ANSI = {
  dim: (s: string) => `\x1b[2m${s}\x1b[22m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[22m`,
  red: (s: string) => `\x1b[31m${s}\x1b[39m`,
  green: (s: string) => `\x1b[32m${s}\x1b[39m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[39m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[39m`,
  magenta: (s: string) => `\x1b[35m${s}\x1b[39m`,
};

const CLEAR_BELOW = '\x1b[J';
const ERASE_EOL = '\x1b[K';
const CUD1 = '\x1b[1B';
const HIDE_CURSOR = '\x1b[?25l';
const SHOW_CURSOR = '\x1b[?25h';
// 同步输出（synchronized update, DEC 2026）：支持它的终端把整帧原子交换，
// 不支持者按未知私有模式忽略——用于消除全量重绘路径的中间空白帧。
const SYNC_ON = '\x1b[?2026h';
const SYNC_OFF = '\x1b[?2026l';

export interface TuiOptions {
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

/** 启动动画（按任意键跳过；--no-boot 或终端过小直接跳过） */
function asciiModeSkip(): boolean {
  return toAscii('▀') !== '▀'; // ASCII 降级下不播放半块粒子动画
}

async function playBoot(noBoot: boolean): Promise<void> {
  const cols = output.columns ?? 80;
  const rows = output.rows ?? 24;
  if (noBoot || asciiModeSkip() || !bootSupported(cols, rows) || input.isTTY !== true) return;
  const anim = new BootAnimation({ cols, rows });
  const t0 = Date.now();
  let skip = false;
  const onKey = () => {
    skip = true;
  };
  input.setRawMode(true);
  input.resume();
  input.on('data', onKey);
  output.write(HIDE_CURSOR);
  try {
    for (;;) {
      const t = Date.now() - t0;
      if (skip || anim.isDone(t)) break;
      output.write(anim.tick(t));
      await sleep(50);
    }
  } finally {
    input.off('data', onKey);
    output.write('\x1b[H' + CLEAR_BELOW + SHOW_CURSOR);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

class ExitTui extends Error {}

export async function runTui(opts: TuiOptions): Promise<number> {
  const cwd = opts.args.cwd ?? process.cwd();
  const runtime = nodeRuntime();
  const config = await loadCliConfig(opts.args, runtime);
  const redactor = createCliRedactor();
  const receipts = createFileReceiptStore(runtime, `${syaoHome()}/evidence`);
  const sessionStore = new FileSessionStore(runtime, `${syaoHome()}/sessions`, String(projectHashOf(cwd)));
  const builtins = createBuiltinTools();
  // FR-051/FR-083：工作目录 + AGENTS.md/CLAUDE.md 项目指令；模型身份随 spec 变化
  const HARNESS = 'SYAOCode v0.2.0-dev';
  const usageTotals: UsageTotals = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0, requests: 0 };
  // 当前工作区的跨会话累计账本（~/.syaocode/usage/<hash>.json），/cost 的数据源
  let workspaceUsage: WorkspaceUsage = readWorkspaceUsage(cwd);
  let usagePersistWarned = false;

  await playBoot(opts.args.noBoot === true);

  let spec: ProviderSpec = cliModelSpec(opts.args, config);
  const tier = resolvePermissionTier(opts.args, config.permissionMode);
  let permissionMode: PermissionMode = config.permissionMode;
  let pendingResume: string | undefined;
  const sessionRules: PermissionRule[] = rulesFromConfig(config);

  // ── ARF governance on the main path (task-8) ────────────────────────────
  // Every tool call of this TUI session is a governed invocation: the kernel
  // gates it with the SAME live permission engine, reserves/settles budget and
  // writes the receipt + audit link. `/rpc` reads the very same evidence.
  const governance = installMainPathGovernance({
    tools: builtins.tools,
    fileState: builtins.fileState,
    permissionMode,
    rules: sessionRules,
    cwd,
    runtime,
    redactor,
    ...(config.limits.maxBudgetUsd !== undefined ? { maxBudgetUsd: config.limits.maxBudgetUsd } : {}),
    taskLabel: 'syao tui session',
  });

  input.setRawMode(true);
  input.resume();
  // 崩溃/信号清理钩子（等价 Rust TUI 的 panic hook）：任何异常退出都恢复终端
  const guards: GuardHandle = installTerminalGuards(input, output);
  // 括号粘贴：多行粘贴不触发多次提交
  output.write(BRACKET_PASTE_ON);
  // 主题探测（OSC 11）：浅色终端上欢迎面板艺术字改用深色系（须在主输入挂载前）
  setDarkTheme(await detectDarkBackground(input, output));
  const editor = new LineEditor();
  const tracker = new StatusTracker({ model: modelSpecLabel(spec), contextWindow: safeContextWindow(spec) });
  // 运行阶段（Explore/Plan/Implement/Validate）与网络重试状态
  const phaseTracker = new PhaseTracker();

  // ── chrome（输入框 + 状态栏）状态 ──
  let chromeDrawn = false;
  // chrome 锚点不用 ESC7/ESC8（DECSC）：内容滚动后保存位置会失配（终端间行为不一，
  // 会导致幽灵行/擦错区域）。改为纯相对移动：光标始终停在输入行，靠 CUU 回到帧首。
  let lastAboveBox = 0;
  /** 上一帧逐行内容（含 ANSI）；用于差分重绘，null = 屏幕内容已失效需全量重画 */
  let lastFrame: string[] | null = null;
  /** 帧首行相对锚点（ESC7 保存位）的行偏移；收缩帧保持底部锚定时 > 0 */

  let busy = false;
  let busySince: number | null = null;
  /** 流式输出是否停在一个未结束的行上：此时不重画 chrome（否则会覆盖半行文本） */
  let streamMidLine = false;
  /** 忙碌期间用户提交的消息队列（保序，不覆盖丢弃；上限 16） */
  const queuedInputs: string[] = [];
  /** 问答引导进行中：提前到达的 Enter 先入队，避免下一问尚未就绪时输入走失 */
  let guidedDepth = 0;
  const queuedAnswers: string[] = [];
  /** 审批重评估期间的输入：留给下一次 ask() 立即消费，不进入聊天队列 */
  const pendingApprovalAnswers: string[] = [];
  type EditorMode =
    | { kind: 'input' }
    | { kind: 'permission'; resolve: (a: string) => void }
    /** 审批中已提交设置、引擎正按新策略重评估：此间输入先缓冲，避免误入聊天队列 */
    | { kind: 'permissionWait' }
    | { kind: 'prompt'; resolve: (a: string) => void };
  let mode: EditorMode = { kind: 'input' };
  let lastSigint = 0;
  let activeAbort: AbortController | undefined;
  let agent = createCurrentAgent();
  let statusTimer: NodeJS.Timeout | undefined;
  // 欢迎面板：进入工作区时显示，首次真实输出（printAbove）后永久收起；
  // 用户敲任意键后蝴蝶立即冻结为静态（防频繁重绘）
  let welcomeActive = false;
  let welcomeFrozen = false;
  // 指令联想：输入 "/" 且未出现空格时激活
  let paletteHints: CommandHint[] = [];
  let paletteIdx = 0;
  // /setup 向导（激活时占用输入框，选择步复用 ↑↓ 导航）
  let wizard: WizardState | null = null;
  setExistingNamesProvider(() => Object.keys(listProfiles()));
  // /set-agents · /setting agent 群向导（与 /setup 向导互斥，共用输入框）
  let groupWizard: GroupWizardState | null = null;
  setGroupWizardDeps({
    groupNames: () => Object.keys(listAgentGroups()),
    modelRefs: () => availableModelRefs(),
  });
  setGroupPrefillProvider((name) => {
    const g = getAgentGroup(name);
    return g !== undefined ? { hyaki: g.hyaki, sota: g.sota, common: g.common } : {};
  });

  function safeContextWindow(s: ProviderSpec): number | null {
    try {
      return buildProvider(s).capabilities(s.model).contextWindow;
    } catch {
      return null;
    }
  }

  function createCurrentAgent(resumeSessionId?: string): Agent {
    const provider: Provider & { model: string } = buildProvider(spec);
    const created = createAgent({
      provider,
      model: provider.model,
      cwd,
      context: buildCliContext(cwd, { model: modelSpecLabel(spec), harness: HARNESS }),
      tools: governance.tools,
      permissionMode,
      rules: sessionRules,
      permissionHandler: tuiPermissionHandler,
      session: sessionStore,
      runtime,
      redactor,
      receipts,
      governor: governance.governor,
      ...(opts.args.verify === true ? { verification: { enabled: true } } : {}),
      retryPolicy: {
        onRetry: (info) => {
          phaseTracker.onRetry(info);
          redraw();
        },
      },
      // tool.start 事件按批次投递；这里即时更新阶段行（长命令执行期间也能看到）
      onToolStart: (info) => {
        phaseTracker.onEvent({ type: 'tool.start', callId: info.callId, name: info.name, input: info.input });
        redraw();
      },
      limits: config.limits,
    });
    // The kernel consults this agent's live engine (rebuilt on /model).
    governance.bindEngine(created.engine);
    if (resumeSessionId !== undefined) {
      pendingResume = resumeSessionId;
    }
    return created;
  }

  // ── 输出（chrome 感知） ──────────────────────────────────────────────

  /** 从当前光标（输入行）上移到 chrome 帧首并清除整个帧。
   * 纯相对移动（CUU + ED），不依赖 ESC7/ESC8——滚动后保存位置会失配。 */
  function eraseChromeSeq(): string {
    const up = lastAboveBox + 1;
    return `${up > 0 ? `\x1b[${up}A` : ''}\r${CLEAR_BELOW}`;
  }

  /** 退出时的收尾文本：撤下 chrome 后打印告别语 */
  function goodbyeText(): string {
    const erase = chromeDrawn ? eraseChromeSeq() : '';
    return `${erase}\r\n${ANSI.dim(t('goodbye'))}\r\n`;
  }

  /** 在 chrome 上方打印文本（文本以换行结尾时正好贴住 chrome 顶部）。
   * raw 模式下终端不做 NL→CRNL 转换，统一在此归一化。 */
  function printAbove(text: string): void {
    welcomeActive = false;
    const nl = text.replace(/\r\n/g, '\n').replace(/\n/g, '\r\n');
    const parts: string[] = [];
    parts.push(chromeDrawn ? eraseChromeSeq() : '\r');
    parts.push(toAscii(nl));
    if (!nl.endsWith('\r\n')) parts.push('\r\n');
    output.write(parts.join(''));
    chromeDrawn = false;
    lastFrame = null;
    streamMidLine = false;
  }

  /** 打印流式片段：不强制换行（换行由 flush/closeStreamLines 决定），
   * 使 16ms 一批的 delta 自然拼成连续段落而不是碎行。 */
  function printStream(text: string): void {
    if (text === '') return;
    welcomeActive = false;
    const nl = text.replace(/\r\n/g, '\n').replace(/\n/g, '\r\n');
    const parts: string[] = [];
    if (chromeDrawn) {
      parts.push(eraseChromeSeq());
      chromeDrawn = false;
      lastFrame = null;
    }
    parts.push(toAscii(nl));
    output.write(parts.join(''));
    streamMidLine = !nl.endsWith('\r\n');
  }

  function boxTitle(): string {
    const model = modelSpecLabel(spec);
    if (mode.kind === 'permission' || mode.kind === 'permissionWait') return t('box.permissionTitle');
    if (mode.kind === 'prompt') return ANSI.bold(promptQuestion);
    if (wizard !== null) return ANSI.bold(wizardQuestion(wizard));
    if (groupWizard !== null) return ANSI.bold(groupQuestion(groupWizard));
    const tier = permissionModeShort(agent.engine.mode);
    const busyTag = busy ? ANSI.magenta(t('box.busy', { secs: busySince !== null ? Math.floor((Date.now() - busySince) / 1000) : 0 })) : '';
    const queued = queuedInputs.length > 0 ? ANSI.dim(t('box.queued', { n: queuedInputs.length })) : '';
    return `${ANSI.cyan(`syao (${model})`)}${busyTag}${queued} ${ANSI.dim(`· ${tier}`)}`;
  }

  /** 联想弹层每页行数：一页 6 条，向下移动时窗口滑动（新的进来、旧的移出）。
   * 终端过小时按可用高度收缩，最少 3 条。 */
  const PALETTE_ROWS = 6;
  function paletteViewMax(total: number): number {
    const rows = output.rows ?? 24;
    return Math.max(3, Math.min(total, PALETTE_ROWS, rows - 5));
  }

  /** 指令联想弹层（输入框下方）：无边框列表，一页 6 条 + 键位/位置提示行。
   * 不加边框是因为每条命令的说明长度不同，框线只会造成参差的留白。 */
  function renderPalette(cols: number): string[] {
    const w = Math.min(cols, 72);
    const total = paletteHints.length;
    const { start, end } = paletteWindow(total, paletteIdx, paletteViewMax(total));
    const lines: string[] = [];
    for (let i = start; i < end; i++) {
      const h = paletteHints[i]!;
      const selected = i === paletteIdx;
      const marker = selected ? '❯ ' : '  ';
      const name = h.name.padEnd(13);
      const content = selected
        ? `${marker}${ANSI.green(name)} ${h.brief}`
        : `${marker}${ANSI.green(name)} ${ANSI.dim(h.brief)}`;
      const [fitted] = truncateToWidth(content, w);
      lines.push(selected ? `\x1b[7m${padToWidth(fitted, w)}\x1b[27m` : padToWidth(fitted, w));
    }
    const range = end - start < total ? `${start + 1}-${end}/${total} · ` : '';
    lines.push(padToWidth(ANSI.dim(`${range}${t('palette.keys')}`), w));
    return lines;
  }

  /** 根据编辑器内容刷新联想候选（仅主输入模式；向导激活时不联想） */
  function updatePalette(): void {
    if (mode.kind !== 'input' || wizard !== null || groupWizard !== null) {
      paletteHints = [];
      editor.setNavCapture(
        (wizard !== null && wizardIsSelect(wizard)) || (groupWizard !== null && groupIsSelect(groupWizard)),
      );
      return;
    }
    paletteHints = suggestCommands(editor.text());
    if (paletteHints.length > 0) {
      // 打开联想即收起欢迎面板：弹层要占满输入框上方的空间，
      // 与最高 22 行的欢迎面板叠加会超出屏幕（此时用户已开始指挥工作区，splash 完成使命）
      welcomeActive = false;
    }
    const exact = exactIndex(paletteHints, editor.text());
    paletteIdx = paletteHints.length > 0 ? (exact >= 0 ? exact : 0) : 0;
    editor.setNavCapture(paletteHints.length > 0);
  }

  /** 用选中候选补全输入行（命令名 + 空格，等待参数/回车执行） */
  function completeSelected(): void {
    if (paletteHints.length === 0) return;
    editor.setLine(`${paletteHints[paletteIdx]!.name} `);
    paletteHints = [];
    editor.setNavCapture(false);
  }

  /** 组装 chrome 帧：欢迎面板（可选）+ 向导（可选）+ 联想弹层（可选）+ 输入框(3) + 状态行 */
  function buildChromeFrame(cols: number): { lines: string[]; aboveBox: number; cursorVisCol: number } {
    const lines: string[] = [];

    // 运行中：阶段行（单字符旋转 + 阶段/当前动作）；网络问题时整体转红。
    if (busy) {
      lines.push(phaseLine(phaseTracker.snapshot(), Date.now(), cols));
    }

    // 极小终端（<40 列或 <8 行）：不画边框与面板，仅保留输入行 + 状态行
    if (isTinyTerminal(cols, output.rows ?? 24)) {
      const rawText = editor.text();
      const [vis] = truncateToWidth(rawText, Math.max(1, cols - 3));
      const snapTiny = tracker.snapshot(Date.now());
      const statusTiny = formatStatusLine(snapTiny, Math.max(8, cols - 1));
      return {
        lines: [`${ANSI.cyan('❯ ')}${vis}`, ` ${ANSI.dim(statusTiny)}`],
        aboveBox: 0,
        cursorVisCol: Math.min(displayWidth(vis), Math.max(0, cols - 3)),
      };
    }

    // 欢迎面板（左：多彩扇翅蝴蝶 + 黑白阴影艺术字；右：英文欢迎与提示；
    // 用户敲任意键后蝴蝶冻结为静态姿态）
    if (welcomeActive) {
      const rowsAvail = (output.rows ?? 24) - 6; // 输入框 3 + 状态 1 + 余量
      const panelH = Math.min(22, Math.max(12, rowsAvail));
      const panel = renderPanel(
        cols,
        panelH,
        Date.now(),
        { version: 'v0.1.0', model: modelSpecLabel(spec), tier: permissionModeShort(agent.engine.mode) },
        welcomeFrozen,
      );
      lines.push(...panel);
    }

    // /setup 向导（Vite 式进度线）
    if (wizard !== null) {
      lines.push(...renderWizard(wizard, Math.min(cols, 64)));
    }

    // /set-agents agent 群向导（三角色进度线）
    if (groupWizard !== null) {
      lines.push(...renderGroupWizard(groupWizard, Math.min(cols, 68)));
    }

    const aboveBox = lines.length;

    // 边框宽度按纯文本列宽计算（boxTitle 含 ANSI，先量后截）
    const titlePlain = stripAnsi(boxTitle());
    const titleW = Math.min(displayWidth(titlePlain), cols - 6);
    lines.push(`┌─ ${boxTitle()} ${'─'.repeat(Math.max(1, cols - titleW - 5))}┐`);

    // 内容行：❯ + 可视窗口（横向滚动；向导 APIKey 步掩码显示）
    const inner = Math.max(10, cols - 6);
    const rawText = editor.text();
    const masked = wizard !== null && wizardIsSecret(wizard);
    const text = masked ? '•'.repeat([...rawText].length) : rawText;
    const cursorCol = editor.cursorCol();
    let scroll = 0;
    if (cursorCol > inner - 2) scroll = cursorCol - (inner - 2);
    const [visible] = truncateToWidth(text.slice(idxOfCol(text, scroll)), inner);
    const pad = inner - displayWidth(visible) + 1;
    lines.push(`│ ${ANSI.cyan('❯ ')}${visible}${' '.repeat(Math.max(1, pad))}│`);

    lines.push(`└${'─'.repeat(cols - 2)}┘`);

    // 指令联想弹层：位于输入框下方、状态行上方（弹层始终在光标之下）
    if (paletteHints.length > 0) {
      lines.push(...renderPalette(cols));
    }

    const snap = tracker.snapshot(Date.now());
    const status = formatStatusLine(snap, cols - 2);
    lines.push(` ${ANSI.dim(status)}`);

    return { lines, aboveBox, cursorVisCol: Math.min(cursorCol - scroll, inner - 2) };
  }

  /**
   * 绘制 chrome 帧（相对锚点 + 原子刷新）：
   * - 锚点完全相对：光标固定停在输入行，重画时 CUU 回帧首、ED 清帧后重写；
   *   不依赖 ESC7/ESC8（DECSC 保存的位置在内容滚动后会失配，终端行为不一，
   *   会产生幽灵行/擦错区域）；
   * - 帧收缩时用 CUD 保持底部锚定（输入框位置不跳）；
   * - 内容完全未变 → 零写入（空闲不再周期性输出）；
   * - 全帧写入用 synchronized update（2026）包裹，支持该模式的终端整帧原子交换。
   */
  function paintChromeFrame(frame: { lines: string[]; aboveBox: number; cursorVisCol: number }): void {
    const { lines, aboveBox, cursorVisCol } = frame;
    if (chromeDrawn && lastFrame !== null && lastFrame.length === lines.length && lastFrame.every((l, i) => l === lines[i])) {
      return; // 内容未变：零输出
    }
    const seq: string[] = [];
    if (chromeDrawn && lastFrame !== null) {
      const up = lastAboveBox + 1; // 输入行 → 旧帧首
      if (up > 0) seq.push(`\x1b[${up}A`);
      const growth = lines.length - lastFrame.length;
      // 底部锚定：帧变高时先上移 growth 行（弹层在输入框下方，否则会顶出屏幕底部）
      if (growth > 0) seq.push(`\x1b[${growth}A`);
      seq.push('\r', CLEAR_BELOW);
      const d = lastFrame.length - lines.length;
      if (d > 0) seq.push(`\x1b[${d}B`); // 收缩时新帧下移，输入框位置不跳
    } else {
      seq.push('\r');
    }
    for (let i = 0; i < lines.length; i++) {
      seq.push(toAscii(lines[i]!));
      if (i < lines.length - 1) seq.push('\r\n');
    }
    const inputRow = aboveBox + 1;
    const upToInput = lines.length - 1 - inputRow;
    seq.push('\r');
    if (upToInput > 0) seq.push(`\x1b[${upToInput}A`);
    seq.push(`\x1b[${4 + cursorVisCol}C`);
    output.write(SYNC_ON + seq.join('') + SYNC_OFF);
    chromeDrawn = true;
    lastFrame = lines;
    lastAboveBox = aboveBox;
  }

  /** 画欢迎面板（可选）+ 联想弹层（可选）+ 输入框（3 行）+ 状态行，并定位光标 */
  function drawChrome(): void {
    // 流式半行期间不画：chrome 会覆盖尚未结束的文本行（等 closeStreamLines 收尾后再画）
    if (streamMidLine) return;
    // pty/极窄终端下列数可能为 0，做下限保护（repeat 负数会抛错）
    const cols = Math.max(24, output.columns ?? 80);
    paintChromeFrame(buildChromeFrame(cols));
  }

  /** 计算横向滚动起点对应的码点索引 */
  function idxOfCol(text: string, col: number): number {
    let w = 0;
    let i = 0;
    for (const ch of text) {
      if (w >= col) return i;
      w += displayWidth(ch);
      i += ch.length;
    }
    return i;
  }

  function redraw(): void {
    drawChrome();
  }

  // ── 权限审批（复用编辑器） ───────────────────────────────────────────

  /** 应用一次内联权限设置（热改）。立即写入引擎，故同回合后续判定即生效。 */
  function applyInlinePermissionChange(change: InlinePermissionChange): void {
    agent.engine.setMode(change.mode);
    permissionMode = change.mode;
    governance.cli().setPermissionTier(change.mode);
    printAbove(
      `${ANSI.green(t('tier.switched', { key: change.key, label: permissionModeShort(change.mode) }))} ${ANSI.dim(t('tier.sessionOnly'))}\n` +
        `${ANSI.dim(t('permission.hotApplied'))}\n`,
    );
  }

  function tuiPermissionHandler(req: PermissionRequest): Promise<PermissionDecision> {
    return new Promise<PermissionDecision>((resolve) => {
      const answer = (raw: string): void => {
        const parsed = parsePermissionAnswer(raw);
        if (parsed.kind === 'setting') {
          // 热改设置：应用后交回引擎重新评估同一请求（升档即放行，不再追问）
          applyInlinePermissionChange(parsed.change);
          // 重评估期间保持审批态，此间输入先缓冲，避免被当成聊天输入发出去
          mode = { kind: 'permissionWait' };
          resolve({ recheck: true });
          return;
        }
        if (parsed.kind === 'unknown') {
          printAbove(`${ANSI.yellow(t('permission.hotUsage'))}\n`);
          ask(); // 重新提示，不把无法识别的指令当成拒绝
          return;
        }
        if (parsed.kind === 'allow') return resolve({ decision: 'allow' });
        if (parsed.kind === 'allowSession') return resolve({ decision: 'allow', remember: 'session' });
        resolve({ decision: 'deny', message: t('permission.deniedByUser') });
      };
      const ask = (): void => {
        // 重评估期间已到达的输入：立即消费，用户无需重新输入
        const buffered = pendingApprovalAnswers.shift();
        if (buffered !== undefined) {
          answer(buffered);
          return;
        }
        printAbove(
          `\n${ANSI.yellow(t('permission.request'))} ${previewOfRequest(req)}\n${ANSI.dim(t('permission.hotHint'))}\n`,
        );
        mode = { kind: 'permission', resolve: answer };
        editor.clear();
        redraw();
      };
      ask();
    });
  }

  function previewOfRequest(req: PermissionRequest): string {
    const s = req.subject;
    if (s.command !== undefined) return t('permission.subject.command', { tool: req.tool, command: ANSI.bold(s.command), risk: req.risk });
    if (s.path !== undefined) return t('permission.subject.path', { tool: req.tool, path: ANSI.bold(s.path), risk: req.risk });
    if (s.url !== undefined) return t('permission.subject.url', { tool: req.tool, url: ANSI.bold(s.url), risk: req.risk });
    return t('permission.subject.generic', { tool: req.tool, risk: req.risk });
  }

  /** 通用问答（/model config 等复用）：问题显示在框标题，编辑器提交即回答 */
  let promptQuestion = '';
  function makePrompt(): (q: string) => Promise<string> {
    return (q: string) => {
      // 快速连按 Enter：答案在问题就绪前已到达 → 直接消费，避免输入走失
      if (queuedAnswers.length > 0) {
        return Promise.resolve(queuedAnswers.shift()!);
      }
      return new Promise<string>((resolve) => {
        promptQuestion = q;
        mode = { kind: 'prompt', resolve };
        editor.clear();
        redraw();
      });
    };
  }

  /** 问答引导包装：期间的 Enter 先入队（下一问就绪后立即消费）；结束后丢弃多余输入 */
  async function guided<T>(fn: () => Promise<T>): Promise<T> {
    guidedDepth++;
    try {
      return await fn();
    } catch (e) {
      // 引导流程异常：把界面从 prompt 模式救回，避免焦点陷阱
      if (mode.kind === 'prompt') {
        mode = { kind: 'input' };
        editor.setNavCapture(false);
        printAbove(`${ANSI.red(`引导流程出错: ${e instanceof Error ? e.message : String(e)}`)}
`);
        redraw();
      }
      throw e;
    } finally {
      guidedDepth--;
      if (guidedDepth === 0) queuedAnswers.length = 0;
      if (mode.kind === 'prompt') {
        mode = { kind: 'input' };
        editor.setNavCapture(false);
        redraw();
      }
    }
  }

  // ── 键盘路由 ────────────────────────────────────────────────────────

  // 输入清洗状态：bracketed paste 跨块、未完成转义序列暂存
  const pasteState = { pasteActive: false };
  let pendingEscape = '';
  let pendingFlush: NodeJS.Timeout | undefined;
  const processInput = (text: string): void => {
    const events = editor.feed(text);
    // 任意按键：欢迎蝴蝶立即转为静态（防频繁重绘）
    if (events.length > 0 && welcomeActive) welcomeFrozen = true;
    for (const ev of events) {
      if (ev.type === 'submit') {
        if (wizard !== null) {
          // 注意：feed() 处理 Enter 时已清空缓冲区，必须用事件携带的 text
          handleWizardSubmit(ev.text);
          continue;
        }
        if (groupWizard !== null) {
          handleGroupSubmit(ev.text);
          continue;
        }
        handleSubmit(ev.text);
      } else if (ev.type === 'interrupt') {
        if (wizard !== null) {
          wizard = null;
          editor.clear();
          editor.setNavCapture(false);
          printAbove(`${ANSI.yellow(t('setup.cancelled'))}\n`);
          redraw();
          continue;
        }
        if (groupWizard !== null) {
          groupWizard = null;
          editor.clear();
          editor.setNavCapture(false);
          printAbove(`${ANSI.yellow(t('groups.cancelled'))}\n`);
          redraw();
          continue;
        }
        handleInterrupt();
      } else if (ev.type === 'eof') {
        if (mode.kind === 'input' && !busy && editor.isEmpty()) {
          output.write(goodbyeText());
          cleanup(0);
        }
      } else if (ev.type === 'nav') {
        // 群向导选择步 → /setup 向导选择步 → 指令联想（均循环滚动）
        if (groupWizard !== null && groupIsSelect(groupWizard)) {
          groupWizard = moveSelection(groupWizard, ev.dir === 'up' ? -1 : 1);
          redraw();
        } else if (wizard !== null && wizardIsSelect(wizard)) {
          const n = selectOptions(wizard).length;
          const delta = ev.dir === 'up' ? -1 : 1;
          wizard = { ...wizard, selIdx: (wizard.selIdx + delta + n) % n };
          redraw();
        } else if (paletteHints.length > 0) {
          const delta = ev.dir === 'up' ? -1 : 1;
          paletteIdx = (paletteIdx + delta + paletteHints.length) % paletteHints.length;
          redraw();
        }
      } else if (ev.type === 'escape') {
        if (wizard !== null) {
          wizard = null;
          editor.clear();
          editor.setNavCapture(false);
          printAbove(`${ANSI.yellow(t('setup.cancelled'))}\n`);
          redraw();
        } else if (groupWizard !== null) {
          groupWizard = null;
          editor.clear();
          editor.setNavCapture(false);
          printAbove(`${ANSI.yellow(t('groups.cancelled'))}\n`);
          redraw();
        } else if (paletteHints.length > 0) {
          paletteHints = [];
          editor.setNavCapture(false);
          redraw();
        }
      } else if (ev.type === 'tab') {
        if (groupWizard !== null) {
          handleGroupSubmit('');
        } else if (wizard !== null) {
          // 向导中 Tab 等同确认当前步
          handleWizardSubmit();
        } else if (paletteHints.length > 0) {
          completeSelected();
          redraw();
        } else {
          editor.insert('  ');
          redraw();
        }
      } else {
        // update：内容/光标变化 → 重算联想并重绘
        updatePalette();
        redraw();
      }
    }
  };

  input.on('data', (chunk: Buffer) => {
    const clean = sanitizeInputChunk(chunk.toString('utf8'), pasteState);
    if (clean === '') return;
    const combined = pendingEscape + clean;
    const suffix = incompleteEscapeSuffix(combined);
    pendingEscape = suffix;
    const complete = suffix === '' ? combined : combined.slice(0, combined.length - suffix.length);
    if (complete !== '') processInput(complete);
    if (pendingEscape !== '') {
      // 用户单独按 Esc：短暂等待后续字节；超时按独立 Esc 处理（关闭联想/取消向导）
      if (pendingFlush !== undefined) clearTimeout(pendingFlush);
      pendingFlush = setTimeout(() => {
        const held = pendingEscape;
        pendingEscape = '';
        pendingFlush = undefined;
        if (held !== '') processInput(held);
      }, 120);
    }
  });

  /** /setup 向导步进：确认当前答案；完成后保存档案并询问是否启用。
   * text 为空时回退到编辑器内容（Tab 确认路径；Enter 路径必须传 ev.text，
   * 因为 feed() 已把缓冲区清空）。 */
  function handleWizardSubmit(text?: string): void {
    if (wizard === null) return;
    const { state: ns, done } = submitAnswer(wizard, text ?? editor.text());
    editor.clear();
    wizard = ns;
    if (done) {
      void finishWizard(ns);
      return;
    }
    editor.setNavCapture(wizardIsSelect(ns));
    redraw();
  }

  async function finishWizard(state: WizardState): Promise<void> {
    const a = state.answers;
    const name = a.profileName ?? '';
    wizard = null;
    editor.setNavCapture(false);
    const existing = listProfiles()[name];
    const apiKeyEnv = `SYAO_KEY_${name.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;
    const profile: ModelProfile = {
      model: a.model ?? '',
      baseUrl: a.baseUrl ?? '',
      protocol: a.protocol ?? 'openai-chat',
      authField: a.authField ?? 'bearer',
      apiKeyEnv,
      createdAt: existing?.createdAt ?? Date.now(),
      updatedAt: Date.now(),
    };
    saveProfile(name, profile, a.apiKey);
    const keyStatus = profileKeyStatus(profile);
    printAbove(
      [
        ANSI.green(t('setup.saved', { name })),
        t('setup.field.model', { value: profile.model }),
        t('setup.field.baseUrl', { value: profile.baseUrl }),
        t('setup.field.protocol', { value: PROTOCOL_LABELS[profile.protocol] }),
        t('setup.field.auth', { value: AUTH_FIELD_LABELS[profile.authField] }),
        t('setup.field.key', {
          env: profile.apiKeyEnv,
          status: keyStatus.set
            ? keyStatus.source === 'env-file'
              ? t('setup.keyInEnvFile')
              : t('setup.keyInProcessEnv')
            : t('setup.keyMissing'),
        }),
        profile.protocol === 'openai-responses' || profile.protocol === 'gemini' ? ANSI.yellow(t('setup.protocolNotice')) : '',
      ]
        .filter((l) => l !== '')
        .join('\n') + '\n',
    );
    const ask = makePrompt();
    const activate = (await ask(t('setup.activatePrompt'))).trim().toLowerCase();
    if (activate === '' || activate === 'y') {
      switchModel(`@${name}`, profile.model);
    } else {
      printAbove(`${ANSI.dim(t('setup.kept', { name }))}\n`);
    }
    redraw();
  }

  /** /setup：启动向导（/manage 编辑入口复用，带预填） */
  function startWizard(prefill?: Partial<{ model: string; baseUrl: string; protocol: ModelProfile['protocol']; authField: ModelProfile['authField'] }>, editing?: string): void {
    welcomeFrozen = true;
    wizard = newWizard(prefill, editing);
    editor.clear();
    editor.setNavCapture(wizardIsSelect(wizard));
    redraw();
  }

  // ── /set-agents · /setting：agent 群向导 ─────────────────────────────

  /** 启动 agent 群向导；editing 为已有群名（改群），缺省为新建/选择 */
  function startGroupWizard(editing?: string): void {
    welcomeFrozen = true;
    const prefill =
      editing !== undefined
        ? (() => {
            const g = getAgentGroup(editing);
            return g !== undefined ? { hyaki: g.hyaki, sota: g.sota, common: g.common } : undefined;
          })()
        : undefined;
    groupWizard = newGroupWizard(editing, prefill);
    editor.clear();
    editor.setNavCapture(groupIsSelect(groupWizard));
    redraw();
  }

  /** 群向导步进；text 为空回退编辑器（Tab 路径；Enter 路径必须传 ev.text） */
  function handleGroupSubmit(text?: string): void {
    if (groupWizard === null) return;
    const { state: ns, done } = submitGroupStep(groupWizard, text ?? editor.text());
    editor.clear();
    groupWizard = ns;
    if (done) {
      void finishGroupWizard(ns);
      return;
    }
    editor.setNavCapture(groupIsSelect(ns));
    redraw();
  }

  async function finishGroupWizard(state: GroupWizardState): Promise<void> {
    const a = state.answers;
    const name = a.name ?? state.editing ?? '';
    groupWizard = null;
    editor.setNavCapture(false);
    const existing = getAgentGroup(name);
    const group: AgentGroup = {
      hyaki: a.hyaki ?? '',
      sota: a.sota ?? '',
      common: a.common ?? '',
      createdAt: existing?.createdAt ?? Date.now(),
      updatedAt: Date.now(),
    };
    saveAgentGroup(name, group);
    printAbove(
      [
        ANSI.green(t('groups.saved', { name })),
        '',
        ...groupSummary(name, a),
        '',
        ANSI.dim(t('groups.note1')),
        ANSI.dim(t('groups.note2')),
      ].join('\n') + '\n',
    );
    const ask = makePrompt();
    const activate = (await ask(t('groups.activatePrompt'))).trim().toLowerCase();
    if (activate === '' || activate === 'y') {
      activateGroup(name);
    } else {
      printAbove(`${ANSI.dim(t('groups.kept', { name }))}\n`);
    }
    redraw();
  }

  /** 激活 agent 群：主工作模型取 common 角色，并记录 activeAgentGroup */
  function activateGroup(name: string): void {
    const res = activateAgentGroup(name);
    if (!res.ok || res.common === undefined) {
      printAbove(`${ANSI.yellow(`agent 群 '${name}' 不存在。/set-agents 创建。`)}\n`);
      return;
    }
    const mc = refToModelConfig(res.common);
    switchModel(mc.provider, mc.name);
    printAbove(
      `${ANSI.green(`已激活 agent 群 '${name}'`)}${ANSI.dim(`：执行模型 ${res.common}（hyaki/sota 配置已保存，M3 编排模式启用后自动分派）`)}\n`,
    );
  }

  /** 面板输出辅助（views.ts 的行数组 → printAbove） */
  function printPanelLines(lines: string[]): void {
    printAbove(`${lines.join('\n')}\n`);
  }

  function handleSubmit(text: string): void {
    if (mode.kind === 'permission') {
      const resolve = mode.resolve;
      // 设置指令会触发引擎重评估：此间保持审批态，避免输入落到聊天队列
      mode = parsePermissionAnswer(text).kind === 'setting' ? { kind: 'permissionWait' } : { kind: 'input' };
      resolve(text);
      editor.clear();
      redraw();
      return;
    }
    if (mode.kind === 'permissionWait') {
      // 引擎正在按新策略重评估：缓冲输入，下一次提示就绪后立即消费
      if (pendingApprovalAnswers.length < 16) pendingApprovalAnswers.push(text);
      editor.clear();
      redraw();
      return;
    }
    if (mode.kind === 'prompt') {
      const resolve = mode.resolve;
      mode = { kind: 'input' };
      resolve(text);
      editor.clear();
      redraw();
      return;
    }
    // 问答引导进行中（下一问尚未就绪）：提交入队，由后续 makePrompt 消费
    if (guidedDepth > 0) {
      queuedAnswers.push(text);
      editor.clear();
      redraw();
      return;
    }
    // 指令联想激活时：Enter = 补全选中项（输入恰为完整命令名则直接执行）
    if (paletteHints.length > 0) {
      if (exactIndex(paletteHints, text) < 0) {
        completeSelected();
        redraw();
        return;
      }
      paletteHints = [];
      editor.setNavCapture(false);
    }
    // 主输入
    if (busy) {
      // 运行中的权限热改：立即生效（不排队），使同一回合后续权限判定就用新设置
      const change = parseInlinePermissionSetting(text);
      if (change !== null) {
        printAbove(`${ANSI.cyan('❯')} ${text}\n`);
        applyInlinePermissionChange(change);
        editor.clear();
        redraw();
        return;
      }
      if (queuedInputs.length < 16) queuedInputs.push(text);
      redraw();
      return;
    }
    printAbove(`${ANSI.cyan('❯')} ${text}\n`);
    editor.clear();
    void dispatch(text);
  }

  function handleInterrupt(): void {
    if (busy && activeAbort !== undefined) {
      activeAbort.abort(new Error('interrupt'));
      return;
    }
    if (mode.kind === 'permission') {
      const resolve = mode.resolve;
      mode = { kind: 'input' };
      resolve('n');
      editor.clear();
      redraw();
      return;
    }
    if (mode.kind === 'prompt') {
      const resolve = mode.resolve;
      mode = { kind: 'input' };
      resolve('');
      editor.clear();
      redraw();
      return;
    }
    const now = Date.now();
    if (now - lastSigint < 2000) {
      output.write(goodbyeText());
      cleanup(130);
      return;
    }
    lastSigint = now;
    if (!editor.isEmpty()) {
      editor.clear();
      redraw();
      return;
    }
    printAbove(ANSI.dim(t('ctrlC.exitHint')) + '\n');
  }

  async function dispatch(raw: string): Promise<void> {
    const trimmed = raw.trim();
    if (trimmed === '') return;
    const slash = parseSlash(trimmed);
    if (slash !== null) {
      try {
        await handleSlash(slash);
      } catch (e) {
        if (e instanceof ExitTui) {
          output.write(goodbyeText());
          cleanup(0);
          return;
        }
        throw e;
      }
      redraw();
      return;
    }
    if (trimmed.startsWith('!')) {
      await runBangCommand(trimmed.slice(1));
      redraw();
      return;
    }
    await runTurn(trimmed);
    redraw();
    if (queuedInputs.length > 0) {
      const next = queuedInputs.shift()!;
      printAbove(`${ANSI.cyan('❯')} ${next}\n`);
      await dispatch(next);
    }
  }

  // ── 回合执行 ────────────────────────────────────────────────────────

  async function runTurn(prompt: string): Promise<void> {
    const expanded = await expandAtPaths(prompt, cwd, runtime);
    activeAbort = new AbortController();
    busy = true;
    busySince = Date.now();
    phaseTracker.start();
    const resumeId = pendingResume;
    pendingResume = undefined;
    // 思考流（reasoning）与正文分开渲染：思考行暗色 + "⋯" 前缀
    let thinkingPrefix = false;
    // 增量批处理：provider 高频小 delta 合并到 16ms 一次写入
    let streamBuf = '';
    let streamKind: 'text' | 'thinking' = 'text';
    let streamTimer: NodeJS.Timeout | undefined;
    const flushStream = (): void => {
      if (streamTimer !== undefined) {
        clearTimeout(streamTimer);
        streamTimer = undefined;
      }
      if (streamBuf === '') return;
      const out = streamBuf;
      streamBuf = '';
      if (streamKind === 'thinking') {
        if (!thinkingPrefix) {
          printStream(ANSI.dim('  ⋯ '));
          thinkingPrefix = true;
        }
        printStream(ANSI.dim(out));
      } else {
        if (thinkingPrefix) {
          printStream('\r\n');
          thinkingPrefix = false;
        }
        printStream(out);
      }
    };
    const pushDelta = (kind: 'text' | 'thinking', text: string): void => {
      if (streamBuf !== '' && kind !== streamKind) flushStream();
      streamKind = kind;
      streamBuf += text;
      if (streamTimer === undefined) streamTimer = setTimeout(flushStream, 16);
    };
    /** 结束当前流式行（工具行/正文前调用），返回后输出从新行开始 */
    const closeStreamLines = (): void => {
      flushStream();
      if (streamMidLine) printStream('\r\n');
      thinkingPrefix = false;
      streamMidLine = false;
    };
    try {
      const stream = agent.run(expanded, { signal: activeAbort.signal, ...(resumeId !== undefined ? { sessionId: resumeId } : {}) });
      for (;;) {
        const r = await stream.next();
        if (r.done) {
          const summary = r.value;
          if (summary.endReason !== 'completed' && summary.endReason !== 'aborted') {
            printAbove(`${ANSI.yellow(t('error.turnEnded', { reason: summary.endReason }))}\n`);
          }
          break;
        }
        handleEvent(r.value);
      }
    } catch (e) {
      printAbove('');
      printAbove(`${ANSI.red(t('error.withCode', { code: SyaoError.is(e) ? e.code : '-', message: userErrorMessage(e) }))}\n`);
    } finally {
      closeStreamLines();
      busy = false;
      busySince = null;
      activeAbort = undefined;
      redraw();
    }

    function handleEvent(ev: AgentEvent): void {
      tracker.onEvent(ev, Date.now());
      phaseTracker.onEvent(ev);
      switch (ev.type) {
        case 'text.delta':
          pushDelta('text', ev.text);
          break;
        case 'thinking.delta':
          pushDelta('thinking', ev.text);
          break;
        case 'tool.start':
          closeStreamLines();
          printAbove(`${ANSI.dim(`  ⚙ ${ev.name} ${summarizeInput(ev.input)}`)}\r\n`);
          break;
        case 'tool.result': {
          closeStreamLines();
          const first = ev.content.find((c) => c.type === 'text');
          const text = first !== undefined && first.type === 'text' ? first.text : '';
          const oneline = text.split('\n').slice(0, 2).join(' ⏎ ').slice(0, 160);
          printAbove(ev.isError ? `${ANSI.red(`  ✖ ${oneline}`)}\r\n` : `${ANSI.dim(`  ✔ ${oneline}`)}\r\n`);
          break;
        }
        case 'usage': {
          usageTotals.inputTokens += ev.usage.inputTokens;
          usageTotals.outputTokens += ev.usage.outputTokens;
          usageTotals.cacheReadTokens += ev.usage.cacheReadTokens ?? 0;
          usageTotals.cacheWriteTokens += ev.usage.cacheWriteTokens ?? 0;
          usageTotals.requests += 1;
          if (ev.costUsd !== undefined) usageTotals.costUsd += ev.costUsd;
          // 记账到工作区账本（按 provider:model 分模型累计，跨会话持久化）
          try {
            workspaceUsage = recordUsage(cwd, { provider: spec.provider, model: spec.model }, ev.usage, ev.costUsd);
          } catch (e) {
            if (!usagePersistWarned) {
              usagePersistWarned = true;
              printAbove(
                `${ANSI.yellow(t('cost.persistFailed', { detail: e instanceof Error ? e.message : String(e) }))}\r\n`,
              );
            }
          }
          break;
        }
        case 'budget.warning':
          printAbove(`${ANSI.yellow(`  ${t('error.budget', { pct: Math.round(ev.ratio * 100) })}`)}\r\n`);
          break;
        case 'error':
          const msg = `${ev.error.code} ${userEventErrorText(ev.error.code, ev.error.message)}`;
          printAbove(ev.fatal ? `${ANSI.red(`  ✖ ${msg}`)}\r\n` : `${ANSI.yellow(`  ⚠ ${msg}`)}\r\n`);
          break;
        default:
          break;
      }
    }
  }

  async function runBangCommand(command: string): Promise<void> {
    const engine = agent.engine;
    const outcome = await engine.checkSubject('bash', 'exec', { command });
    if (outcome.outcome === 'deny') {
      printAbove(`${ANSI.red(`✖ 拒绝 [${outcome.error.code}]: ${outcome.error.modelMessage ?? outcome.error.message}`)}\n`);
      return;
    }
    const proc = runtime.shell.spawn('/bin/sh', ['-c', command], { cwd, timeoutMs: 60_000 });
    let out = '';
    const collect = async (s: AsyncIterable<string>) => {
      for await (const line of s) out += `${line}\n`;
    };
    const code = await Promise.all([proc.exited, collect(proc.stdout), collect(proc.stderr)]).then(([c]) => c);
    printAbove(`${ANSI.dim(`exit=${code}`)}\n${out.slice(0, 2000)}`);
  }

  // ── 斜杠命令（移植自 REPL，交互改用 promptUser） ────────────────────

  // ── ARF 治理控制台：fabric 为进程单例，主路径与 /rpc 共享同一条证据链。
  // 档位变化就地重签策略包（setPermissionTier），不重建 fabric —— 重建会丢掉
  // 已产生的 receipt / audit / budget。
  let fabricMode: PermissionMode | undefined;

  function governanceCli(): CliFabric {
    const cli = governance.cli();
    if (fabricMode !== agent.engine.mode) {
      fabricMode = agent.engine.mode;
      cli.setPermissionTier(agent.engine.mode);
    }
    return cli;
  }

  function governanceConsole(): SlashConsole {
    return {
      cli: governanceCli(),
      print: (lines) => {
        printPanelLines(typeof lines === 'string' ? [lines] : lines);
      },
      printError: (text) => {
        printAbove(`${ANSI.yellow(text)}\n`);
      },
      background: (task) => {
        void task()
          .then((lines) => {
            printPanelLines(lines);
          })
          .catch((e: unknown) => {
            printAbove(`${ANSI.red(userErrorMessage(e))}\n`);
          });
      },
    };
  }

  async function handleSlash(cmd: { name: string; args: string[] }): Promise<void> {
    switch (cmd.name) {
      case '/help':
        if (cmd.args[0] !== undefined) {
          printAbove(`${helpText(cmd.args[0])}\n`);
        } else {
          printPanelLines(
            helpPanel(
              commandDocs().filter(isAvailableDoc).map((c) => ({ usage: c.usage, summary: c.summary })),
              commandDocs().filter((c) => !isAvailableDoc(c)).map((c) => ({ name: c.name, summary: c.summary, since: c.since })),
            ),
          );
        }
        return;
      case '/rpc':
        await handleRpcSlash(cmd.args, governanceConsole());
        return;
      case '/approve':
        await handleApproveSlash(cmd.args, governanceConsole());
        return;
      case '/peer':
        await handlePeerSlash(cmd.args, governanceConsole());
        return;
      case '/mcp':
        // /mcp 继续可用：现在是 /peer 的 MCP 专用视图。
        await handlePeerSlash(cmd.args, governanceConsole(), { forceProtocol: 'mcp' });
        return;
      case '/call':
        await handleCallSlash(cmd.args, governanceConsole());
        return;
      case '/serve':
        await handleServeSlash(cmd.args, governanceConsole());
        return;
      case '/exit':
      case '/quit':
        throw new ExitTui();
      case '/model':
        await (cmd.args[0] === 'config' ? guided(() => cmdModel(cmd.args)) : cmdModel(cmd.args));
        return;
      case '/permission':
      case '/permissions':
        await guided(() => cmdPermissions(cmd.args, cmd.name));
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
      case '/clear':
        agent = createCurrentAgent();
        printAbove(`${ANSI.green(t('clear.done'))}\n`);
        return;
      case '/resume':
        await cmdResume(cmd.args);
        return;
      case '/doctor':
        printPanelLines(doctorPanel(runDoctor(cwd)));
        return;
      case '/language':
        await guided(() => cmdLanguage(cmd.args));
        return;
      case '/setup':
        startWizard();
        return;
      case '/manage':
        await guided(() => cmdManage(cmd.args));
        return;
      case '/set-agents':
        startGroupWizard();
        return;
      case '/setting': {
        const active = readUserConfig().activeAgentGroup;
        if (active === undefined) {
          printAbove(`${ANSI.yellow(t('groups.none'))}\n`);
          return;
        }
        startGroupWizard(active);
        return;
      }
      case '/agents': {
        const groups = listAgentGroups();
        const names = Object.keys(groups);
        const active = readUserConfig().activeAgentGroup;
        printPanelLines(
          panel(t('agents.panelTitle'), [
            section(t('agents.sectionRoles')),
            C.dim(t('agents.roleLineHyaki')),
            C.dim(t('agents.roleLineSota')),
            C.dim(t('agents.roleLineCommon')),
            '',
            section(t('agents.sectionGroups', { n: names.length })),
            ...(names.length > 0
              ? table(
                  [t('tbl.group'), 'hyaki', 'sota', 'common'],
                  names.map((n) => {
                    const g = groups[n]!;
                    return [`${n === active ? C.green('●') : C.dim('○')} @${n}`, g.hyaki, g.sota, g.common];
                  }),
                )
              : [C.dim(t('val.noneGroups'))]),
            '',
            C.yellow(t('agents.workModeM3')),
            C.dim(t('agents.untilThen')),
            C.dim(t('agents.configureHint')),
          ]),
        );
        return;
      }
      case '/goal':
      case '/rewind': {
        const doc = { '/goal': t('milestone.goal'), '/rewind': t('milestone.rewind') }[cmd.name];
        printAbove(`${ANSI.yellow(t('milestone.placeholder', { cmd: cmd.name, doc }))}\n`);
        return;
      }
      default:
        printAbove(`${ANSI.yellow(t('config.unknownCommand', { cmd: cmd.name }))}\n`);
        return;
    }
  }

  /** /language：切换 CLI 语言；写入配置后立即退出，下次启动生效 */
  async function cmdLanguage(args: string[]): Promise<void> {
    const raw = args[0]?.trim().toLowerCase();
    let target: Lang | undefined;
    if (raw !== undefined) {
      if (!isLang(raw)) {
        printAbove(`${ANSI.yellow(t('language.invalid', { value: args[0] ?? '' }))}\n`);
        return;
      }
      target = raw;
    } else {
      printAbove(
        [
          t('language.current', { lang: languageName(getLanguage()) }),
          t('language.option1'),
          t('language.option2'),
          '',
        ].join('\n') + '\n',
      );
      const ask = makePrompt();
      const pick = (await ask(t('language.choose'))).trim().toLowerCase();
      target = pick === '2' || pick === 'zh' ? 'zh' : pick === '1' || pick === 'en' ? 'en' : undefined;
      if (target === undefined) {
        printAbove(`${ANSI.yellow(t('language.invalid', { value: pick }))}\n`);
        return;
      }
    }
    if (target === getLanguage()) {
      printAbove(`${t('language.already', { lang: languageName(target) })}\n`);
      return;
    }
    printAbove(`${ANSI.yellow(t('language.warning'))}\n`);
    const ask2 = makePrompt();
    const confirm = (await ask2(t('language.confirm', { lang: languageName(target) }))).trim().toLowerCase();
    if (confirm !== 'y' && confirm !== 'yes') {
      printAbove(`${t('language.cancelled')}\n`);
      return;
    }
    saveLanguage(target);
    printAbove(`${ANSI.green(t('language.saved', { lang: languageName(target) }))}\n`);
    throw new ExitTui();
  }

  async function cmdModel(args: string[]): Promise<void> {
    const sub = args[0];
    if (sub === undefined || sub === 'show' || sub === 'list') {
      printModelPanel();
      return;
    }
    if (sub === 'use') {
      const target = args[1];
      if (target === undefined) {
        printAbove(`${ANSI.yellow(t('model.useUsage'))}\n`);
        return;
      }
      if (target.startsWith('@')) {
        const name = target.slice(1);
        if (getAgentGroup(name) !== undefined) {
          activateGroup(name);
          return;
        }
        const profile = listProfiles()[name];
        if (profile !== undefined) {
          switchModel(`@${name}`, profile.model);
          return;
        }
        printAbove(`${ANSI.red(t('model.unknownTarget', { target }))}\n`);
        return;
      }
      if (!target.includes(':')) {
        printAbove(`${ANSI.yellow(t('model.useUsageShort'))}\n`);
        return;
      }
      const [providerId, name] = target.split(':');
      const entry = catalogEntry(providerId ?? '');
      if (entry === undefined) {
        printAbove(`${ANSI.red(t('model.unknownProvider', { provider: providerId ?? '' }))}\n`);
        return;
      }
      if (entry.needsKey && !keyStatusOf(entry).set) {
        printAbove(`${ANSI.yellow(t('model.needKey', { provider: providerId ?? '', env: entry.apiKeyEnv ?? '' }))}\n`);
        return;
      }
      switchModel(providerId ?? 'mock', name ?? 'default');
      return;
    }
    if (sub === 'config') {
      await cmdModelConfig(args[1]);
      return;
    }
    printAbove(`${ANSI.yellow(t('model.usage'))}\n`);
  }

  function switchModel(providerId: string, name: string): void {
    const previousProvider = spec.provider;
    const history = [...agent.history];
    spec = { provider: providerId, model: name };
    const previousMode = agent.engine.mode;
    permissionMode = previousMode;
    agent = createCurrentAgent();
    agent.engine.setMode(previousMode);
    // 跨 mock 边界切换时丢弃旧上下文：mock 的脚本回复留在历史里会误导真实模型
    const acrossMock = (previousProvider === 'mock') !== (providerId === 'mock');
    if (!acrossMock) agent.history.push(...history);
    tracker.setModel({ model: modelSpecLabel(spec), contextWindow: safeContextWindow(spec) });
    writeUserConfig({ ...readUserConfig(), model: { provider: spec.provider, name: spec.model } });
    printAbove(
      `${ANSI.green(t(acrossMock ? 'model.switchedFresh' : 'model.switched', { provider: spec.provider, model: spec.model }))}\n`,
    );
  }

  /** /model 面板：当前模型 + 内置 Provider + 自定义档案 + agent 群 */
  function printModelPanel(): void {
    const config = readUserConfig();
    printPanelLines(
      modelPanel({
        current: modelSpecLabel(spec),
        activeGroup: config.activeAgentGroup,
        catalog: PROVIDER_CATALOG.map((p) => ({
          id: p.id,
          label: providerLabel(p),
          models: p.models,
          keySet: p.apiKeyEnv === undefined ? true : keyStatusOf(p).set,
        })),
        profiles: Object.entries(listProfiles()).map(([name, prof]) => ({
          name,
          protocol: PROTOCOL_LABELS[prof.protocol],
          model: prof.model,
          keySet: profileKeyStatus(prof).set,
        })),
        groups: Object.entries(listAgentGroups()).map(([name, g]) => ({ name, hyaki: g.hyaki, sota: g.sota, common: g.common })),
      }),
    );
  }

  async function cmdModelConfig(providerId?: string): Promise<void> {
    const ask = makePrompt();
    let entry = providerId !== undefined ? catalogEntry(providerId) : undefined;
    if (providerId !== undefined && entry === undefined) {
      printAbove(`${ANSI.red(`未知 provider '${providerId}'。可选: ${PROVIDER_CATALOG.map((p) => p.id).join(', ')}`)}\n`);
      return;
    }
    if (entry === undefined) {
      printAbove(`${t('config.providerPick')}\n`);
      PROVIDER_CATALOG.forEach((p, i) => printAbove(`  ${i + 1}. ${p.id.padEnd(18)} ${providerLabel(p)}\n`));
      const pick = (await ask(t('config.indexPrompt'))).trim();
      entry = PROVIDER_CATALOG[Number(pick || '1') - 1] ?? PROVIDER_CATALOG[0]!;
    }
    if (entry === undefined) return;
    const models = entry.models;
    printAbove(`${t('config.models', { models: models.join(' / ') })}\n`);
    const modelAnswer = (await ask(t('config.modelPrompt', { default: models[0] ?? '' }))).trim();
    const model = modelAnswer !== '' ? modelAnswer : models[0]!;
    let baseUrl = entry.baseUrl;
    if (entry.baseUrl !== '') {
      const urlAnswer = (await ask(`Base URL [${entry.baseUrl}]: `)).trim();
      if (urlAnswer !== '') baseUrl = urlAnswer;
    }
    const config = readUserConfig();
    config.model = { provider: entry.id, name: model, ...(entry.apiKeyEnv !== undefined ? { apiKeyEnv: entry.apiKeyEnv } : {}) };
    if (baseUrl !== entry.baseUrl) config.model.baseUrl = baseUrl;
    writeUserConfig(config);

    if (entry.apiKeyEnv !== undefined) {
      const keyAnswer = (await ask(t('config.apiKeyPrompt'))).trim();
      if (keyAnswer !== '') {
        const existing = parseEnvFile((await readFileSafe(envFilePath())) ?? '');
        existing[entry.apiKeyEnv] = keyAnswer;
        writeEnvFile(existing);
        process.env[entry.apiKeyEnv] = keyAnswer;
        printAbove(`${ANSI.green(`密钥已保存到 ~/.syaocode/env（${maskKey(keyAnswer)}）。绝不进入会话文件与日志。`)}\n`);
      }
    }
    switchModel(entry.id, model);
  }

  async function cmdPermissions(args: string[], invokedAs = '/permissions'): Promise<void> {
    // ── 快路径：参数直接生效（/permission yao · /permissions mode plan · allow/deny） ──
    if (args.length > 0) {
      if (args[0] === 'mode' && args[1] !== undefined) {
        const modeArg = args[1];
        if (modeArg !== 'strict' && modeArg !== 'default' && modeArg !== 'acceptEdits' && modeArg !== 'plan' && modeArg !== 'bypass') {
          printAbove(`${ANSI.yellow(t('config.invalidMode'))}\n`);
          return;
        }
        agent.engine.setMode(modeArg);
        permissionMode = modeArg;
        printAbove(`${ANSI.green(t('config.modeSwitched', { mode: modeArg }))}\n`);
        return;
      }
      if ((args[0] === 'allow' || args[0] === 'deny') && args[1] !== undefined) {
        addSessionRule(args[0], args[1]);
        return;
      }
      const tier = parsePermissionArg(args[0]!);
      if (tier !== null) {
        agent.engine.setMode(tier.mode);
        permissionMode = tier.mode;
        printAbove(
          `${ANSI.green(t('tier.switched', { key: tier.key, label: permissionModeShort(tier.mode) }))} ${ANSI.dim(t('tier.sessionOnly'))}\n`,
        );
        return;
      }
      printAbove(`${ANSI.yellow(t('tier.usageLong', { invoked: invokedAs }))}${ANSI.dim(t('config.guidedHint'))}\n`);
      return;
    }

    // ── 无参数：面板 + 逐项问答引导 ──
    printPanelLines(permissionsPanel(agent.engine.mode, permissionModeShort(agent.engine.mode), permRuleRows()));
    const ask = makePrompt();
    const modeAns = (await ask(t('perm.switchAsk'))).trim();
    if (modeAns !== '') {
      const parsed = parsePermissionArg(modeAns);
      if (parsed === null) {
        printAbove(`${ANSI.yellow(t('perm.unrecognized', { value: modeAns }))}\n`);
      } else {
        agent.engine.setMode(parsed.mode);
        permissionMode = parsed.mode;
        printAbove(`${ANSI.green(t('tier.switched', { key: parsed.key, label: permissionModeShort(parsed.mode) }))}\n`);
      }
    }
    const allowAns = (await ask(t('perm.allowAsk'))).trim();
    if (allowAns !== '') addSessionRule('allow', allowAns);
    const denyAns = (await ask(t('perm.denyAsk'))).trim();
    if (denyAns !== '') addSessionRule('deny', denyAns);
    printAbove(`${ANSI.dim(t('config.finalState'))}\n`);
    printPanelLines(permissionsPanel(agent.engine.mode, permissionModeShort(agent.engine.mode), permRuleRows()));
  }

  /** 会话规则 → 面板行数据 */
  function permRuleRows(): { effect: string; tool: string; command?: string; path?: string }[] {
    return sessionRules.map((r) => ({
      effect: r.effect,
      tool: r.tool,
      ...(r.match?.command !== undefined ? { command: r.match.command } : {}),
      ...(r.match?.path !== undefined ? { path: r.match.path } : {}),
    }));
  }

  function addSessionRule(effect: 'allow' | 'deny', tool: string): void {
    const rule: PermissionRule = { effect, tool, source: 'user' };
    sessionRules.push(rule);
    agent.engine.addRules([rule]);
    printAbove(`${ANSI.green(`已添加 ${effect} 规则: ${tool}（仅本次会话）。`)}\n`);
  }

  function cmdStatus(): void {
    const contextTokens = estimateMessagesTokens(agent.history, agent.registry.definitions());
    const windowSize = safeContextWindow(spec) ?? 128_000;
    const turns = agent.history.filter((m) => m.role === 'assistant').length;
    printPanelLines(
      statusPanel({
        sessionId: agent.sessionId,
        model: `${spec.provider}:${spec.model}`,
        mode: agent.engine.mode,
        tier: permissionModeShort(agent.engine.mode),
        activeGroup: readUserConfig().activeAgentGroup,
        turns,
        historyCount: agent.history.length,
        contextTokens,
        contextWindow: windowSize,
        requests: usageTotals.requests,
        inputTokens: usageTotals.inputTokens,
        outputTokens: usageTotals.outputTokens,
      }),
    );
  }

  function cmdCost(): void {
    printPanelLines(costPanel(costDataOf(workspaceUsage, usageTotals, usageFilePath(cwd))));
  }

  function cmdTools(): void {
    printPanelLines(
      toolsPanel(
        agent.registry.list().map((t) => ({
          name: t.name,
          risk: t.risk,
          readOnly: t.readOnly,
          concurrencySafe: t.concurrencySafe,
        })),
      ),
    );
  }

  function cmdCompact(): void {
    const before = estimateMessagesTokens(agent.history, agent.registry.definitions());
    const compacted = trimOldToolResults(agent.history, 6);
    agent.history.length = 0;
    agent.history.push(...compacted);
    const after = estimateMessagesTokens(agent.history, agent.registry.definitions());
    printAbove(`${ANSI.green(t('repl.compacted', { before, after }))}\n`);
  }

  /** /manage：查看/编辑/删除已保存的自定义模型档案 */
  async function cmdManage(args: string[]): Promise<void> {
    const profiles = listProfiles();
    const names = Object.keys(profiles);
    if (names.length === 0) {
      printAbove(`${ANSI.dim(t('config.noProfiles'))}\n`);
      return;
    }
    const rows = names.map((n) => {
      const p = profiles[n]!;
      const key = profileKeyStatus(p);
      return `  ${(('@' + n)).padEnd(16)} ${PROTOCOL_LABELS[p.protocol].padEnd(40)} ${p.model.padEnd(18)} ${t('common.keySet', { mark: key.set ? ANSI.green(t('common.yesMark')) : ANSI.yellow(t('common.noMark')) })}`;
    });
    printAbove([t('config.profilesSaved', { n: names.length }), ...rows].join('\n') + '\n');

    const ask = makePrompt();
    let target = args[0];
    if (target === undefined) {
      target = (await ask(t('manage.which'))).trim().replace(/^@/, '');
    }
    if (target === '') return;
    const profile = profiles[target];
    if (profile === undefined) {
      printAbove(`${ANSI.yellow(t('manage.notFound', { name: target }))}\n`);
      return;
    }
    printAbove(
      [
        `@${target}:`,
        t('setup.field.model', { value: profile.model }),
        t('setup.field.baseUrl', { value: profile.baseUrl }),
        t('setup.field.protocol', { value: PROTOCOL_LABELS[profile.protocol] }),
        t('setup.field.auth', { value: AUTH_FIELD_LABELS[profile.authField] }),
        t('setup.field.key', {
          env: profile.apiKeyEnv,
          status: profileKeyStatus(profile).set ? t('common.set') : t('common.notSet'),
        }),
        `  ${t('tbl.updated')}: ${new Date(profile.updatedAt).toLocaleString()}`,
      ].join('\n') + '\n',
    );
    const action = (await ask('[e]dit / [d]elete / (empty = cancel): ')).trim().toLowerCase();
    if (action === 'e' || action === 'edit') {
      printAbove(`${ANSI.dim(t('manage.editHint', { name: target }))}\n`);
      startWizard(
        { model: profile.model, baseUrl: profile.baseUrl, protocol: profile.protocol, authField: profile.authField },
        target,
      );
      return;
    }
    if (action === 'd' || action === 'delete') {
      const confirm = (await ask(t('manage.deleteConfirm', { name: target }))).trim().toLowerCase();
      if (confirm === 'y') {
        deleteProfile(target);
        printAbove(`${ANSI.green(t('manage.deleted', { name: target }))}\n`);
      } else {
        printAbove(`${ANSI.dim(t('manage.canceled'))}\n`);
      }
    }
  }

  async function cmdResume(args: string[]): Promise<void> {
    const sessions = await sessionStore.list({ limit: 5 });
    if (args[0] === undefined) {
      if (sessions.length === 0) {
        printAbove(`${t('resume.none')}\n`);
        return;
      }
      printAbove(`${t('resume.recent')}\n`);
      for (const s of sessions) {
        printAbove(`  ${s.sessionId.padEnd(42)} ${new Date(s.updatedAt).toLocaleString()}  ${t('resume.entries', { n: s.entryCount })}\n`);
      }
      return;
    }
    const target = sessions.find((s) => s.sessionId === args[0]);
    if (target === undefined) {
      printAbove(`${ANSI.yellow(`会话 '${args[0]}' 不存在（SY-SES-001）。/resume 查看列表。`)}\n`);
      return;
    }
    agent = createCurrentAgent(target.sessionId);
    printAbove(`${ANSI.green(`已恢复会话 ${target.sessionId}，下一条消息将接续该历史。`)}\n`);
  }

  // ── 生命周期 ────────────────────────────────────────────────────────

  function cleanup(code: number): never {
    if (statusTimer !== undefined) clearInterval(statusTimer);
    guards.cleanup(); // 恢复 raw/光标/粘贴/同步输出（幂等）
    // 释放 fabric（挂载的 peer 子进程等）；进程随即退出，不做异步等待。
    void governance.dispose();
    process.exit(code);
  }

  function resizeHandler(): void {
    if (chromeDrawn) {
      output.write(eraseChromeSeq());
      chromeDrawn = false;
      lastFrame = null;
    }
    redraw();
  }
  output.on('resize', resizeHandler);

  // 开场：终端足够大 → 欢迎面板（多彩蝴蝶 + 艺术字 + 英文提示）；否则旧横幅兜底
  if (welcomeSupported(output.columns ?? 80, output.rows ?? 24)) {
    welcomeActive = true;
  } else {
    printAbove(ANSI.bold(t('banner.title')) + '\n');
    printAbove(ANSI.dim(t('banner.tier', { tier: tierLongOf(tier.mode) })) + '\n');
    printAbove(ANSI.dim(t('banner.hint')) + '\n');
  }
  redraw();
  // 欢迎面板蝴蝶扇翅动画 + 状态栏实时速度共用此定时器
  statusTimer = setInterval(() => {
    if (chromeDrawn || busy) redraw();
  }, 150);

  if (opts.initialPrompt !== undefined && opts.initialPrompt.trim().length > 0) {
    printAbove(`${ANSI.cyan('❯')} ${opts.initialPrompt}\n`);
    await dispatch(opts.initialPrompt);
  }

  await new Promise<void>(() => {
    // 常驻：由 cleanup() 结束进程
  });
  return 0;
}

function tierLongOf(mode: PermissionMode): string {
  switch (mode) {
    case 'strict': return t('tier.long.strict');
    case 'default': return t('tier.long.default');
    case 'acceptEdits': return t('tier.long.acceptEdits');
    case 'plan': return t('tier.long.plan');
    case 'bypass': return t('tier.long.bypass');
  }
}

function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
}

async function readFileSafe(path: string): Promise<string | undefined> {
  try {
    const { readFileSync } = await import('node:fs');
    return readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
}
