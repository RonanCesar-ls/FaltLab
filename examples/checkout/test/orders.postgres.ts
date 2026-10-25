import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import { after, before, describe, it } from 'node:test';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { DatabaseService } from '../src/database.service';
import type { OrderResponseDto } from '../src/orders/dto/order-response.dto';

function assertOrder(value: unknown): asserts value is OrderResponseDto {
  assert.ok(value !== null && typeof value === 'object');
  assert.deepEqual(Object.keys(value).sort(), [
    'amountCents',
    'createdAt',
    'currency',
    'id',
    'providerChargeId',
    'status',
    'updatedAt',
  ]);
  const order = value as Record<string, unknown>;
  assert.equal(typeof order['id'], 'string');
  assert.match(
    String(order['id']),
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );
  assert.equal(typeof order['amountCents'], 'number');
  assert.equal(order['currency'], 'BRL');
  assert.equal(order['status'], 'PENDING_PAYMENT');
  assert.equal(order['providerChargeId'], null);
  for (const field of ['createdAt', 'updatedAt']) {
    const timestamp = order[field];
    assert.equal(typeof timestamp, 'string');
    assert.equal(new Date(String(timestamp)).toISOString(), timestamp);
    assert.ok(Math.abs(Date.now() - Date.parse(String(timestamp))) < 120_000);
  }
}

