import * as http from 'node:http';
import type { AddressInfo } from 'node:net';

export interface MockServer {
  url: string;
  requests: { url: string; body: string; headers: Record<string, string> }[];
  close: () => Promise<void>;
}

/** Local SSE mock: handler receives the request body, returns SSE frames. */
export interface SseReply {
  status: number;
  events?: string[];
  text?: string;
}

export async function startSseMock(handle: (req: { url: string; body: string }) => SseReply | Promise<SseReply>): Promise<MockServer> {
  const requests: { url: string; body: string; headers: Record<string, string> }[] = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(req.headers)) headers[k] = Array.isArray(v) ? v.join(',') : (v ?? '');
      requests.push({ url: req.url ?? '/', body, headers });
      void Promise.resolve(handle({ url: req.url ?? '/', body })).then((out) => {
        if (out.status !== 200 || out.events === undefined) {
          res.writeHead(out.status, { 'content-type': 'application/json' });
          res.end(out.text ?? '');
          return;
        }
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        for (const event of out.events) {
          res.write(`data: ${event}\n\n`);
        }
        res.write('data: [DONE]\n\n');
        res.end();
      });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
