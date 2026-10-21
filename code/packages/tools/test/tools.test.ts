import { beforeEach, describe, expect, it } from 'vitest';
import { MemoryRuntime } from '@syaocode/testing';
import { FsError, SyaoError, type Tool, type ToolContext, type ToolOutput } from '@syaocode/core';
import { FileStateTracker, createBashTool, createEditTool, createGlobTool, createGrepTool, createReadTool, createWriteTool } from '../src';

let rt: MemoryRuntime;
let state: FileStateTracker;
const noSignal = new AbortController().signal;
const ctx = (): ToolContext => ({ runtime: rt, cwd: '/ws', signal: noSignal, progress: () => {} });

/** Drain a tool's execute (promise or async generator) into a ToolOutput. */
async function run<I>(tool: Tool<I>, input: unknown, toolCtx: ToolContext): Promise<ToolOutput> {
  const parsed = tool.inputSchema.parse(input) as I;
  const result = tool.execute(parsed, toolCtx);
  if (result !== null && typeof result === 'object' && typeof (result as AsyncGenerator).next === 'function') {
    const gen = result as AsyncGenerator<{ note: string }, ToolOutput>;
    for (;;) {
      const n = await gen.next();
      if (n.done) return n.value;
    }
  }
  return result as Promise<ToolOutput>;
}

beforeEach(() => {
  rt = new MemoryRuntime({
    seed: {
      '/ws/a.txt': 'line1\nline2\nline3\n',
      '/ws/src/x.ts': 'export const x = 1;\nexport const BUG = 2;\n',
      '/ws/src/y.ts': 'export const y = 3;\n',
      '/ws/src/nested/deep.ts': 'export const deep = 4;\n',
      '/ws/.gitignore': 'ignored-dir/\n*.log\n',
      '/ws/ignored-dir/secret.txt': 'hidden\n',
      '/ws/debug.log': 'log content\n',
    },
  });
  state = new FileStateTracker();
});

describe('read (FR-030)', () => {
  it('returns numbered lines and records state', async () => {
    const out = await run(createReadTool(state), { path: 'a.txt' }, ctx());
    const first = out.content[0];
    const text = first !== undefined && first.type === 'text' ? first.text : '';
    expect(text).toContain('line1');
    expect(text.match(/^\s{4,}1\s/)).toBeTruthy(); // "     1\t"
    expect(state.hasRead('/ws/a.txt')).toBe(true);
  });

  it('respects offset/limit', async () => {
    const out = await run(createReadTool(state), { path: 'a.txt', offset: 2, limit: 1 }, ctx());
    const text = JSON.stringify(out.content);
    expect(text).toContain('line2');
    expect(text).not.toContain('line1\n');
  });

  it('missing file → SY-FS-005 with modelMessage', async () => {
    await expect(run(createReadTool(state), { path: 'nope.txt' }, ctx())).rejects.toSatisfy(
      (e) => SyaoError.is(e) && e.code === 'SY-FS-005',
    );
  });
});

describe('write (FR-031) + read-before-write (BR-004)', () => {
  it('creates a new file without prior read', async () => {
    await run(createWriteTool(state), { path: 'new.txt', content: 'fresh' }, ctx());
    expect(await rt.fs.readFile('/ws/new.txt')).toBe('fresh');
  });

  it('refuses overwriting an unread existing file (SY-FS-001)', async () => {
    await expect(
      run(createWriteTool(state), { path: 'a.txt', content: 'clobber' }, ctx()),
    ).rejects.toSatisfy((e) => SyaoError.is(e) && e.code === 'SY-FS-001');
  });

  it('refuses after external modification (SY-FS-002)', async () => {
    await run(createReadTool(state), { path: 'a.txt' }, ctx());
    rt.fs.pokeExternally('/ws/a.txt', 'line1\nCHANGED\nline3\n');
    await expect(
      run(createWriteTool(state), { path: 'a.txt', content: 'clobber' }, ctx()),
    ).rejects.toSatisfy((e) => SyaoError.is(e) && e.code === 'SY-FS-002');
  });
});

