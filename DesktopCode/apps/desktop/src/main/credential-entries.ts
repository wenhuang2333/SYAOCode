/**
 * 凭据条目的命名规则（**纯函数**，主进程与渲染层共用）。
 *
 * 与 Host 侧 `packages/host/src/credentials.ts` 的 `keychainEntryFor` 必须**逐字一致**——
 * 两边算出的条目名不同，就意味着"渲染层写进去的令牌，Host 找不到"。
 * `apps/desktop/test/credential-entries.test.ts` 会断言两者相等。
 *
 * 规则：`syaocode.git.<host>.<method>`
 *  - `host`：远端主机名（`https://github.com/x` → `github.com`；`git@host:path` → `host`）；
 *    没有主机名的本地路径远端由调用方传入工作区名。
 *  - `method`：`oauth` / `ssh-agent` / `ssh-key` / `token`。
 */

export const CREDENTIAL_METHODS = ['oauth', 'ssh-agent', 'ssh-key', 'token'] as const;
export type CredentialMethod = (typeof CREDENTIAL_METHODS)[number];

/** 从远端 URL 推导主机名；无法推导时返回空串。 */
export function remoteHost(remoteUrl: string): string {
  const value = remoteUrl.trim();
  if (value === '') return '';
  const scp = /^([A-Za-z0-9._-]+)@([A-Za-z0-9._-]+):/.exec(value);
  if (scp !== null) return scp[2] ?? '';
  try {
    const parsed = new URL(value);
    return parsed.hostname;
  } catch {
    return '';
  }
}

/** 条目名：`syaocode.git.<host>.<method>`。 */
export function credentialEntry(host: string, method: CredentialMethod): string {
  const safeHost = host.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120) || 'unknown';
  return `syaocode.git.${safeHost}.${method}`;
}
