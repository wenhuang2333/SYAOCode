import { describe, expect, it } from 'vitest';
import { PermissionEngine, classifyCommand, type PermissionRule } from '../src';
import { fakeRuntime } from './helpers';

const rt = fakeRuntime({ '/ws/a.txt': 'a', '/outside/x.txt': 'x' });

function engine(opts: Partial<ConstructorParameters<typeof PermissionEngine>[0]> = {}) {
  return new PermissionEngine({
    mode: 'default',
    rules: [],
    workspaceRoots: ['/ws'],
    runtime: rt,
    ...opts,
  });
}

describe('rule precedence (BR-001)', () => {
  it('deny beats allow regardless of order', async () => {
    const rules: PermissionRule[] = [
      { effect: 'allow', tool: 'write', source: 'user' },
      { effect: 'deny', tool: 'write', source: 'user' },
    ];
    const out = await engine({ rules }).checkSubject('write', 'write', { path: '/ws/a.txt' });
    expect(out.outcome).toBe('deny');
    if (out.outcome === 'deny') expect(out.error.code).toBe('SY-PERM-001');
  });

  it('ask beats allow; deny beats ask', async () => {
    const askVsAllow = await engine({
      rules: [
        { effect: 'allow', tool: 't', source: 'user' },
        { effect: 'ask', tool: 't', source: 'user' },
      ],
    }).checkSubject('t', 'write', {});
    // ask → no handler → deny with SY-PERM-005
    expect(askVsAllow.outcome).toBe('deny');
    if (askVsAllow.outcome === 'deny') expect(askVsAllow.error.code).toBe('SY-PERM-005');

    const denyVsAsk = await engine({
      rules: [
        { effect: 'ask', tool: 't', source: 'user' },
        { effect: 'deny', tool: 't', source: 'user' },
      ],
    }).checkSubject('t', 'write', {});
    expect(denyVsAsk.outcome).toBe('deny');
  });

  it('default mode: read allow, write ask→deny(SY-PERM-005) without handler', async () => {
    const read = await engine().checkSubject('read', 'read', { path: '/ws/a.txt' });
    expect(read.outcome).toBe('allow');
    const write = await engine().checkSubject('write', 'write', { path: '/ws/a.txt' });
    expect(write.outcome).toBe('deny');
    if (write.outcome === 'deny') expect(write.error.code).toBe('SY-PERM-005');
  });

  it('handler receives ask and its decision wins (SY-PERM-002 on deny)', async () => {
    let sawRequest = false;
    const out = await engine({
      onRequest: async () => {
        sawRequest = true;
        return { decision: 'deny' };
      },
    }).checkSubject('write', 'write', { path: '/ws/a.txt' });
    expect(sawRequest).toBe(true);
    expect(out.outcome).toBe('deny');
    if (out.outcome === 'deny') expect(out.error.code).toBe('SY-PERM-002');
  });
});

describe('permission modes (BR-001/BR-002 semantics)', () => {
  it('strict mode asks for everything, including reads (three-tier CLI default)', async () => {
    const e = engine({ mode: 'strict' });
    const read = await e.checkSubject('read', 'read', { path: '/ws/a.txt' });
    expect(read.outcome).toBe('deny'); // ask → no handler → deny
    if (read.outcome === 'deny') expect(read.error.code).toBe('SY-PERM-005');

    let sawReadRequest = false;
    const e2 = engine({
      mode: 'strict',
      onRequest: async (req) => {
        sawReadRequest = req.risk === 'read';
        return { decision: 'allow' };
      },
    });
    const readAllowed = await e2.checkSubject('read', 'read', { path: '/ws/a.txt' });
    expect(sawReadRequest).toBe(true);
    expect(readAllowed.outcome).toBe('allow');

    // explicit allow rule still beats the strict default
    const ruleBack = await engine({
      mode: 'strict',
      rules: [{ effect: 'allow', tool: 'read', source: 'user' }],
    }).checkSubject('read', 'read', { path: '/ws/a.txt' });
    expect(ruleBack.outcome).toBe('allow');

    // dangerous commands stay denied regardless of mode (BR-006)
    expect((await e.checkSubject('bash', 'exec', { command: 'rm -rf /' })).outcome).toBe('deny');
  });

  it('plan mode only allows read risk', async () => {
    const e = engine({ mode: 'plan' });
    expect((await e.checkSubject('read', 'read', {})).outcome).toBe('allow');
    expect((await e.checkSubject('write', 'write', { path: '/ws/a.txt' })).outcome).toBe('deny');
    expect((await e.checkSubject('bash', 'exec', { command: 'ls' })).outcome).toBe('allow'); // classified read
  });

  it('acceptEdits allows workspace writes but not outside (BR-003)', async () => {
    const e = engine({ mode: 'acceptEdits' });
    expect((await e.checkSubject('write', 'write', { path: '/ws/a.txt' })).outcome).toBe('allow');
    const outside = await e.checkSubject('write', 'write', { path: '/outside/x.txt' });
    expect(outside.outcome).toBe('deny');
    if (outside.outcome === 'deny') expect(outside.error.code).toBe('SY-PERM-003');
  });

  it('default mode outside-workspace write is SY-PERM-003, not ask', async () => {
    const out = await engine().checkSubject('write', 'write', { path: '/outside/x.txt' });
    expect(out.outcome).toBe('deny');
    if (out.outcome === 'deny') expect(out.error.code).toBe('SY-PERM-003');
  });

  it('bypass allows everything the engine sees', async () => {
    const e = engine({ mode: 'bypass' });
    expect((await e.checkSubject('write', 'write', { path: '/outside/x.txt' })).outcome).toBe('allow');
  });
});

