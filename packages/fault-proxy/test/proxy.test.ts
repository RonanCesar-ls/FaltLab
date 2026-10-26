import assert from 'node:assert/strict';
import {
  createServer,
  request,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, it, type TestContext } from 'node:test';
import { createFaultProxy } from '../src/proxy';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return 'http://127.0.0.1:' + (server.address() as AddressInfo).port;
}

async function fixture(
  t: TestContext,
  handler: (req: IncomingMessage, res: ServerResponse) => void,
  timeoutMs = 2000,
  shutdownTimeoutMs = 1000,
) {
  const provider = createServer(handler);
  const providerUrl = await listen(provider);
  const logs: Record<string, unknown>[] = [];
  const proxy = createFaultProxy(
    {
      host: '127.0.0.1',
      port: 3003,
      providerUrl: new URL(providerUrl),
      timeoutMs,
      shutdownTimeoutMs,
    },
    (entry) => logs.push(entry),
  );
  const url = await listen(proxy.server);
  t.after(async () => {
    await proxy.close();
    await new Promise<void>((resolve, reject) => {
      provider.close((error) => {
        if (error) reject(error);
        else resolve();
      });
      provider.closeAllConnections();
    });
  });
  return { proxy, url, providerUrl, logs };
}

function body(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.once('end', () => resolve(Buffer.concat(chunks)));
    req.once('error', reject);
  });
}

function exchange(
  url: string,
  path: string,
  options: {
    method?: string;
    body?: Buffer;
    headers?: IncomingHttpHeaders;
    onResponse?: () => void;
  } = {},
): Promise<{ status: number; headers: IncomingHttpHeaders; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const client = request(
      url + path,
      {
        method: options.method ?? 'POST',
        agent: false,
        headers: options.headers,
        signal: AbortSignal.timeout(5000),
      },
      (res) => {
        options.onResponse?.();
        void body(res).then(
          (body) =>
            resolve({
              status: res.statusCode ?? 0,
              headers: res.headers,
              body,
            }),
          reject,
        );
      },
    );
    client.once('error', reject);
    client.end(options.body);
  });
}

async function arm(url: string, id = 'arm-test'): Promise<void> {
  const result = await exchange(url, '/__faults/drop-next-charge-response', {
    headers: { 'x-correlation-id': id },
  });
  assert.equal(result.status, 200);
  assert.deepEqual(JSON.parse(result.body.toString()), { armed: true });
}

function succeeds(req: IncomingMessage, res: ServerResponse): void {
  req.resume();
  res.writeHead(201, {
    'content-type': 'application/json',
    'x-correlation-id': req.headers['x-correlation-id'],
  });
  res.end('{"status":"SUCCEEDED"}');
}

