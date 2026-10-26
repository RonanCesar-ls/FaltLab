import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { after, before, beforeEach, describe, it } from 'node:test';
import { HttpPaymentGateway } from '../src/payments/http-payment-gateway';
import type { PaymentRequest } from '../src/payments/payment-gateway';
import { PaymentGatewayError } from '../src/payments/payment-gateway';
import { RequestContext } from '../src/observability/request-context';

const paymentKey = randomUUID();
const payment: PaymentRequest = {
  merchantReference: randomUUID(),
  amountCents: 12990,
  currency: 'BRL',
};
const valid = {
  ...payment,
  id: randomUUID(),
  status: 'SUCCEEDED',
  createdAt: new Date().toISOString(),
};

void describe('HTTP payment gateway with a real HTTP server', () => {
  let baseUrl: string;
  const context = new RequestContext();
  let handler: (request: IncomingMessage, response: ServerResponse) => void;
  let calls: Array<{
    method: string | undefined;
    path: string | undefined;
    body: unknown;
    correlationId: string | undefined;
    idempotencyKey: string | undefined;
  }> = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const body: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      calls.push({
        idempotencyKey: request.headers['idempotency-key'] as
          string | undefined,
        method: request.method,
        path: request.url,
        body,
        correlationId: request.headers['x-correlation-id'] as
          string | undefined,
      });
      handler(request, response);
    });
  });
  before(async () => {
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    baseUrl = `http://127.0.0.1:${address.port}/api/`;
  });
  beforeEach(() => {
    calls = [];
    handler = (_request, response) => {
      response.writeHead(201, { 'content-type': 'application/json' });
      response.end(JSON.stringify(valid));
    };
  });
  after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  });
  function gateway(timeoutMs = 2000): HttpPaymentGateway {
    return new HttpPaymentGateway({ baseUrl, timeoutMs }, fetch, context);
  }
  async function fails(
    kind: PaymentGatewayError['kind'],
    timeoutMs = 2000,
  ): Promise<void> {
    await assert.rejects(
      gateway(timeoutMs).createCharge(payment, paymentKey),
      (error: unknown) =>
        error instanceof PaymentGatewayError && error.kind === kind,
    );
    assert.equal(calls.length, 1, 'Exactly one attempt is allowed.');
  }

  void it('POSTs only the persisted identity, amount and currency and validates the confirmation', async () => {
    assert.deepEqual(
      await context.run('gateway-test-1', () =>
        gateway().createCharge(payment, paymentKey),
      ),
      valid,
    );
    assert.deepEqual(calls, [
      {
        method: 'POST',
        path: '/api/charges',
        body: payment,
        correlationId: 'gateway-test-1',
        idempotencyKey: paymentKey,
      },
    ]);
  });
  void it('generates an outbound UUID when called outside an incoming request', async () => {
    await gateway().createCharge(payment, paymentKey);
    assert.match(calls[0]?.correlationId ?? '', /^[0-9a-f-]{36}$/);
    assert.equal(context.getId(), undefined);
  });
  void it('propagates concurrent contexts without mixing identifiers', async () => {
    const ids = Array.from(
      { length: 20 },
      (_value, index) => 'gateway-concurrent-' + index,
    );
    const adapter = gateway();
    await Promise.all(
      ids.map((id) =>
        context.run(id, () => adapter.createCharge(payment, paymentKey)),
      ),
    );
    assert.deepEqual(
      new Set(calls.map((call) => call.correlationId)),
      new Set(ids),
    );
    assert.equal(calls.length, ids.length);
    assert.equal(context.getId(), undefined);
  });
  for (const status of [400, 401, 404, 409, 429, 500, 503]) {
    void it('reports HTTP ' + status + ' without retrying', async () => {
      handler = (_request, response) => {
        response.writeHead(status);
        response.end('Private upstream error details');
      };
      await fails('http_error');
    });
  }
  void it('does not follow redirects or replay the POST', async () => {
    handler = (_request, response) => {
      response.writeHead(307, { location: '/api/charges' });
      response.end();
    };
    await fails('http_error');
  });
  for (const status of [200, 202, 204]) {
    void it(
      'rejects an unexpected successful HTTP status ' + status,
      async () => {
        handler = (_request, response) => {
          response.writeHead(status, { 'content-type': 'application/json' });
          response.end(JSON.stringify(valid));
        };
        await fails('invalid_response');
      },
    );
  }
  void it('reports a dropped connection as unavailability', async () => {
    handler = (request) => request.socket.destroy();
    await fails('unavailable');
  });
  void it('bounds the wait for response headers', async () => {
    handler = () => undefined;
    await fails('timeout', 150);
  });
  void it('also times out an incomplete response body after headers arrive', async () => {
    handler = (_request, response) => {
      response.writeHead(201, { 'content-type': 'application/json' });
      response.flushHeaders();
      response.write('{"id":');
    };
    await fails('timeout', 150);
  });
  void it('rejects non-JSON content types', async () => {
    handler = (_request, response) => {
      response.writeHead(201, { 'content-type': 'text/html' });
      response.end(JSON.stringify(valid));
    };
    await fails('invalid_response');
  });
  void it('rejects malformed JSON', async () => {
    handler = (_request, response) => {
      response.writeHead(201, { 'content-type': 'application/json' });
      response.end('{broken');
    };
    await fails('invalid_response');
  });
  const invalid: Array<{ label: string; value: unknown }> = [
    { label: 'null', value: null },
    { label: 'array', value: [valid] },
    { label: 'empty object', value: {} },
    { label: 'charge UUID', value: { ...valid, id: 'invalid' } },
    {
      label: 'reference UUID',
      value: { ...valid, merchantReference: 'invalid' },
    },
    {
      label: 'reference mismatch',
      value: { ...valid, merchantReference: randomUUID() },
    },
    { label: 'amount mismatch', value: { ...valid, amountCents: 1 } },
    { label: 'numeric string', value: { ...valid, amountCents: '12990' } },
    { label: 'currency mismatch', value: { ...valid, currency: 'USD' } },
    { label: 'status', value: { ...valid, status: 'PENDING' } },
    { label: 'timestamp', value: { ...valid, createdAt: 'not-a-date' } },
    {
      label: 'timestamp without timezone',
      value: { ...valid, createdAt: '2026-10-25T18:00:00' },
    },
    {
      label: 'impossible date',
      value: { ...valid, createdAt: '2026-02-30T18:00:00Z' },
    },
  ];
  for (const { label, value } of invalid) {
    void it('rejects an invalid confirmation: ' + label, async () => {
      handler = (_request, response) => {
        response.writeHead(201, { 'content-type': 'application/json' });
        response.end(JSON.stringify(value));
      };
      await fails('invalid_response');
    });
  }
});