describe('dangerous commands (BR-006 / FR-043)', () => {
  it.each([
    'rm -rf /',
    'rm -rf ~',
    'rm -rf /* ',
    'mkfs.ext4 /dev/sda1',
    'dd if=/dev/zero of=/dev/disk0',
    'git push origin main --force',
    'shutdown -h now',
  ])('classifyCommand("%s") → dangerous', (cmd) => {
    expect(classifyCommand(cmd)).toBe('dangerous');
  });

  it.each([
    ['ls -la', 'read'],
    ['cat a.txt | grep foo', 'read'],
    ['git status && git diff', 'read'],
    ['pwd', 'read'],
    ['echo done', 'read'],
    ['npm install', 'write'],
    ['rm -rf node_modules', 'write'],
    ['echo hi > out.txt', 'write'],
    ['cd src && npm test', 'write'],
  ])('classifyCommand("%s") → %s', (cmd, want) => {
    expect(classifyCommand(cmd)).toBe(want);
  });

  it('engine denies dangerous bash regardless of mode except explicit user allow', async () => {
    const denied = await engine().checkSubject('bash', 'exec', { command: 'rm -rf /' });
    expect(denied.outcome).toBe('deny');
    if (denied.outcome === 'deny') expect(denied.error.code).toBe('SY-PERM-004');

    const userAllowed = await engine({
      rules: [{ effect: 'allow', tool: 'bash', source: 'user', match: { command: 'rm -rf /' } }],
    }).checkSubject('bash', 'exec', { command: 'rm -rf /' });
    expect(userAllowed.outcome).toBe('allow');
  });

  it('read-classified commands count as read risk in default mode (allow)', async () => {
    const e = engine();
    const out = await e.checkSubject('bash', 'exec', { command: 'ls -la /ws' });
    expect(out.outcome).toBe('allow');
  });
});

describe('glob rules', () => {
  it('matches tool names with wildcards and path patterns', async () => {
    const e = engine({
      rules: [{ effect: 'allow', tool: 'mcp__github__*', source: 'user' }],
    });
    expect((await e.checkSubject('mcp__github__create_issue', 'network', {})).outcome).toBe('allow');
    const denied = await e.checkSubject('mcp__gitlab__*', 'network', {});
    expect(denied.outcome).toBe('deny');
  });
});

// 审批挂起时的热改设置（recheck）：用户改权限后重新评估同一请求，
// 升档即放行、无需再次询问；硬拒绝与 deny 规则不受升档影响。
describe('hot policy change during approval (recheck)', () => {
  it('policyVerdict reports ask without invoking the approval handler', async () => {
    let calls = 0;
    const e = engine({
      mode: 'default',
      onRequest: async () => {
        calls += 1;
        return { decision: 'allow' };
      },
    });
    const v = await e.policyVerdict('write', 'write', { path: '/ws/a.txt' });
    expect(v.outcome).toBe('ask');
    if (v.outcome === 'ask') expect(v.reason).toContain('write');
    expect(calls).toBe(0);
  });

  it('upgrading the tier mid-approval allows the pending request without a second prompt', async () => {
    let e!: PermissionEngine;
    let calls = 0;
    e = engine({
      mode: 'default',
      onRequest: async () => {
        calls += 1;
        e.setMode('bypass'); // 用户在审批界面输入 /permission si
        return { recheck: true };
      },
    });
    const out = await e.checkSubject('write', 'write', { path: '/ws/a.txt' });
    expect(out.outcome).toBe('allow');
    expect(calls).toBe(1); // 只问了一次
  });

  it('prompts again when the new policy still requires approval', async () => {
    let calls = 0;
    const e = engine({
      mode: 'default',
      onRequest: async () => {
        calls += 1;
        return calls === 1 ? { recheck: true } : { decision: 'allow' };
      },
    });
    const out = await e.checkSubject('write', 'write', { path: '/ws/a.txt' });
    expect(out.outcome).toBe('allow');
    expect(calls).toBe(2);
  });

  it('recheck can turn an ask into a deny (downgrade to plan)', async () => {
    let e!: PermissionEngine;
    e = engine({
      mode: 'default',
      onRequest: async () => {
        e.setMode('plan');
        return { recheck: true };
      },
    });
    const out = await e.checkSubject('write', 'write', { path: '/ws/a.txt' });
    expect(out.outcome).toBe('deny');
    if (out.outcome === 'deny') expect(out.error.code).toBe('SY-PERM-001');
  });

  it('dangerous commands stay denied even in bypass (BR-006)', async () => {
    const v = await engine({ mode: 'bypass' }).policyVerdict('bash', 'exec', { command: 'rm -rf /' });
    expect(v.outcome).toBe('deny');
    if (v.outcome === 'deny') expect(v.error.code).toBe('SY-PERM-004');
  });

  it('bounds endless rechecks and denies (SY-PERM-002)', async () => {
    const e = engine({ mode: 'default', onRequest: async () => ({ recheck: true }) });
    const out = await e.checkSubject('write', 'write', { path: '/ws/a.txt' });
    expect(out.outcome).toBe('deny');
    if (out.outcome === 'deny') expect(out.error.code).toBe('SY-PERM-002');
  });
});
