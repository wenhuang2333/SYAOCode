/**
 * JSON-RPC codec / framing / correlation unit tests.
 *
 * These cover the wire primitives the three edges share: both framings,
 * incremental delivery, pending-request correlation, notification dispatch,
 * inbound (reverse) requests, timeouts and the absence of automatic retries.
 */

import { describe, expect, it } from 'vitest';
import {
  JsonRpcConnection,
  JsonRpcRemoteError,
  JsonRpcTimeoutError,
  MessageFramer,
  NO_RESPONSE,
  decodeMessage,
  decodeMessages,
  encodeMessage,
  frameContentLength,
  isJsonRpcNotification,
  isJsonRpcRequest,
  isJsonRpcResponse,
  toJsonRpcErrorObject,
} from '../src/shared/jsonrpc.js';
import { createCallbackChannel, createLoopbackPair, createStdioChannel } from '../src/shared/transport.js';
import { createFakeRuntime, recordingStdin, scriptedHandle } from './helpers/fake-runtime.js';

describe('jsonrpc · codec', () => {
  it('round-trips a request and validates the envelope', () => {
    const request = { jsonrpc: '2.0' as const, id: 1, method: 'tools/call', params: { name: 'x' } };
    const decoded = decodeMessage(encodeMessage(request));
    expect(decoded).toEqual(request);
    expect(isJsonRpcRequest(decoded)).toBe(true);
    expect(isJsonRpcNotification(decoded)).toBe(false);
    expect(isJsonRpcResponse(decoded)).toBe(false);
  });

  it('rejects a non-2.0 envelope', () => {
    expect(() => decodeMessage('{"id":1,"method":"x"}')).toThrow(/jsonrpc must be "2.0"/);
    expect(() => decodeMessage('[]')).toThrow(/must be an object/);
  });

  it('flattens batches', () => {
    const messages = decodeMessages('[{"jsonrpc":"2.0","id":1,"method":"a"},{"jsonrpc":"2.0","id":2,"method":"b"}]');
    expect(messages).toHaveLength(2);
  });

  it('frames with Content-Length headers', () => {
    const body = encodeMessage({ jsonrpc: '2.0', id: 1, method: 'x' });
    const framed = frameContentLength(body);
    expect(framed.startsWith(`Content-Length: ${body.length}\r\n\r\n`)).toBe(true);
  });

  it('coerces thrown values without losing protocol error objects', () => {
    expect(toJsonRpcErrorObject({ code: -32021, message: 'tampered' })).toEqual({ code: -32021, message: 'tampered' });
    expect(toJsonRpcErrorObject(new JsonRpcRemoteError({ code: -32001, message: 'nope' }))).toEqual({ code: -32001, message: 'nope' });
    expect(toJsonRpcErrorObject(new Error('boom')).code).toBe(-32603);
  });
});

describe('jsonrpc · framing', () => {
  it('parses Content-Length frames delivered in pieces', () => {
    const framer = new MessageFramer('content-length');
    const first = frameContentLength(encodeMessage({ jsonrpc: '2.0', id: 1, method: 'a' }));
    const second = frameContentLength(encodeMessage({ jsonrpc: '2.0', id: 2, method: 'b' }));
    const stream = first + second;
    const messages = [];
    for (const char of stream) messages.push(...framer.push(char));
    expect(messages).toHaveLength(2);
    expect(messages.map((message) => (isJsonRpcRequest(message) ? message.method : ''))).toEqual(['a', 'b']);
  });

  it('parses newline-delimited frames in auto mode', () => {
    const framer = new MessageFramer('auto');
    const messages = framer.push(`${encodeMessage({ jsonrpc: '2.0', method: 'n' })}\n${encodeMessage({ jsonrpc: '2.0', id: 3, method: 'a' })}\n`);
    expect(messages).toHaveLength(2);
    expect(isJsonRpcNotification(messages[0] ?? ({} as never))).toBe(true);
    expect(isJsonRpcRequest(messages[1] ?? ({} as never))).toBe(true);
  });

  it('flushes a trailing unframed message at EOF', () => {
    const framer = new MessageFramer('auto');
    expect(framer.push(encodeMessage({ jsonrpc: '2.0', id: 9, method: 'a' }))).toHaveLength(0);
    expect(framer.flush()).toHaveLength(1);
  });

  it('drops malformed frames instead of killing the connection', () => {
    const framer = new MessageFramer('auto');
    const messages = framer.push(`not json\n${encodeMessage({ jsonrpc: '2.0', id: 1, method: 'a' })}\n`);
    expect(messages).toHaveLength(1);
  });
});

