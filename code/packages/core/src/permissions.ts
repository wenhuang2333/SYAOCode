import type { Runtime } from './runtime/index.js';
import type { PermissionSubject, Tool, ToolRisk } from './tool.js';
import { PermissionError } from './errors/syao-error.js';
import type { PermissionMode } from './events.js';

/**
 * Deterministic permission engine (DD-5, BR-001..BR-006, BR-021..BR-024).
 * It is the final authority: no model output, MCP annotation, or plugin can
 * upgrade a deny. Evaluation order: deny → ask → allow; first match wins.
 */

export interface PermissionRule {
  effect: 'allow' | 'ask' | 'deny';
  /** Tool name or glob, e.g. 'bash', 'read', 'mcp__github__*'. */
  tool: string;
  /** Optional argument matchers. All present matchers must match. */
  match?: { path?: string; command?: string; url?: string };
  source: 'user' | 'project' | 'plugin' | 'code';
}

export interface PermissionRequest {
  /** Stable id for this approval round (event correlation / multi-client answers). */
  id: string;
  tool: string;
  risk: ToolRisk;
  subject: PermissionSubject;
  reason: string;
  /** Sensitive path (e.g. ~/.ssh, workspace .env): approval cannot be remembered for the session. */
  sensitive?: boolean;
  /** Tool call that triggered the request, when executed through the pipeline. */
  callId?: string;
}

/**
 * Outcome of one approval round.
 *
 * `recheck` lets the approver change session policy *while the request is
 * pending* (hot setting change, e.g. `/permission si`) instead of answering
 * allow/deny: the engine re-evaluates the same request under the new mode and
 * rules, so an upgraded tier resolves the request without asking again.
 */
export type PermissionDecision =
  | { decision: 'allow'; remember?: 'once' | 'session' | 'project'; message?: string }
  | { decision: 'deny'; remember?: 'once' | 'session' | 'project'; message?: string }
  | { recheck: true };

/** Verdict of the deterministic policy, before any approval handler runs. */
export type PolicyVerdict =
  | { outcome: 'allow' }
  | { outcome: 'deny'; error: PermissionError }
  | { outcome: 'ask'; reason: string; risk: ToolRisk; sensitive?: boolean };

export type PermissionHandler = (req: PermissionRequest) => Promise<PermissionDecision>;

export type EngineOutcome =
  | { outcome: 'allow' }
  | { outcome: 'deny'; error: PermissionError };

export interface EngineOptions {
  mode: PermissionMode;
  rules: PermissionRule[];
  /** Workspace root + extra dirs allowed without confirmation (BR-003). */
  workspaceRoots: string[];
  runtime: Runtime;
  handler?: PermissionHandler;
  /** Emit events; wired by the agent (permission.request / permission.result). */
  onRequest?: (req: PermissionRequest) => Promise<PermissionDecision>;
  /** Called before the approval handler sees a request (event contract v2). */
  onRequestStart?: (req: PermissionRequest) => void;
  onResult?: (id: string, decision: 'allow' | 'deny', by: string) => void;
}

/**
 * Sensitive paths always require an explicit answer, even in bypass mode, and
 * the answer is never remembered for the session (report S4 / §13.1).
 * HOME is read through the injected runtime so the engine stays host-agnostic.
 */
const SENSITIVE_HOME_ENTRIES = ['.ssh', '.aws', '.syaocode/env'];
const WORKSPACE_SECRET_BASENAME = /^\.env(\..*)?$/;

