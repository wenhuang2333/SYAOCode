/**
 * Minimal eval harness (G1 baseline seed — 10 deterministic tasks for v0.1;
 * grows to the 30-task set as M1 continues). Runs scripted MockProvider
 * turns through the REAL agent loop + tools + permission engine against an
 * in-memory workspace, then verifies the end state. No network, no keys.
 *
 * Usage: corepack pnpm exec tsx evals/run-eval.ts [--json]
 */
import { createAgent, type Message } from '@syaocode/core';
import { createBuiltinTools } from '@syaocode/tools';
import { MemoryRuntime, MockProvider, mockText, mockToolUse } from '@syaocode/testing';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

interface TaskStep {
  toolUse?: { id: string; name: string; input: unknown };
  text?: string;
}

interface EvalTask {
  id: string;
  description: string;
  seed: Record<string, string>;
  prompt: string;
  script: TaskStep[];
  verify: {
    finalTextIncludes?: string;
    fileEquals?: { path: string; content: string };
  };
}

const here = dirname(fileURLToPath(import.meta.url));
const tasks: EvalTask[] = JSON.parse(readFileSync(join(here, 'tasks.json'), 'utf8'));

// deterministic stand-in shell for evals
const echoCommands: Record<string, (args: string[]) => { code: number; stdout: string }> = {
  '/bin/sh': (args) => {
    const line = args.filter((a) => a !== '-c').join(' ');
    if (line === 'node check.js') return { code: 0, stdout: 'check passed' };
    if (line.startsWith('echo ')) return { code: 0, stdout: line.slice(5) };
    return { code: 0, stdout: '' };
  },
};

const asJson = process.argv.includes('--json');
const results: { id: string; pass: boolean; detail: string }[] = [];

for (const task of tasks) {
  const runtime = new MemoryRuntime({ seed: task.seed, commands: echoCommands });
  const script: Message[] = task.script.map((step, i) =>
    step.toolUse !== undefined
      ? mockToolUse(`m${i}`, [step.toolUse])
      : mockText(`m${i}`, step.text ?? ''),
  );
  const provider = new MockProvider({ script });
  const { tools } = createBuiltinTools();
  const agent = createAgent({
    provider,
    model: 'mock-eval',
    cwd: '/ws',
    tools,
    runtime,
    permissionMode: 'acceptEdits',
  });
  let detail = '';
  let pass = false;
  try {
    const summary = await agent.runOnce(task.prompt);
    const checks: boolean[] = [];
    if (task.verify.finalTextIncludes !== undefined) {
      const ok = summary.finalText.includes(task.verify.finalTextIncludes);
      checks.push(ok);
      if (!ok) detail = `finalText missing '${task.verify.finalTextIncludes}': got '${summary.finalText.slice(0, 120)}'`;
    }
    if (task.verify.fileEquals !== undefined) {
      const want = task.verify.fileEquals;
      const got = await runtime.fs.readFile(want.path).catch(() => undefined);
      const ok = got === want.content;
      checks.push(ok);
      if (!ok) detail = `file mismatch at ${want.path}: got ${JSON.stringify(got?.slice(0, 120))}`;
    }
    pass = checks.length > 0 && checks.every(Boolean);
    if (pass) detail = `end=${summary.endReason} turns=${summary.turns}`;
  } catch (e) {
    pass = false;
    detail = `threw: ${e instanceof Error ? e.message : String(e)}`;
  }
  results.push({ id: task.id, pass, detail });
}

const passed = results.filter((r) => r.pass).length;
if (asJson) {
  console.log(JSON.stringify({ total: results.length, passed, results }, null, 2));
} else {
  for (const r of results) {
    console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.id.padEnd(32)} ${r.detail}`);
  }
  console.log(`\n${passed}/${results.length} passed`);
}
process.exitCode = passed === results.length ? 0 : 1;