describe('jsonrpc · connection', () => {
  it('correlates a response with its request over the loopback', async () => {
    const pair = createLoopbackPair();
    const server = new JsonRpcConnection({
      channel: pair.b,
      handlers: { request: (method, params) => ({ method, params }) },
    });
    server.start();
    const client = new JsonRpcConnection({ channel: pair.a, requestTimeoutMs: 500 });
    client.start();

    const result = await client.request('echo', { value: 1 });
    expect(result).toEqual({ method: 'echo', params: { value: 1 } });
    expect(client.stats.sent).toBe(1);
    expect(server.stats.received).toBe(1);

    await client.close();
    await server.close();
  });

  it('dispatches notifications to the handler', async () => {
    const pair = createLoopbackPair();
    const received: string[] = [];
    const server = new JsonRpcConnection({ channel: pair.b, handlers: { notification: (method) => received.push(method) } });
    server.start();
    const client = new JsonRpcConnection({ channel: pair.a });
    client.start();

    await client.notify('notifications/cancelled', { requestId: 1 });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(received).toEqual(['notifications/cancelled']);

    await client.close();
    await server.close();
  });

  it('answers a reverse request from the peer', async () => {
    const pair = createLoopbackPair();
    const agent = new JsonRpcConnection({
      channel: pair.a,
      handlers: { request: (method) => (method === 'session/request_permission' ? { outcome: 'selected', optionId: 'a1' } : undefined) },
    });
    agent.start();
    const editor = new JsonRpcConnection({ channel: pair.b, requestTimeoutMs: 500 });
    editor.start();

    const response = await editor.request('session/request_permission', { sessionId: 's1' });
    expect(response).toEqual({ outcome: 'selected', optionId: 'a1' });

    await agent.close();
    await editor.close();
  });

  it('routes stream events to a pending stream by id', async () => {
    const pair = createLoopbackPair();
    const events: unknown[] = [];
    let seenId: string | number | undefined;
    const server = new JsonRpcConnection({
      channel: pair.b,
      handlers: {
        request: async (_method, _params, ctx) => {
          await server.notifyStream(ctx.id, { step: 1 });
          await server.notifyStream(ctx.id, { step: 2 });
          return { done: true };
        },
      },
    });
    server.start();
    const client = new JsonRpcConnection({
      channel: pair.a,
      requestTimeoutMs: 500,
      handlers: {
        streamEvent: (id, event) => {
          seenId = id;
          events.push(event);
          return true;
        },
      },
    });
    client.start();

    const result = await client.request('stream');
    expect(result).toEqual({ done: true });
    expect(seenId).toBeDefined();
    expect(events).toEqual([{ step: 1 }, { step: 2 }]);

    await client.close();
    await server.close();
  });

  it('lets a handler own the response frames (NO_RESPONSE)', async () => {
    const pair = createLoopbackPair();
    const server = new JsonRpcConnection({
      channel: pair.b,
      handlers: {
        request: async (_method, _params, ctx) => {
          await server.respond(ctx.id, { owned: true });
          return NO_RESPONSE;
        },
      },
    });
    server.start();
    const client = new JsonRpcConnection({ channel: pair.a, requestTimeoutMs: 500 });
    client.start();

    expect(await client.request('custom')).toEqual({ owned: true });

    await client.close();
    await server.close();
  });

  it('reports a timeout and never retries', async () => {
    const pair = createLoopbackPair();
    const calls: string[] = [];
    const server = new JsonRpcConnection({
      channel: pair.b,
      handlers: {
        request: (method) => {
          calls.push(method);
          return new Promise<never>(() => undefined);
        },
      },
    });
    server.start();
    const client = new JsonRpcConnection({ channel: pair.a, requestTimeoutMs: 20 });
    client.start();

    await expect(client.request('slow')).rejects.toBeInstanceOf(JsonRpcTimeoutError);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(calls).toEqual(['slow']);
    expect(client.pendingCount).toBe(0);

    await client.close();
    await server.close();
  });

  it('rejects a pending request when the connection closes', async () => {
    const pair = createLoopbackPair();
    const server = new JsonRpcConnection({ channel: pair.b, handlers: { request: () => new Promise<never>(() => undefined) } });
    server.start();
    const client = new JsonRpcConnection({ channel: pair.a, requestTimeoutMs: 0 });
    client.start();

    const pending = client.request('never');
    await client.close();
    await expect(pending).rejects.toBeDefined();
    await server.close();
  });

  it('fails fast on a closed connection', async () => {
    const pair = createLoopbackPair();
    const client = new JsonRpcConnection({ channel: pair.a });
    client.start();
    await client.close();
    await expect(client.request('x')).rejects.toThrow(/connection closed/);
    await pair.close();
  });
});

