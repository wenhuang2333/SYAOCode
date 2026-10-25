import { describe, expect, it } from 'vitest';
import { PermissionEngine, commandPathCandidates, type PermissionRule } from '../src';
import { fakeRuntime } from './helpers';

const rt = fakeRuntime(
  {
    '/ws/a.txt': 'a',
    '/ws/.env': 'TOKEN=secret',
    '/outside/x.txt': 'x',
    '/home/u/.ssh/id_rsa': 'private',
    '/home/u/.aws/credentials': 'aws',
    '/home/u/.syaocode/env': 'KEY=secret',
  },
  { env: { HOME: '/home/u' } },
);

function engine(opts: Partial<ConstructorParameters<typeof PermissionEngine>[0]> = {}) {
  return new PermissionEngine({
    mode: 'default',
    rules: [],
    workspaceRoots: ['/ws'],
    runtime: rt,
    ...opts,
  });
}

describe('read-path fence (report S4)', () => {
  it.each(['default', 'acceptEdits', 'plan'] as const)('%s: outside read asks, inside read passes', async (mode) => {
    let asked = 0;
    const e = engine({
      mode,
      onRequest: async () => {
        asked += 1;
        return { decision: 'allow' };
      },
    });
    const inside = await e.checkSubject('read', 'read', { path: '/ws/a.txt' });
    expect(inside.outcome).toBe('allow');
    const outside = await e.checkSubject('read', 'read', { path: '/outside/x.txt' });
    expect(outside.outcome).toBe('allow');
    expect(asked).toBe(1);
    expect((await e.policyVerdict('read', 'read', { path: '/outside/x.txt' })).outcome).toBe('ask');
  });

  it('plan mode still denies writes', async () => {
    expect((await engine({ mode: 'plan' }).checkSubject('write', 'write', { path: '/ws/a.txt' })).outcome).toBe('deny');
  });

  it('bash read commands that touch outside paths ask too', async () => {
    const e = engine();
    expect((await e.policyVerdict('bash', 'exec', { command: 'cat /etc/passwd' })).outcome).toBe('ask');
    expect((await e.policyVerdict('bash', 'exec', { command: 'cat /ws/a.txt' })).outcome).toBe('allow');
    expect((await e.policyVerdict('bash', 'exec', { command: 'ls -la' })).outcome).toBe('allow');
    expect(commandPathCandidates('cat a.txt | grep foo')).toEqual(['a.txt']);
  });

  it.each(['bypass', 'default', 'acceptEdits', 'plan', 'strict'] as const)('%s: sensitive paths always ask', async (mode) => {
    const e = engine({ mode });
    for (const path of ['/ws/.env', '/home/u/.ssh/id_rsa', '/home/u/.aws/credentials', '/home/u/.syaocode/env']) {
      const verdict = await e.policyVerdict('read', 'read', { path });
      expect(verdict.outcome, `${mode} ${path}`).toBe('ask');
      if (verdict.outcome === 'ask') expect(verdict.sensitive).toBe(true);
    }
  });

  it('sensitive approval is one-shot and ignores remember=session', async () => {
    let asked = 0;
    const e = engine({
      mode: 'bypass',
      onRequest: async () => {
        asked += 1;
        return { decision: 'allow', remember: 'session' };
      },
    });
    expect((await e.checkSubject('read', 'read', { path: '/ws/.env' })).outcome).toBe('allow');
    expect((await e.checkSubject('read', 'read', { path: '/ws/.env' })).outcome).toBe('allow');
    expect(asked).toBe(2);
  });
});

describe('dangerous-command rule source (report S5)', () => {
  const dangerous = { command: 'rm -rf /' };
  it('project/plugin/code allow rules cannot pass the dangerous library', async () => {
    for (const source of ['project', 'plugin', 'code'] as const) {
      const rules: PermissionRule[] = [{ effect: 'allow', tool: 'bash', source, match: { command: 'rm -rf /' } }];
      const out = await engine({ rules }).checkSubject('bash', 'exec', dangerous);
      expect(out.outcome, source).toBe('deny');
      if (out.outcome === 'deny') expect(out.error.code).toBe('SY-PERM-004');
    }
  });

  it('a user wildcard allow without an exact command matcher cannot pass', async () => {
    const rules: PermissionRule[] = [{ effect: 'allow', tool: 'bash', source: 'user' }];
    const out = await engine({ rules }).checkSubject('bash', 'exec', dangerous);
    expect(out.outcome).toBe('deny');
  });

  it('only a user rule naming the exact command passes', async () => {
    const rules: PermissionRule[] = [
      { effect: 'allow', tool: 'bash', source: 'user', match: { command: 'rm -rf /' } },
    ];
    expect((await engine({ rules }).checkSubject('bash', 'exec', dangerous)).outcome).toBe('allow');
  });

  it('user allow with a glob command does not count as exact', async () => {
    const rules: PermissionRule[] = [
      { effect: 'allow', tool: 'bash', source: 'user', match: { command: 'rm -rf *' } },
    ];
    expect((await engine({ rules }).checkSubject('bash', 'exec', dangerous)).outcome).toBe('deny');
  });
});
