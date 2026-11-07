/**
 * 会话改动 / 产出 / 来源采集器的单测。
 *
 * 对应 `27` §13 的 TC-N-001…007、018、019，以及 §7–§9 的其余硬规则。
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { nodeRuntime } from '@syaocode/node';
import type { Tool, ToolContext, ToolOutput } from '@syaocode/core';
import { createDesktopAgent } from '../src/agent-factory.ts';
import {
  artifactKindFor,
  BASH_COVERAGE_NOTE,
  ChangesCollector,
  createChangeToolHooks,
  MAX_SOURCES_PER_SESSION,
} from '../src/changes.ts';

const dirs: string[] = [];
async function directory(): Promise<string> {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), 'changes-'));
  dirs.push(d);
  return d;
}
afterEach(async () => {
  for (const d of dirs.splice(0)) await fs.rm(d, { recursive: true, force: true });
});

/** 模拟一次工具执行：拍前置像 → 改盘 → 拍后置像。 */
async function runTool(
  collector: ChangesCollector,
  sessionId: string,
  tool: string,
  relPath: string,
  mutate: () => Promise<void>,
  isError = false,
): Promise<void> {
  const hooks = createChangeToolHooks(collector, sessionId);
  await hooks.before(tool, { path: relPath });
  if (!isError) await mutate();
  await hooks.after(tool, { path: relPath }, isError);
}

