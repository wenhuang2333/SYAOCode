import { randomUUID } from 'node:crypto';
import { noopLogger, type Runtime } from '../src';

/** Minimal in-test runtime: memory fs, no shell/http. Keeps core tests free
 * of any @syaocode dependency (the kernel depends on nothing). */
export function fakeRuntime(seed: Record<string, string> = {}): Runtime & { files: Map<string, string> } {
  const files = new Map(Object.entries(seed));
  const norm = (p: string) => (p.startsWith('/') ? p.replace(/\/+/g, '/') : `/${p}`);
  const ids = (() => {
    let n = 0;
    return { next: (prefix: string) => `${prefix}_${randomUUID().slice(0, 8)}${(n += 1)}` };
  })();
  return {
    files,
    fs: {
      readFile: async (p) => {
        const c = files.get(norm(p));
        if (c === undefined) throw new Error(`ENOENT ${p}`);
        return c;
      },
      writeFile: async (p, data) => {
        files.set(norm(p), data);
      },
      stat: async (p) => {
        if (!files.has(norm(p))) throw new Error(`ENOENT ${p}`);
        return { size: (files.get(norm(p)) ?? '').length, mtimeMs: 1, isFile: true, isDirectory: false };
      },
      readdir: async () => [],
      realpath: async (p) => norm(p),
      mkdir: async () => {},
      unlink: async (p) => {
        files.delete(norm(p));
      },
      exists: async (p) => files.has(norm(p)),
    },
    shell: {
      spawn: () => {
        throw new Error('shell not available in fakeRuntime');
      },
    },
    http: {
      fetch: async () => ({ status: 500, headers: {}, text: async () => '' }),
    },
    clock: { now: () => 1_000, sleep: async () => {} },
    logger: noopLogger,
    env: { get: () => undefined },
    ids,
  };
}
