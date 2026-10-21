import {
  noopLogger,
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

/**
 * Fully in-memory Runtime for tests and evals: no fs, no real processes,
 * no network. Deterministic clock and ids.
 */

interface MemNode {
  content: string;
  mtimeMs: number;
  isDir: boolean;
}

class MemoryFileSystem implements FileSystem {
  private files = new Map<string, MemNode>();

  constructor(seed: Record<string, string> = {}, private clock: { now(): number }) {
    for (const [path, content] of Object.entries(seed)) {
      this.files.set(this.norm(path), { content, mtimeMs: clock.now(), isDir: false });
    }
  }

  private norm(path: string): string {
    const abs = path.startsWith('/') ? path : `/${path}`;
    return abs.replace(/\/+/g, '/').replace(/\/[^/]+\/\.\./g, '').replace(/\/\.\//g, '/') || '/';
  }

  snapshot(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [path, node] of this.files) {
      if (!node.isDir) out[path] = node.content;
    }
    return out;
  }

  async readFile(path: string): Promise<string> {
    const node = this.files.get(this.norm(path));
    if (node === undefined || node.isDir) throw new Error(`ENOENT: ${path}`);
    return node.content;
  }
  async writeFile(path: string, data: string): Promise<void> {
    this.files.set(this.norm(path), { content: data, mtimeMs: this.clock.now(), isDir: false });
  }
  async stat(path: string): Promise<FileStat> {
    const node = this.files.get(this.norm(path));
    if (node === undefined) throw new Error(`ENOENT: ${path}`);
    return { size: node.content.length, mtimeMs: node.mtimeMs, isFile: !node.isDir, isDirectory: node.isDir };
  }
  async readdir(path: string): Promise<DirEntry[]> {
    const prefix = `${this.norm(path)}/`;
    const names = new Set<string>();
    for (const key of this.files.keys()) {
      if (key.startsWith(prefix)) {
        const rest = key.slice(prefix.length);
        const first = rest.split('/')[0]!;
        names.add(first);
      }
    }
    if (names.size === 0 && !this.files.has(this.norm(path))) throw new Error(`ENOENT: ${path}`);
    return [...names].map((name) => {
      const node = this.files.get(`${prefix}${name}`);
      return { name, isFile: node !== undefined && !node.isDir, isDirectory: node === undefined || node.isDir };
    });
  }
  async realpath(path: string): Promise<string> {
    return this.norm(path);
  }
  async mkdir(path: string): Promise<void> {
    this.files.set(this.norm(path), { content: '', mtimeMs: this.clock.now(), isDir: true });
  }
  async unlink(path: string): Promise<void> {
    this.files.delete(this.norm(path));
  }
  async exists(path: string): Promise<boolean> {
    return this.files.has(this.norm(path));
  }
  /** Test helper: simulate an external modification. */
  pokeExternally(path: string, content: string): void {
    this.files.set(this.norm(path), { content, mtimeMs: this.clock.now() + 5000, isDir: false });
  }
}

class MemoryShell implements Shell {
  constructor(
    private handlers: Map<string, (args: string[], opts?: ShellSpawnOptions) => { code: number; stdout: string; stderr?: string }>,
    private clock: { now(): number },
  ) {}

  spawn(command: string, args: string[], opts?: ShellSpawnOptions): ProcessHandle {
    const handler = this.handlers.get(command);
    let exitedResolve: (code: number) => void;
    const exited = new Promise<number>((resolve) => {
      exitedResolve = resolve;
    });
    const mkStream = (text: string): AsyncIterable<string> =>
      (async function* () {
        for (const line of text.split('\n')) {
          if (line !== '') yield line;
        }
      })();
    if (handler === undefined) {
      exitedResolve!(127);
      return { pid: 1, stdout: mkStream(''), stderr: mkStream(`command not found: ${command}`), exited, kill() {} };
    }
    const result = handler(args, opts);
    if (opts?.signal?.aborted) exitedResolve!(137);
    else {
      const t = setTimeout(() => exitedResolve!(result.code), 0);
      void t;
    }
    return {
      pid: 1,
      stdout: mkStream(result.stdout),
      stderr: mkStream(result.stderr ?? ''),
      exited,
      kill() {
        exitedResolve!(137);
      },
    };
  }
}

class MemoryHttpClient implements HttpClient {
  private routes = new Map<string, (init?: { method?: string; body?: string }) => HttpResponse>();

  route(url: string, handler: (init?: { method?: string; body?: string }) => HttpResponse): void {
    this.routes.set(url, handler);
  }

  async fetch(url: string, init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal }): Promise<HttpResponse> {
    const handler = this.routes.get(url);
    if (handler === undefined) {
      return { status: 404, headers: {}, text: async () => JSON.stringify({ error: 'no route' }) };
    }
    return handler(init);
  }
}

class FakeClock implements Clock {
  private current = 1_700_000_000_000;
  now(): number {
    return this.current;
  }
  advance(ms: number): void {
    this.current += ms;
  }
  async sleep(ms: number, signal?: AbortSignal): Promise<void> {
    this.current += ms;
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
  }
}

class SeqIds implements IdGenerator {
  private n = 0;
  next(prefix: string): string {
    this.n += 1;
    return `${prefix}_${this.n}`;
  }
}

export class MemoryRuntime implements Runtime {
  readonly clock: FakeClock;
  readonly fs: MemoryFileSystem;
  readonly shell: MemoryShell;
  readonly http: MemoryHttpClient;
  readonly logger: Logger;
  readonly env: Env;
  readonly ids: IdGenerator;
  private envMap: Record<string, string>;

  constructor(opts: {
    seed?: Record<string, string>;
    commands?: Record<string, (args: string[], opts?: ShellSpawnOptions) => { code: number; stdout: string; stderr?: string }>;
    env?: Record<string, string>;
    logger?: Logger;
  } = {}) {
    this.clock = new FakeClock();
    this.fs = new MemoryFileSystem(opts.seed ?? {}, this.clock);
    const handlers = new Map(Object.entries(opts.commands ?? {}));
    this.shell = new MemoryShell(handlers, this.clock);
    this.http = new MemoryHttpClient();
    this.envMap = opts.env ?? {};
    this.env = { get: (name) => this.envMap[name] };
    this.ids = new SeqIds();
    this.logger = opts.logger ?? noopLogger;
  }

  setEnv(name: string, value: string): void {
    this.envMap[name] = value;
  }
}

export { FakeClock };