export function commandPathCandidates(command: string): string[] {
  const out: string[] = [];
  const segments = command.split(/&&|\|\||;|\|/);
  for (const segment of segments) {
    const tokens = segment
      .trim()
      .split(/\s+/)
      .map((t) => t.replace(/^["']|["']$/g, ''))
      .filter((t) => t.length > 0);
    const head = (tokens[0] ?? '').replace(/^.*\//, '');
    if (!READ_ONLY_COMMANDS.has(head)) continue;
    let args = tokens.slice(1).filter((t) => !t.startsWith('-') && !t.startsWith('$'));
    // The first non-flag argument of grep/rg is the pattern, not a path.
    if (head === 'grep' || head === 'rg') args = args.slice(1);
    if (head !== 'find') out.push(...args);
    else if (args[0] !== undefined) out.push(args[0]);
  }
  return out;
}

// ── glob matching (small subset: '*' any-chars, '**' crosses '/') ──────────

export function globMatch(pattern: string, value: string): boolean {
  const re = globToRegExp(pattern);
  return re.test(value);
}

function globToRegExp(pattern: string): RegExp {
  let out = '';
  for (let i = 0; i < pattern.length; i += 1) {
    const ch = pattern[i]!;
    if (ch === '*') {
      if (pattern[i + 1] === '*') {
        out += '.*';
        i += 1;
      } else {
        out += '[^/]*';
      }
    } else if (ch === '?') {
      out += '[^/]';
    } else {
      out += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${out}$`);
}

// ── command risk classification (BR-006, FR-043) ─────────────────────────

const READ_ONLY_COMMANDS = new Set([
  'ls', 'cat', 'head', 'tail', 'grep', 'rg', 'find', 'pwd', 'echo', 'wc', 'which',
  'whoami', 'uname', 'date', 'sort', 'uniq', 'diff', 'stat', 'file', 'du', 'df',
  'env', 'printenv', 'type', 'true', 'false', 'sleep',
]);

const READ_ONLY_PREFIXES: [string, RegExp][] = [
  ['git', /^(status|log|diff|show|branch|rev-parse|remote|config --get|describe|blame|shortlog|tag --list|ls-files|grep)\b/],
  ['node', /^(--version|-v|npm ls)/],
  ['npm', /^(ls|outdated|--version|-v|view|run\b)/],
  ['pnpm', /^(ls|--version|-v)/],
];

const DANGEROUS_PATTERNS: RegExp[] = [
  /\brm\s+[^;|&]*\s+(-[a-zA-Z]*[rf][a-zA-Z]*\s+)+(\/|~|\$HOME|\/\*|~\/\*)?(\s|$)/,
  /\brm\s+(-[a-zA-Z]*[rf][a-zA-Z]*\s+)+(\/|~|\/\*|~\/*)?(\s|$)/,
  /\bmkfs(\.\w+)?\b/,
  /\bdd\b[^;|&]*\bof=\/dev\//,
  /\b(git\s+push\s+.*(--force(-with-lease)?\s|--force$|-f\b))\b/,
  /\b(shutdown|reboot|halt|poweroff)\b/,
  /\bchmod\s+(-[a-zA-Z]+\s+)*-?[rwx]{7}[rwx]?[a-zA-Z]*\s+\/(\s|$)/,
  /\b(chown|chmod)\s+[^;|&]*\s+\/(etc|usr|bin|sbin|System|Windows)(\/|\s|$)/,
  />\s*\/dev\/(sd|hd|disk)/,
  /\b(cp|mv|tee|>)\b[^;|&]*\s+\/(etc|usr|bin|sbin|System32)(\/|\s|$)/,
];

export type CommandClass = 'read' | 'write' | 'dangerous';

/**
 * Split a shell line into segments (`&&`, `||`, `;`, `|`) and classify each
 * segment's head command (FR-043). Unparsable segments count as `write`.
 */
export function classifyCommand(line: string): CommandClass {
  const segments = line
    .split(/&&|\|\||;|\||\$\(/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (segments.length === 0) return 'write';
  let sawWrite = false;
  for (const seg of segments) {
    if (DANGEROUS_PATTERNS.some((re) => re.test(seg))) return 'dangerous';
    const cls = classifySegment(seg);
    if (cls === 'write') sawWrite = true;
  }
  return sawWrite ? 'write' : 'read';
}

function classifySegment(seg: string): 'read' | 'write' {
  const cleaned = seg.replace(/^\(+\s*/, '').trim();
  const tokens = cleaned.split(/\s+/);
  const head = tokens[0] ?? '';
  const rest = cleaned.slice(head.length).trim();
  // Redirections make a segment a write, even for read-only commands.
  if (/[>]{1,2}\s*\S/.test(seg) || /\btee\b/.test(seg)) return 'write';
  const bare = head.replace(/^.*\//, '');
  if (READ_ONLY_COMMANDS.has(bare)) return 'read';
  for (const [cmd, re] of READ_ONLY_PREFIXES) {
    if (bare === cmd && re.test(`${rest} `)) return 'read';
  }
  return 'write';
}

// ── the engine ────────────────────────────────────────────────────────────

export class PermissionEngine {
  private opts: EngineOptions;

  constructor(opts: EngineOptions) {
    this.opts = opts;
  }

  get mode(): PermissionMode {
    return this.opts.mode;
  }

  setMode(mode: PermissionMode): void {
    this.opts = { ...this.opts, mode };
  }

  addRules(rules: PermissionRule[]): void {
    this.opts = { ...this.opts, rules: [...this.opts.rules, ...rules] };
  }

  /** Path fence (BR-003): realpath first; outside all roots → not fenced. */
  async insideWorkspace(path: string): Promise<boolean> {
    const resolved = await this.resolve(path);
    const roots = await this.realRoots();
    return roots.some((root) => resolved === root || resolved.startsWith(`${root}/`));
  }

  /** Roots realpath-normalized once (macOS /var → /private/var etc.). */
  private cachedRealRoots?: string[];
  private async realRoots(): Promise<string[]> {
    if (this.cachedRealRoots === undefined) {
      const normalized: string[] = [];
      for (const root of this.opts.workspaceRoots) {
        try {
          normalized.push(await this.opts.runtime.fs.realpath(root));
        } catch {
          normalized.push(root);
        }
      }
      this.cachedRealRoots = normalized;
    }
    return this.cachedRealRoots;
  }

  async resolve(path: string): Promise<string> {
    // Relative paths are anchored at the workspace root, matching how the
    // built-in tools resolve them. `~` is expanded through the runtime env.
    const expanded = path === '~' || path.startsWith('~/')
      ? `${this.opts.runtime.env.get('HOME') ?? ''}${path.slice(1)}`
      : path;
    const anchored = expanded.startsWith('/') ? expanded : `${this.opts.workspaceRoots[0]}/${expanded}`;
    try {
      return await this.opts.runtime.fs.realpath(anchored);
    } catch {
      // Path may not exist yet (write target): resolve the deepest existing ancestor.
      const parts = anchored.split('/');
      for (let i = parts.length; i > 0; i -= 1) {
        const ancestor = parts.slice(0, i).join('/') || '/';
        try {
          const real = await this.opts.runtime.fs.realpath(ancestor);
          return `${real}${anchored.slice(ancestor.length)}`;
        } catch {
          /* try next ancestor */
        }
      }
      return anchored;
    }
  }

  async check(tool: Tool, input: unknown, callId?: string): Promise<EngineOutcome> {
    const subject = tool.permissionSubject?.(input as never) ?? {};
    const effRisk = this.effectiveRisk(tool, subject);
    return this.checkSubject(tool.name, effRisk, subject, callId);
  }

  /** Bash commands get risk from classification: read → effectively read-only. */
  effectiveRisk(tool: Tool, subject: PermissionSubject): ToolRisk {
    if (tool.risk === 'exec' && subject.command !== undefined) {
      const cls = classifyCommand(subject.command);
      if (cls === 'read') return 'read';
    }
    return tool.risk;
  }

  async checkSubject(toolName: string, risk: ToolRisk, subject: PermissionSubject, callId?: string): Promise<EngineOutcome> {
    const verdict = await this.policyVerdict(toolName, risk, subject);
    if (verdict.outcome === 'ask') {
      return this.resolveAsk(toolName, verdict.risk, subject, verdict.reason, callId, verdict.sensitive === true);
    }
    return verdict;
  }

  /**
   * Deterministic policy only: never calls the approval handler. `ask` is
   * returned as a verdict so callers can re-evaluate after a hot setting
   * change without recursing into another prompt.
   */
  async policyVerdict(toolName: string, risk: ToolRisk, subject: PermissionSubject): Promise<PolicyVerdict> {
    // Exec risk with a concrete command is refined by classification (FR-043):
    // all-read-only segments count as read; dangerous never gets here (below).
    const commandClass = subject.command !== undefined ? classifyCommand(subject.command) : undefined;
    const effRisk: ToolRisk = risk === 'exec' && commandClass === 'read' ? 'read' : risk;

    // 1) Dangerous commands are denied outright; only a user-level rule that
    // names the exact command can pass (BR-006 / report S5). A wildcard bash
    // allow or a project/plugin-sourced rule must never open this door.
    if (commandClass === 'dangerous' && !this.dangerousAllowed(toolName, subject)) {
      return deny('SY-PERM-004', 'Command matched the dangerous-command pattern library (BR-006). Refusing to run it.');
    }

    // 2) Explicit deny always wins (BR-001).
    const denyRule = this.matchingRule(toolName, subject, 'deny');
    if (denyRule !== undefined) {
      return deny('SY-PERM-001', `Denied by ${denyRule.source} rule for tool '${toolName}'.`);
    }

    // 3) Sensitive paths ask in every mode, including bypass, and can never be
    // remembered for the session (report S4 supplementary rule).
    if (await this.isSensitiveSubject(subject)) {
      return {
        outcome: 'ask',
        risk: effRisk,
        sensitive: true,
        reason: 'This path is sensitive (workspace secrets or credential directory); explicit approval is required and cannot be remembered.',
      };
    }

    // 4) ask → allow; first matching effect wins (BR-001).
    for (const effect of ['ask', 'allow'] as const) {
      const rule = this.matchingRule(toolName, subject, effect);
      if (rule !== undefined) {
        if (effect === 'allow') return { outcome: 'allow' };
        return { outcome: 'ask', risk: effRisk, reason: `Rule (${rule.source}) set this tool to ask.` };
      }
    }

    // 5) Mode defaults when no rule matched (BR-001).
    const outsideRead =
      effRisk === 'read' ? await this.hasPathOutsideWorkspace(subject) : false;
    switch (this.opts.mode) {
      case 'bypass':
        return { outcome: 'allow' };
      case 'plan':
        if (effRisk === 'read') {
          if (outsideRead) {
            return {
              outcome: 'ask',
              risk: effRisk,
              reason: 'Plan mode reads outside the workspace only with explicit approval (report S4).',
            };
          }
          return { outcome: 'allow' };
        }
        return deny('SY-PERM-001', 'Plan mode only permits read-only tools.');
      case 'strict':
        // Strictest tier: even reads ask (CLI default when launched bare).
        return {
          outcome: 'ask',
          risk: effRisk,
          reason:
            effRisk === 'read'
              ? 'Strict mode confirms every operation, including reads.'
              : `Strict mode: tool '${toolName}' is a ${effRisk}-level operation.`,
        };
      case 'acceptEdits': {
        if (effRisk === 'read') {
          if (outsideRead) {
            return {
              outcome: 'ask',
              risk: effRisk,
              reason: 'Reading outside the workspace requires explicit approval (report S4).',
            };
          }
          return { outcome: 'allow' };
        }
        if (effRisk === 'write' && subject.path !== undefined) {
          const inside = await this.insideWorkspace(subject.path);
          if (inside) return { outcome: 'allow' };
          return deny('SY-PERM-003', 'Path is outside the workspace; acceptEdits does not cover it (BR-003).');
        }
        return { outcome: 'ask', risk: effRisk, reason: 'acceptEdits only auto-accepts workspace edits.' };
      }
      case 'default':
      default:
        if (effRisk === 'read') {
          if (outsideRead) {
            return {
              outcome: 'ask',
              risk: effRisk,
              reason: 'Reading outside the workspace requires explicit approval (report S4).',
            };
          }
          return { outcome: 'allow' };
        }
        // Path fence: outside workspace degrades to ask even for writes (BR-003).
        if (subject.path !== undefined && !(await this.insideWorkspace(subject.path))) {
          return deny('SY-PERM-003', 'Path is outside the workspace and has not been approved (BR-003).');
        }
        return { outcome: 'ask', risk: effRisk, reason: `Tool '${toolName}' is a ${effRisk}-level operation.` };
    }
  }

  /** Approval rounds allowed for one request; bounds hot-policy-change loops. */
  static readonly MAX_APPROVAL_ROUNDS = 8;

  /** Dangerous commands require a user-sourced rule naming the exact command. */
  private dangerousAllowed(toolName: string, subject: PermissionSubject): boolean {
    if (subject.command === undefined) return false;
    return this.opts.rules.some(
      (rule) =>
        rule.effect === 'allow' &&
        rule.source === 'user' &&
        globMatch(rule.tool, toolName) &&
        rule.match?.command === subject.command,
    );
  }

  private subjectPaths(subject: PermissionSubject): string[] {
    const paths = subject.path !== undefined ? [subject.path] : [];
    if (subject.command !== undefined) paths.push(...commandPathCandidates(subject.command));
    return paths;
  }

  private async hasPathOutsideWorkspace(subject: PermissionSubject): Promise<boolean> {
    for (const path of this.subjectPaths(subject)) {
      if (!(await this.insideWorkspace(path))) return true;
    }
    return false;
  }

  private async isSensitiveSubject(subject: PermissionSubject): Promise<boolean> {
    for (const path of this.subjectPaths(subject)) {
      if (await this.isSensitivePath(path)) return true;
    }
    return false;
  }

  private async isSensitivePath(path: string): Promise<boolean> {
    const resolved = await this.resolve(path);
    const home = this.opts.runtime.env.get('HOME');
    if (home !== undefined && home !== '') {
      for (const entry of SENSITIVE_HOME_ENTRIES) {
        const target = `${home}/${entry}`;
        if (resolved === target || resolved.startsWith(`${target}/`)) return true;
      }
    }
    const base = resolved.slice(resolved.lastIndexOf('/') + 1);
    if (WORKSPACE_SECRET_BASENAME.test(base)) {
      const roots = await this.realRoots();
      if (roots.some((root) => resolved === root || resolved.startsWith(`${root}/`))) return true;
    }
    return false;
  }

  private async resolveAsk(
    toolName: string,
    risk: ToolRisk,
    subject: PermissionSubject,
    reason: string,
    callId?: string,
    sensitive = false,
  ): Promise<EngineOutcome> {
    const handler = this.opts.onRequest ?? this.opts.handler;
    if (handler === undefined) {
      // ask without a handler is a deny (SY-PERM-005). Headless CLI relies on this.
      return deny('SY-PERM-005', `Operation needs approval but no permission handler is configured; treated as deny. (${reason})`);
    }

    let currentRisk = risk;
    let currentReason = reason;
    for (let round = 0; round < PermissionEngine.MAX_APPROVAL_ROUNDS; round += 1) {
      const req: PermissionRequest = {
        id: this.opts.runtime.ids.next('perm'),
        tool: toolName,
        risk: currentRisk,
        subject,
        reason: currentReason,
        ...(sensitive ? { sensitive: true } : {}),
        ...(callId !== undefined ? { callId } : {}),
      };
      this.opts.onRequestStart?.(req);
      const decision = await handler(req);

      // Hot setting change: re-evaluate under the *new* policy instead of
      // answering. Upgrading the tier can therefore settle the pending request
      // without a second prompt.
      if ('recheck' in decision) {
        const now = await this.policyVerdict(toolName, currentRisk, subject);
        if (now.outcome === 'allow') {
          this.opts.onResult?.(req.id, 'allow', 'user');
          return { outcome: 'allow' };
        }
        if (now.outcome === 'deny') {
          this.opts.onResult?.(req.id, 'deny', 'user');
          return now;
        }
        // Still ask under the new policy: prompt again with the updated reason.
        currentRisk = now.risk;
        currentReason = now.reason;
        sensitive = now.sensitive === true;
        continue;
      }

      const by = decision.decision === 'allow' ? 'user' : 'user-deny';
      this.opts.onResult?.(req.id, decision.decision, by);
      if (decision.decision === 'allow') {
        // Sensitive approvals are always one-shot, even if the approver asked
        // to remember them.
        if (!sensitive && (decision.remember === 'project' || decision.remember === 'session')) {
          this.remember(toolName, subject, decision.remember);
        }
        return { outcome: 'allow' };
      }
      return deny('SY-PERM-002', decision.message ?? 'The user denied this operation.');
    }

    // Guard against an approver that never settles the request.
    return deny(
      'SY-PERM-002',
      `Approval did not settle after ${PermissionEngine.MAX_APPROVAL_ROUNDS} rounds of policy changes; treated as deny.`,
    );
  }

  private remember(toolName: string, subject: PermissionSubject, scope: 'session' | 'project'): void {
    const rule: PermissionRule = {
      effect: 'allow',
      tool: toolName,
      source: scope === 'session' ? 'code' : 'user',
      ...(subject.path !== undefined ? { match: { path: subject.path } } : {}),
      ...(subject.command !== undefined ? { match: { command: subject.command } } : {}),
    };
    this.addRules([rule]);
  }

  private matchingRule(
    toolName: string,
    subject: PermissionSubject,
    effect: 'allow' | 'ask' | 'deny',
  ): PermissionRule | undefined {
    return this.opts.rules.find((rule) => {
      if (rule.effect !== effect) return false;
      if (!globMatch(rule.tool, toolName)) return false;
      const m = rule.match;
      if (m === undefined) return true;
      if (m.path !== undefined && (subject.path === undefined || !globMatch(m.path, subject.path))) return false;
      if (m.command !== undefined && (subject.command === undefined || !globMatch(m.command, subject.command))) return false;
      if (m.url !== undefined && (subject.url === undefined || !globMatch(m.url, subject.url))) return false;
      return true;
    });
  }
}

function deny(code: string, modelMessage: string): { outcome: 'deny'; error: PermissionError } {
  return { outcome: 'deny', error: new PermissionError({ code, modelMessage, message: modelMessage }) };
}
