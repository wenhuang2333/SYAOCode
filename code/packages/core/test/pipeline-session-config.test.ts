import { describe, expect, it } from 'vitest';
import {
  FileSessionStore,
  MemorySessionStore,
  SyaoError,
  loadConfig,
  Redactor,
  TRUNCATION_MAX_CHARS,
  truncateOutput,
  estimateTokens,
  assembleSystemPrompt,
} from '../src';
import { fakeRuntime } from './helpers';

describe('pipeline truncation (BR-012)', () => {
  it('keeps head 40% + tail 60% and appends a marker', () => {
    const big = 'x'.repeat(TRUNCATION_MAX_CHARS + 5_000);
    const { content, truncated } = truncateOutput([{ type: 'text', text: big }]);
    expect(truncated).toBe(true);
    const text = content[0]?.type === 'text' ? content[0].text : '';
    expect(text).toContain('truncated');
    expect(text.length).toBeLessThan(big.length);
  });

  it('leaves small outputs untouched', () => {
    const { content, truncated } = truncateOutput([{ type: 'text', text: 'short' }]);
    expect(truncated).toBe(false);
    expect(content[0]).toEqual({ type: 'text', text: 'short' });
  });

  it('truncates by line count too', () => {
    const lines = Array.from({ length: 2_500 }, (_, i) => `line${i}`).join('\n');
    const { truncated } = truncateOutput([{ type: 'text', text: lines }]);
    expect(truncated).toBe(true);
  });
});

describe('session stores (FR-060..062, BR-016)', () => {
  it('memory store: append/load/list/fork/delete', async () => {
    const store = new MemorySessionStore();
    await store.append('s1', [
      { v: 1, id: 'e1', ts: 1, sessionId: 's1', type: 'message', data: { hello: 1 } },
      { v: 1, id: 'e2', ts: 2, sessionId: 's1', type: 'usage', data: {} },
    ]);
    const entries = await store.load('s1');
    expect(entries).toHaveLength(2);
    const listed = await store.list();
    expect(listed[0]?.sessionId).toBe('s1');
    const forkId = await store.fork('s1', 'e1');
    const forked = await store.load(forkId);
    expect(forked).toHaveLength(1);
    await expect(store.load('missing')).rejects.toSatisfy(SyaoError.is);
    await store.delete('s1');
    expect(await store.list()).toHaveLength(1);
  });

  it('file store: JSONL round-trip, corrupt-line tolerance, version guard', async () => {
    const rt = fakeRuntime();
    const store = new FileSessionStore(rt, '/sessions', 'proj1');
    await store.append('s1', [
      { v: 1, id: 'e1', ts: 1, sessionId: 's1', type: 'message', data: 'x' },
    ]);
    const entries = await store.load('s1');
    expect(entries[0]?.data).toBe('x');

    // 1 corrupt line among 6 (16.7% ≤ 20% threshold): tolerated and skipped
    const good = Array.from({ length: 5 }, (_, i) =>
      JSON.stringify({ v: 1, id: `g${i}`, ts: i, sessionId: 's1', type: 'message', data: i }),
    ).join('\n');
    await rt.fs.writeFile('/sessions/proj1/s1.jsonl', `${good}\n{"garbage\n`);
    const tolerated = await store.load('s1');
    expect(tolerated).toHaveLength(5);

    // corruption over threshold (all corrupt) → SY-SES-002
    await rt.fs.writeFile('/sessions/proj1/s1.jsonl', '{"garbage\n{"more garbage\n');
    await expect(store.load('s1')).rejects.toSatisfy((e) => SyaoError.is(e) && e.code === 'SY-SES-002');

    // version-too-high line must fail with SY-SES-003
    await rt.fs.writeFile('/sessions/proj1/s1.jsonl', '{"v":99,"id":"e9","ts":1,"sessionId":"s1","type":"message","data":{}}\n');
    await expect(store.load('s1')).rejects.toSatisfy((e) => SyaoError.is(e) && e.code === 'SY-SES-003');
  });
});