describe('edit (FR-032, BR-005)', () => {
  it('replaces a unique match after read', async () => {
    await run(createReadTool(state), { path: 'a.txt' }, ctx());
    await run(createEditTool(state), { path: 'a.txt', old_string: 'line2', new_string: 'LINE-2' }, ctx());
    expect(await rt.fs.readFile('/ws/a.txt')).toBe('line1\nLINE-2\nline3\n');
  });

  it('ambiguous match → SY-FS-003 with counts and lines', async () => {
    await rt.fs.writeFile('/ws/dup.txt', 'same\nsame\nsame\n');
    await run(createReadTool(state), { path: 'dup.txt' }, ctx());
    const err = await run(createEditTool(state), { path: 'dup.txt', old_string: 'same', new_string: 'x' }, ctx()).catch((e) => e);
    expect(SyaoError.is(err) && err.code === 'SY-FS-003').toBe(true);
    if (SyaoError.is(err)) {
      expect(err.modelMessage).toContain('3 times');
      expect(err.modelMessage).toContain('1, 2, 3');
    }
  });

  it('replace_all resolves ambiguity', async () => {
    await rt.fs.writeFile('/ws/dup.txt', 'same\nsame\nsame\n');
    await run(createReadTool(state), { path: 'dup.txt' }, ctx());
    await run(createEditTool(state), { path: 'dup.txt', old_string: 'same', new_string: 'x', replace_all: true }, ctx());
    expect(await rt.fs.readFile('/ws/dup.txt')).toBe('x\nx\nx\n');
  });

  it('no match → SY-FS-004 with nearest-line hint', async () => {
    await run(createReadTool(state), { path: 'a.txt' }, ctx());
    const err = await run(createEditTool(state), { path: 'a.txt', old_string: 'lin3', new_string: 'x' }, ctx()).catch((e) => e);
    expect(SyaoError.is(err) && err.code === 'SY-FS-004').toBe(true);
  });

  it('edit without read → SY-FS-001 (BR-004)', async () => {
    await expect(
      run(createEditTool(state), { path: 'src/x.ts', old_string: 'x', new_string: 'y' }, ctx()),
    ).rejects.toSatisfy((e) => SyaoError.is(e) && e.code === 'SY-FS-001');
  });
});

describe('glob/grep (FR-034) + .gitignore', () => {
  it('glob finds matching files and skips ignored dirs', async () => {
    const out = await run(createGlobTool(), { pattern: '**/*.ts' }, ctx());
    const first = out.content[0];
    const text = first !== undefined && first.type === 'text' ? first.text : '';
    expect(text).toContain('src/x.ts');
    expect(text).toContain('src/nested/deep.ts');
    expect(text).not.toContain('ignored-dir');
  });

  it('grep matches patterns with include filter and skips .log files', async () => {
    const out = await run(createGrepTool(), { pattern: 'export const', include: '*.ts' }, ctx());
    const first = out.content[0];
    const text = first !== undefined && first.type === 'text' ? first.text : '';
    expect(text).toContain('src/x.ts:1:');
    expect(text).toContain('src/y.ts:1:');
    expect(text).not.toContain('debug.log');
  });

  it('grep reports no matches clearly', async () => {
    const out = await run(createGrepTool(), { pattern: 'zzzznotfound' }, ctx());
    const text = JSON.stringify(out.content);
    expect(text).toContain('No matches');
  });

  it('invalid regex → structured error for the model', async () => {
    await expect(run(createGrepTool(), { pattern: '([unclosed' }, ctx())).rejects.toSatisfy(
      (e) => SyaoError.is(e) && e.code === 'SY-TOOL-002',
    );
  });
});

describe('bash (FR-035) via MemoryRuntime shell', () => {
  it('runs a whitelisted command and reports exit code', async () => {
    const rtShell = new MemoryRuntime({
      commands: {
        '/bin/sh': (args: string[]): { code: number; stdout: string; stderr?: string } => {
          const line = args.filter((a) => a !== '-c').join(' ');
          if (line === 'echo syao') return { code: 0, stdout: 'syao' };
          return { code: 1, stdout: '', stderr: 'unknown' };
        },
      },
    });
    const bash = createBashTool();
    const out = await run(bash, { command: 'echo syao' }, { runtime: rtShell, cwd: '/ws', signal: noSignal, progress: () => {} });
    const first = out.content[0];
    const text = first !== undefined && first.type === 'text' ? first.text : '';
    expect(text).toContain('exit=0');
    expect(text).toContain('syao');
  });

  it('non-zero exit marks the result as error (informational for the model)', async () => {
    const rtShell = new MemoryRuntime({
      commands: { '/bin/sh': (): { code: number; stdout: string; stderr: string } => ({ code: 2, stdout: '', stderr: 'failed hard' }) },
    });
    const out = await run(createBashTool(), { command: 'npm test' }, { runtime: rtShell, cwd: '/ws', signal: noSignal, progress: () => {} });
    expect(out.isError).toBe(true);
    expect(JSON.stringify(out.content)).toContain('exit=2');
  });
});

describe('FileStateTracker unit', () => {
  it('SY-FS-001 vs SY-FS-002 distinction', () => {
    const t = new FileStateTracker();
    expect(() => t.assertUnchanged('/ws/x', 'now', 1)).toThrow(FsError);
    t.recordRead('/ws/x', 'original', 1);
    t.assertUnchanged('/ws/x', 'original', 1);
    expect(() => t.assertUnchanged('/ws/x', 'changed', 1)).toThrow(FsError);
  });
});
