/**
 * Real interop probe: the OFFICIAL @a2a-js/sdk client against SYAOCode's A2A
 * edge.
 *
 * Like the MCP probe, this is not a unit test — it needs the official SDK and
 * a listening server — so it runs on demand or in a CI job with network access.
 * It found two defects that no self-referential test could see:
 *
 *   1. the edge served NO AgentCard at `/.well-known/agent-card.json`, so a
 *      compliant client could not discover it at all;
 *   2. A2A 1.0 carries the protocol version in the HTTP `A2A-Version` HEADER,
 *      but the edge read it from the request body's `metadata`, so it fell back
 *      to 0.3 and rejected EVERY request from a real SDK client as an
 *      unsupported version.
 *
 * USAGE
 *   # 1. install the official SDK somewhere
 *   mkdir -p /tmp/a2a-interop && cd /tmp/a2a-interop
 *   npm init -y >/dev/null && npm i --no-audit --no-fund @a2a-js/sdk@1.3.0
 *
 *   # 2. start our edge
 *   cd <repo>/code && ./node_modules/.bin/tsx packages/cli/src/main.ts serve --a2a --http --port 8995
 *
 *   # 3. run the probe
 *   node scripts/interop-a2a-official.mjs http://127.0.0.1:8995 /tmp/a2a-interop
 *
 * Exit code 0 = interoperable, 1 = not.
 *
 * NOTE: the edge deliberately does not execute agent turns (audit C-2), so a
 * `SendMessage` MUST be refused with UnsupportedOperation rather than answered
 * as completed. That refusal is asserted here — a fabricated completion would
 * fail this probe.
 */

const base = process.argv[2] ?? 'http://127.0.0.1:8995';
const moduleBase = process.argv[3] ?? '/tmp/a2a-interop';

let ClientFactory;
let DefaultAgentCardResolver;
let JsonRpcTransportFactory;
let ServiceParameters;
let withA2AVersion;
try {
  const sdk = await import(`${moduleBase}/node_modules/@a2a-js/sdk/dist/client/index.js`);
  ({ ClientFactory, DefaultAgentCardResolver, JsonRpcTransportFactory, ServiceParameters, withA2AVersion } = sdk);
} catch (e) {
  console.error(`cannot load @a2a-js/sdk from ${moduleBase}/node_modules: ${e?.message}`);
  console.error('see the usage comment at the top of this file');
  process.exit(1);
}

const checks = [];
function check(name, ok, detail) {
  checks.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? `  ${detail}` : ''}`);
}

/** The SDK defaults A2A-Version to 0.3; our edge speaks 1.0. */
function versionedParameters() {
  const params = ServiceParameters.create();
  withA2AVersion('1.0')(params);
  return params;
}

try {
  const factory = new ClientFactory({
    transports: [new JsonRpcTransportFactory()],
    cardResolver: new DefaultAgentCardResolver(),
  });
  const client = await factory.createFromUrl(`${base}/a2a`);

  const card = await client.getAgentCard();
  check('resolves the AgentCard from /.well-known/agent-card.json', card?.name === 'syaocode', `name=${card?.name}`);
  check('the card advertises protocolVersion 1.0', card?.supportedInterfaces?.[0]?.protocolVersion === '1.0');
  check('the card points at the JSONRPC edge path', String(card?.supportedInterfaces?.[0]?.url ?? '').endsWith('/a2a'));
  check('the client negotiates 1.0', client.protocolVersion === '1.0', `negotiated=${client.protocolVersion}`);

  // The edge does not execute turns: it must refuse, never fake completion.
  let refusal;
  try {
    await client.sendMessage(
      {
        message: { messageId: 'm1', role: 'ROLE_USER', parts: [{ text: 'hello' }], kind: 'message' },
        metadata: { tenantId: 'syaocode-local' },
      },
      { serviceParameters: versionedParameters() },
    );
    refusal = undefined;
  } catch (e) {
    refusal = { name: e?.constructor?.name, message: String(e?.message).slice(0, 140) };
  }
  check(
    'SendMessage is refused (UnsupportedOperation), not faked as completed',
    refusal !== undefined && /UnsupportedOperation/.test(refusal.name ?? ''),
    JSON.stringify(refusal),
  );

  await client.close?.();
} catch (e) {
  check('the official SDK client can talk to the edge', false, `${e?.constructor?.name}: ${e?.message}`);
}

const failed = checks.filter((c) => !c.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} interop checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
