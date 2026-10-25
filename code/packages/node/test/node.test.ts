import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { contentHash, FileSessionStore } from '@syaocode/core';
import { nodeRuntime, sha256Hex } from '../src/index';

describe('@syaocode/node host runtime', () => {
  it('provides a Node runtime with injected logger', async () => {
    const runtime = nodeRuntime();
    expect(typeof runtime.fs.readFile).toBe('function');
    expect(typeof runtime.shell.spawn).toBe('function');
    const id = runtime.ids.next('x');
    expect(id.startsWith('x_')).toBe(true);
    expect(await runtime.fs.exists('/definitely/not/here')).toBe(false);
  });

  it('sha256Hex is stable and differs from the kernel content hash', () => {
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(contentHash('abc')).toBe(contentHash('abc'));
    expect(contentHash('abc')).not.toBe(contentHash('abd'));
  });

  it('FileSessionStore appends without interleaving under concurrency', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'syao-session-'));
    const runtime = nodeRuntime();
    try {
      const a = new FileSessionStore(runtime, dir, 'p');
      const b = new FileSessionStore(runtime, dir, 'p');
      await Promise.all(
        Array.from({ length: 20 }, (_, i) =>
          (i % 2 === 0 ? a : b).append('s1', [
            { v: 1, id: `e${i}`, ts: i, sessionId: 's1', type: 'message', data: i },
          ]),
        ),
      );
      const entries = await a.load('s1');
      expect(entries).toHaveLength(20);
      expect(new Set(entries.map((e) => e.id)).size).toBe(20);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
