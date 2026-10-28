import { describe, expect, it } from 'vitest';
import { configSchema, loadConfig, resolveServerToken, type SyaoConfig } from '../src';
import { fakeRuntime } from './helpers';

/**
 * C9 · Agent RPC configuration section (03 §5.6).
 *
 * Two business rules must hold at the rpc layer exactly as they do at the
 * permission layer: a project config may not enable bypass (BR-002), and it
 * may not relax a user-level deny (BR-024).
 */

const projectConfig = (rpc: unknown): string => JSON.stringify({ rpc });

function runtimeWith(seed: Record<string, string>, env: Record<string, string> = {}) {
  return fakeRuntime(seed, { env });
}

describe('C9 · rpc config section', () => {
  it('is optional and has safe defaults', () => {
    const parsed = configSchema.parse({});
    expect(parsed.rpc.policy.rules).toEqual([]);
    expect(parsed.rpc.audit.enabled).toBe(false);
    expect(parsed.rpc.audit.retentionDays).toBe(30);
    expect(parsed.rpc.registry).toEqual([]);
    expect(parsed.rpc.server).toEqual({});
  });

  it('accepts the documented shape and merges across layers', async () => {
    const runtime = runtimeWith({
      '/home/u/.syaocode/config.json': JSON.stringify({
        rpc: {
          policy: { bundle: 'org.json', mode: 'default' },
          budget: { limitUsd: 5 },
          server: { host: '127.0.0.1', port: 8787 },
          audit: { enabled: true },
          registry: [{ id: 'gh', protocol: 'mcp', endpoint: 'stdio:npx' }],
        },
      }),
      '/ws/.syaocode/config.json': projectConfig({
        budget: { limitTokens: 1000 },
        registry: [{ id: 'local', protocol: 'local', endpoint: 'inproc' }],
      }),
    });
    const config = await loadConfig({
      userPath: '/home/u/.syaocode/config.json',
      projectPath: '/ws/.syaocode/config.json',
      runtime,
    });
    expect(config.rpc.policy.bundle).toBe('org.json');
    expect(config.rpc.budget).toEqual({ limitUsd: 5, limitTokens: 1000 });
    expect(config.rpc.server.port).toBe(8787);
    expect(config.rpc.audit).toEqual({ enabled: true, retentionDays: 30 });
    // Registry entries accumulate across layers.
    expect(config.rpc.registry.map((e) => e.id).sort()).toEqual(['gh', 'local']);
  });

  it('BR-002: a project cannot enable bypass through rpc.policy.mode', async () => {
    const runtime = runtimeWith({
      '/ws/.syaocode/config.json': projectConfig({ policy: { mode: 'bypass' } }),
    });
    const config = await loadConfig({ projectPath: '/ws/.syaocode/config.json', runtime });
    expect(config.rpc.policy.mode).toBe('default');
    expect(config.permissionMode).not.toBe('bypass');
  });

  it('BR-024: a project rule cannot relax a user-level deny in the rpc layer', async () => {
    const runtime = runtimeWith({
      '/home/u/.syaocode/config.json': JSON.stringify({
        rpc: { policy: { rules: [{ effect: 'deny', tool: 'bash', source: 'user' }] } },
      }),
      '/ws/.syaocode/config.json': projectConfig({
        policy: {
          rules: [
            { effect: 'allow', tool: 'bash', source: 'project' },
            { effect: 'allow', tool: 'read', source: 'project' },
          ],
        },
      }),
    });
    const config = await loadConfig({
      userPath: '/home/u/.syaocode/config.json',
      projectPath: '/ws/.syaocode/config.json',
      runtime,
    });
    const bash = config.rpc.policy.rules.find((r) => r.tool === 'bash');
    expect(bash?.effect).toBe('deny');
    // An unrelated rule is untouched: BR-024 is not a blanket deny.
    const read = config.rpc.policy.rules.find((r) => r.tool === 'read');
    expect(read?.effect).toBe('allow');
  });

  it('rejects a malformed rpc section with SY-CFG-001 field paths', async () => {
    const runtime = runtimeWith({
      '/ws/.syaocode/config.json': projectConfig({ server: { port: 99_999 } }),
    });
    await expect(
      loadConfig({ projectPath: '/ws/.syaocode/config.json', runtime }),
    ).rejects.toMatchObject({ code: 'SY-CFG-001' });
  });
});

describe('C9 · server token is an environment reference, never a literal', () => {
  it('resolves env:NAME, ${NAME}, $NAME and a bare variable name', () => {
    const env = { get: (n: string) => (n === 'SYAO_TOKEN' ? 's3cret' : undefined) };
    for (const ref of ['env:SYAO_TOKEN', '${SYAO_TOKEN}', '$SYAO_TOKEN', 'SYAO_TOKEN']) {
      expect(resolveServerToken(ref, env), ref).toBe('s3cret');
    }
  });

  it('refuses a literal secret instead of shipping it', () => {
    const env = { get: () => undefined };
    expect(resolveServerToken('sk-live-abcdef123456', env)).toBeUndefined();
    expect(resolveServerToken('', env)).toBeUndefined();
    expect(resolveServerToken(undefined, env)).toBeUndefined();
  });

  it('returns undefined when the referenced variable is unset', () => {
    expect(resolveServerToken('env:MISSING', { get: () => undefined })).toBeUndefined();
  });
});

describe('C9 · rpc config stays inside the layered precedence', () => {
  it('code layer wins over project for the same field', async () => {
    const runtime = runtimeWith({
      '/ws/.syaocode/config.json': projectConfig({ budget: { limitUsd: 1 } }),
    });
    const code: Partial<SyaoConfig> = { rpc: { ...configSchema.parse({}).rpc, budget: { limitUsd: 9 } } };
    const config = await loadConfig({ projectPath: '/ws/.syaocode/config.json', runtime, code });
    expect(config.rpc.budget.limitUsd).toBe(9);
  });
});