describe('会话改动统计（TC-N-001…007）', () => {
  it('write 新建文件：status=added、added=文件行数、removed=0、stat=exact', async () => {
    const root = await directory();
    const collector = new ChangesCollector({ workspaceRoot: root });
    await runTool(collector, 's1', 'write', 'docs/new.md', async () => {
      await fs.mkdir(path.join(root, 'docs'), { recursive: true });
      await fs.writeFile(path.join(root, 'docs/new.md'), 'a\nb\nc\n');
    });
    const change = collector.snapshot('s1').changes[0];
    expect(change).toMatchObject({ path: 'docs/new.md', status: 'added', added: 3, removed: 0, stat: 'exact', tool: 'write' });
    expect(typeof change?.updatedAt).toBe('number');
  });

  it('edit 替换多行：added/removed 与行级 diff 一致', async () => {
    const root = await directory();
    await fs.writeFile(path.join(root, 'a.txt'), 'a\nb\nc\nd\n');
    const collector = new ChangesCollector({ workspaceRoot: root });
    await runTool(collector, 's1', 'edit', 'a.txt', async () => {
      await fs.writeFile(path.join(root, 'a.txt'), 'a\nB\nc\nD\n');
    });
    expect(collector.snapshot('s1').changes[0]).toMatchObject({
      path: 'a.txt',
      status: 'modified',
      added: 2,
      removed: 2,
      stat: 'exact',
      tool: 'edit',
    });
  });

  it('同一路径多次写入：只按首次前置像→最后后置像，不逐次累加', async () => {
    const root = await directory();
    const collector = new ChangesCollector({ workspaceRoot: root });
    await runTool(collector, 's1', 'write', 'a.txt', async () => {
      await fs.writeFile(path.join(root, 'a.txt'), '1\n2\n3\n');
    });
    await runTool(collector, 's1', 'write', 'a.txt', async () => {
      await fs.writeFile(path.join(root, 'a.txt'), '1\n2\n3\n4\n5\n');
    });
    // 逐次累加会得到 3 + 5 = 8；正确口径是 5。
    expect(collector.snapshot('s1').changes[0]).toMatchObject({ status: 'added', added: 5, removed: 0, stat: 'exact' });
    expect(collector.snapshot('s1').changes).toHaveLength(1);
  });

  it('同一路径多次改写：净改动按首次前置像算，改回原样则不留条目', async () => {
    const root = await directory();
    await fs.writeFile(path.join(root, 'b.txt'), 'a\nb\nc\n');
    const collector = new ChangesCollector({ workspaceRoot: root });
    await runTool(collector, 's1', 'edit', 'b.txt', async () => {
      await fs.writeFile(path.join(root, 'b.txt'), 'a\nc\n');
    });
    await runTool(collector, 's1', 'edit', 'b.txt', async () => {
      await fs.writeFile(path.join(root, 'b.txt'), 'a\nb\nc\nd\n');
    });
    // 逐次累加会得到 +1/-1；净改动是 +1/-0。
    expect(collector.snapshot('s1').changes[0]).toMatchObject({ status: 'modified', added: 1, removed: 0, stat: 'exact' });

    const root2 = await directory();
    await fs.writeFile(path.join(root2, 'c.txt'), 'a\nb\n');
    const collector2 = new ChangesCollector({ workspaceRoot: root2 });
    await runTool(collector2, 's1', 'edit', 'c.txt', async () => {
      await fs.writeFile(path.join(root2, 'c.txt'), 'a\n');
    });
    await runTool(collector2, 's1', 'edit', 'c.txt', async () => {
      await fs.writeFile(path.join(root2, 'c.txt'), 'a\nb\n');
    });
    expect(collector2.snapshot('s1').changes).toEqual([]);
  });

  it('写入 2 MiB 文件：保留条目、stat=unavailable、行数为 null', async () => {
    const root = await directory();
    const collector = new ChangesCollector({ workspaceRoot: root });
    await runTool(collector, 's1', 'write', 'big.txt', async () => {
      await fs.writeFile(path.join(root, 'big.txt'), 'x'.repeat(2 * 1024 * 1024));
    });
    const change = collector.snapshot('s1').changes[0];
    expect(change).toMatchObject({ path: 'big.txt', status: 'added', stat: 'unavailable' });
    expect(change?.added).toBeNull();
    expect(change?.removed).toBeNull();
  });

  it('二进制文件：stat=unavailable、不返回部分行数', async () => {
    const root = await directory();
    const collector = new ChangesCollector({ workspaceRoot: root });
    await runTool(collector, 's1', 'write', 'bin.dat', async () => {
      await fs.writeFile(path.join(root, 'bin.dat'), Buffer.from([0x61, 0x00, 0x62, 0x0a]));
    });
    const change = collector.snapshot('s1').changes[0];
    expect(change).toMatchObject({ status: 'added', stat: 'unavailable' });
    expect(change?.added).toBeNull();
    expect(change?.removed).toBeNull();
  });

  it('工具报错：不新增条目，也不影响已有条目', async () => {
    const root = await directory();
    const collector = new ChangesCollector({ workspaceRoot: root });
    await runTool(collector, 's1', 'write', 'a.txt', async () => {
      await fs.writeFile(path.join(root, 'a.txt'), 'x\n');
    }, true);
    expect(collector.snapshot('s1').changes).toEqual([]);

    await runTool(collector, 's1', 'write', 'b.txt', async () => {
      await fs.writeFile(path.join(root, 'b.txt'), 'y\n');
    });
    expect(collector.snapshot('s1').changes).toHaveLength(1);
    // 同一路径再报错一次：已有条目保持不变。
    await runTool(collector, 's1', 'write', 'b.txt', async () => {
      await fs.writeFile(path.join(root, 'b.txt'), 'z\n');
    }, true);
    expect(collector.snapshot('s1').changes[0]).toMatchObject({ path: 'b.txt', added: 1, removed: 0 });
  });

  it('bash 被调用：诚实降级、不伪造数字', async () => {
    const root = await directory();
    const collector = new ChangesCollector({ workspaceRoot: root });
    const hooks = createChangeToolHooks(collector, 's1');
    await hooks.before('bash', { command: 'rm -rf build' });
    const snap = collector.snapshot('s1');
    expect(snap.coverage).toEqual({ exact: false, bashUsed: true, note: BASH_COVERAGE_NOTE });
    expect(snap.coverage.note).toBe('本会话还执行过命令，命令造成的文件变化未逐文件统计');
    expect(snap.changes).toEqual([]);
    // 重复通知不叠加。
    await hooks.after('bash', { command: 'ls' }, false);
    expect(collector.snapshot('s1').coverage).toEqual({ exact: false, bashUsed: true, note: BASH_COVERAGE_NOTE });
  });

  it('没用过 bash 时 coverage 是精确的', async () => {
    const root = await directory();
    const collector = new ChangesCollector({ workspaceRoot: root });
    expect(collector.snapshot('s1').coverage).toEqual({ exact: true, bashUsed: false, note: null });
  });
});

