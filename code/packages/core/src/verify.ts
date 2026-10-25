import type { Runtime } from './runtime/index.js';
import type { Redactor } from './redact.js';
import {
  parseTestStats,
  type ReceiptStore,
  type VerificationResult,
  type VerificationReport,
} from './evidence.js';

/**
 * Verification discovery + execution (report §12.1 / §12.6).
 *
 * Priority: explicit `.syaocode/verify.json` → AGENTS.md → CI workflow →
 * package.json scripts → language conventions. The first source that yields
 * a command wins, so a team can pin its real merge gate once.
 */

export interface VerificationOptions {
  enabled?: boolean;
  /** Explicit commands override discovery and are always trusted. */
  commands?: string[];
  /**
   * Run commands discovered from AGENTS.md/CI/package scripts without a prior
   * `verify init`. Off by default: auto-running a repository-controlled
   * command would bypass the permission gate.
   */
  allowDiscovered?: boolean;
  timeoutMs?: number;
  /** Also run the same commands before the first edit (report baseline). */
  baseline?: boolean;
}

export interface DiscoveredCommand {
  command: string;
  source: 'config' | 'agents' | 'ci' | 'package' | 'language';
  scope: 'related' | 'full';
}

const OUTPUT_CAP = 200_000;
const MAX_COMMANDS = 3;

export async function discoverVerification(runtime: Runtime, cwd: string): Promise<DiscoveredCommand[]> {
  const configured = await readVerifyJson(runtime, cwd);
  if (configured.length > 0) return configured.slice(0, MAX_COMMANDS);

  const agents = await readAgentsCommands(runtime, cwd);
  if (agents.length > 0) return dedupe(agents).slice(0, MAX_COMMANDS);

  const ci = await readCiCommands(runtime, cwd);
  if (ci.length > 0) return dedupe(ci).slice(0, MAX_COMMANDS);

  const pkg = await readPackageCommands(runtime, cwd);
  if (pkg.length > 0) return dedupe(pkg).slice(0, MAX_COMMANDS);

  const lang = await readLanguageCommands(runtime, cwd);
  return dedupe(lang).slice(0, MAX_COMMANDS);
}

async function readFileIfExists(runtime: Runtime, path: string): Promise<string | undefined> {
  try {
    if (!(await runtime.fs.exists(path))) return undefined;
    return await runtime.fs.readFile(path);
  } catch {
    return undefined;
  }
}

async function readVerifyJson(runtime: Runtime, cwd: string): Promise<DiscoveredCommand[]> {
  const text = await readFileIfExists(runtime, `${cwd}/.syaocode/verify.json`);
  if (text === undefined) return [];
  try {
    const parsed = JSON.parse(text) as unknown;
    const raw =
      Array.isArray(parsed)
        ? parsed
        : parsed !== null && typeof parsed === 'object' && Array.isArray((parsed as { commands?: unknown }).commands)
          ? ((parsed as { commands: unknown[] }).commands)
          : [];
    return raw
      .map((item): DiscoveredCommand | undefined => {
        if (typeof item === 'string' && item.trim() !== '') return { command: item.trim(), source: 'config', scope: 'full' };
        if (item !== null && typeof item === 'object') {
          const obj = item as { command?: unknown; scope?: unknown };
          if (typeof obj.command === 'string' && obj.command.trim() !== '') {
            return {
              command: obj.command.trim(),
              source: 'config',
              scope: obj.scope === 'related' ? 'related' : 'full',
            };
          }
        }
        return undefined;
      })
      .filter((x): x is DiscoveredCommand => x !== undefined);
  } catch {
    return [];
  }
}

const COMMAND_LINE = /^(?:[-*]\s*)?(?:`{1,3})?\s*((?:cd\s+\S+\s*&&\s*)?(?:corepack\s+)?(?:pnpm|npm|yarn|cargo|go|pytest|python\s+-m\s+pytest|npx\s+tsc|tsc)\b[^\n`]*)/;

async function readAgentsCommands(runtime: Runtime, cwd: string): Promise<DiscoveredCommand[]> {
  const text = await readFileIfExists(runtime, `${cwd}/AGENTS.md`);
  if (text === undefined) return [];
  const out: DiscoveredCommand[] = [];
  for (const line of text.split('\n')) {
    const m = line.trim().match(COMMAND_LINE);
    if (m?.[1] === undefined) continue;
    const command = m[1].trim();
    if (!/\b(test|typecheck|lint|build|check)\b/.test(command)) continue;
    out.push({ command, source: 'agents', scope: 'full' });
  }
  return out;
}

