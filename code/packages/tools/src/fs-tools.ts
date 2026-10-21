import { z } from 'zod';
import { FsError, type Tool, type ToolContext, type ToolOutput } from '@syaocode/core';
import type { FileStateTracker } from './file-state.js';

const MAX_READ_LINES = 2000;

function resolvePath(cwd: string, p: string): string {
  return p.startsWith('/') ? p : `${cwd}/${p}`;
}

/** read (FR-030): line-numbered output, optional line range. */
export function createReadTool(state: FileStateTracker) {
  const schema = z.object({
    path: z.string().min(1).describe('File path, relative to workspace root or absolute'),
    offset: z.number().int().min(1).optional().describe('1-based first line to read'),
    limit: z.number().int().min(1).optional().describe('Max lines to return'),
  });
  const tool: Tool<z.output<typeof schema>> = {
    name: 'read',
    description: 'Read a text file from the workspace. Output has line numbers (cat -n format). Use offset/limit for large files.',
    inputSchema: schema,
    risk: 'read',
    readOnly: true,
    concurrencySafe: true,
    timeoutMs: 30_000,
    permissionSubject: (input) => ({ path: input.path }),
    async execute(input, ctx: ToolContext): Promise<ToolOutput> {
      const path = resolvePath(ctx.cwd, input.path);
      let content: string;
      try {
        content = await ctx.runtime.fs.readFile(path);
      } catch (e) {
        throw new FsError({
          code: 'SY-FS-005',
          modelMessage: `Cannot read ${input.path}: ${e instanceof Error ? e.message : String(e)}`,
          cause: e,
        });
      }
      const stat = await ctx.runtime.fs.stat(path).catch(() => undefined);
      if (stat !== undefined) state.recordRead(path, content, stat.mtimeMs);

      const all = content.split('\n');
      const start = (input.offset ?? 1) - 1;
      const end = start + Math.min(input.limit ?? MAX_READ_LINES, MAX_READ_LINES);
      const lines = all.slice(start, end);
      const body = lines.map((line, i) => `${String(start + i + 1).padStart(6)}\t${line}`).join('\n');
      const more = all.length > end ? `\n… [${all.length - end} more lines; read with offset=${start + end + 1}]` : '';
      return { content: [{ type: 'text', text: `${body}${more}` }] };
    },
  };
  return tool;
}

/** write (FR-031): whole-file write; existing files must have been read (BR-004). */
export function createWriteTool(state: FileStateTracker) {
  const schema = z.object({
    path: z.string().min(1),
    content: z.string(),
  });
  const tool: Tool<z.output<typeof schema>> = {
    name: 'write',
    description: 'Write an entire file. The file must have been read first if it already exists. Creates parent directories.',
    inputSchema: schema,
    risk: 'write',
    readOnly: false,
    concurrencySafe: false,
    timeoutMs: 30_000,
    permissionSubject: (input) => ({ path: input.path }),
    async execute(input, ctx: ToolContext): Promise<ToolOutput> {
      const path = resolvePath(ctx.cwd, input.path);
      const existed = await ctx.runtime.fs.exists(path);
      if (existed) {
        const current = await ctx.runtime.fs.readFile(path);
        const stat = await ctx.runtime.fs.stat(path);
        state.assertUnchanged(path, current, stat.mtimeMs);
      }
      try {
        await ctx.runtime.fs.mkdir(path.slice(0, path.lastIndexOf('/')) || '/', { recursive: true });
        await ctx.runtime.fs.writeFile(path, input.content);
      } catch (e) {
        throw new FsError({
          code: 'SY-FS-006',
          modelMessage: `Failed to write ${input.path}: ${e instanceof Error ? e.message : String(e)}`,
          cause: e,
        });
      }
      const stat = await ctx.runtime.fs.stat(path);
      state.recordWrite(path, input.content, stat.mtimeMs);
      return { content: [{ type: 'text', text: `Wrote ${input.content.length} chars to ${input.path}${existed ? ' (overwrote)' : ' (created)'}` }] };
    },
  };
  return tool;
}

/** edit (FR-032 / BR-005): unique-match string replacement with fencing. */
export function createEditTool(state: FileStateTracker) {
  const schema = z.object({
    path: z.string().min(1),
    old_string: z.string().min(1),
    new_string: z.string(),
    replace_all: z.boolean().optional(),
  });
  const tool: Tool<z.output<typeof schema>> = {
    name: 'edit',
    description: 'Replace an exact string in a file. old_string must match exactly once unless replace_all=true. File must have been read first.',
    inputSchema: schema,
    risk: 'write',
    readOnly: false,
    concurrencySafe: false,
    timeoutMs: 30_000,
    permissionSubject: (input) => ({ path: input.path }),
    async execute(input, ctx: ToolContext): Promise<ToolOutput> {
      const path = resolvePath(ctx.cwd, input.path);
      let content: string;
      try {
        content = await ctx.runtime.fs.readFile(path);
      } catch (e) {
        throw new FsError({ code: 'SY-FS-005', modelMessage: `Cannot read ${input.path}`, cause: e });
      }
      const stat = await ctx.runtime.fs.stat(path);
      state.assertUnchanged(path, content, stat.mtimeMs);

      const matches: number[] = [];
      let idx = content.indexOf(input.old_string);
      while (idx >= 0) {
        matches.push(idx);
        idx = content.indexOf(input.old_string, idx + 1);
      }
      if (matches.length === 0) {
        const line = nearestLine(content, input.old_string.slice(0, 40));
        throw new FsError({
          code: 'SY-FS-004',
          modelMessage: `old_string not found in ${input.path}. ${line}`,
        });
      }
      if (matches.length > 1 && input.replace_all !== true) {
        const lineNos = matches.map((m) => content.slice(0, m).split('\n').length);
        throw new FsError({
          code: 'SY-FS-003',
          modelMessage: `The string appears ${matches.length} times (lines ${lineNos.slice(0, 5).join(', ')}${lineNos.length > 5 ? ', …' : ''}). Add surrounding lines to make it unique, or set replace_all to true.`,
        });
      }

      const updated =
        input.replace_all === true
          ? content.split(input.old_string).join(input.new_string)
          : content.replace(input.old_string, input.new_string);
      try {
        await ctx.runtime.fs.writeFile(path, updated);
      } catch (e) {
        throw new FsError({ code: 'SY-FS-006', modelMessage: `Failed to write ${input.path}`, cause: e });
      }
      const newStat = await ctx.runtime.fs.stat(path);
      state.recordWrite(path, updated, newStat.mtimeMs);
      const count = input.replace_all === true ? matches.length : 1;
      return { content: [{ type: 'text', text: `Edited ${input.path}: replaced ${count} occurrence${count > 1 ? 's' : ''}` }] };
    },
  };
  return tool;
}

function nearestLine(content: string, fragment: string): string {
  const lines = content.split('\n');
  const firstWord = fragment.split(/\s+/)[0] ?? '';
  if (firstWord.length >= 3) {
    for (let i = 0; i < lines.length; i += 1) {
      if (lines[i]?.includes(firstWord) === true) {
        return `Did you mean line ${i + 1}: ${lines[i]!.slice(0, 80)}`;
      }
    }
  }
  return '';
}
