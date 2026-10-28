import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createCliFabric, disposeCliFabric, hasCliFabric, type CliFabric } from '../src/arf';
import { splitCommand, protocolsAvailable } from '../src/edges';
import { decodeFramesForTest, messageIds } from '../src/serve';
import { listPeers, savePeer } from '../src/peers';
import { setLanguage } from '../src/i18n/index';

let tmp: string;
let home: string;
const made: CliFabric[] = [];

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'syao-edges-'));
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'syao-home-'));
  setLanguage('en');
});

afterEach(async () => {
  for (const cli of made.splice(0)) await cli.dispose();
  if (hasCliFabric()) await disposeCliFabric();
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.rmSync(home, { recursive: true, force: true });
});

function cli(opts: Parameters<typeof createCliFabric>[0] = {}): CliFabric {
  const created = createCliFabric({ cwd: tmp, home, permissionMode: 'default', ...opts });
  made.push(created);
  return created;
}

// ── command lines ─────────────────────────────────────────────────────────

describe('splitCommand', () => {
  it('splits a plain command line', () => {
    expect(splitCommand('npx -y @modelcontextprotocol/server-github')).toEqual([
      'npx',
      '-y',
      '@modelcontextprotocol/server-github',
    ]);
  });

  it('honours single and double quotes', () => {
    expect(splitCommand(`node "/tmp/a b/server.mjs" --flag`)).toEqual(['node', '/tmp/a b/server.mjs', '--flag']);
    expect(splitCommand(`sh -c 'echo "hi there"'`)).toEqual(['sh', '-c', 'echo "hi there"']);
  });

  it('collapses repeated whitespace and tolerates a trailing space', () => {
    expect(splitCommand('  node   server.mjs  ')).toEqual(['node', 'server.mjs']);
    expect(splitCommand('')).toEqual([]);
  });
});

// ── wire framing (the reply-correlation helper) ────────────────────────────

describe('messageIds / decodeFrames', () => {
  it('reads ids out of Content-Length framed messages', () => {
    const body = '{"jsonrpc":"2.0","id":7,"method":"tools/list"}';
    const framed = `Content-Length: ${body.length}\r\n\r\n${body}`;
    expect(messageIds(framed)).toEqual(['7']);
  });

  it('reads ids out of newline-delimited messages, including batches', () => {
    const a = '{"jsonrpc":"2.0","id":1,"method":"a"}';
    const b = '{"jsonrpc":"2.0","id":"two","method":"b"}';
    expect(messageIds(`${a}\n${b}\n`)).toEqual(['1', 'two']);
  });

  it('ignores notifications (no id) and a partial frame', () => {
    expect(messageIds('{"jsonrpc":"2.0","method":"notifications/progress"}')).toEqual([]);
    expect(messageIds('Content-Length: 500\r\n\r\n{"jsonrpc":"2.0","id":1')).toEqual([]);
  });

  it('decodes several frames out of one chunk', () => {
    const one = '{"jsonrpc":"2.0","id":1,"method":"a"}';
    const two = '{"jsonrpc":"2.0","id":2,"method":"b"}';
    const framed = `Content-Length: ${one.length}\r\n\r\n${one}Content-Length: ${two.length}\r\n\r\n${two}`;
    expect(decodeFramesForTest(framed)).toEqual([one, two]);
  });
});

// ── the protocol package is a real dependency now ─────────────────────────

describe('protocol edges', () => {
  it('loads @syaocode/protocols in this build', async () => {
    expect(await protocolsAvailable()).toBe(true);
  });

  it('reports a registered-but-unmountable peer without throwing', async () => {
    const c = cli({ tools: false });
    // A command that cannot start: the mount fails closed, the registry keeps
    // the entry so the user can see and fix it.
    savePeer('broken', { protocol: 'mcp', target: 'definitely-not-a-real-binary-xyz', addedAt: Date.now() }, home);
    const reports = await c.mountRegisteredPeers();
    expect(reports).toHaveLength(1);
    expect(reports[0]!.id).toBe('broken');
    expect(reports[0]!.ok).toBe(false);
    expect(c.failedPeers.get('broken')).toBeTruthy();
    // The failure never leaks into the rest of the fabric.
    const status = await c.fabric.status();
    expect(status.capabilityCount).toBe(0);
  });

  it('mounts nothing when the registry is empty', async () => {
    const c = cli({ tools: false });
    expect(listPeers(home)).toEqual({});
    expect(await c.mountRegisteredPeers()).toEqual([]);
  });

  it('mounts a registered peer only once per process', async () => {
    const c = cli({ tools: false });
    savePeer('ghost', { protocol: 'mcp', target: 'definitely-not-a-real-binary-xyz', addedAt: Date.now() }, home);
    const first = await c.mountRegisteredPeers();
    const second = await c.mountRegisteredPeers();
    expect(second).toBe(first); // memoized promise
  });
});

// ── built-in tools ────────────────────────────────────────────────────────

describe('built-in tools as governed capabilities', () => {
  it('registers local://tools/<name> and shares one FileStateTracker', async () => {
    const c = cli({ permissionMode: 'bypass' });
    expect(c.tools).toBeDefined();
    const caps = await c.fabric.discover();
    const ids = caps.map((cap) => cap.id).sort();
    expect(ids).toContain('local://tools/read');
    expect(ids).toContain('local://tools/write');
    expect(ids).toContain('local://tools/bash');
    expect(ids).toHaveLength(6);
    // Every built-in tool shares the tracker: read-before-write fencing needs it.
    expect(c.fileState).toBeDefined();
  });

  it('runs a governed local read and issues exactly one receipt', async () => {
    fs.writeFileSync(path.join(tmp, 'note.txt'), 'hello governance\n');
    const c = cli({ permissionMode: 'bypass' });
    const result = await c.call({ capabilityId: 'local://tools/read', input: { path: 'note.txt' } });
    expect(result.outcome).toBe('succeeded');
    expect(result.receiptId).toBeTruthy();
    const receipts = await c.fabric.stores.receipts.listByTask(result.taskId);
    expect(receipts).toHaveLength(1);
    expect(receipts[0]!.capabilityId).toBe('local://tools/read');
  });

  it('can opt out with tools: false (bare fabric for embedding/tests)', async () => {
    const c = cli({ tools: false });
    expect(c.tools).toBeUndefined();
    expect(await c.fabric.discover()).toEqual([]);
  });
});
