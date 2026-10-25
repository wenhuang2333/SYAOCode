import * as fs from 'node:fs';
import * as path from 'node:path';
import { classifyCommand, discoverVerification } from '@syaocode/core';
import { nodeRuntime } from '@syaocode/node';
import type { CliArgs } from './args.js';
import { cliCwd } from './effective-config.js';

/**
 * `syao verify init`: confirm the discovered verification commands once and
 * pin them in .syaocode/verify.json (report §12.1).
 */
export async function runVerifyInit(args: CliArgs): Promise<number> {
  const cwd = cliCwd(args);
  const runtime = nodeRuntime();
  const discovered = await discoverVerification(runtime, cwd);
  const dangerous = discovered.filter((c) => classifyCommand(c.command) === 'dangerous');
  const commands = discovered.filter((c) => classifyCommand(c.command) !== 'dangerous');
  if (commands.length === 0) {
    process.stderr.write('No safe verification command discovered. Add .syaocode/verify.json with a "commands" array.\n');
    return 1;
  }
  for (const c of dangerous) process.stderr.write(`refusing dangerous command: ${c.command}\n`);
  const file = path.join(cwd, '.syaocode', 'verify.json');
  if (fs.existsSync(file) && args.force !== true) {
    process.stdout.write(`${file} already exists (use --force to overwrite).\n`);
    for (const c of commands) process.stdout.write(`  ${c.command}  (${c.source}, ${c.scope})\n`);
    return 0;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    `${JSON.stringify(
      { commands: commands.map((c) => ({ command: c.command, scope: c.scope, source: c.source })) },
      null,
      2,
    )}\n`,
  );
  process.stdout.write(`Wrote ${file}\n`);
  for (const c of commands) process.stdout.write(`  ${c.command}  (${c.source}, ${c.scope})\n`);
  return 0;
}
