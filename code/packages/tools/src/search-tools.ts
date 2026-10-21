import { z } from 'zod';
import { FsError, globMatch, type Tool, type ToolContext, type ToolOutput } from '@syaocode/core';

/**
 * glob / grep (FR-034): workspace search honoring .gitignore.
 * A pragmatic subset of gitignore semantics: literal names, directory
 * prefixes, `*`/`**`/`?` wildcards, leading-`/` anchoring, `!` negation.
 */

const ALWAYS_IGNORED = new Set(['node_modules', '.git', 'dist', 'build', '.DS_Store', 'coverage']);
const MAX_RESULTS = 200;
const MAX_DEPTH = 12;

export interface IgnoreRules {
  patterns: { negated: boolean; anchored: boolean; dirOnly: boolean; pattern: string }[];
}

export async function loadGitignore(runtime: ToolContext['runtime'], cwd: string): Promise<IgnoreRules> {
  const rules: IgnoreRules = { patterns: [] };
  for (const gitignore of [`${cwd}/.gitignore`]) {
    if (!(await runtime.fs.exists(gitignore))) continue;
    const text = await runtime.fs.readFile(gitignore);
    for (const raw of text.split('\n')) {
      const line = raw.trim();
      if (line === '' || line.startsWith('#')) continue;
      const negated = line.startsWith('!');
      let p = negated ? line.slice(1) : line;
      const dirOnly = p.endsWith('/');
      if (dirOnly) p = p.slice(0, -1);
      const anchored = p.startsWith('/');
      if (anchored) p = p.slice(1);
      if (p !== '') rules.patterns.push({ negated, anchored, dirOnly, pattern: p });
    }
  }
  return rules;
}

export function isIgnored(relPath: string, isDir: boolean, rules: IgnoreRules): boolean {
  if (ALWAYS_IGNORED.has(relPath.split('/').pop() ?? '')) return true;
  let ignored = false;
  for (const rule of rules.patterns) {
    const target = rule.dirOnly && !isDir ? parentChain(relPath) : relPath;
    let hit = false;
    if (rule.anchored) {
      hit = globMatch(rule.pattern, target) || (rule.pattern.includes('/') === false && target.split('/').some((seg) => globMatch(rule.pattern, seg)));
    } else {
      hit = target.split('/').some((seg) => globMatch(rule.pattern, seg)) || globMatch(rule.pattern, target);
    }
    if (hit) ignored = !rule.negated;
  }
  return ignored;
}

function parentChain(path: string): string {
  return path.split('/').slice(0, -1).join('/');
}

async function* walk(
  runtime: ToolContext['runtime'],
  dir: string,
  rules: IgnoreRules,
  depth = 0,
): AsyncGenerator<string> {
  if (depth > MAX_DEPTH) return;
  let entries;
  try {
    entries = await runtime.fs.readdir(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = `${dir}/${entry.name}`;
    if (isIgnored(full, entry.isDirectory, rules)) continue;
    if (entry.isDirectory) {
      yield* walk(runtime, full, rules, depth + 1);
    } else if (entry.isFile) {
      yield full;
    }
  }
}

export function createGlobTool() {
  const schema = z.object({
    pattern: z.string().min(1),
    path: z.string().optional().describe('Directory to search in; default workspace root'),
  });
  const tool: Tool<z.output<typeof schema>> = {
    name: 'glob',
    description: 'Find files matching a glob pattern (e.g. "src/**/*.ts"), respecting .gitignore. Returns matching paths, newest-first is not guaranteed.',
    inputSchema: schema,
    risk: 'read',
    readOnly: true,
    concurrencySafe: true,
    timeoutMs: 30_000,
    permissionSubject: (input) => ({ path: input.path ?? '.' }),
    async execute(input, ctx: ToolContext): Promise<ToolOutput> {
      const root = input.path !== undefined ? (input.path.startsWith('/') ? input.path : `${ctx.cwd}/${input.path}`) : ctx.cwd;
      const rules = await loadGitignore(ctx.runtime, ctx.cwd);
      const found: string[] = [];
      for await (const file of walk(ctx.runtime, root, rules)) {
        const rel = file.startsWith(`${ctx.cwd}/`) ? file.slice(ctx.cwd.length + 1) : file;
        if (globMatch(input.pattern, rel) || globMatch(input.pattern, file)) {
          found.push(rel);
          if (found.length >= MAX_RESULTS) break;
        }
      }
      if (found.length === 0) {
        return { content: [{ type: 'text', text: 'No files matched.' }] };
      }
      return { content: [{ type: 'text', text: found.join('\n') }] };
    },
  };
  return tool;
}

export function createGrepTool() {
  const schema = z.object({
    pattern: z.string().min(1).describe('ECMAScript regular expression'),
    path: z.string().optional().describe('Directory to search; default workspace root'),
    include: z.string().optional().describe('Glob filter for file names, e.g. "*.ts"'),
  });
  const tool: Tool<z.output<typeof schema>> = {
    name: 'grep',
    description: 'Search file contents with a regular expression. Returns file:line:text matches (capped). Respects .gitignore.',
    inputSchema: schema,
    risk: 'read',
    readOnly: true,
    concurrencySafe: true,
    timeoutMs: 60_000,
    permissionSubject: (input) => ({ path: input.path ?? '.' }),
    async execute(input, ctx: ToolContext): Promise<ToolOutput> {
      let re: RegExp;
      try {
        re = new RegExp(input.pattern);
      } catch (e) {
        throw new FsError({
          code: 'SY-TOOL-002',
          modelMessage: `Invalid regular expression: ${e instanceof Error ? e.message : String(e)}`,
          cause: e,
        });
      }
      const root = input.path !== undefined ? (input.path.startsWith('/') ? input.path : `${ctx.cwd}/${input.path}`) : ctx.cwd;
      const rules = await loadGitignore(ctx.runtime, ctx.cwd);
      const hits: string[] = [];
      outer: for await (const file of walk(ctx.runtime, root, rules)) {
        const rel = file.startsWith(`${ctx.cwd}/`) ? file.slice(ctx.cwd.length + 1) : file;
        if (input.include !== undefined && !globMatch(input.include, rel.split('/').pop() ?? '')) continue;
        let content: string;
        try {
          content = await ctx.runtime.fs.readFile(file);
        } catch {
          continue;
        }
        const lines = content.split('\n');
        for (let i = 0; i < lines.length; i += 1) {
          if (re.test(lines[i] ?? '')) {
            hits.push(`${rel}:${i + 1}:${(lines[i] ?? '').trim().slice(0, 200)}`);
            if (hits.length >= MAX_RESULTS) break outer;
          }
        }
      }
      if (hits.length === 0) {
        return { content: [{ type: 'text', text: 'No matches found.' }] };
      }
      return { content: [{ type: 'text', text: hits.join('\n') }] };
    },
  };
  return tool;
}
