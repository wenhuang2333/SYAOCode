/**
 * The in-memory host must satisfy the same `FileSystem` contract as the Node
 * one (06 §6.1, WP-1.1), because every kernel test leans on it. If `rename`
 * merely "worked" without replacing the target, the store tests would pass
 * while the shipped code corrupted files.
 */

import { describe, expect, it } from 'vitest';
import { MemoryRuntime } from '../src/index';

describe('MemoryFileSystem.rename', () => {
  it('replaces an existing target', async () => {
    const runtime = new MemoryRuntime({ seed: { '/t/budget.json': 'old', '/t/budget.json.tmp': 'new' } });
    await runtime.fs.rename('/t/budget.json.tmp', '/t/budget.json');
    expect(await runtime.fs.readFile('/t/budget.json')).toBe('new');
    expect(await runtime.fs.exists('/t/budget.json.tmp')).toBe(false);
  });

  it('renames to a new path', async () => {
    const runtime = new MemoryRuntime({ seed: { '/t/a': 'content' } });
    await runtime.fs.rename('/t/a', '/t/b');
    expect(await runtime.fs.readFile('/t/b')).toBe('content');
    expect(await runtime.fs.exists('/t/a')).toBe(false);
  });

  it('rejects a missing source', async () => {
    const runtime = new MemoryRuntime();
    await expect(runtime.fs.rename('/t/nope', '/t/target')).rejects.toThrow(/ENOENT/);
  });

  it('moves the content, not a reference to the old key', async () => {
    const runtime = new MemoryRuntime({ seed: { '/t/a': 'v1' } });
    await runtime.fs.rename('/t/a', '/t/b');
    // Writing the old path afterwards must not be visible at the new one.
    await runtime.fs.writeFile('/t/a', 'v2');
    expect(await runtime.fs.readFile('/t/b')).toBe('v1');
    expect(await runtime.fs.readFile('/t/a')).toBe('v2');
  });
});

describe('MemoryFileSystem fsync', () => {
  it('resolves for existing paths and rejects for missing ones', async () => {
    const runtime = new MemoryRuntime({ seed: { '/t/x': 'a' } });
    await expect(runtime.fs.fsyncFile?.('/t/x')).resolves.toBeUndefined();
    await expect(runtime.fs.fsyncFile?.('/t/missing')).rejects.toThrow(/ENOENT/);
    await expect(runtime.fs.fsyncDir?.('/t/x')).resolves.toBeUndefined();
  });
});

describe('MemoryFileSystem.stat fingerprints', () => {
  it('reports the real size and a changing mtime on every write', async () => {
    const runtime = new MemoryRuntime();
    await runtime.fs.writeFile('/t/a', 'abc');
    const first = await runtime.fs.stat('/t/a');
    expect(first.size).toBe(3);

    await runtime.fs.writeFile('/t/a', 'abcdef');
    const second = await runtime.fs.stat('/t/a');
    expect(second.size).toBe(6);
    // A fingerprint that never changes would make the lease's re-read check a
    // no-op, which is the exact bug the design exists to prevent.
    expect(second.mtimeMs).toBeGreaterThan(first.mtimeMs);
  });

  it('rejects stat for a missing path so callers can treat ENOENT as empty', async () => {
    const runtime = new MemoryRuntime();
    await expect(runtime.fs.stat('/t/none')).rejects.toThrow(/ENOENT/);
  });
});

describe('FakeClock.monotonicNow', () => {
  it('advances with the wall clock', () => {
    const runtime = new MemoryRuntime();
    const before = runtime.clock.monotonicNow?.() ?? 0;
    runtime.clock.advance(1_000);
    expect((runtime.clock.monotonicNow?.() ?? 0) - before).toBe(1_000);
  });

  it('does not follow a backwards wall-clock step', () => {
    const runtime = new MemoryRuntime();
    runtime.clock.advance(5_000);
    const before = runtime.clock.monotonicNow?.() ?? 0;
    // Model an NTP correction: the wall clock jumps back a minute.
    runtime.clock.advance(-60_000);
    expect(runtime.clock.monotonicNow?.() ?? 0).toBeGreaterThanOrEqual(before);
  });
});
