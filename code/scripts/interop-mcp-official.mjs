/**
 * Real interop probe: the OFFICIAL @modelcontextprotocol/client@2.4.0 against
 * SYAOCode's MCP server.
 *
 * This is NOT a unit test — it needs the official SDK installed and a server
 * listening — so it lives as a script and is run manually or in a CI job with
 * network access. Its purpose is the one a self-referential test cannot do:
 * prove that an independent implementation of the protocol can talk to ours.
 *
 * The three defects it found (and which are now regression-tested in
 * packages/protocols/test/mcp-server.wire.test.ts):
 *   1. the HTTP body carried stdio `Content-Length` framing;
 *   2. list results lacked the `resultType` discriminator;
 *   3. list results lacked the `ttlMs`/`cacheScope` cache hints and the
 *      per-tool `inputSchema`.
 *
 * USAGE
 *   # 1. install the official SDK somewhere
 *   mkdir -p /tmp/interop && cd /tmp/interop
 *   npm init -y >/dev/null && npm i --no-audit --no-fund @modelcontextprotocol/client@2.4.0
 *
 *   # 2. start our server
 *   cd <repo>/code && pnpm exec tsx packages/cli/src/main.ts serve --mcp --http --port 8975
 *
 *   # 3. run the probe
 *   node scripts/interop-mcp-official.mjs http://127.0.0.1:8975/mcp
 *
 * Exit code 0 = interoperable, 1 = not.
 */

const target = process.argv[2] ?? 'http://127.0.0.1:8975/mcp';
const moduleBase = process.argv[3] ?? '/tmp/interop';

let Client;
let StreamableHTTPClientTransport;
try {
  const entry = `${moduleBase}/node_modules/@modelcontextprotocol/client/dist/index.mjs`;
  ({ Client, StreamableHTTPClientTransport } = await import(entry));
} catch (e) {
  console.error(`cannot load @modelcontextprotocol/client from ${moduleBase}/node_modules: ${e?.message}`);
  console.error('see the usage comment at the top of this file');
  process.exit(1);
}

const transport = new StreamableHTTPClientTransport(new URL(target));
const client = new Client(
  { name: 'syaocode-interop-probe', version: '1.0.0' },
  // The modern era has no `initialize` handshake: the client probes with
  // `server/discover` and pins the revision.
  { versionNegotiation: { mode: { pin: '2026-07-28' } } },
);

const checks = [];
function check(name, ok, detail) {
  checks.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? `  ${detail}` : ''}`);
}

try {
  await client.connect(transport);
  check('connects and negotiates the modern era', client.getProtocolEra?.() === 'modern', `era=${client.getProtocolEra?.()}`);
  check('negotiates protocol version 2026-07-28', client.getNegotiatedProtocolVersion?.() === '2026-07-28');

  const discover = client.getDiscoverResult?.();
  check('server/discover offers 2026-07-28', (discover?.supportedVersions ?? []).includes('2026-07-28'));
  check('server/discover carries cache hints', typeof discover?.ttlMs === 'number' && typeof discover?.cacheScope === 'string');

  const tools = await client.listTools();
  check('tools/list returns tools', (tools.tools?.length ?? 0) > 0, `tools=${tools.tools?.map((t) => t.name).join(',')}`);
  check('every tool carries an inputSchema', tools.tools.every((t) => typeof t.inputSchema === 'object'));

  // Call a READ-ONLY tool: an execute-risk tool legitimately asks for approval,
  // and a non-interactive server fails that closed (exit 3 semantics) — that is
  // governance working, not an interop failure.
  const readTool = tools.tools.find((t) => t.name === 'read') ?? tools.tools[0];
  const call = await client.callTool({ name: readTool.name, arguments: { path: 'package.json' } });
  check('tools/call returns content', Array.isArray(call.content) && call.content.length > 0, `tool=${readTool.name}`);
  // NOTE: the SDK client CONSUMES the `resultType` discriminator and strips it
  // from the object it returns (see `delete stripped["resultType"]` in its
  // source), so `call.resultType` being undefined here is correct client
  // behaviour. The discriminator on the wire is asserted in
  // packages/protocols/test/mcp-server.wire.test.ts instead.
  check('tools/call is not flagged as an input-required round trip', call.isError !== true, `isError=${call.isError}`);

  await client.close();
} catch (e) {
  check('connects and negotiates the modern era', false, `${e?.constructor?.name}: ${e?.message}`);
  try { await client.close(); } catch { /* ignore */ }
}

const failed = checks.filter((c) => !c.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} interop checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