describe('jsonrpc · transports', () => {
  it('loopback delivers in both directions', async () => {
    const pair = createLoopbackPair();
    const received: string[] = [];
    const reader = (async () => {
      for await (const chunk of pair.b.receive()) received.push(chunk);
    })();
    await pair.a.send('hello');
    await new Promise((resolve) => setTimeout(resolve, 5));
    await pair.close();
    await reader;
    expect(received).toEqual(['hello']);
  });

  it('callback channel pushes chunks to the reader', async () => {
    const sent: string[] = [];
    const { channel, push, end } = createCallbackChannel({
      onSend: (chunk) => {
        sent.push(chunk);
      },
    });
    const reader = (async () => {
      const out: string[] = [];
      for await (const chunk of channel.receive()) out.push(chunk);
      return out;
    })();
    push('a');
    push('b');
    end();
    expect(await reader).toEqual(['a', 'b']);
    await channel.send('out');
    expect(sent).toEqual(['out']);
  });

  it('stdio channel spawns through Runtime.shell and frames with Content-Length', async () => {
    const stdin = recordingStdin();
    const runtime = createFakeRuntime({ spawn: () => scriptedHandle([''], stdin) });
    const { channel, handle } = createStdioChannel(runtime, 'fake-mcp', ['--stdio']);
    // A stdio edge asks for a writable pipe by default.
    expect(runtime.spawns[0]?.opts?.stdin).toBe(true);
    expect(channel.framing).toBe('content-length');
    expect(channel.describe()).toContain('stdio:fake-mcp');
    await channel.send('x');
    expect(stdin.written).toEqual(['x']);
    await channel.close();
    expect(stdin.ended).toBe(true);
    expect(handle.pid).toBe(4242);
  });

  it('stdio channel accepts an injected stdin override', async () => {
    const injected = recordingStdin();
    const runtime = createFakeRuntime({ spawn: () => scriptedHandle([]) });
    const { channel } = createStdioChannel(runtime, 'fake-mcp', [], { providedStdin: injected });
    await channel.send('y');
    expect(injected.written).toEqual(['y']);
    await channel.close();
  });

  it('stdio channel fails closed when the handle exposes no stdin', async () => {
    const runtime = createFakeRuntime({ spawn: () => scriptedHandle([]) });
    const { channel } = createStdioChannel(runtime, 'fake-mcp', []);
    await expect(channel.send('x')).rejects.toMatchObject({ kind: 'internal' });
    await channel.close();
  });

  it('http channel posts through Runtime.http and queues the response', async () => {
    const bodies: string[] = [];
    const runtime = createFakeRuntime({
      http: async (_url, init) => {
        bodies.push(init?.body ?? '');
        return {
          status: 200,
          headers: { 'content-type': 'application/json' },
          async text() {
            return JSON.stringify({ jsonrpc: '2.0', id: 1, result: { ok: true } });
          },
        };
      },
    });
    const { createHttpChannel } = await import('../src/shared/transport.js');
    const channel = createHttpChannel(runtime, 'http://127.0.0.1:1/rpc');
    await channel.send('{"jsonrpc":"2.0","id":1,"method":"x"}');
    const iterator = channel.receive()[Symbol.asyncIterator]();
    const first = await iterator.next();
    expect(bodies[0]).toContain('"method":"x"');
    expect(first.value).toContain('"ok":true');
    await iterator.return?.(undefined as never);
    await channel.close();
  });
});
