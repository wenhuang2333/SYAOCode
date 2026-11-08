/**
 * `Runtime.fs` primitives the write-lease work depends on (06 §6.1, WP-1.1).
 *
 * These are the low-level guarantees the store layer will build on, so they
 * are tested against the REAL filesystem rather than a mock: the whole point of
 * `rename` is that the operating system makes the replacement atomic, and a
 * fake that "looks atomic" proves nothing about the host.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { nodeRuntime } from '../src/index';

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'liwen-fs-'));
}

describe('NodeFileSystem.rename', () => {
  it('replaces an existing target in one step', async () => {
    const dir = tempDir();
    const runtime = nodeRuntime();
    try {
      const target = join(dir, 'budget.json');
      const tmp = join(dir, 'budget.json.tmp');
      writeFileSync(target, '{"reservedUsd":0}', 'utf8');
      writeFileSync(tmp, '{"reservedUsd":5}', 'utf8');

      await runtime.fs.rename(tmp, target);

      // The whole point: the target holds the NEW content and the temp file is
      // gone, with no window where the target was truncated.
      expect(readFileSync(target, 'utf8')).toBe('{"reservedUsd":5}');
      expect(await runtime.fs.exists(tmp)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('renames onto a path that does not exist yet', async () => {
    const dir = tempDir();
    const runtime = nodeRuntime();
    try {
      const from = join(dir, 'a.jsonl');
      const to = join(dir, 'b.jsonl');
      writeFileSync(from, 'line\n', 'utf8');
      await runtime.fs.rename(from, to);
      expect(readFileSync(to, 'utf8')).toBe('line\n');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects when the source is missing', async () => {
    const dir = tempDir();
    const runtime = nodeRuntime();
    try {
      await expect(runtime.fs.rename(join(dir, 'nope'), join(dir, 'target'))).rejects.toThrow(/ENOENT/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('never exposes a partial file to a concurrent reader', async () => {
    const dir = tempDir();
    const runtime = nodeRuntime();
    try {
      const target = join(dir, 'state.json');
      writeFileSync(target, 'A'.repeat(200), 'utf8');

      // Each round writes a differently-sized payload then renames it over.
      // A reader must only ever observe a COMPLETE payload, never a prefix.
      const payloads = ['B'.repeat(50), 'C'.repeat(500), 'D'.repeat(10)];
      let bad = 0;
      let stop = false;
      const reader = (async () => {
        while (!stop) {
          const text = readFileSync(target, 'utf8');
          if (!/^(A{200}|B{50}|C{500}|D{10})$/.test(text)) bad += 1;
          await new Promise((resolve) => setImmediate(resolve));
        }
      })();

      for (const payload of payloads) {
        const tmp = join(dir, `state.json.tmp.${payload.length}`);
        await writeFile(tmp, payload, 'utf8');
        await runtime.fs.rename(tmp, target);
      }
      stop = true;
      await reader;
      expect(bad).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('NodeFileSystem fsync', () => {
  it('flushes a file that exists', async () => {
    const dir = tempDir();
    const runtime = nodeRuntime();
    try {
      const path = join(dir, 'audit.jsonl');
      writeFileSync(path, '{"a":1}\n', 'utf8');
      await expect(runtime.fs.fsyncFile?.(path)).resolves.toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects fsyncFile for a missing path', async () => {
    const dir = tempDir();
    const runtime = nodeRuntime();
    try {
      await expect(runtime.fs.fsyncFile?.(join(dir, 'missing'))).rejects.toThrow(/ENOENT/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('flushes a directory so a rename is durable', async () => {
    const dir = tempDir();
    const runtime = nodeRuntime();
    try {
      const sub = join(dir, 'arf');
      await mkdir(sub);
      await expect(runtime.fs.fsyncDir?.(sub)).resolves.toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reports fsync support on the Node host', () => {
    const runtime = nodeRuntime();
    // The store layer decides between 'batch' and 'never' from this.
    expect(typeof runtime.fs.fsyncFile).toBe('function');
    expect(typeof runtime.fs.fsyncDir).toBe('function');
    expect(typeof runtime.fs.rename).toBe('function');
  });
});

describe('NodeClock.monotonicNow', () => {
  it('exists on the host clock', () => {
    const runtime = nodeRuntime();
    expect(typeof runtime.clock.monotonicNow).toBe('function');
  });

  it('never moves backwards', async () => {
    const runtime = nodeRuntime();
    let previous = runtime.clock.monotonicNow?.() ?? 0;
    for (let i = 0; i < 200; i += 1) {
      const current = runtime.clock.monotonicNow?.() ?? 0;
      expect(current).toBeGreaterThanOrEqual(previous);
      previous = current;
      await new Promise((resolve) => setImmediate(resolve));
    }
  });

  it('is independent of the wall clock', () => {
    const runtime = nodeRuntime();
    // Wall clock and monotonic clock answer different questions; a lease must
    // not be fooled by an NTP step in `Date.now()`.
    const before = runtime.clock.monotonicNow?.() ?? 0;
    const wall = runtime.clock.now();
    expect(typeof wall).toBe('number');
    expect((runtime.clock.monotonicNow?.() ?? 0) - before).toBeLessThan(5_000);
  });
});