describe('产出（FR-N-012）', () => {
  it('write 新建路径登记产出，修改已有文件不算产出', async () => {
    const root = await directory();
    const collector = new ChangesCollector({ workspaceRoot: root });
    await runTool(collector, 's1', 'write', 'out/logo.png', async () => {
      await fs.mkdir(path.join(root, 'out'), { recursive: true });
      await fs.writeFile(path.join(root, 'out/logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    });
    const artifact = collector.snapshot('s1').artifacts[0];
    expect(artifact).toMatchObject({ path: 'out/logo.png', name: 'logo.png', kind: 'image', sizeBytes: 4, tool: 'write' });

    // 已存在文件再写一次：只是改动，不是产出。
    await runTool(collector, 's1', 'write', 'out/logo.png', async () => {
      await fs.writeFile(path.join(root, 'out/logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d]));
    });
    expect(collector.snapshot('s1').artifacts).toHaveLength(1);
  });

  it('产出类型按扩展名推断', () => {
    expect(artifactKindFor('a.png')).toBe('image');
    expect(artifactKindFor('a.JPEG')).toBe('image');
    expect(artifactKindFor('a.diff')).toBe('patch');
    expect(artifactKindFor('a.patch')).toBe('patch');
    expect(artifactKindFor('a.md')).toBe('report');
    expect(artifactKindFor('a.csv')).toBe('report');
    expect(artifactKindFor('a.zip')).toBe('archive');
    expect(artifactKindFor('a.tar.gz')).toBe('archive');
    expect(artifactKindFor('a.ts')).toBe('file');
  });
});

describe('参考来源（FR-N-013 / TC-N-018 / TC-N-019）', () => {
  it('抽取 http(s) 链接：trust=extracted、verified=false、count 去重累加', async () => {
    const root = await directory();
    const collector = new ChangesCollector({ workspaceRoot: root });
    collector.noteOutput('s1', 'bash', '见 https://example.com/a 和 https://example.com/a 以及 http://docs.test/b');
    const sources = collector.snapshot('s1').sources;
    expect(sources).toHaveLength(2);
    const first = sources.find((s) => s.domain === 'example.com');
    expect(first).toMatchObject({ url: 'https://example.com/a', count: 2, trust: 'extracted', verified: false, tool: 'bash' });
    expect(sources.find((s) => s.domain === 'docs.test')).toMatchObject({ count: 1, verified: false });
  });

  it('拒绝 javascript:/data:/file: 等协议', async () => {
    const root = await directory();
    const collector = new ChangesCollector({ workspaceRoot: root });
    collector.noteOutput('s1', 'bash', 'javascript://evil.example/x data:text/html;base64,AAA file:///etc/passwd https://ok.test/y');
    const sources = collector.snapshot('s1').sources;
    expect(sources).toHaveLength(1);
    expect(sources[0]?.url).toBe('https://ok.test/y');
  });

  it('URL 内嵌凭据先剥离', async () => {
    const root = await directory();
    const collector = new ChangesCollector({ workspaceRoot: root });
    collector.noteOutput('s1', 'bash', 'https://user:tok3n@example.com/secret/path https://example.com/x?token=abc&q=1');
    const sources = collector.snapshot('s1').sources;
    expect(sources[0]?.url).toBe('https://example.com/secret/path');
    expect(sources[0]?.domain).toBe('example.com');
    expect(sources[1]?.url).toBe('https://example.com/x?q=1');
    expect(sources.map((s) => s.url).join(' ')).not.toContain('tok3n');
  });

  it('每会话最多 50 条：超出丢弃新条目，已有条目 count 继续累加', async () => {
    const root = await directory();
    const collector = new ChangesCollector({ workspaceRoot: root });
    const many = Array.from({ length: 60 }, (_, i) => `https://host${i}.test/page`).join(' ');
    collector.noteOutput('s1', 'bash', many);
    expect(collector.snapshot('s1').sources).toHaveLength(MAX_SOURCES_PER_SESSION);
    collector.noteOutput('s1', 'bash', 'https://host0.test/page');
    const sources = collector.snapshot('s1').sources;
    expect(sources).toHaveLength(MAX_SOURCES_PER_SESSION);
    expect(sources.find((s) => s.url === 'https://host0.test/page')?.count).toBe(2);
  });
});

describe('路径围栏与敏感文件', () => {
  it('绝对路径、.. 逃逸、敏感文件、逃出工作区的符号链接一律拒绝', async () => {
    const root = await directory();
    const outside = await directory();
    await fs.writeFile(path.join(outside, 'secret.txt'), 'x\n');
    await fs.symlink(path.join(outside, 'secret.txt'), path.join(root, 'link.txt'));
    const collector = new ChangesCollector({ workspaceRoot: root });

    await runTool(collector, 's1', 'write', path.join(root, 'inside.txt'), async () => {
      await fs.writeFile(path.join(root, 'inside.txt'), 'a\n');
    });
    await runTool(collector, 's1', 'write', '../escape.txt', async () => {
      await fs.writeFile(path.join(root, '..', 'escape.txt'), 'a\n');
    });
    await runTool(collector, 's1', 'write', '.env', async () => {
      await fs.writeFile(path.join(root, '.env'), 'SECRET=1\n');
    });
    await runTool(collector, 's1', 'write', 'link.txt', async () => {
      await fs.writeFile(path.join(root, 'link.txt'), 'y\n');
    });

    expect(collector.snapshot('s1').changes).toEqual([]);
    expect(collector.snapshot('s1').artifacts).toEqual([]);
  });
});

describe('会话生命周期', () => {
  it('onChange 在改动后回调，restore/clear 可用', async () => {
    const root = await directory();
    const seen: string[] = [];
    const collector = new ChangesCollector({ workspaceRoot: root, onChange: (sessionId) => seen.push(sessionId) });
    await runTool(collector, 's1', 'write', 'a.txt', async () => {
      await fs.writeFile(path.join(root, 'a.txt'), 'a\n');
    });
    expect(seen).toContain('s1');

    const snapshot = collector.snapshot('s1');
    expect(snapshot.changes).toHaveLength(1);
    collector.clear('s1');
    expect(collector.snapshot('s1')).toEqual({ changes: [], artifacts: [], sources: [], coverage: { exact: true, bashUsed: false, note: null } });

    collector.restore('s1', snapshot);
    expect(collector.snapshot('s1').changes).toHaveLength(1);
    expect(collector.snapshot('s1').changes[0]).toMatchObject({ path: 'a.txt', added: 1 });
  });

  it('钩子：兼容 file_path 入参，没有路径的输入被忽略', async () => {
    const root = await directory();
    const collector = new ChangesCollector({ workspaceRoot: root });
    const hooks = createChangeToolHooks(collector, 's1');
    await hooks.before('write', { file_path: 'x.ts' });
    await fs.writeFile(path.join(root, 'x.ts'), 'a\n');
    await hooks.after('write', { file_path: 'x.ts' }, false);
    expect(collector.snapshot('s1').changes[0]).toMatchObject({ path: 'x.ts', status: 'added', added: 1 });

    await hooks.before('write', { content: 'no path' });
    await hooks.after('write', { content: 'no path' }, false);
    expect(collector.snapshot('s1').changes).toHaveLength(1);
  });
});

describe('删除与不可统计的边界（§7.5 不伪造）', () => {
  it('文件被删除：status=deleted、+0 -N（删除前全文行数有效）', async () => {
    const root = await directory();
    await fs.writeFile(path.join(root, 'gone.txt'), 'a\nb\n');
    const collector = new ChangesCollector({ workspaceRoot: root });
    const hooks = createChangeToolHooks(collector, 's1');
    await hooks.before('edit', { path: 'gone.txt' });
    await fs.rm(path.join(root, 'gone.txt'));
    await hooks.after('edit', { path: 'gone.txt' }, false);
    const change = collector.snapshot('s1').changes[0];
    expect(change).toMatchObject({ path: 'gone.txt', status: 'deleted', added: 0, removed: 2, stat: 'exact' });
  });

  it('会话内新建后又删除：用最后已知内容算 +0 -N', async () => {
    const root = await directory();
    const collector = new ChangesCollector({ workspaceRoot: root });
    const hooks = createChangeToolHooks(collector, 's1');
    // 先新建 3 行文件（前置像本来不存在）。
    await hooks.before('write', { path: 'tmp.txt' });
    await fs.writeFile(path.join(root, 'tmp.txt'), '1\n2\n3\n');
    await hooks.after('write', { path: 'tmp.txt' }, false);
    expect(collector.snapshot('s1').changes[0]).toMatchObject({ status: 'added', added: 3 });
    // 再删除：删除前的全文行数（3）仍然算得出来。
    await hooks.before('write', { path: 'tmp.txt' });
    await fs.rm(path.join(root, 'tmp.txt'));
    await hooks.after('write', { path: 'tmp.txt' }, false);
    expect(collector.snapshot('s1').changes[0]).toMatchObject({
      path: 'tmp.txt',
      status: 'deleted',
      added: 0,
      removed: 3,
      stat: 'exact',
    });
  });

  it('连删除前的内容都拿不到：退回 stat=unavailable、行数为 null', async () => {
    const root = await directory();
    const collector = new ChangesCollector({ workspaceRoot: root });
    const hooks = createChangeToolHooks(collector, 's1');
    await hooks.before('write', { path: 'never.txt' });
    // 工具没真正建出文件（例如宿主只调了 after）：没有可统计的内容。
    await hooks.after('write', { path: 'never.txt' }, false);
    const change = collector.snapshot('s1').changes[0];
    expect(change).toMatchObject({ path: 'never.txt', status: 'deleted', stat: 'unavailable' });
    expect(change?.added).toBeNull();
    expect(change?.removed).toBeNull();
  });

  it('非普通文件（目录）：行数不可统计', async () => {
    const root = await directory();
    await fs.mkdir(path.join(root, 'dir'));
    const collector = new ChangesCollector({ workspaceRoot: root });
    const hooks = createChangeToolHooks(collector, 's1');
    await hooks.before('write', { path: 'dir' });
    await hooks.after('write', { path: 'dir' }, false);
    const change = collector.snapshot('s1').changes[0];
    expect(change).toMatchObject({ path: 'dir', stat: 'unavailable' });
    expect(change?.added).toBeNull();
    expect(change?.removed).toBeNull();
  });
});

describe('工具装饰器（agent-factory 接线）', () => {
  /** 内核的工具返回值可能是 Promise 或生成器，这里统一取最终输出。 */
  async function outputOf(tool: Tool | undefined, input: unknown, ctx: ToolContext): Promise<ToolOutput> {
    const result = await tool!.execute(input, ctx);
    return result as ToolOutput;
  }

  it('只包裹 write/edit/bash：工具语义不变，before → execute → after 顺序固定', async () => {
    const root = await directory();
    const events: string[] = [];
    const created = createDesktopAgent({
      modelSpec: 'mock:default',
      cwd: root,
      permissionMode: 'default',
      permissionHandler: async () => ({ decision: 'allow' }),
      toolHooks: {
        async before(tool) { events.push(`before:${tool}`); },
        async after(tool, _input, isError) { events.push(`after:${tool}:${String(isError)}`); },
      },
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const write = created.agent.registry.get('write');
    // 装饰器不改变工具本身的语义。
    expect(write?.name).toBe('write');
    expect(write?.risk).toBe('write');
    expect(write?.readOnly).toBe(false);
    expect(write?.timeoutMs).toBe(30_000);
    expect(typeof write?.description).toBe('string');
    expect(write?.inputSchema).toBeDefined();
    expect(write?.permissionSubject?.({ path: 'a.txt' })).toEqual({ path: 'a.txt' });

    const ctx: ToolContext = {
      runtime: nodeRuntime(),
      cwd: root,
      signal: new AbortController().signal,
      progress: () => undefined,
    };

    const written = await outputOf(write, { path: 'a.txt', content: 'a\n' }, ctx);
    expect(written.isError).toBeUndefined();
    expect(events).toEqual(['before:write', 'after:write:false']);

    // execute 抛错：after 依然被调用，且 isError=true。
    events.length = 0;
    const edit = created.agent.registry.get('edit');
    await expect(edit!.execute({ path: 'a.txt', old_string: 'zzz', new_string: 'y' }, ctx)).rejects.toThrow();
    expect(events).toEqual(['before:edit', 'after:edit:true']);

    // 返回 isError（非零退出码）：after 传 isError=true。
    events.length = 0;
    const bash = created.agent.registry.get('bash');
    const bashOut = await outputOf(bash, { command: 'exit 3' }, ctx);
    expect(bashOut.isError).toBe(true);
    expect(events).toEqual(['before:bash', 'after:bash:true']);

    // 没被包裹的工具不触发钩子。
    events.length = 0;
    const read = created.agent.registry.get('read');
    await outputOf(read, { path: 'a.txt' }, ctx);
    expect(events).toEqual([]);
  });
});

describe('单文件改动 diff（27 §11.2：点击文件看只读 diff）', () => {
  it('修改文件：diff 是"首次前置像 → 现在"，行数与改动条一致', async () => {
    const root = await directory();
    const collector = new ChangesCollector({ workspaceRoot: root });
    await fs.writeFile(path.join(root, 'app.ts'), 'a\nb\nc\n');

    await collector.captureBefore('s1', 'edit', 'app.ts');
    await fs.writeFile(path.join(root, 'app.ts'), 'a\nB\nc\nd\n');
    await collector.captureAfter('s1', 'edit', 'app.ts');

    const entry = collector.snapshot('s1').changes.find((c) => c.path === 'app.ts');
    const diff = await collector.diff('s1', 'app.ts');
    expect(diff).not.toBeNull();
    expect(diff?.unavailable).toBeNull();
    expect(diff?.status).toBe(entry?.status);
    // diff 里的 +/- 必须与改动条目里的行数是同一个真相。
    expect(diff?.added).toBe(entry?.added);
    expect(diff?.removed).toBe(entry?.removed);
    expect(diff?.hunks.length).toBeGreaterThan(0);
  });

  it('新建文件：前置像是"不存在"，diff 全是新增行', async () => {
    const root = await directory();
    const collector = new ChangesCollector({ workspaceRoot: root });
    await collector.captureBefore('s1', 'write', 'new.ts');
    await fs.writeFile(path.join(root, 'new.ts'), 'one\ntwo\n');
    await collector.captureAfter('s1', 'write', 'new.ts');

    const diff = await collector.diff('s1', 'new.ts');
    expect(diff?.status).toBe('added');
    expect(diff?.unavailable).toBeNull();
    expect(diff?.added).toBe(2);
    expect(diff?.removed).toBe(0);
  });

  it('删除文件：给不了内容 diff，但行数仍然有效（unavailable=deleted）', async () => {
    const root = await directory();
    const collector = new ChangesCollector({ workspaceRoot: root });
    await fs.writeFile(path.join(root, 'gone.ts'), 'x\ny\n');
    await collector.captureBefore('s1', 'edit', 'gone.ts');
    await fs.unlink(path.join(root, 'gone.ts'));
    await collector.captureAfter('s1', 'edit', 'gone.ts');

    const diff = await collector.diff('s1', 'gone.ts');
    expect(diff?.status).toBe('deleted');
    expect(diff?.unavailable).toBe('deleted');
    expect(diff?.hunks).toEqual([]);
    // "不可统计"绝不能变成 0 以外的假数字：这里 2 是删除前的真实行数。
    expect(diff?.removed).toBe(2);
  });

  it('二进制文件：不猜内容（unavailable=binary）', async () => {
    const root = await directory();
    const collector = new ChangesCollector({ workspaceRoot: root });
    await fs.writeFile(path.join(root, 'blob.bin'), Buffer.from([0, 1, 2, 3]));
    await collector.captureBefore('s1', 'edit', 'blob.bin');
    await fs.writeFile(path.join(root, 'blob.bin'), Buffer.from([0, 9, 9, 9]));
    await collector.captureAfter('s1', 'edit', 'blob.bin');

    const diff = await collector.diff('s1', 'blob.bin');
    expect(diff?.unavailable).toBe('binary');
    expect(diff?.hunks).toEqual([]);
  });

  it('没有前置像（例如重启后恢复的快照）→ no_snapshot，绝不把当前内容当 diff', async () => {
    const root = await directory();
    const collector = new ChangesCollector({ workspaceRoot: root });
    await fs.writeFile(path.join(root, 'restored.ts'), 'now\n');
    // 直接恢复一条"结果"快照：只有 changes，没有文件像（这正是重启后的状态）。
    collector.restore('s1', {
      changes: [{ path: 'restored.ts', status: 'modified', added: 5, removed: 1, stat: 'exact', tool: 'edit', updatedAt: Date.now() }],
      artifacts: [],
      sources: [],
      coverage: { exact: true, bashUsed: false, note: null },
    });

    const diff = await collector.diff('s1', 'restored.ts');
    expect(diff?.unavailable).toBe('no_snapshot');
    expect(diff?.hunks).toEqual([]);
    // 行数沿用改动条目（那是唯一已知的真相）。
    expect(diff?.added).toBe(5);
    expect(diff?.removed).toBe(1);
  });

  it('没有登记的路径 → null（宿主据此报错，而不是返回空 diff）', async () => {
    const root = await directory();
    const collector = new ChangesCollector({ workspaceRoot: root });
    expect(await collector.diff('s1', 'never-touched.ts')).toBeNull();
  });

  it('超过行数预算 → too_large，不返回半截 diff', async () => {
    const root = await directory();
    const collector = new ChangesCollector({ workspaceRoot: root });
    const big = Array.from({ length: 3100 }, (_, i) => `line ${i}`).join('\n');
    await fs.writeFile(path.join(root, 'big.ts'), 'seed\n');
    await collector.captureBefore('s1', 'edit', 'big.ts');
    // 3100 行 < 1 MiB，采集器会记成精确行数；diff 侧必须自己收口。
    await fs.writeFile(path.join(root, 'big.ts'), big);
    await collector.captureAfter('s1', 'edit', 'big.ts');

    const diff = await collector.diff('s1', 'big.ts');
    expect(diff?.unavailable).toBe('too_large');
    expect(diff?.hunks).toEqual([]);
  });

  it('路径逃逸被拒（../ 与绝对路径都拿不到 diff）', async () => {
    const root = await directory();
    const collector = new ChangesCollector({ workspaceRoot: root });
    expect(await collector.diff('s1', '../outside.ts')).toBeNull();
    expect(await collector.diff('s1', '/etc/passwd')).toBeNull();
  });
});