describe('config layering (FR-120, BR-024)', () => {
  it('merges user then project then env then code; code wins', async () => {
    const rt = fakeRuntime();
    await rt.fs.writeFile('/home/.syaocode/config.json', JSON.stringify({ permissionMode: 'default', rules: [{ effect: 'deny', tool: 'bash', source: 'user' }] }));
    await rt.fs.writeFile('/.syaocode/config.json', JSON.stringify({ permissionMode: 'acceptEdits' }));
    const config = await loadConfig({
      userPath: '/home/.syaocode/config.json',
      projectPath: '/.syaocode/config.json',
      env: { SYAO_PERMISSION_MODE: 'plan' },
      code: { permissionMode: 'bypass' },
      runtime: rt,
    });
    expect(config.permissionMode).toBe('bypass');
    expect(config.rules).toHaveLength(1);
  });

  it('rejects project-level bypass with a warning, not a crash (BR-002)', async () => {
    const rt = fakeRuntime();
    await rt.fs.writeFile('/.syaocode/config.json', JSON.stringify({ permissionMode: 'bypass' }));
    const config = await loadConfig({ projectPath: '/.syaocode/config.json', runtime: rt });
    expect(config.permissionMode).toBe('default');
  });

  it('project cannot relax a user deny — forced back to deny (BR-024)', async () => {
    const rt = fakeRuntime();
    await rt.fs.writeFile('/home/.syaocode/config.json', JSON.stringify({ rules: [{ effect: 'deny', tool: 'bash', source: 'user' }] }));
    await rt.fs.writeFile('/.syaocode/config.json', JSON.stringify({ rules: [{ effect: 'allow', tool: 'bash', source: 'project' }] }));
    const config = await loadConfig({ userPath: '/home/.syaocode/config.json', projectPath: '/.syaocode/config.json', runtime: rt });
    expect(config.rules.every((r) => r.effect === 'deny')).toBe(true);
  });

  it('invalid config fails with SY-CFG-001 and field paths', async () => {
    const rt = fakeRuntime();
    await rt.fs.writeFile('/.syaocode/config.json', JSON.stringify({ permissionMode: 'nope', limits: { maxTurns: 'x' } }));
    await expect(loadConfig({ projectPath: '/.syaocode/config.json', runtime: rt })).rejects.toSatisfy(
      (e) => SyaoError.is(e) && e.code === 'SY-CFG-001',
    );
  });
});

describe('redactor (FR-045, BR-023)', () => {
  it('masks common key shapes and registered values, records type only', () => {
    const red = new Redactor();
    red.register('sk-supersecretvalue99', 'deepseek-key');
    const { text, hits } = red.redact('key=sk-supersecretvalue99 and sk-proj-abcdef123456789012345 and AKIAIOSFODNN7EXAMPLE');
    expect(text).not.toContain('supersecretvalue');
    expect(text).not.toContain('sk-proj-abcdef');
    expect(text).toContain('[REDACTED:deepseek-key]');
    expect(text).toContain('[REDACTED:openai-key]');
    expect(text).toContain('[REDACTED:aws-access-key]');
    expect(hits.sort()).toEqual(['aws-access-key', 'deepseek-key', 'openai-key']);
  });

  it('deep-redacts nested structures', () => {
    const red = new Redactor();
    const { value } = red.redactValue({ nested: { token: 'Bearer abcdefghijklmnopqrst' }, safe: 42 });
    expect(JSON.stringify(value)).not.toContain('abcdefghijklmnopqrst');
    expect((value as { safe: number }).safe).toBe(42);
  });
});

describe('context (FR-050/052)', () => {
  it('assembles stable prompt segments', () => {
    const prompt = assembleSystemPrompt({ projectInstructions: 'do good', environmentInfo: 'macOS' });
    expect(prompt).toContain('# Project instructions');
    expect(prompt).toContain('do good');
    expect(prompt).toContain('# Environment');
  });

  it('estimates CJK heavier than latin', () => {
    const latin = estimateTokens('abcdefghij'.repeat(10));
    const cjk = estimateTokens('你好世界测试'.repeat(10));
    expect(cjk).toBeGreaterThan(latin);
  });
});
