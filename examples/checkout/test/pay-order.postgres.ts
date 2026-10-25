import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { after, before, beforeEach, describe, it } from 'node:test';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { DatabaseService } from '../src/database.service';
import type { OrderResponseDto } from '../src/orders/dto/order-response.dto';

void describe('Pay order over HTTP with real PostgreSQL', () => {
  let app: INestApplication;
  let server: Server;
  let database: DatabaseService;
  let mode:
    | 'valid'
    | 'unavailable'
    | 'timeout'
    | 'body_timeout'
    | 'http_error'
    | 'invalid_json'
    | 'invalid_confirmation' = 'valid';
  let calls: unknown[] = [];
  let chargeIds: string[] = [];
  const provider = createServer((incoming, response) => {
    const chunks: Buffer[] = [];
    incoming.on('data', (chunk: Buffer) => chunks.push(chunk));
    incoming.on('end', () => {
      const body: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      calls.push(body);
      assert.equal(incoming.method, 'POST');
      assert.equal(incoming.url, '/charges');
      if (mode === 'unavailable') {
        incoming.socket.destroy();
        return;
      }
      if (mode === 'timeout') return;
      if (mode === 'http_error') {
        response.writeHead(500);
        response.end('Private provider details.');
        return;
      }
      response.writeHead(201, { 'content-type': 'application/json' });
      if (mode === 'invalid_json') {
        response.end('{broken');
        return;
      }
      if (mode === 'body_timeout') {
        response.flushHeaders();
        response.write('{"id":');
        return;
      }
      assert.ok(body !== null && typeof body === 'object');
      const id = randomUUID();
      chargeIds.push(id);
      response.end(
        JSON.stringify({
          ...body,
          id,
          status: 'SUCCEEDED',
          createdAt: new Date().toISOString(),
          ...(mode === 'invalid_confirmation' ? { amountCents: 1 } : {}),
        }),
      );
    });
  });

  before(async () => {
    assert.equal(process.env['FAULTLAB_ORDERS_TEST_DATABASE'], '1');
    assert.equal(process.env['PGDATABASE'], 'faultlab_checkout_test');
    await new Promise<void>((resolve) =>
      provider.listen(0, '127.0.0.1', resolve),
    );
    const address = provider.address();
    assert.ok(address && typeof address === 'object');
    process.env['PAYMENT_PROVIDER_URL'] = `http://127.0.0.1:${address.port}`;
    process.env['PAYMENT_PROVIDER_TIMEOUT_MS'] = '300';
    const { AppModule } = await import('../src/app.module.js');
    const module = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = module.createNestApplication({ logger: false });
    await app.init();
    database = app.get(DatabaseService);
    server = app.getHttpServer() as Server;
  });
  beforeEach(() => {
    mode = 'valid';
    calls = [];
    chargeIds = [];
  });
  after(async () => {
    await app?.close();
    provider.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      provider.close((error) => (error ? reject(error) : resolve())),
    );
  });

  async function create(): Promise<OrderResponseDto> {
    const response = await request(server)
      .post('/orders')
      .send({ amountCents: 12990, currency: 'BRL' })
      .expect(201);
    return response.body as OrderResponseDto;
  }

  void it('charges using persisted data and atomically stores PAID plus the confirmed charge ID', async () => {
    const order = await create();
    const response = await request(server)
      .post('/orders/' + order.id + '/pay')
      .expect(200);
    const paid = response.body as OrderResponseDto;
    assert.deepEqual(calls, [
      {
        merchantReference: order.id,
        amountCents: order.amountCents,
        currency: order.currency,
      },
    ]);
    assert.equal(paid.status, 'PAID');
    assert.equal(paid.providerChargeId, chargeIds[0]);
    assert.equal(paid.amountCents, order.amountCents);
    assert.equal(paid.currency, order.currency);
    assert.equal(paid.createdAt, order.createdAt);
    assert.ok(Date.parse(paid.updatedAt) >= Date.parse(order.updatedAt));
    await request(server)
      .get('/orders/' + order.id)
      .expect(200)
      .expect(paid);
    const result = await database.query<{ status: string; charge: string }>(
      'SELECT status, provider_charge_id AS charge FROM checkout.orders WHERE id = $1::uuid',
      [order.id],
    );
    assert.deepEqual(result.rows, [{ status: 'PAID', charge: chargeIds[0] }]);
  });
  void it('returns the persisted paid order on sequential calls even when the provider is now unavailable', async () => {
    const order = await create();
    const first = await request(server)
      .post('/orders/' + order.id + '/pay')
      .send({})
      .expect(200);
    mode = 'unavailable';
    await request(server)
      .post('/orders/' + order.id + '/pay')
      .expect(200)
      .expect(first.body as OrderResponseDto);
    assert.equal(calls.length, 1);
  });
  void it('returns 404 for missing orders and 400 for malformed UUIDs without contacting the provider', async () => {
    await request(server)
      .post('/orders/' + randomUUID() + '/pay')
      .expect(404);
    await request(server).post('/orders/not-a-uuid/pay').expect(400);
    assert.equal(calls.length, 0);
  });
  for (const field of [
    'amountCents',
    'currency',
    'id',
    'status',
    'providerChargeId',
    'merchantReference',
    'createdAt',
    'updatedAt',
    '__proto__',
  ]) {
    void it(
      'rejects a payment body attempting to supply ' + field,
      async () => {
        const order = await create();
        await request(server)
          .post('/orders/' + order.id + '/pay')
          .send({ [field]: 'forged' })
          .expect(400);
        await request(server)
          .get('/orders/' + order.id)
          .expect(200)
          .expect(order);
        assert.equal(calls.length, 0);
      },
    );
  }
  for (const body of [[], null, 'not-an-object', 1]) {
    void it(
      'rejects a non-object payment body: ' + JSON.stringify(body),
      async () => {
        const order = await create();
        await request(server)
          .post('/orders/' + order.id + '/pay')
          .set('content-type', 'application/json')
          .send(JSON.stringify(body))
          .expect(400);
        assert.equal(calls.length, 0);
      },
    );
  }
  for (const [failure, status, code] of [
    ['unavailable', 503, 'PAYMENT_PROVIDER_UNAVAILABLE'],
    ['timeout', 504, 'PAYMENT_PROVIDER_TIMEOUT'],
    ['body_timeout', 504, 'PAYMENT_PROVIDER_TIMEOUT'],
    ['http_error', 502, 'PAYMENT_PROVIDER_HTTP_ERROR'],
    ['invalid_json', 502, 'PAYMENT_PROVIDER_INVALID_RESPONSE'],
    ['invalid_confirmation', 502, 'PAYMENT_PROVIDER_INVALID_RESPONSE'],
  ] as const) {
    void it('keeps the order unchanged and pending on ' + failure, async () => {
      const order = await create();
      mode = failure;
      const response = await request(server)
        .post('/orders/' + order.id + '/pay')
        .expect(status);
      const body = response.body as Record<string, unknown>;
      assert.equal(body['code'], code);
      assert.equal(JSON.stringify(body).includes('Private'), false);
      await request(server)
        .get('/orders/' + order.id)
        .expect(200)
        .expect(order);
      assert.equal(calls.length, 1);
    });
  }
  void it('reports a local persistence failure without retrying the confirmed charge', async () => {
    const order = await create();
    await database.query(
      `CREATE FUNCTION checkout.reject_paid_test() RETURNS trigger LANGUAGE plpgsql
      AS $$ BEGIN RAISE EXCEPTION 'Simulated local confirmation write failure'; END; $$`,
      [],
    );
    try {
      await database.query(
        'CREATE TRIGGER reject_paid_test BEFORE UPDATE ON checkout.orders FOR EACH ROW EXECUTE FUNCTION checkout.reject_paid_test()',
        [],
      );
      const response = await request(server)
        .post('/orders/' + order.id + '/pay')
        .expect(503);
      assert.equal(
        (response.body as Record<string, unknown>)['code'],
        'PAYMENT_CONFIRMATION_NOT_PERSISTED',
      );
      assert.equal(calls.length, 1);
      assert.equal(chargeIds.length, 1);
      await request(server)
        .get('/orders/' + order.id)
        .expect(200)
        .expect(order);
    } finally {
      await database.query(
        'DROP TRIGGER IF EXISTS reject_paid_test ON checkout.orders',
        [],
      );
      await database.query('DROP FUNCTION checkout.reject_paid_test()', []);
    }
  });
});
