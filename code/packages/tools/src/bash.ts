import { z } from 'zod';
import { ToolError, type Tool, type ToolContext, type ToolOutput } from '@syaocode/core';

/**
 * Restricted bash (FR-035, WP-1.5). Command risk classification happens in
 * the permission engine via `permissionSubject` — dangerous commands never
 * reach execute (BR-006). Runs through the injected Runtime.shell, keeps a
 * persistent working directory across calls, and truncates combined output.
 */

const OUTPUT_CAP = 100_000; // collected before pipeline-level truncation

export function createBashTool(opts: { defaultTimeoutMs?: number } = {}) {
  let persistentCwd: string | undefined;
  const schema = z.object({
    command: z.string().min(1),
    timeout_ms: z.number().int().min(100).max(600_000).optional(),
  });
  const tool: Tool<z.output<typeof schema>> = {
    name: 'bash',
    description:
      'Execute a shell command in the workspace. Working directory persists across calls. ' +
      'Dangerous commands (recursive root deletes, forced pushes, disk formats) are refused. ' +
      'Long-running output is truncated.',
    inputSchema: schema,
    risk: 'exec',
    readOnly: false,
    concurrencySafe: false,
    timeoutMs: opts.defaultTimeoutMs ?? 120_000,
    permissionSubject: (input) => ({ command: input.command }),
    async execute(input, ctx: ToolContext): Promise<ToolOutput> {
      const timeoutMs = input.timeout_ms ?? opts.defaultTimeoutMs ?? 120_000;
      const cwd = persistentCwd ?? ctx.cwd;
      const isWin = process.platform === 'win32';
      const shell = isWin ? 'cmd' : '/bin/sh';
      const args = isWin ? ['/c', input.command] : ['-c', input.command];

      const proc = ctx.runtime.shell.spawn(shell, args, {
        cwd,
        timeoutMs,
        signal: ctx.signal,
        detached: !isWin,
      });

      let out = '';
      const collect = async (stream: AsyncIterable<string>) => {
        for await (const line of stream) {
          if (out.length < OUTPUT_CAP) out += `${line}\n`;
        }
      };
      const code = await Promise.all([proc.exited, collect(proc.stdout), collect(proc.stderr)]).then(
        ([exitCode]) => exitCode,
      );

      if (code === 0) {
        // Capture cd for persistence only when the command was a pure cd.
        const pureCd = input.command.trim().match(/^cd\s+(\S+)$/);
        if (pureCd?.[1] !== undefined) persistentCwd = resolveDir(cwd, pureCd[1]);
      }

      const text = out.length >= OUTPUT_CAP ? `${out}\n… [output capped at ${OUTPUT_CAP} chars]` : out;
      const result = text === '' ? '(no output)' : text;
      return {
        content: [{ type: 'text', text: `exit=${code}\n${result}` }],
        ...(code !== 0 ? { isError: true } : {}),
      };
    },
  };
  return tool;
}

function resolveDir(cwd: string, target: string): string {
  if (target.startsWith('/')) return target;
  if (target === '~') return process.env.HOME ?? cwd;
  return `${cwd}/${target}`.replace(/\/\.\//g, '/').replace(/\/[^/]+\/\.\./g, '');
}
