/**
 * Runtime abstraction — every IO the kernel performs goes through this
 * interface (ADR-03). Tests inject in-memory implementations; the Node
 * host uses `nodeRuntime()`. The library itself never touches fs/child_process
 * directly (NFR-011).
 */

export interface FileStat {
  size: number;
  mtimeMs: number;
  isFile: boolean;
  isDirectory: boolean;
}

export interface DirEntry {
  name: string;
  isFile: boolean;
  isDirectory: boolean;
}

export interface FileSystem {
  readFile(path: string, opts?: { encoding?: 'utf8' }): Promise<string>;
  writeFile(path: string, data: string): Promise<void>;
  /** Atomic-ish append; used for the JSONL session log (no read-rewrite). */
  appendFile(path: string, data: string): Promise<void>;
  stat(path: string): Promise<FileStat>;
  readdir(path: string): Promise<DirEntry[]>;
  realpath(path: string): Promise<string>;
  mkdir(path: string, opts?: { recursive?: boolean }): Promise<void>;
  /** Remove an empty directory (session lock release). */
  rmdir(path: string): Promise<void>;
  unlink(path: string): Promise<void>;
  exists(path: string): Promise<boolean>;
}

export interface ProcessHandle {
  readonly pid: number | undefined;
  readonly stdout: AsyncIterable<string>;
  readonly stderr: AsyncIterable<string>;
  /** Resolves with the exit code; killed processes resolve non-zero. */
  exited: Promise<number>;
  kill(signal?: 'SIGTERM' | 'SIGKILL'): void;
}

export interface ShellSpawnOptions {
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Run in its own process group so the whole tree can be signalled. */
  detached?: boolean;
}

export interface Shell {
  spawn(command: string, args: string[], opts?: ShellSpawnOptions): ProcessHandle;
}

export interface HttpResponse {
  status: number;
  headers: Record<string, string>;
  /** Streaming body for SSE; fall back to text() when absent (memory mocks). */
  body?: ReadableStream<Uint8Array>;
  text(): Promise<string>;
}

export interface HttpClient {
  fetch(url: string, init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  }): Promise<HttpResponse>;
}

export interface Clock {
  now(): number;
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface Logger {
  log(level: LogLevel, msg: string, fields?: Record<string, unknown>): void;
}

export interface Env {
  get(name: string): string | undefined;
}

export interface IdGenerator {
  /** Monotonic-unique, sortable ids for messages / calls / sessions. */
  next(prefix: string): string;
}

export interface Runtime {
  fs: FileSystem;
  shell: Shell;
  http: HttpClient;
  clock: Clock;
  logger: Logger;
  env: Env;
  ids: IdGenerator;
}

export const noopLogger: Logger = {
  log() {
    /* silence by default; the CLI attaches a real logger */
  },
};

/** Collect log lines in memory — handy for tests and `syao doctor`. */
export class MemoryLogger implements Logger {
  readonly lines: { level: LogLevel; msg: string; fields?: Record<string, unknown> }[] = [];
  log(level: LogLevel, msg: string, fields?: Record<string, unknown>): void {
    this.lines.push({ level, msg, ...(fields !== undefined ? { fields } : {}) });
  }
}
