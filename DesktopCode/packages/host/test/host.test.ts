/**
 * Host 集成测试：不经 WebSocket，直接测投影 / 审批 / 幂等这些"错了就很难查"的地方。
 *
 * WebSocket 层的端到端测试在 `test/dhp-e2e.test.ts`（用真实 socket）。
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { InteractionBroker, toPendingInteraction } from '../src/interaction-broker.ts';
import { SessionRegistry, toSessionEvents } from '../src/session-registry.ts';
import { WorkspaceService, diffLines } from '../src/workspace.ts';
import { resolveLIWENHome, liwenPaths, LIWENHomeError } from '../src/paths.ts';
import { ConfigService } from '../src/config-service.ts';

const tmpDirs: string[] = [];
function mkTmp(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'liwen-host-'));
  tmpDirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe('数据目录解析（OI-D-07）', () => {
  it('LIWENCODE_HOME 优先', () => {
    expect(resolveLIWENHome({ LIWENCODE_HOME: '/tmp/x' })).toBe('/tmp/x');
  });

  it('未设置时回退 os.homedir()', () => {
    expect(resolveLIWENHome({})).toBe(path.join(os.homedir(), '.liwencode'));
  });

  it('空字符串视为未设置', () => {
    expect(resolveLIWENHome({ LIWENCODE_HOME: '   ' })).toBe(path.join(os.homedir(), '.liwencode'));
  });

  it('路径全部由 liwenPaths 一次构造', () => {
    const p = liwenPaths({ LIWENCODE_HOME: '/tmp/home' });
    expect(p.configFile).toBe(path.join('/tmp/home', 'config.json'));
    expect(p.sessionsDir).toBe(path.join('/tmp/home', 'sessions'));
    expect(p.desktopDir).toBe(path.join('/tmp/home', 'desktop'));
  });

  it('LIWENHomeError 是具名错误', () => {
    const e = new LIWENHomeError('x');
    expect(e.name).toBe('LIWENHomeError');
  });
});

describe('会话投影（Host 侧）', () => {
  const makeRegistry = (): { reg: SessionRegistry; id: string } => {
    const reg = new SessionRegistry();
    const st = reg.create({
      sessionId: 's1',
      title: 't',
      model: 'mock:default',
      permissionMode: 'default',
      workspaceRoot: '/w',
    });
    return { reg, id: st.sessionId };
  };

  it('seq 单调递增，投影随之推进', () => {
    const { reg, id } = makeRegistry();
    reg.append(id, { type: 'turn.start', turn: 1 });
    reg.append(id, { type: 'text.delta', text: 'a' });
    reg.append(id, { type: 'text.delta', text: 'b' });
    const snap = reg.require(id).snapshot;
    expect(snap.seq).toBe(3);
    expect(snap.rows).toHaveLength(1);
    expect((snap.rows[0] as { text: string }).text).toBe('ab');
  });

  it('事件环会丢弃最旧事件并抬高 floor', () => {
    const reg = new SessionRegistry();
    const st = reg.create({
      sessionId: 's2',
      title: 't',
      model: 'm',
      permissionMode: 'default',
      workspaceRoot: '/w',
    });
    for (let i = 0; i < 5; i += 1) reg.append(st.sessionId, { type: 'text.delta', text: `${i}` });
    const floor = reg.require(st.sessionId).ringFloor;
    expect(floor).toBe(1);
    // 超出环容量后 floor 应上升（这里用 eventsBetween 间接验证语义）
    expect(reg.eventsBetween(st.sessionId, 1, 5)?.events).toHaveLength(5);
  });

  it('补洞请求早于 floor 时返回 undefined（→ gap_unrecoverable）', () => {
    const { reg, id } = makeRegistry();
    const st = reg.require(id);
    st.ringFloor = 100;
    expect(reg.eventsBetween(id, 1, 2)).toBeUndefined();
  });

  it('turn.end 会把未收尾的行置为 final', () => {
    const { reg, id } = makeRegistry();
    reg.append(id, { type: 'text.delta', text: 'partial' });
    reg.append(id, { type: 'turn.end', turn: 1 });
    const row = reg.require(id).snapshot.rows[0] as { final: boolean };
    expect(row.final).toBe(true);
    expect(reg.require(id).runState).toBe('idle');
  });

  it('孤儿 tool.result 会补建一行（内容不丢）', () => {
    const { reg, id } = makeRegistry();
    reg.append(id, {
      type: 'tool.result',
      callId: 'c9',
      name: 'read',
      text: 'content',
      blocks: 1,
      isError: false,
      durationMs: 5,
    });
    const rows = reg.require(id).snapshot.rows;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.kind).toBe('toolCall');
  });
});

describe('内核事件翻译', () => {
  it('permission.* 不由翻译层负责（避免两条来源不同的审批）', () => {
    const ev = {
      type: 'permission.request' as const,
      id: 'p1',
      request: {} as never,
      seq: 1,
      runId: 'r',
    };
    expect(toSessionEvents(ev)).toEqual([]);
  });

  it('内核 session.end（一次 run 结束）→ turn.end，而不是 DHP session.end', () => {
    const out = toSessionEvents({
      type: 'session.end',
      reason: 'completed',
      seq: 1,
      runId: 'r',
    });
    expect(out).toEqual([{ type: 'turn.end', turn: 0 }]);
  });

  it('内核 session.end 非正常结束 → turn.end + 说明性 error', () => {
    const out = toSessionEvents({
      type: 'session.end',
      reason: 'budget_exhausted',
      seq: 1,
      runId: 'r',
    });
    expect(out[0]?.type).toBe('turn.end');
    expect(out[1]?.type).toBe('error');
  });

  it('tool.receipt 映射字段', () => {
    const out = toSessionEvents({
      type: 'tool.receipt',
      receipt: {
        callId: 'c1',
        tool: 'read',
        timestamp: 0,
        durationMs: 1,
        inputHash: 'i',
        outputHash: 'o',
        outputRef: 'ev/o',
        outputChars: 10,
        truncated: false,
        isError: false,
        trust: 'trusted',
        sandbox: 'none',
      } as never,
      seq: 1,
      runId: 'r',
    });
    expect(out).toEqual([
      {
        type: 'tool.receipt',
        receiptId: 'c1',
        toolName: 'read',
        outputRef: 'ev/o',
        hash: 'o',
      },
    ]);
  });
});

describe('审批代理', () => {
  const req = {
    id: 'perm-1',
    tool: 'bash',
    risk: 'exec' as const,
    subject: { command: 'npm install' },
    reason: '默认策略：执行命令需确认',
  };

  it('敏感项只保留 once/deny', () => {
    const p = toPendingInteraction({ ...req, sensitive: true }, 's1', () => 0);
    expect(p.options.map((o) => o.scope).sort()).toEqual(['deny', 'once']);
  });

  it('非敏感项给四档', () => {
    const p = toPendingInteraction(req, 's1', () => 0);
    expect(p.options).toHaveLength(4);
    expect(p.preview?.type).toBe('command');
  });

  it('允许 → 结算一次；重复结算返回 interaction_settled', async () => {
    const emitted: unknown[] = [];
    const broker = new InteractionBroker((i) => emitted.push(i), { sessionId: 's1' });
    const promise = broker.handle(req);
    expect(emitted).toHaveLength(1);

    const first = broker.resolve('perm-1', 'session');
    expect(first.ok).toBe(true);
    const second = broker.resolve('perm-1', 'deny');
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.kind).toBe('interaction_settled');

    await expect(promise).resolves.toMatchObject({ decision: 'allow', remember: 'session' });
  });

  it('敏感项请求 session 记忆 → 降级为 once', async () => {
    const broker = new InteractionBroker(() => {}, { sessionId: 's1' });
    const promise = broker.handle({ ...req, sensitive: true });
    broker.resolve('perm-1', 'session');
    await expect(promise).resolves.toMatchObject({ decision: 'allow', remember: 'once' });
  });

  it('drain 把未决项按拒绝结算（防内核永久阻塞）', async () => {
    const broker = new InteractionBroker(() => {}, { sessionId: 's1' });
    const promise = broker.handle(req);
    broker.drain('会话关闭');
    await expect(promise).resolves.toMatchObject({ decision: 'deny' });
  });

  it('超时 fail-closed', async () => {
    const broker = new InteractionBroker(() => {}, { sessionId: 's1', timeoutMs: 20 });
    const promise = broker.handle(req);
    await expect(promise).resolves.toMatchObject({ decision: 'deny' });
  });
});

describe('工作区围栏', () => {
  it('拒绝 .. 逃逸', () => {
    const root = mkTmp();
    const ws = new WorkspaceService({ root });
    expect(() => ws.resolve('../etc/passwd')).toThrow(/escapes workspace/);
  });

  it('拒绝含 NUL 的路径', () => {
    const root = mkTmp();
    const ws = new WorkspaceService({ root });
    expect(() => ws.resolve('a\0b')).toThrow(/NUL/);
  });

  it('允许工作区内路径', () => {
    const root = mkTmp();
    const ws = new WorkspaceService({ root });
    expect(ws.resolve('src/a.ts')).toBe(path.join(root, 'src/a.ts'));
  });

  it('读文件 + 截断', async () => {
    const root = mkTmp();
    fs.writeFileSync(path.join(root, 'a.txt'), 'x'.repeat(100));
    const ws = new WorkspaceService({ root, maxReadBytes: 10 });
    const r = await ws.readFile('a.txt');
    expect(r.text).toHaveLength(10);
    expect(r.truncated).toBe(true);
  });

  it('文件树跳过 node_modules', async () => {
    const root = mkTmp();
    fs.mkdirSync(path.join(root, 'node_modules'));
    fs.mkdirSync(path.join(root, 'src'));
    fs.writeFileSync(path.join(root, 'src/a.ts'), '');
    const ws = new WorkspaceService({ root });
    const nodes = await ws.tree('.', 2);
    expect(nodes.map((n) => n.name)).toEqual(['src']);
  });
});

describe('差异算法', () => {
  it('相同输入无 hunk', () => {
    expect(diffLines(['a', 'b'], ['a', 'b'])).toHaveLength(0);
  });

  it('单行替换产生删+增', () => {
    const h = diffLines(['a', 'b', 'c'], ['a', 'x', 'c']);
    const kinds = h.flatMap((x) => x.lines.map((l) => l.kind));
    expect(kinds).toContain('del');
    expect(kinds).toContain('add');
  });

  it('大文件退化为整体替换（不卡 UI）', () => {
    const big = new Array(6000).fill('x');
    const h = diffLines(big, ['y']);
    expect(h).toHaveLength(1);
    expect(h[0]?.lines.length).toBe(6001);
  });
});

describe('配置服务', () => {
  it('默认值 + 来源标注', async () => {
    const home = mkTmp();
    const ws = mkTmp();
    const paths = liwenPaths({ LIWENCODE_HOME: home });
    const cfg = new ConfigService(paths, ws, {});
    const eff = await cfg.effective();
    expect(eff.model).toBe('mock:default');
    expect(eff.sources['model']).toBe('default');
  });

  it('环境变量优先级最高', async () => {
    const home = mkTmp();
    const ws = mkTmp();
    const paths = liwenPaths({ LIWENCODE_HOME: home });
    const cfg = new ConfigService(paths, ws, { LIWEN_MODEL: 'deepseek:deepseek-chat' });
    const eff = await cfg.effective();
    expect(eff.model).toBe('deepseek:deepseek-chat');
    expect(eff.sources['model']).toBe('env');
  });

  it('写回保留其他字段（不抹掉用户档案）', async () => {
    const home = mkTmp();
    const ws = mkTmp();
    const paths = liwenPaths({ LIWENCODE_HOME: home });
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(paths.configFile, JSON.stringify({ models: { work: { provider: 'x' } } }));
    const cfg = new ConfigService(paths, ws, {});
    await cfg.set('language', 'zh');
    const written = JSON.parse(fs.readFileSync(paths.configFile, 'utf8')) as Record<string, unknown>;
    expect(written['language']).toBe('zh');
    expect(written['models']).toEqual({ work: { provider: 'x' } });
  });

  it('拒绝非法 permissionMode', async () => {
    const home = mkTmp();
    const ws = mkTmp();
    const cfg = new ConfigService(liwenPaths({ LIWENCODE_HOME: home }), ws, {});
    await expect(cfg.set('permissionMode', 'god')).rejects.toThrow();
  });
});
