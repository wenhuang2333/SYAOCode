/**
 * 凭据条目命名的一致性（`27` §10.7.4）。
 *
 * 主进程（渲染层写）与 Host（执行 git 前读）**各自**计算钥匙串条目名。
 * 两边算出不同的名字，就意味着"用户填了令牌，Host 找不到"——
 * 这种故障在界面上表现为"明明配置了却提示未配置"，极难定位。
 *
 * 所以这里直接断言两个实现逐字相等。
 */

import { describe, expect, it } from 'vitest';
import { keychainEntryFor } from '@syaocode/host';
import { credentialEntry, remoteHost } from '../src/main/credential-entries.ts';

describe('凭据条目命名', () => {
  it('主进程与 Host 的条目名逐字一致', () => {
    const cases: readonly [string, string][] = [
      ['github.com', 'token'],
      ['github.com', 'oauth'],
      ['gitlab.example.com', 'ssh-key'],
      ['example-host', 'ssh-agent'],
      ['unknown', 'token'],
    ];
    for (const [host, method] of cases) {
      expect(credentialEntry(host, method as 'token')).toBe(keychainEntryFor(host, method));
    }
  });

  it('主机名推导覆盖常见远端形态', () => {
    expect(remoteHost('https://github.com/o/r.git')).toBe('github.com');
    expect(remoteHost('https://user:token@github.com/o/r.git')).toBe('github.com');
    expect(remoteHost('git@github.com:o/r.git')).toBe('github.com');
    expect(remoteHost('ssh://git@gitlab.example.com/o/r.git')).toBe('gitlab.example.com');
    expect(remoteHost('')).toBe('');
  });

  it('条目名不含路径分隔符与冒号（钥匙串键的安全要求）', () => {
    const entry = credentialEntry('git@host:2222', 'token');
    expect(entry).not.toContain('/');
    expect(entry).not.toContain(':');
    expect(entry.startsWith('syaocode.git.')).toBe(true);
  });
});
