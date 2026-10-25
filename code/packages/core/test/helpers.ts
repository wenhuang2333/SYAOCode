import { randomUUID } from 'node:crypto';
import { noopLogger, type Runtime } from '../src';

/** Minimal in-test runtime: memory fs, optional scripted shell, no network. */
export function fakeRuntime(
  seed: Record<string, string> = {},
  opts: {
    env?: Record<string, string>;
    shell?: (command: string) => { code: number; stdout?: string; stderr?: string };
  } = {},
): Runtime & { files: Map<string, string> } {
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
      appendFile: async (p, data) => {
        files.set(norm(p), `${files.get(norm(p)) ?? ''}${data}`);
      },
      stat: async (p) => {
        if (!files.has(norm(p))) throw new Error(`ENOENT ${p}`);
        return { size: (files.get(norm(p)) ?? '').length, mtimeMs: 1, isFile: true, isDirectory: false };
      },
      readdir: async () => [],
      realpath: async (p) => norm(p),
      mkdir: async () => {},
      rmdir: async () => {},
      unlink: async (p) => {
        files.delete(norm(p));
      },
      exists: async (p) => files.has(norm(p)),
    },
    shell: {
      spawn: (command, args) => {
        if (opts.shell === undefined) throw new Error('shell not available in fakeRuntime');
        const script = command === '/bin/sh' ? (args[args.length - 1] ?? '') : command;
        const result = opts.shell(script);
        let resolve!: (code: number) => void;
        const exited = new Promise<number>((r) => {
          resolve = r;
        });
        queueMicrotask(() => resolve(result.code));
        const stream = (text: string): AsyncIterable<string> =>
          (async function* () {
            for (const line of text.split('\n')) if (line !== '') yield line;
          })();
        return {
          pid: 1,
          stdout: stream(result.stdout ?? ''),
          stderr: stream(result.stderr ?? ''),
          exited,
          kill() {
            resolve(137);
          },
        };
      },
    },
    http: {
      fetch: async () => ({ status: 500, headers: {}, text: async () => '' }),
    },
    clock: { now: () => 1_000, sleep: async () => {} },
    logger: noopLogger,
    env: { get: (name) => opts.env?.[name] },
    ids,
  };
}
