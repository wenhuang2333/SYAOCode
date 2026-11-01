/**
 * DHP 版本与握手（`06` §4）
 *
 * 版本策略：**主版本不同即拒绝**（fail-closed）。次版本通过能力交集降级。
 * 这条规则让"旧渲染层 + 新 Host"成为一个**不可表示**的状态——四者同属一次发布。
 */

/** 协议主/次版本。 */
export const DHP_VERSION = { major: 1, minor: 0 } as const;

export type DhpVersion = { readonly major: number; readonly minor: number };

/**
 * 能力位：Host 在 `hello-ack` 中声明自己支持哪些可选能力。
 * 客户端**必须**以 `capabilities` 为准，不得假设某项能力存在。
 */
export type DhpCapability =
  | 'session'
  | 'turn'
  | 'interaction'
  | 'config'
  | 'model'
  | 'workspace'
  | 'workspace.watch'
  | 'workspace.diff'
  | 'terminal'
  | 'governance'
  | 'edge'
  | 'cost'
  | 'diagnostics';

export const DHP_CAPABILITIES: readonly DhpCapability[] = [
  'session',
  'turn',
  'interaction',
  'config',
  'model',
  'workspace',
  'workspace.watch',
  'workspace.diff',
  'terminal',
  'governance',
  'edge',
  'cost',
  'diagnostics',
] as const;

export interface HelloParams {
  readonly clientName: string;
  readonly clientVersion: string;
  readonly dhpVersion: DhpVersion;
  /** 客户端支持的能力位；Host 返回交集。 */
  readonly capabilities?: readonly DhpCapability[];
}

export interface HelloAckResult {
  readonly hostName: string;
  readonly hostVersion: string;
  readonly dhpVersion: DhpVersion;
  /** 双方能力的交集 —— 客户端只能用这里声明的能力。 */
  readonly capabilities: readonly DhpCapability[];
  /** schema 摘要，用于发现"文档与实现漂移"。 */
  readonly schemaHash: string;
  /** Host 当前的工作区根（绝对路径）。 */
  readonly workspaceRoot: string;
}

export type CompatVerdict =
  | { readonly ok: true; readonly negotiated: DhpVersion; readonly capabilities: readonly DhpCapability[] }
  | { readonly ok: false; readonly reason: string };

/**
 * 协商：主版本必须相同；次版本取较小值；能力取交集。
 *
 * 注意 `capabilities` 缺省时**不**等于"全部支持"——按空集处理并告警，
 * 否则新客户端会静默依赖一个旧 Host 并不具备的能力。
 */
export function negotiate(
  client: DhpVersion,
  host: DhpVersion,
  clientCaps: readonly DhpCapability[] | undefined,
  hostCaps: readonly DhpCapability[],
): CompatVerdict {
  if (client.major !== host.major) {
    return {
      ok: false,
      reason: `DHP major version mismatch: client ${client.major}.${client.minor} vs host ${host.major}.${host.minor}`,
    };
  }
  const caps = clientCaps === undefined ? [] : clientCaps.filter((c) => hostCaps.includes(c));
  return {
    ok: true,
    negotiated: { major: host.major, minor: Math.min(client.minor, host.minor) },
    capabilities: caps,
  };
}

export function formatVersion(v: DhpVersion): string {
  return `${v.major}.${v.minor}`;
}