void describe('Orders HTTP and PostgreSQL constraints (isolated database only)', () => {
  let app: INestApplication;
  let database: DatabaseService;
  let server: Server;

  before(async () => {
    assert.equal(
      process.env['FAULTLAB_ORDERS_TEST_DATABASE'],
      '1',
      'Run pnpm test:orders to provision an isolated database.',
    );
    assert.equal(process.env['PGDATABASE'], 'faultlab_checkout_test');
    assert.equal(process.env['PGUSER'], 'faultlab_checkout_test');
    const { AppModule } = await import('../src/app.module.js');
    const module = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = module.createNestApplication();
    await app.init();
    database = app.get(DatabaseService);
    server = app.getHttpServer() as Server;
    const identity = await database.query<{ database: string }>(
      'SELECT current_database() AS database',
      [],
    );
    assert.equal(identity.rows[0]?.database, 'faultlab_checkout_test');
  });

  after(async () => {
    await app?.close();
  });

  async function countOrders(): Promise<number> {
    const result = await database.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM checkout.orders',
      [],
    );
    const count = result.rows[0]?.count;
    assert.notEqual(count, undefined);
    return count as number;
  }

  void it('POST creates a pending order with server UUID/timestamps and GET returns the persisted order', async () => {
    const response = await request(server)
      .post('/orders')
      .send({ amountCents: 12990, currency: 'BRL' })
      .expect(201);
    const created: unknown = response.body;
    assertOrder(created);
    assert.equal(created.amountCents, 12990);
    assert.equal(created.createdAt, created.updatedAt);
    await request(server)
      .get('/orders/' + created.id)
      .expect(200)
      .expect(created);
    await request(server)
      .get('/orders/' + created.id.toUpperCase() + '/')
      .expect(200)
      .expect(created);
    const stored = await database.query<{
      amount: number;
      createdAt: Date;
      updatedAt: Date;
    }>(
      'SELECT amount_cents AS amount, created_at AS "createdAt", updated_at AS "updatedAt" FROM checkout.orders WHERE id = $1::uuid',
      [created.id],
    );
    assert.equal(stored.rows[0]?.amount, 12990);
    assert.equal(stored.rows[0]?.createdAt.toISOString(), created.createdAt);
    assert.equal(stored.rows[0]?.updatedAt.toISOString(), created.updatedAt);
  });

  for (const amountCents of [1, 2_147_483_647]) {
    void it(
      'accepts the inclusive amount boundary ' + amountCents,
      async () => {
        const response = await request(server)
          .post('/orders/')
          .send({ amountCents, currency: 'BRL' })
          .expect(201);
        const created: unknown = response.body;
        assertOrder(created);
        assert.equal(created.amountCents, amountCents);
        await request(server)
          .get('/orders/' + created.id)
          .expect(200)
          .expect(created);
      },
    );
  }

  const invalidBodies: Array<{ label: string; body: unknown }> = [
    { label: 'missing fields', body: {} },
    { label: 'missing amount', body: { currency: 'BRL' } },
    { label: 'missing currency', body: { amountCents: 100 } },
    { label: 'root array', body: [{ amountCents: 100, currency: 'BRL' }] },
    { label: 'root null', body: null },
    { label: 'root number', body: 100 },
    { label: 'root string', body: '100' },
    ...[
      '1',
      '2147483647',
      '0x10',
      0,
      -1,
      0.5,
      1.5,
      2_147_483_648,
      Number.MAX_SAFE_INTEGER,
      1e100,
      null,
      true,
      [],
      {},
    ].map((amountCents) => ({
      label: 'invalid amount ' + JSON.stringify(amountCents),
      body: { amountCents, currency: 'BRL' },
    })),
    ...['USD', 'brl', '', null, 986, ['BRL'], {}].map((currency) => ({
      label: 'invalid currency ' + JSON.stringify(currency),
      body: { amountCents: 100, currency },
    })),
    ...[
      'extra',
      'id',
      'status',
      'providerChargeId',
      'createdAt',
      'updatedAt',
      'constructor',
      '__proto__',
    ].map((field) => ({
      label: 'unknown/server-controlled field ' + field,
      body: { amountCents: 100, currency: 'BRL', [field]: 'forged' },
    })),
  ];
  for (const { label, body } of invalidBodies) {
    void it('returns 400 and inserts nothing for ' + label, async () => {
      const beforeCount = await countOrders();
      await request(server)
        .post('/orders')
        .set('Content-Type', 'application/json')
        .send(JSON.stringify(body))
        .expect(400);
      assert.equal(await countOrders(), beforeCount);
    });
  }

  void it('rejects a missing body and malformed JSON without inserting anything', async () => {
    const beforeCount = await countOrders();
    await request(server).post('/orders').expect(400);
    await request(server)
      .post('/orders')
      .set('Content-Type', 'application/json')
      .send('{"amountCents":')
      .expect(400);
    assert.equal(await countOrders(), beforeCount);
  });

  for (const id of [
    'not-a-uuid',
    randomUUID().replaceAll('-', ''),
    randomUUID() + 'x',
    "x' OR 1=1 --",
  ]) {
    void it('returns 400 for an invalid UUID: ' + id, async () => {
      await request(server)
        .get('/orders/' + encodeURIComponent(id))
        .expect(400);
    });
  }
  for (const id of [randomUUID(), '00000000-0000-0000-0000-000000000000']) {
    void it('returns 404 for a valid, nonexistent UUID: ' + id, async () => {
      await request(server)
        .get('/orders/' + id)
        .expect(404);
    });
  }

  const invalidRows: Array<{
    label: string;
    index: number;
    value: unknown;
    code: string;
  }> = [
    { label: 'null UUID', index: 0, value: null, code: '23502' },
    { label: 'invalid UUID', index: 0, value: 'invalid', code: '22P02' },
    { label: 'null amount', index: 1, value: null, code: '23502' },
    { label: 'zero amount', index: 1, value: 0, code: '23514' },
    { label: 'negative amount', index: 1, value: -1, code: '23514' },
    { label: 'fractional amount', index: 1, value: 1.5, code: '22P02' },
    { label: 'amount overflow', index: 1, value: 2_147_483_648, code: '22003' },
    { label: 'null currency', index: 2, value: null, code: '23502' },
    { label: 'non-BRL currency', index: 2, value: 'USD', code: '23514' },
    { label: 'null status', index: 3, value: null, code: '23502' },
    { label: 'unknown status', index: 3, value: 'CANCELLED', code: '23514' },
    { label: 'paid without charge', index: 3, value: 'PAID', code: '23514' },
    {
      label: 'pending with charge',
      index: 4,
      value: randomUUID(),
      code: '23514',
    },
    {
      label: 'malformed charge UUID',
      index: 4,
      value: 'invalid',
      code: '22P02',
    },
    { label: 'null creation time', index: 5, value: null, code: '23502' },
    { label: 'null update time', index: 6, value: null, code: '23502' },
  ];
  const insert = `INSERT INTO checkout.orders
    (id, amount_cents, currency, status, provider_charge_id, created_at, updated_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7)`;
  for (const { label, index, value, code } of invalidRows) {
    void it(
      'PostgreSQL rejects ' + label + ' even when HTTP validation is bypassed',
      async () => {
        const values: unknown[] = [
          randomUUID(),
          100,
          'BRL',
          'PENDING_PAYMENT',
          null,
          new Date(),
          new Date(),
        ];
        values[index] = value;
        await assert.rejects(database.query(insert, values), { code });
      },
    );
  }

  void it('PostgreSQL permits PAID only with a UUID charge and enforces unique order IDs', async () => {
    const id = randomUUID();
    const values = [
      id,
      100,
      'BRL',
      'PAID',
      randomUUID(),
      new Date(),
      new Date(),
    ];
    await database.query(insert, values);
    await assert.rejects(database.query(insert, values), { code: '23505' });
    const response = await request(server)
      .get('/orders/' + id)
      .expect(200);
    const body = response.body as Record<string, unknown>;
    assert.equal(body['status'], 'PAID');
    assert.equal(body['providerChargeId'], values[4]);
  });

  void it('stores UUIDs, integer amounts, and timezone-aware timestamps in PostgreSQL', async () => {
    const result = await database.query<{
      column_name: string;
      data_type: string;
    }>(
      'SELECT column_name, data_type FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2 ORDER BY ordinal_position',
      ['checkout', 'orders'],
    );
    assert.deepEqual(result.rows, [
      { column_name: 'id', data_type: 'uuid' },
      { column_name: 'amount_cents', data_type: 'integer' },
      { column_name: 'currency', data_type: 'text' },
      { column_name: 'status', data_type: 'text' },
      { column_name: 'provider_charge_id', data_type: 'uuid' },
      { column_name: 'created_at', data_type: 'timestamp with time zone' },
      { column_name: 'updated_at', data_type: 'timestamp with time zone' },
    ]);
  });
});
