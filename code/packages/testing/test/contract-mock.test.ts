import { describe, expect, it } from 'vitest';
import type { Message, Provider } from '@syaocode/core';
import { MemoryRuntime, MockProvider, mockText, mockToolUse } from '../src';
import { defineProviderContract } from '../src/contract';

let currentScript: Message[] = [];

defineProviderContract('MockProvider', {
  createProvider: () => new MockProvider({ script: currentScript }),
  playScript: async (turns: Message[]) => {
    currentScript = turns;
  },
});

describe('MockProvider specifics', () => {
  it('records requests for assertions', async () => {
    const p = new MockProvider({ script: [mockText('m', 'ok')] });
    for await (const _ev of p.stream({ model: 'm', messages: [] }, { signal: new AbortController().signal })) {
      void _ev;
    }
    expect(p.requests).toHaveLength(1);
    expect(p.id).toBe('mock');
  });

  it('exhausted script surfaces as SY-PRV-007 (stream interrupted)', async () => {
    const p = new MockProvider({ script: [] });
    await expect(async () => {
      for await (const _ev of p.stream({ model: 'm', messages: [] }, { signal: new AbortController().signal })) {
        void _ev;
      }
    }).rejects.toSatisfy((e) => {
      const json = JSON.stringify(e ?? {});
      return json.includes('SY-PRV-007') && json.includes('script exhausted');
    });
  });
});

describe('MemoryRuntime', () => {
  it('seeds, reads, writes, and pokes externally', async () => {
    const rt = new MemoryRuntime({ seed: { '/a.txt': 'one' } });
    expect(await rt.fs.readFile('/a.txt')).toBe('one');
    await rt.fs.writeFile('/b/c.txt', 'two');
    expect(await rt.fs.readFile('/b/c.txt')).toBe('two');
    rt.fs.pokeExternally('/a.txt', 'changed');
    expect(await rt.fs.readFile('/a.txt')).toBe('changed');
    const entries = await rt.fs.readdir('/b');
    expect(entries.map((e) => e.name)).toEqual(['c.txt']);
  });

  it('deterministic ids and clock', async () => {
    const rt = new MemoryRuntime({});
    const a = rt.ids.next('msg');
    const b = rt.ids.next('msg');
    expect(a).not.toBe(b);
    const before = rt.clock.now();
    await rt.clock.sleep(50);
    expect(rt.clock.now() - before).toBe(50);
  });
});

export type { Provider };