void describe(
  'Fault proxy over real HTTP with a controlled provider',
  { timeout: 15000 },
  () => {
    void it('forwards request/response bytes, status, query, cookies and correlation, removing hop-by-hop headers', async (t) => {
      const seen = deferred<{
        bytes: Buffer;
        method: string | undefined;
        path: string | undefined;
        headers: IncomingHttpHeaders;
      }>();
      const responseBytes = Buffer.from([0, 255, 1, 128, 42]);
      const { url, providerUrl } = await fixture(t, (req, res) => {
        void body(req).then((bytes) => {
          seen.resolve({
            bytes,
            method: req.method,
            path: req.url,
            headers: req.headers,
          });
          res.writeHead(202, {
            'content-type': 'application/octet-stream',
            'x-correlation-id': req.headers['x-correlation-id'],
            'set-cookie': ['a=1', 'b=2'],
            connection: 'close, x-provider-hop',
            'x-provider-hop': 'removed',
          });
          res.end(responseBytes);
        });
      });
      const requestBytes = Buffer.from([255, 0, 3, 10]);
      const response = await exchange(url, '/echo?value=a%2Fb', {
        body: requestBytes,
        headers: {
          'x-correlation-id': 'preserve-1',
          connection: 'close, x-client-hop',
          'x-client-hop': 'removed',
        },
      });
      assert.equal(response.status, 202);
      assert.deepEqual(response.body, responseBytes);
      assert.equal(response.headers['x-correlation-id'], 'preserve-1');
      assert.deepEqual(response.headers['set-cookie'], ['a=1', 'b=2']);
      assert.equal(response.headers['x-provider-hop'], undefined);
      const received = await seen.promise;
      assert.deepEqual(received.bytes, requestBytes);
      assert.equal(received.method, 'POST');
      assert.equal(received.path, '/echo?value=a%2Fb');
      assert.equal(received.headers['x-correlation-id'], 'preserve-1');
      assert.equal(received.headers['x-client-hop'], undefined);
      assert.equal(received.headers.host, new URL(providerUrl).host);
    });

    void it('records the operation and receives the entire 201 before dropping without headers; the next charge succeeds', async (t) => {
      const partial = deferred<void>();
      const finish = deferred<void>();
      const completed = deferred<void>();
      const operations: string[] = [];
      let finished = false;
      const { url, logs } = await fixture(t, (req, res) => {
        void body(req).then((bytes) => {
          operations.push(bytes.toString());
          res.writeHead(201, {
            'content-type': 'application/json',
            'x-correlation-id': req.headers['x-correlation-id'],
          });
          if (operations.length === 1) {
            res.write('{"status":', () => partial.resolve());
            void finish.promise.then(() =>
              res.end('"SUCCEEDED"}', () => {
                finished = true;
                completed.resolve();
              }),
            );
          } else res.end('{"status":"SUCCEEDED"}');
        });
      });
      await arm(url, 'arm-1');
      let receivedHeaders = false;
      let clientSettled = false;
      const result = exchange(url, '/charges', {
        body: Buffer.from('record-this-operation'),
        headers: { 'x-correlation-id': 'payment-1' },
        onResponse: () => {
          receivedHeaders = true;
        },
      }).then(
        () => {
          clientSettled = true;
          return new Error('Unexpected response');
        },
        (error: unknown) => {
          clientSettled = true;
          assert.equal(finished, true);
          return error;
        },
      );
      await partial.promise;
      assert.equal(
        (await exchange(url, '/health', { method: 'GET' })).status,
        200,
      );
      assert.deepEqual(operations, ['record-this-operation']);
      assert.equal(clientSettled, false);
      assert.equal(receivedHeaders, false);
      assert.equal(
        logs.filter((entry) => entry['event'] === 'fault.applied').length,
        0,
      );
      finish.resolve();
      await completed.promise;
      assert.equal(
        ((await result) as NodeJS.ErrnoException).code,
        'ECONNRESET',
      );
      assert.equal(receivedHeaders, false);
      const next = await exchange(url, '/charges', {
        headers: { 'x-correlation-id': 'payment-2' },
      });
      assert.equal(next.status, 201);
      assert.equal(next.body.toString(), '{"status":"SUCCEEDED"}');
      assert.equal(next.headers['x-correlation-id'], 'payment-2');
      assert.equal(operations.length, 2);
      assert.deepEqual(
        logs
          .filter((entry) => entry['event'] === 'fault.armed')
          .map((entry) => entry['correlationId']),
        ['arm-1'],
      );
      assert.deepEqual(
        logs
          .filter((entry) => entry['event'] === 'fault.applied')
          .map((entry) => [
            entry['correlationId'],
            entry['armedCorrelationId'],
          ]),
        [['payment-1', 'arm-1']],
      );
    });

    void it('does not consume the fault for provider errors, another method/path or a non-201 success', async (t) => {
      const { url, logs } = await fixture(t, (req, res) => {
        req.resume();
        res.writeHead(Number(req.headers['x-status'] ?? 201), {
          'x-correlation-id': req.headers['x-correlation-id'],
        });
        res.end('provider-body');
      });
      await arm(url);
      for (const [method, path, status] of [
        ['POST', '/charges', 400],
        ['POST', '/charges', 500],
        ['POST', '/charges', 200],
        ['GET', '/charges', 201],
        ['POST', '/other', 201],
      ] as const) {
        const result = await exchange(url, path, {
          method,
          headers: {
            'x-status': String(status),
            'x-correlation-id': 'not-eligible',
          },
        });
        assert.equal(result.status, status);
        assert.equal(result.body.toString(), 'provider-body');
        assert.equal(result.headers['x-correlation-id'], 'not-eligible');
        assert.equal(
          logs.filter((entry) => entry['event'] === 'fault.applied').length,
          0,
        );
      }
      await assert.rejects(exchange(url, '/charges?test=1'), {
        code: 'ECONNRESET',
      });
      assert.equal((await exchange(url, '/charges')).status, 201);
    });

    void it('keeps the fault armed after a truncated 201 response', async (t) => {
      const { url, logs } = await fixture(t, (req, res) => {
        if (req.headers['x-truncated']) {
          req.resume();
          res.writeHead(201, { 'content-length': '100', connection: 'close' });
          res.end('incomplete');
        } else succeeds(req, res);
      });
      await arm(url);
      const failed = await exchange(url, '/charges', {
        headers: { 'x-truncated': '1' },
      });
      assert.equal(failed.status, 502);
      assert.equal(
        logs.filter((entry) => entry['event'] === 'fault.applied').length,
        0,
      );
      await assert.rejects(exchange(url, '/charges'), { code: 'ECONNRESET' });
      assert.equal((await exchange(url, '/charges')).status, 201);
    });

    void it('uses a finite whole-response deadline and keeps the fault armed on timeout', async (t) => {
      const seen = deferred<void>();
      const closed = deferred<void>();
      const { url, logs } = await fixture(
        t,
        (req, res) => {
          if (req.headers['x-hang']) {
            req.resume();
            res.writeHead(201);
            res.write('partial');
            res.once('close', () => closed.resolve());
            seen.resolve();
          } else succeeds(req, res);
        },
        250,
      );
      await arm(url);
      const pending = exchange(url, '/charges', {
        headers: { 'x-hang': '1', 'x-correlation-id': 'deadline-1' },
      });
      await seen.promise;
      const result = await pending;
      assert.equal(result.status, 504);
      assert.deepEqual(JSON.parse(result.body.toString()), {
        statusCode: 504,
        code: 'PROXY_UPSTREAM_TIMEOUT',
        message: 'Provider deadline exceeded.',
        correlationId: 'deadline-1',
      });
      await closed.promise;
      assert.equal(
        logs.filter((entry) => entry['event'] === 'fault.applied').length,
        0,
      );
      await assert.rejects(exchange(url, '/charges'), { code: 'ECONNRESET' });
    });

    void it('drops exactly the first completed concurrent charge and repeated arming does not queue faults', async (t) => {
      const first = deferred<ServerResponse>();
      const second = deferred<ServerResponse>();
      const { url, logs } = await fixture(t, (req, res) => {
        req.resume();
        res.writeHead(201, {
          'x-correlation-id': req.headers['x-correlation-id'],
        });
        if (req.headers['x-correlation-id'] === 'first') first.resolve(res);
        else second.resolve(res);
      });
      await arm(url, 'original-arm');
      await arm(url, 'same-one-shot');
      const firstResult = exchange(url, '/charges', {
        headers: { 'x-correlation-id': 'first' },
      });
      const secondResult = assert.rejects(
        exchange(url, '/charges', {
          headers: { 'x-correlation-id': 'second' },
        }),
        { code: 'ECONNRESET' },
      );
      const [firstResponse, secondResponse] = await Promise.all([
        first.promise,
        second.promise,
      ]);
      secondResponse.end('second-completed-first');
      await secondResult;
      firstResponse.end('first-completed-second');
      assert.equal(
        (await firstResult).body.toString(),
        'first-completed-second',
      );
      assert.deepEqual(
        logs
          .filter((entry) => entry['event'] === 'fault.applied')
          .map((entry) => entry['correlationId']),
        ['second'],
      );
      assert.equal(
        logs.filter((entry) => entry['event'] === 'fault.armed').length,
        1,
      );
    });

    void it('waits for an in-flight response during graceful, idempotent shutdown', async (t) => {
      const ready = deferred<ServerResponse>();
      const { proxy, url, logs } = await fixture(t, (req, res) => {
        req.resume();
        ready.resolve(res);
      });
      const pending = exchange(url, '/charges');
      const response = await ready.promise;
      const shutdown = proxy.close();
      assert.equal(proxy.close(), shutdown);
      assert.equal(
        logs.filter((entry) => entry['event'] === 'proxy.stopped').length,
        0,
      );
      response.writeHead(201);
      response.end('completed-before-shutdown');
      assert.equal(
        (await pending).body.toString(),
        'completed-before-shutdown',
      );
      await shutdown;
      assert.equal(proxy.server.listening, false);
      assert.equal(
        logs.filter((entry) => entry['event'] === 'proxy.stopped').length,
        1,
      );
    });

    void it('drains the provider during shutdown even after the original caller disconnects', async (t) => {
      const ready = deferred<ServerResponse>();
      const { proxy, url, logs } = await fixture(t, (req, res) => {
        req.resume();
        ready.resolve(res);
      });
      await arm(url);
      const client = request(url + '/charges', {
        method: 'POST',
        agent: false,
      });
      client.on('error', () => {
        /* This caller deliberately disconnects. */
      });
      const clientClosed = new Promise<void>((resolve) =>
        client.once('close', resolve),
      );
      client.end();
      const response = await ready.promise;
      client.destroy();
      await clientClosed;
      const serverClosed = new Promise<void>((resolve) =>
        proxy.server.once('close', resolve),
      );
      const shutdown = proxy.close();
      await serverClosed;
      assert.equal(response.destroyed, false);
      assert.equal(
        logs.filter((entry) => entry['event'] === 'proxy.stopped').length,
        0,
      );
      response.writeHead(201);
      response.end('complete upstream response');
      await shutdown;
      assert.equal(
        logs.filter((entry) => entry['event'] === 'fault.applied').length,
        1,
      );
    });

    void it('bounds shutdown when the provider never finishes', async (t) => {
      const ready = deferred<void>();
      const { proxy, url } = await fixture(
        t,
        (req) => {
          req.resume();
          ready.resolve();
        },
        2000,
        100,
      );
      const pending = exchange(url, '/charges').catch(
        (error: unknown) => error,
      );
      await ready.promise;
      await proxy.close();
      assert.ok((await pending) instanceof Error);
      assert.equal(proxy.server.listening, false);
    });

    void it('serves health locally and rejects invalid correlation IDs before forwarding or arming', async (t) => {
      let forwarded = 0;
      const { url, logs } = await fixture(t, (req, res) => {
        forwarded++;
        succeeds(req, res);
      });
      const health = await exchange(url, '/health', { method: 'GET' });
      assert.equal(health.status, 200);
      assert.deepEqual(JSON.parse(health.body.toString()), {
        status: 'ok',
        service: 'fault-proxy',
      });
      assert.match(
        String(health.headers['x-correlation-id']),
        /^[0-9a-f-]{36}$/,
      );
      const invalid = await exchange(
        url,
        '/__faults/drop-next-charge-response',
        { headers: { 'x-correlation-id': 'invalid id' } },
      );
      assert.equal(invalid.status, 400);
      const duplicate = await exchange(
        url,
        '/__faults/drop-next-charge-response',
        {
          headers: { 'x-correlation-id': ['one', 'two'] },
        },
      );
      assert.equal(duplicate.status, 400);
      assert.equal(logs.length, 0);
      assert.equal((await exchange(url, '/charges')).status, 201);
      assert.equal(forwarded, 1);
      assert.equal(
        (
          await exchange(url, '/__faults/drop-next-charge-response', {
            method: 'GET',
          })
        ).status,
        405,
      );
    });
  },
);
