/**
 * Minimal in-memory `Runtime` for the protocol contract suites.
 *
 * No `node:` imports, no real IO: `fs` records calls (so a test can prove the
 * ACP edge never falls back to a local filesystem), `shell.spawn` is scriptable,
 * `http.fetch` fails unless a test installs a handler, and the clock is real but
 * injectable.
 */

import {
  MemoryLogger,
  type Clock,
  type DirEntry,
  type Env,
  type FileStat,
  type FileSystem,
  type HttpClient,
  type HttpResponse,
  type IdGenerator,
  type Logger,
  type ProcessHandle,
  type Runtime,
  type Shell,
  type ShellSpawnOptions,
} from '@syaocode/core';

export interface FakeRuntime extends Runtime {
  /** Paths written through `runtime.fs.writeFile` (must stay empty for ACP). */
  readonly fsWrites: string[];
  /** Paths read through `runtime.fs.readFile`. */
  readonly fsReads: string[];
  /** Commands spawned through `runtime.shell.spawn` (with their options). */
  readonly spawns: { command: string; args: string[]; opts?: ShellSpawnOptions }[];
  logger: Logger & { lines: { level: string; msg: string }[] };
}

export interface FakeRuntimeOptions {
  seed?: Record<string, string>;
  /** Handler for `runtime.http.fetch`; default rejects. */
  http?: (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<HttpResponse>;
  /** Scripted process handles returned by `runtime.shell.spawn`. */
  spawn?: (command: string, args: string[]) => ProcessHandle;
  now?: () => number;
}

function memoryFs(seed: Record<string, string>, now: () => number, writes: string[], reads: string[]): FileSystem {
  const files = new Map<string, string>(Object.entries(seed));
  const norm = (path: string): string => path.replace(/\/+/g, '/');
  return {
    async readFile(path) {
      reads.push(path);
      const value = files.get(norm(path));
      if (value === undefined) throw new Error(`ENOENT: ${path}`);
      return value;
    },
    async writeFile(path, data) {
      writes.push(path);
      files.set(norm(path), data);
    },
    async appendFile(path, data) {
      writes.push(path);
      files.set(norm(path), `${files.get(norm(path)) ?? ''}${data}`);
    },
    async stat(path): Promise<FileStat> {
      const value = files.get(norm(path));
      if (value === undefined) throw new Error(`ENOENT: ${path}`);
      return { size: value.length, mtimeMs: now(), isFile: true, isDirectory: false };
    },
    async readdir(): Promise<DirEntry[]> {
      return [];
    },
    async realpath(path) {
      return norm(path);
    },
    async mkdir() {
      /* no-op */
    },
    async rmdir() {
      /* no-op */
    },
    async unlink(path) {
      files.delete(norm(path));
    },
    async exists(path) {
      return files.has(norm(path));
    },
  };
}

export function createFakeRuntime(options?: FakeRuntimeOptions): FakeRuntime {
  const fsWrites: string[] = [];
  const fsReads: string[] = [];
  const spawns: { command: string; args: string[]; opts?: ShellSpawnOptions }[] = [];
  const logger = new MemoryLogger();
  const now = options?.now ?? (() => Date.now());
  let counter = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const ids: IdGenerator = {
    next(prefix: string): string {
      counter += 1;
      return `${prefix}_${counter}`;
    },
  };

  const clock: Clock = {
    now,
    async sleep(ms: number, signal?: AbortSignal): Promise<void> {
      if (ms <= 0) return;
      await new Promise<void>((resolve, reject) => {
        timer = setTimeout(() => {
          timer = undefined;
          resolve();
        }, ms);
        signal?.addEventListener(
          'abort',
          () => {
            if (timer !== undefined) clearTimeout(timer);
            timer = undefined;
            resolve();
          },
          { once: true },
        );
        void reject;
      });
    },
  };

  const shell: Shell = {
    spawn(command: string, args: string[], opts?: ShellSpawnOptions): ProcessHandle {
      spawns.push({ command, args, ...(opts !== undefined ? { opts } : {}) });
      if (options?.spawn !== undefined) return options.spawn(command, args);
      return {
        pid: undefined,
        stdout: emptyStream(),
        stderr: emptyStream(),
        exited: Promise.resolve(1),
        kill() {
          /* no-op */
        },
      };
    },
  };

  const http: HttpClient = {
    async fetch(url, init) {
      if (options?.http !== undefined) return options.http(url, init);
      throw new Error(`no http handler installed for ${url}`);
    },
  };

  const env: Env = { get: () => undefined };

  const runtime: FakeRuntime = {
    fs: memoryFs(options?.seed ?? {}, now, fsWrites, fsReads),
    shell,
    http,
    clock,
    logger,
    env,
    ids,
    fsWrites,
    fsReads,
    spawns,
  };
  return runtime;
}

async function* emptyStream(): AsyncIterable<string> {
  /* yields nothing */
}

type ProcessStdinLike = NonNullable<ProcessHandle['stdin']>;

/** A process handle whose stdout emits the given lines then ends. */
export function scriptedHandle(lines: readonly string[], stdin?: ProcessStdinLike): ProcessHandle {
  return {
    pid: 4242,
    stdout: (async function* () {
      for (const line of lines) yield line;
    })(),
    stderr: emptyStream(),
    exited: Promise.resolve(0),
    kill() {
      /* no-op */
    },
    ...(stdin !== undefined ? { stdin } : {}),
  };
}

/** A recording child stdin writer (core's optional `ProcessHandle.stdin`). */
export function recordingStdin(): ProcessStdinLike & { written: string[]; ended: boolean } {
  const written: string[] = [];
  return {
    written,
    ended: false,
    write(data: string): void {
      written.push(data);
    },
    end(): void {
      this.ended = true;
    },
  };
}
