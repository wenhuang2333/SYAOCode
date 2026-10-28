import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { commandDocs, helpText, isAvailableDoc, parseSlash } from '../src/slash';
import { setLanguage } from '../src/i18n/index';
import { getPeer, listPeers, removePeer, savePeer } from '../src/peers';

const V03 = ['/rpc', '/peer', '/call', '/serve', '/approve', '/mcp'];

beforeEach(() => {
  setLanguage('en');
});
afterEach(() => {
  setLanguage('en');
});

describe('parseSlash — governance commands (v0.3)', () => {
  it('parses /rpc with and without a sub-view', () => {
    expect(parseSlash('/rpc')).toEqual({ name: '/rpc', args: [], raw: '/rpc' });
    expect(parseSlash('/rpc tasks')).toEqual({ name: '/rpc', args: ['tasks'], raw: '/rpc tasks' });
    expect(parseSlash('/rpc task task_1')).toEqual({ name: '/rpc', args: ['task', 'task_1'], raw: '/rpc task task_1' });
    expect(parseSlash('/rpc policy mcp://x/tool/y')).toEqual({
      name: '/rpc',
      args: ['policy', 'mcp://x/tool/y'],
      raw: '/rpc policy mcp://x/tool/y',
    });
    expect(parseSlash('/rpc approve apr_1 session')).toEqual({
      name: '/rpc',
      args: ['approve', 'apr_1', 'session'],
      raw: '/rpc approve apr_1 session',
    });
    expect(parseSlash('/rpc deny apr_1')).toEqual({ name: '/rpc', args: ['deny', 'apr_1'], raw: '/rpc deny apr_1' });
    expect(parseSlash('/rpc budget')).toEqual({ name: '/rpc', args: ['budget'], raw: '/rpc budget' });
    expect(parseSlash('/rpc audit')).toEqual({ name: '/rpc', args: ['audit'], raw: '/rpc audit' });
    expect(parseSlash('/rpc status')).toEqual({ name: '/rpc', args: ['status'], raw: '/rpc status' });
    expect(parseSlash('/rpc approvals')).toEqual({ name: '/rpc', args: ['approvals'], raw: '/rpc approvals' });
  });

  it('parses /approve, /peer, /call and /serve', () => {
    expect(parseSlash('/approve apr_1')).toEqual({ name: '/approve', args: ['apr_1'], raw: '/approve apr_1' });
    expect(parseSlash('/approve apr_1 always')).toEqual({ name: '/approve', args: ['apr_1', 'always'], raw: '/approve apr_1 always' });
    expect(parseSlash('/peer add gh npx -y github-mcp')).toEqual({
      name: '/peer',
      args: ['add', 'gh', 'npx', '-y', 'github-mcp'],
      raw: '/peer add gh npx -y github-mcp',
    });
    expect(parseSlash('/peer ping gh')).toEqual({ name: '/peer', args: ['ping', 'gh'], raw: '/peer ping gh' });
    expect(parseSlash('/call mcp://x/tool/y {"a":1}')).toEqual({
      name: '/call',
      args: ['mcp://x/tool/y', '{"a":1}'],
      raw: '/call mcp://x/tool/y {"a":1}',
    });
    expect(parseSlash('/serve acp --stdio')).toEqual({ name: '/serve', args: ['acp', '--stdio'], raw: '/serve acp --stdio' });
  });

  it('keeps /mcp working as a name (now an alias of /peer)', () => {
    expect(parseSlash('/mcp list')).toEqual({ name: '/mcp', args: ['list'], raw: '/mcp list' });
    expect(parseSlash('/mcp')).toEqual({ name: '/mcp', args: [], raw: '/mcp' });
  });
});

describe('commandDocs — the new commands are advertised', () => {
  it('includes every v0.3 command in the available group', () => {
    const docs = commandDocs();
    for (const name of V03) {
      const doc = docs.find((d) => d.name === name);
      expect(doc, `${name} missing from commandDocs()`).toBeDefined();
      expect(doc!.since).toBe('v0.3');
      expect(doc!.usage.startsWith(name)).toBe(true);
      expect(doc!.summary.length).toBeGreaterThan(10);
      expect(isAvailableDoc(doc!)).toBe(true);
    }
  });

  it('marks /mcp as an alias of /peer', () => {
    const mcp = commandDocs().find((d) => d.name === '/mcp');
    expect(mcp?.aliasOf).toBe('/peer');
  });

  it('lists the new commands under "available" in /help, not under "planned"', () => {
    const text = helpText();
    const availableBlock = text.split('planned')[0] ?? text;
    for (const name of V03) expect(availableBlock).toContain(name);
    expect(availableBlock).toContain('/rpc [tasks|task <id>');
    expect(text).toContain('alias of /peer');
    // The planned group keeps the genuinely unbuilt commands.
    expect(text).toContain('/agents');
    expect(text).toContain('M3+');
  });

  it('describes one governance command on demand', () => {
    const detail = helpText('rpc');
    expect(detail).toContain('/rpc');
    expect(detail).toContain('v0.3');
    expect(helpText('/peer')).toContain('/peer');
  });

  it('translates the new help entries', () => {
    setLanguage('zh');
    const text = helpText();
    expect(text).toContain('/rpc');
    expect(text).toContain('治理控制台');
    expect(text).toContain('协议边');
  });
});

describe('peer registry (the store behind /peer and /mcp)', () => {
  let home: string;
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'syao-peers-'));
  });
  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('adds, lists and removes an edge', () => {
    expect(listPeers(home)).toEqual({});
    expect(savePeer('gh', { protocol: 'mcp', target: 'npx -y github-mcp', addedAt: 1 }, home)).toBe(true);
    expect(savePeer('agent', { protocol: 'a2a', target: 'https://agent.example/card', addedAt: 2 }, home)).toBe(true);
    expect(Object.keys(listPeers(home))).toEqual(['agent', 'gh']);
    expect(getPeer('gh', home)?.target).toBe('npx -y github-mcp');
    expect(getPeer('agent', home)?.protocol).toBe('a2a');

    expect(removePeer('gh', home)).toBe(true);
    expect(removePeer('gh', home)).toBe(false);
    expect(Object.keys(listPeers(home))).toEqual(['agent']);
  });

  it('refuses an unusable id and never stores a secret value', () => {
    expect(savePeer('bad id', { protocol: 'mcp', target: 'x', addedAt: 1 }, home)).toBe(false);
    savePeer('gh', { protocol: 'mcp', target: 'npx -y github-mcp', tokenEnv: 'GH_TOKEN', addedAt: 1 }, home);
    const raw = fs.readFileSync(path.join(home, '.syaocode', 'config.json'), 'utf8');
    expect(raw).toContain('GH_TOKEN');
    expect(raw).not.toContain('ghp_');
  });
});
