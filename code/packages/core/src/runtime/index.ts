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

/** Raw byte chunks as a process emits them (no line splitting). */
export type ProcessChunkStream = AsyncIterable<Uint8Array>;

export interface ProcessHandle {
  readonly pid: number | undefined;
  readonly stdout: AsyncIterable<string>;
  readonly stderr: AsyncIterable<string>;
  /**
   * Raw stdout bytes, exactly as the process wrote them.
   *
   * `stdout` splits on newlines, which is right for log/command output but
   * destroys any framing that uses a header/body separator — MCP's stdio
   * transport (`Content-Length: N\r\n\r\n<body>`) is the motivating case.
   * A protocol edge must read this stream, not `stdout`, whenever it is
   * present; it is optional so embedders that only implement line iteration
   * keep working.
   */
  stdoutChunks?: ProcessChunkStream;
  /** Raw stderr bytes; same contract as `stdoutChunks`. */
  stderrChunks?: ProcessChunkStream;
  /** Resolves with the exit code; killed processes resolve non-zero. */
  exited: Promise<number>;
  kill(signal?: 'SIGTERM' | 'SIGKILL'): void;
  /**
   * Optional stdin writer. Present when the child was spawned with a pipe;
   * a stdio protocol edge (MCP/ACP) fails closed with an `internal` error
   * rather than silently degrading to a read-only channel when it is absent.
   */
  stdin?: ProcessStdin;
}

export interface ProcessStdin {
  /** Write a chunk (callers frame it themselves, e.g. JSON-RPC + '\n'). */
  write(data: string): void;
  /** Close the child's stdin (EOF). */
  end(): void;
}

export interface ShellSpawnOptions {
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Run in its own process group so the whole tree can be signalled. */
  detached?: boolean;
  /**
   * Open a writable stdin pipe so a stdio protocol edge can frame requests to
   * the child. Defaults to `false`: commands that never read stdin (the vast
   * majority of tool invocations) must not inherit a dangling pipe.
   */
  stdin?: boolean;
}

export interface Shell {
  spawn(command: string, args: string[], opts?: ShellSpawnOptions): ProcessHandle;
}

/**
 * Decode a raw chunk stream into text **without** touching the framing.
 *
 * `ProcessHandle.stdout` is a line iterator: it strips the newlines, so a
 * header/body framing (`Content-Length: N\r\n\r\n<body>`) cannot survive it.
 * A protocol edge that speaks such a framing must read `stdoutChunks` and
 * decode the bytes itself; this helper is the byte-exact text view of that
 * stream, for the (rarer) case where the peer frames in characters rather
 * than bytes.
 */
export function decodeChunkStream(chunks: ProcessChunkStream): AsyncIterable<string> {
  return (async function* () {
    const decoder = new TextDecoder();
    for await (const chunk of chunks) {
      const text = decoder.decode(chunk, { stream: true });
      if (text !== '') yield text;
    }
    const tail = decoder.decode();
    if (tail !== '') yield tail;
  })();
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

/**
 * Optional cryptographic digest injection (report C6).
 *
 * The kernel already ships a dependency-free SHA-256, so this is only needed
 * when a host wants the platform implementation (node:crypto) or a
 * FIPS-approved module. Governance chains must never use FNV `contentHash`.
 */
export interface Hasher {
  sha256(text: string): string;
}

export interface Runtime {
  fs: FileSystem;
  shell: Shell;
  http: HttpClient;
  clock: Clock;
  logger: Logger;
  env: Env;
  ids: IdGenerator;
  /** Optional SHA-256 provider; the kernel default is used when absent. */
  hash?: Hasher;
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
