import { SyaoError, type Env, type Runtime } from '@syaocode/core';

/**
 * SecretRef resolution (03 §3.5, BR-023, report C9).
 *
 * `server.token` and MCP credentials are stored as *references*, never as
 * literals:
 *
 *   env:SYAO_SERVER_TOKEN     environment variable
 *   ${SYAO_SERVER_TOKEN}      shell-style reference
 *   file:~/.syaocode/token    file whose first line is the secret
 *
 * Resolution is keychain-free on purpose: a headless CI host has no keychain,
 * and a missing secret must fail with SY-CFG-002 rather than silently running
 * unauthenticated.
 */

export type SecretRef =
  | { kind: 'env'; name: string }
  | { kind: 'file'; path: string };

const ENV_PATTERNS: RegExp[] = [
  /^env:([A-Za-z_][A-Za-z0-9_]*)$/,
  /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/,
  /^\$([A-Za-z_][A-Za-z0-9_]*)$/,
];

/** Parse a reference string; returns undefined for a literal secret. */
export function parseSecretRef(raw: string): SecretRef | undefined {
  const text = raw.trim();
  for (const re of ENV_PATTERNS) {
    const m = re.exec(text);
    const name = m?.[1];
    if (name !== undefined) return { kind: 'env', name };
  }
  if (text.startsWith('file:')) {
    const path = text.slice('file:'.length);
    return path === '' ? undefined : { kind: 'file', path };
  }
  return undefined;
}

export interface SecretResolverOptions {
  runtime: Runtime;
  env?: Env;
  /** Resolve `~/` against this HOME instead of the runtime env. */
  home?: string;
}

export interface SecretResolver {
  /** Resolve a reference string to its secret value. */
  resolve(ref: string): Promise<string>;
  /** True when the reference can be parsed (no lookup performed). */
  canResolve(ref: string): boolean;
}

export function createSecretResolver(opts: SecretResolverOptions): SecretResolver {
  const env = opts.env ?? opts.runtime.env;
  const homeOf = (): string => opts.home ?? env.get('HOME') ?? '';

  const expand = (path: string): string =>
    path === '~' || path.startsWith('~/') ? `${homeOf()}${path.slice(1)}` : path;

  return {
    canResolve(ref: string): boolean {
      return parseSecretRef(ref) !== undefined;
    },
    async resolve(ref: string): Promise<string> {
      const parsed = parseSecretRef(ref);
      if (parsed === undefined) {
        // A literal is refused: the config file must never hold a plaintext
        // token, and guessing would silently ship one to a log (BR-023).
        throw new SyaoError({
          code: 'SY-CFG-002',
          message: `Secret reference '${redactRef(ref)}' is not a valid reference (use env:NAME or file:PATH).`,
          details: { ref: redactRef(ref) },
        });
      }
      if (parsed.kind === 'env') {
        const value = env.get(parsed.name);
        if (value === undefined || value === '') {
          throw new SyaoError({
            code: 'SY-CFG-002',
            message: `Environment variable '${parsed.name}' referenced by a secret is not set.`,
            details: { ref: `env:${parsed.name}` },
          });
        }
        return value;
      }
      const path = expand(parsed.path);
      let raw: string;
      try {
        raw = await opts.runtime.fs.readFile(path);
      } catch (e) {
        throw new SyaoError({
          code: 'SY-CFG-002',
          message: `Secret file '${path}' could not be read.`,
          details: { ref: `file:${parsed.path}` },
          cause: e,
        });
      }
      const value = raw.split('\n')[0]?.trim() ?? '';
      if (value === '') {
        throw new SyaoError({
          code: 'SY-CFG-002',
          message: `Secret file '${path}' is empty.`,
          details: { ref: `file:${parsed.path}` },
        });
      }
      return value;
    },
  };
}

/** Show only the reference kind + name, never a literal value (BR-023). */
function redactRef(ref: string): string {
  const parsed = parseSecretRef(ref);
  if (parsed === undefined) return '[REDACTED:literal]';
  return parsed.kind === 'env' ? `env:${parsed.name}` : `file:${parsed.path}`;
}

/**
 * PermissionRuleStore backed by a JSON file (report C5).
 *
 * `remember:'project'` approvals must survive the process, and they belong to
 * the repository: `.syaocode/permissions.json` next to the project config.
 * A malformed file degrades to "no remembered rules" rather than bricking the
 * permission engine.
 */
export function createFilePermissionStore(
  runtime: Runtime,
  path: string,
): { load(): Promise<import('@syaocode/core').PermissionRule[]>; save(rules: import('@syaocode/core').PermissionRule[]): Promise<void> } {
  return {
    async load() {
      if (!(await runtime.fs.exists(path))) return [];
      try {
        const parsed = JSON.parse(await runtime.fs.readFile(path)) as unknown;
        const rules = Array.isArray(parsed)
          ? parsed
          : parsed !== null && typeof parsed === 'object' && Array.isArray((parsed as { rules?: unknown }).rules)
            ? ((parsed as { rules: unknown[] }).rules)
            : [];
        return rules.filter(isRule);
      } catch {
        runtime.logger.log('warn', 'permission store: unreadable rule file, ignoring remembered rules', { path });
        return [];
      }
    },
    async save(rules) {
      const dir = path.slice(0, path.lastIndexOf('/'));
      if (dir !== '' && dir !== path) await runtime.fs.mkdir(dir, { recursive: true });
      await runtime.fs.writeFile(path, `${JSON.stringify({ v: 1, rules }, null, 2)}\n`);
    },
  };
}

function isRule(value: unknown): value is import('@syaocode/core').PermissionRule {
  if (value === null || typeof value !== 'object') return false;
  const rule = value as Record<string, unknown>;
  return (
    (rule.effect === 'allow' || rule.effect === 'ask' || rule.effect === 'deny') &&
    typeof rule.tool === 'string' &&
    rule.tool.length > 0 &&
    (rule.source === 'user' || rule.source === 'project' || rule.source === 'plugin' || rule.source === 'code')
  );
}