async function readCiCommands(runtime: Runtime, cwd: string): Promise<DiscoveredCommand[]> {
  const dir = `${cwd}/.github/workflows`;
  try {
    if (!(await runtime.fs.exists(dir))) return [];
    const files = (await runtime.fs.readdir(dir)).filter((e) => e.isFile && /\.ya?ml$/.test(e.name));
    const out: DiscoveredCommand[] = [];
    for (const file of files.sort((a, b) => a.name.localeCompare(b.name))) {
      const text = await readFileIfExists(runtime, `${dir}/${file.name}`);
      if (text === undefined) continue;
      for (const line of text.split('\n')) {
        const m = line.match(/^\s*-?\s*run:\s*(.+)$/);
        if (m?.[1] === undefined) continue;
        const command = m[1].trim().replace(/^["']|["']$/g, '');
        if (!/\b(test|typecheck|lint)\b/.test(command)) continue;
        if (command.includes('${{')) continue;
        out.push({ command, source: 'ci', scope: 'full' });
      }
    }
    return out;
  } catch {
    return [];
  }
}

async function readPackageCommands(runtime: Runtime, cwd: string): Promise<DiscoveredCommand[]> {
  const text = await readFileIfExists(runtime, `${cwd}/package.json`);
  if (text === undefined) return [];
  let scripts: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(text) as { scripts?: Record<string, unknown> };
    scripts = parsed.scripts ?? {};
  } catch {
    return [];
  }
  const pm = (await runtime.fs.exists(`${cwd}/pnpm-lock.yaml`))
    ? 'pnpm'
    : (await runtime.fs.exists(`${cwd}/yarn.lock`))
      ? 'yarn'
      : 'npm';
  const run = (name: string): string => (pm === 'npm' ? `npm run ${name}` : `${pm} run ${name}`);
  const out: DiscoveredCommand[] = [];
  for (const name of ['test', 'typecheck', 'lint', 'build']) {
    if (typeof scripts[name] === 'string') out.push({ command: run(name), source: 'package', scope: 'full' });
  }
  if (out.length === 0 && (await runtime.fs.exists(`${cwd}/tsconfig.json`))) {
    out.push({ command: 'npx tsc --noEmit', source: 'language', scope: 'full' });
  }
  return out;
}

async function readLanguageCommands(runtime: Runtime, cwd: string): Promise<DiscoveredCommand[]> {
  if (await runtime.fs.exists(`${cwd}/tsconfig.json`)) return [{ command: 'npx tsc --noEmit', source: 'language', scope: 'full' }];
  if (await runtime.fs.exists(`${cwd}/pyproject.toml`) || (await runtime.fs.exists(`${cwd}/pytest.ini`))) {
    return [{ command: 'pytest', source: 'language', scope: 'full' }];
  }
  if (await runtime.fs.exists(`${cwd}/Cargo.toml`)) return [{ command: 'cargo test', source: 'language', scope: 'full' }];
  if (await runtime.fs.exists(`${cwd}/go.mod`)) return [{ command: 'go test ./...', source: 'language', scope: 'full' }];
  return [];
}

function dedupe(commands: DiscoveredCommand[]): DiscoveredCommand[] {
  const seen = new Set<string>();
  return commands.filter((c) => (seen.has(c.command) ? false : (seen.add(c.command), true)));
}

export async function runVerification(
  runtime: Runtime,
  cwd: string,
  commands: DiscoveredCommand[],
  store: ReceiptStore | undefined,
  opts: { timeoutMs?: number; signal?: AbortSignal; redactor?: Redactor } = {},
): Promise<VerificationResult[]> {
  const results: VerificationResult[] = [];
  for (const item of commands) {
    results.push(await runOne(runtime, cwd, item, store, opts));
  }
  return results;
}

async function runOne(
  runtime: Runtime,
  cwd: string,
  item: DiscoveredCommand,
  store: ReceiptStore | undefined,
  opts: { timeoutMs?: number; signal?: AbortSignal; redactor?: Redactor },
): Promise<VerificationResult> {
  const startedAt = runtime.clock.now();
  let output = '';
  let truncated = false;
  let exitCode = 127;
  try {
    const proc = runtime.shell.spawn('/bin/sh', ['-c', item.command], {
      cwd,
      timeoutMs: opts.timeoutMs ?? 300_000,
      detached: true,
      ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    });
    const collect = async (stream: AsyncIterable<string>): Promise<void> => {
      for await (const line of stream) {
        if (output.length < OUTPUT_CAP) output += `${line}\n`;
        else truncated = true;
      }
    };
    const [code] = await Promise.all([proc.exited, collect(proc.stdout), collect(proc.stderr)]);
    exitCode = code;
  } catch (e) {
    output += `${e instanceof Error ? e.message : String(e)}\n`;
    exitCode = 127;
  }
  // Verification output may contain secrets printed by the test runner; the
  // same redaction boundary as tool results applies before evidence storage.
  if (opts.redactor !== undefined) output = opts.redactor.redact(output).text;
  let outputHash = '';
  let outputRef: string | undefined;
  if (store !== undefined) {
    try {
      const stored = await store.put(output);
      outputHash = stored.hash;
      outputRef = stored.ref;
    } catch {
      /* store failure must not turn a passing verification into a failure */
    }
  }
  const testStats = parseTestStats(output);
  return {
    command: item.command,
    source: item.source,
    scope: item.scope,
    exitCode,
    timestamp: runtime.clock.now(),
    durationMs: runtime.clock.now() - startedAt,
    outputHash,
    ...(outputRef !== undefined ? { outputRef } : {}),
    truncated,
    ...(testStats !== undefined ? { testStats } : {}),
  };
}

export function verificationPassed(report: VerificationReport | undefined): boolean {
  return report !== undefined && report.results.length > 0 && report.results.every((r) => r.exitCode === 0);
}
