import {
  isPersistableEvent,
  logEntryTypeOf,
  type AgentEvent,
  type EventSink,
  type Runtime,
} from '@syaocode/core';

/**
 * File-backed event sink (report C3).
 *
 * Appends one JSON line per persisted event, in the same shape as a session
 * log entry, so a sink file can be replayed with the session tools. Writes
 * are serialized through a single promise chain: two concurrent runs must
 * never interleave halves of a line.
 *
 * Only governance-relevant events are written by default
 * (`permission.*`, `tool.receipt`, `verification.*`, `usage`); pass
 * `all: true` to keep the full stream.
 */
export interface FileEventSinkOptions {
  /** Session id stamped on entries; falls back to the envelope's sessionId. */
  sessionId?: string;
  /** Persist every event instead of only the governance-relevant ones. */
  all?: boolean;
}

interface EventLogLine {
  v: 1;
  id: string;
  ts: number;
  sessionId: string;
  type: ReturnType<typeof logEntryTypeOf>;
  data: AgentEvent;
}

export function createFileEventSink(
  runtime: Runtime,
  path: string,
  opts: FileEventSinkOptions = {},
): EventSink {
  let chain: Promise<void> = Promise.resolve();
  let pending = 0;
  let lastError: unknown;

  const write = (line: EventLogLine): void => {
    pending += 1;
    chain = chain
      .then(async () => {
        const dir = path.slice(0, path.lastIndexOf('/'));
        if (dir !== '' && dir !== path) await runtime.fs.mkdir(dir, { recursive: true });
        await runtime.fs.appendFile(path, `${JSON.stringify(line)}\n`);
      })
      .catch((e: unknown) => {
        lastError = e;
        runtime.logger.log('warn', 'event sink: write failed', {
          path,
          error: e instanceof Error ? e.message : String(e),
        });
      })
      .finally(() => {
        pending -= 1;
      });
  };

  return {
    emit(event: AgentEvent): void {
      if (opts.all !== true && !isPersistableEvent(event)) return;
      const sessionId = opts.sessionId ?? event.sessionId ?? '';
      write({
        v: 1,
        id: `${event.runId}:${event.seq}`,
        ts: event.ts ?? 0,
        sessionId,
        type: logEntryTypeOf(event),
        data: event,
      });
    },
    async flush(): Promise<void> {
      await chain;
      if (lastError !== undefined) {
        const error = lastError;
        lastError = undefined;
        throw error;
      }
    },
  };
}
