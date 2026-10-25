import { createHash, randomUUID } from 'node:crypto';
import { spawn as nodeSpawn } from 'node:child_process';
import * as fsp from 'node:fs/promises';
import {
  noopLogger,
  type Clock,
  type Env,
  type FileSystem,
  type HttpClient,
  type IdGenerator,
  type Logger,
  type ProcessHandle,
  type ReceiptStore,
  type Runtime,
  type Shell,
  type ShellSpawnOptions,
  type StoredOutput,
} from '@syaocode/core';

export type { HttpResponse } from '@syaocode/core';

class NodeFileSystem implements FileSystem {
  async readFile(path: string): Promise<string> {
    return fsp.readFile(path, 'utf8');
  }
  async writeFile(path: string, data: string): Promise<void> {
    await fsp.writeFile(path, data, 'utf8');
  }
  async appendFile(path: string, data: string): Promise<void> {
    await fsp.appendFile(path, data, 'utf8');
  }
  async stat(path: string) {
    const s = await fsp.stat(path);
    return { size: s.size, mtimeMs: s.mtimeMs, isFile: s.isFile(), isDirectory: s.isDirectory() };
  }
  async readdir(path: string) {
    const entries = await fsp.readdir(path, { withFileTypes: true });
    return entries.map((e) => ({ name: e.name, isFile: e.isFile(), isDirectory: e.isDirectory() }));
  }
  async realpath(path: string): Promise<string> {
    return fsp.realpath(path);
  }
  async mkdir(path: string, opts?: { recursive?: boolean }): Promise<void> {
    await fsp.mkdir(path, opts);
  }
  async rmdir(path: string): Promise<void> {
    await fsp.rmdir(path);
  }
  async unlink(path: string): Promise<void> {
    await fsp.unlink(path);
  }
  async exists(path: string): Promise<boolean> {
    try {
      await fsp.access(path);
      return true;
    } catch {
      return false;
    }
  }
}

class NodeShell implements Shell {
  spawn(command: string, args: string[], opts: ShellSpawnOptions = {}): ProcessHandle {
    const child = nodeSpawn(command, args, {
      cwd: opts.cwd,
      env: opts.env === undefined ? process.env : { ...process.env, ...opts.env },
      detached: opts.detached === true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let settled = false;
    const exited = new Promise<number>((resolve) => {
      child.once('exit', (code) => {
        settled = true;
        resolve(code === null ? (child.signalCode ? 137 : 1) : code);
      });
      child.once('error', () => {
        if (!settled) resolve(127);
      });
    });

    async function* lines(stream: NodeJS.ReadableStream | null): AsyncIterable<string> {
      if (stream === null) return;
      let buffer = '';
      for await (const chunk of stream) {
        buffer += String(chunk);
        let idx: number;
        while ((idx = buffer.indexOf('\n')) >= 0) {
          yield buffer.slice(0, idx);
          buffer = buffer.slice(idx + 1);
        }
      }
      if (buffer.length > 0) yield buffer;
    }

    const handle: ProcessHandle = {
      pid: child.pid,
      stdout: lines(child.stdout),
      stderr: lines(child.stderr),
      exited,
      kill(signal: 'SIGTERM' | 'SIGKILL' = 'SIGTERM'): void {
        if (child.exitCode === null && !child.killed) {
          try {
            if (opts.detached === true && child.pid !== undefined) {
              process.kill(-child.pid, signal);
            } else {
              child.kill(signal);
            }
          } catch {
            /* already gone */
          }
        }
      },
    };

    if (opts.signal !== undefined) {
      const onAbort = () => handle.kill('SIGKILL');
      if (opts.signal.aborted) onAbort();
      else opts.signal.addEventListener('abort', onAbort, { once: true });
    }
    if (opts.timeoutMs !== undefined) {
      const timer = setTimeout(() => handle.kill('SIGTERM'), opts.timeoutMs);
      void exited.then(() => clearTimeout(timer));
    }
    return handle;
  }
}

class NodeHttpClient implements HttpClient {
  async fetch(url: string, init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  }) {
    const res = await fetch(url, {
      ...(init?.method !== undefined ? { method: init.method } : {}),
      ...(init?.headers !== undefined ? { headers: init.headers } : {}),
      ...(init?.body !== undefined ? { body: init.body } : {}),
      ...(init?.signal !== undefined ? { signal: init.signal } : {}),
    });
    const headers: Record<string, string> = {};
    res.headers.forEach((v, k) => {
      headers[k] = v;
    });
    return {
      status: res.status,
      headers,
      ...(res.body !== null ? { body: res.body as ReadableStream<Uint8Array> } : {}),
      async text() {
        return res.text();
      },
    };
  }
}

class NodeClock implements Clock {
  now(): number {
    return Date.now();
  }
  sleep(ms: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.reject(new DOMException('Aborted', 'AbortError'));
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => resolve(), ms);
      signal?.addEventListener('abort', () => {
        clearTimeout(t);
        reject(new DOMException('Aborted', 'AbortError'));
      }, { once: true });
    });
  }
}

class NodeEnv implements Env {
  get(name: string): string | undefined {
    return process.env[name];
  }
}

class NodeIds implements IdGenerator {
  private counter = 0;
  next(prefix: string): string {
    this.counter += 1;
    const rand = randomUUID().slice(0, 8);
    return `${prefix}_${Date.now().toString(36)}${this.counter.toString(36)}_${rand}`;
  }
}

export function sha256Hex(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/** Content-addressed evidence store: <baseDir>/<sha256>. */
export function createFileReceiptStore(runtime: Runtime, baseDir: string): ReceiptStore {
  return {
    async put(text: string): Promise<StoredOutput> {
      const hash = sha256Hex(text);
      const ref = `${baseDir}/${hash}`;
      await runtime.fs.mkdir(baseDir, { recursive: true });
      if (!(await runtime.fs.exists(ref))) await runtime.fs.writeFile(ref, text);
      return { hash, ref };
    },
    async get(ref: string): Promise<string | undefined> {
      try {
        return await runtime.fs.readFile(ref);
      } catch {
        return undefined;
      }
    },
  };
}

export function nodeRuntime(overrides?: { logger?: Logger }): Runtime {
  return {
    fs: new NodeFileSystem(),
    shell: new NodeShell(),
    http: new NodeHttpClient(),
    clock: new NodeClock(),
    logger: overrides?.logger ?? noopLogger,
    env: new NodeEnv(),
    ids: new NodeIds(),
  };
}
