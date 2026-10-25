import 'reflect-metadata';
import { configureHttpApplication } from '../src/observability/configure-http';
import { JSON_LOG_SINK } from '../src/observability/json-logger';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import { after, before, describe, it } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import type { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { Client } from 'pg';
import request from 'supertest';
import { DatabaseService } from '../src/database.service';
import type { Environment } from '../src/environment';
import type { ChargeResponseDto } from '../src/charges/dto/charge-response.dto';

function parseCharge(value: unknown): ChargeResponseDto {
  assert.ok(value !== null && typeof value === 'object');
  assert.deepEqual(Object.keys(value).sort(), [
    'amountCents',
    'createdAt',
    'currency',
    'id',
    'merchantReference',
    'status',
  ]);
  const charge = value as Record<string, unknown>;
  assert.equal(typeof charge['id'], 'string');
  assert.match(
    String(charge['id']),
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );
  assert.equal(typeof charge['merchantReference'], 'string');
  assert.equal(typeof charge['amountCents'], 'number');
  assert.equal(charge['currency'], 'BRL');
  assert.equal(charge['status'], 'SUCCEEDED');
  assert.equal(typeof charge['createdAt'], 'string');
  assert.equal(
    new Date(String(charge['createdAt'])).toISOString(),
    charge['createdAt'],
  );
  return value as ChargeResponseDto;
}

void describe('Charges HTTP and PostgreSQL (isolated provider database)', () => {
  let app: INestApplication;
  let database: DatabaseService;
  let config: Environment['database'];
  let server: Server;

  before(async () => {
    assert.equal(
      process.env['FAULTLAB_CHARGES_TEST_DATABASE'],
      '1',
      'Use pnpm test:charges to provision an isolated database.',
    );
    assert.equal(process.env['PGDATABASE'], 'faultlab_payment_provider_test');
    assert.equal(process.env['PGUSER'], 'faultlab_payment_provider_test');
    const { AppModule } = await import('../src/app.module.js');
    const module = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(JSON_LOG_SINK)
      .useValue(() => undefined)
      .compile();
    app = module.createNestApplication({ logger: false });
    configureHttpApplication(app);
    await app.init();
    database = app.get(DatabaseService);
    config = app
      .get(ConfigService<Environment, true>)
      .get('database', { infer: true });
    server = app.getHttpServer() as Server;
    const result = await database.query<{ database: string }>(
      'SELECT current_database() AS database',
      [],
    );
    assert.equal(result.rows[0]?.database, 'faultlab_payment_provider_test');
  });
  after(async () => {
    await app?.close();
  });

  async function create(
    merchantReference = randomUUID(),
    amountCents = 12990,
  ): Promise<ChargeResponseDto> {
    const response = await request(server)
      .post('/charges')
      .send({ merchantReference, amountCents, currency: 'BRL' })
      .expect(201);
    return parseCharge(response.body);
  }

  async function countCharges(): Promise<number> {
    const result = await database.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM payment_provider.charges',
      [],
    );
    const count = result.rows[0]?.count;
    assert.notEqual(count, undefined);
    return count as number;
  }

  void it('persists a SUCCEEDED charge before 201, visible to an independent connection and GET', async () => {
    const merchantReference = randomUUID();
    const charge = await create(merchantReference);
    assert.equal(charge.merchantReference, merchantReference);
    assert.equal(charge.amountCents, 12990);
    assert.ok(Math.abs(Date.now() - Date.parse(charge.createdAt)) < 120_000);
    const reader = new Client(config);
    try {
      await reader.connect();
      const stored = await reader.query<{
        id: string;
        merchant_reference: string;
        amount_cents: number;
        status: string;
      }>(
        'SELECT id, merchant_reference, amount_cents, status FROM payment_provider.charges WHERE id = $1::uuid',
        [charge.id],
      );
      assert.deepEqual(stored.rows, [
        {
          id: charge.id,
          merchant_reference: merchantReference,
          amount_cents: 12990,
          status: 'SUCCEEDED',
        },
      ]);
    } finally {
      await reader.end();
    }
    await request(server)
      .get('/charges/' + charge.id)
      .expect(200)
      .expect(charge);
    await request(server)
      .get('/charges/' + charge.id.toUpperCase())
      .expect(200)
      .expect(charge);
  });

  void it('does not return 201 while PostgreSQL is still waiting to persist the charge', async () => {
    const reader = new Client({
      ...config,
      application_name: 'charges-test-lock',
    });
    await reader.connect();
    try {
      await reader.query('BEGIN');
      await reader.query('LOCK TABLE payment_provider.charges IN SHARE MODE');
      let finished = false;
      let transactionOpen = true;
      const pending = request(server)
        .post('/charges')
        .send({
          merchantReference: randomUUID(),
          amountCents: 100,
          currency: 'BRL',
        })
        .then((response) => {
          finished = true;
          return response;
        });
      try {
        let waiting = false;
        const deadline = Date.now() + 5000;
        while (!waiting && Date.now() < deadline) {
          const result = await database.query<{ waiting: boolean }>(
            `SELECT EXISTS (SELECT 1 FROM pg_stat_activity
             WHERE datname = current_database() AND application_name = $1
             AND wait_event_type = 'Lock' AND query LIKE $2) AS waiting`,
            [config.application_name, 'INSERT INTO payment_provider.charges%'],
          );
          waiting = result.rows[0]?.waiting === true;
          if (!waiting) await delay(20);
        }
        assert.equal(
          waiting,
          true,
          'The INSERT should be blocked by the independent transaction.',
        );
        assert.equal(
          finished,
          false,
          'No successful response is allowed before persistence completes.',
        );
        await reader.query('COMMIT');
        transactionOpen = false;
        const response = await pending;
        assert.equal(response.status, 201);
        const charge = parseCharge(response.body);
        const result = await reader.query<{ id: string }>(
          'SELECT id FROM payment_provider.charges WHERE id = $1::uuid',
          [charge.id],
        );
        assert.equal(result.rows[0]?.id, charge.id);
      } finally {
        if (transactionOpen) await reader.query('ROLLBACK');
        await pending.catch(() => undefined);
      }
    } finally {
      await reader.end();
    }
  });

  void it('returns an error instead of 201 when actual database persistence fails', async () => {
    const beforeCount = await countCharges();
    await database.query(
      `CREATE FUNCTION payment_provider.reject_test_charge() RETURNS trigger
      LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Simulated persistence failure'; END; $$`,
      [],
    );
    try {
      await database.query(
        `CREATE TRIGGER reject_test_charge BEFORE INSERT ON payment_provider.charges
        FOR EACH ROW EXECUTE FUNCTION payment_provider.reject_test_charge()`,
        [],
      );
      await request(server)
        .post('/charges')
        .send({
          merchantReference: randomUUID(),
          amountCents: 100,
          currency: 'BRL',
        })
        .expect(500);
      assert.equal(await countCharges(), beforeCount);
    } finally {
      await database.query(
        'DROP TRIGGER IF EXISTS reject_test_charge ON payment_provider.charges',
        [],
      );
      await database.query(
        'DROP FUNCTION payment_provider.reject_test_charge()',
        [],
      );
    }
  });

  for (const amountCents of [1, 2_147_483_647]) {
    void it(
      'accepts the inclusive amount boundary ' + amountCents,
      async () => {
        const charge = await create(randomUUID(), amountCents);
        assert.equal(charge.amountCents, amountCents);
        await request(server)
          .get('/charges/' + charge.id)
          .expect(200)
          .expect(charge);
      },
    );
  }

  void it('creates independent charges for repeated and concurrent identical requests', async () => {
    const merchantReference = randomUUID();
    const charges = await Promise.all(
      Array.from({ length: 5 }, () => create(merchantReference, 100)),
    );
    assert.equal(new Set(charges.map((charge) => charge.id)).size, 5);
    const response = await request(server)
      .get('/charges')
      .query({ merchantReference })
      .expect(200);
    const body: unknown = response.body;
    assert.ok(Array.isArray(body));
    const listed = body.map((value: unknown) => parseCharge(value));
    assert.equal(listed.length, 5);
    assert.deepEqual(
      new Set(listed.map((charge) => charge.id)),
      new Set(charges.map((charge) => charge.id)),
    );
  });

  void it('lists only charges for the required reference and returns [] for an unknown reference', async () => {
    const referenceA = randomUUID();
    const referenceB = randomUUID();
    const a1 = await create(referenceA, 100);
    const b1 = await create(referenceB, 200);
    const a2 = await create(referenceA, 300);
    const a = await request(server)
      .get('/charges')
      .query({ merchantReference: referenceA.toUpperCase() })
      .expect(200);
    assert.deepEqual(a.body as unknown, [a1, a2]);
    await request(server)
      .get('/charges')
      .query({ merchantReference: referenceB })
      .expect(200)
      .expect([b1]);
    await request(server)
      .get('/charges')
      .query({ merchantReference: randomUUID() })
      .expect(200)
      .expect([]);
  });

  void it('orders by creation time and uses UUID as a deterministic tiebreaker', async () => {
    const merchantReference = randomUUID();
    const low = '11111111-1111-4111-8111-111111111111';
    const high = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
    const older = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
    for (const [id, timestamp] of [
      [high, '2026-01-02T00:00:00Z'],
      [low, '2026-01-02T00:00:00Z'],
      [older, '2026-01-01T00:00:00Z'],
    ]) {
      await database.query(
        `INSERT INTO payment_provider.charges (id, merchant_reference, amount_cents, currency, created_at)
        VALUES ($1::uuid, $2::uuid, $3, $4, $5::timestamptz)`,
        [id, merchantReference, 100, 'BRL', timestamp],
      );
    }
    const first = await request(server)
      .get('/charges')
      .query({ merchantReference })
      .expect(200);
    const body: unknown = first.body;
    assert.ok(Array.isArray(body));
    assert.deepEqual(
      body.map((value: unknown) => parseCharge(value).id),
      [older, low, high],
    );
    await request(server)
      .get('/charges')
      .query({ merchantReference })
      .expect(200)
      .expect(body);
  });

  const valid = {
    merchantReference: randomUUID(),
    amountCents: 100,
    currency: 'BRL',
  };
  const invalidBodies: Array<{ label: string; body: unknown }> = [
    { label: 'missing fields', body: {} },
    { label: 'missing reference', body: { amountCents: 100, currency: 'BRL' } },
    {
      label: 'missing amount',
      body: { merchantReference: valid.merchantReference, currency: 'BRL' },
    },
    {
      label: 'missing currency',
      body: { merchantReference: valid.merchantReference, amountCents: 100 },
    },
    { label: 'root array', body: [valid] },
    { label: 'root null', body: null },
    { label: 'root number', body: 100 },
    { label: 'root string', body: '100' },
    ...[
      '1',
      '2147483647',
      0,
      -1,
      0.5,
      1.5,
      2_147_483_648,
      Number.MAX_SAFE_INTEGER,
      null,
      true,
      [],
      {},
    ].map((amountCents) => ({
      label: 'amount ' + JSON.stringify(amountCents),
      body: { ...valid, amountCents },
    })),
    ...['USD', 'brl', '', null, 986, ['BRL'], {}].map((currency) => ({
      label: 'currency ' + JSON.stringify(currency),
      body: { ...valid, currency },
    })),
    ...[
      'not-a-uuid',
      valid.merchantReference.replaceAll('-', ''),
      null,
      123,
      [],
      {},
    ].map((merchantReference) => ({
      label: 'reference ' + JSON.stringify(merchantReference),
      body: { ...valid, merchantReference },
    })),
    ...['extra', 'id', 'status', 'createdAt', 'constructor', '__proto__'].map(
      (field) => ({
        label: 'unknown/server property ' + field,
        body: { ...valid, [field]: 'forged' },
      }),
    ),
  ];
  for (const { label, body } of invalidBodies) {
    void it('returns 400 and persists nothing for ' + label, async () => {
      const beforeCount = await countCharges();
      await request(server)
        .post('/charges')
        .set('Content-Type', 'application/json')
        .send(JSON.stringify(body))
        .expect(400);
      assert.equal(await countCharges(), beforeCount);
    });
  }
  void it('rejects a missing body or malformed JSON without creating a charge', async () => {
    const beforeCount = await countCharges();
    await request(server).post('/charges').expect(400);
    await request(server)
      .post('/charges')
      .set('Content-Type', 'application/json')
      .send('{"amountCents":')
      .expect(400);
    assert.equal(await countCharges(), beforeCount);
  });

  const invalidQueries = [
    '',
    '?merchantReference=',
    '?merchantReference=not-a-uuid',
    '?merchantReference=123',
    '?merchantReference=' + encodeURIComponent("x' OR 1=1 --"),
    '?merchantReference=' +
      valid.merchantReference +
      '&merchantReference=' +
      valid.merchantReference,
    '?merchantReference[]=' + valid.merchantReference,
    ...['extra', 'status', 'constructor', '__proto__'].map(
      (field) =>
        '?merchantReference=' +
        valid.merchantReference +
        '&' +
        field +
        '=forged',
    ),
  ];
  for (const query of invalidQueries) {
    void it(
      'rejects an invalid or unknown list query: ' +
        (query || '(missing reference)'),
      async () => {
        await request(server)
          .get('/charges' + query)
          .expect(400);
      },
    );
  }
  for (const id of [
    'not-a-uuid',
    randomUUID().replaceAll('-', ''),
    randomUUID() + 'x',
    "x' OR 1=1 --",
  ]) {
    void it('returns 400 for a malformed charge UUID: ' + id, async () => {
      await request(server)
        .get('/charges/' + encodeURIComponent(id))
        .expect(400);
    });
  }
  void it('returns 404 for a valid charge UUID that does not exist', async () => {
    await request(server)
      .get('/charges/' + randomUUID())
      .expect(404);
  });

  const insert = `INSERT INTO payment_provider.charges (id, merchant_reference, amount_cents, currency, status, created_at)
    VALUES ($1, $2, $3, $4, $5, $6)`;
  const invalidRows: Array<{
    label: string;
    index: number;
    value: unknown;
    code: string;
  }> = [
    { label: 'null ID', index: 0, value: null, code: '23502' },
    { label: 'invalid ID', index: 0, value: 'invalid', code: '22P02' },
    { label: 'null reference', index: 1, value: null, code: '23502' },
    { label: 'invalid reference', index: 1, value: 'invalid', code: '22P02' },
    { label: 'null amount', index: 2, value: null, code: '23502' },
    { label: 'zero amount', index: 2, value: 0, code: '23514' },
    { label: 'negative amount', index: 2, value: -1, code: '23514' },
    { label: 'fractional amount', index: 2, value: 1.5, code: '22P02' },
    { label: 'amount overflow', index: 2, value: 2_147_483_648, code: '22003' },
    { label: 'null currency', index: 3, value: null, code: '23502' },
    { label: 'non-BRL currency', index: 3, value: 'USD', code: '23514' },
    { label: 'null status', index: 4, value: null, code: '23502' },
    {
      label: 'non-SUCCEEDED status',
      index: 4,
      value: 'PENDING',
      code: '23514',
    },
    { label: 'null creation time', index: 5, value: null, code: '23502' },
  ];
  for (const { label, index, value, code } of invalidRows) {
    void it(
      'PostgreSQL rejects ' + label + ' when HTTP validation is bypassed',
      async () => {
        const values: unknown[] = [
          randomUUID(),
          randomUUID(),
          100,
          'BRL',
          'SUCCEEDED',
          new Date(),
        ];
        values[index] = value;
        await assert.rejects(database.query(insert, values), { code });
      },
    );
  }

  void it('has native types, no merchant reference FK/uniqueness, and works without any orders schema', async () => {
    const types = await database.query<{
      column_name: string;
      data_type: string;
    }>(
      'SELECT column_name, data_type FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2 ORDER BY ordinal_position',
      ['payment_provider', 'charges'],
    );
    assert.deepEqual(types.rows, [
      { column_name: 'id', data_type: 'uuid' },
      { column_name: 'merchant_reference', data_type: 'uuid' },
      { column_name: 'amount_cents', data_type: 'integer' },
      { column_name: 'currency', data_type: 'text' },
      { column_name: 'status', data_type: 'text' },
      { column_name: 'created_at', data_type: 'timestamp with time zone' },
    ]);
    const constraints = await database.query<{
      foreignKeys: number;
      uniqueReferences: number;
      ordersSchema: boolean;
    }>(
      `SELECT (SELECT count(*)::int FROM pg_constraint WHERE conrelid = $1::regclass AND contype = 'f') AS "foreignKeys",
       (SELECT count(*)::int FROM pg_index i JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
        WHERE i.indrelid = $1::regclass AND i.indisunique AND a.attname = $2) AS "uniqueReferences",
       EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = $3) AS "ordersSchema"`,
      ['payment_provider.charges', 'merchant_reference', 'checkout'],
    );
    assert.deepEqual(constraints.rows, [
      { foreignKeys: 0, uniqueReferences: 0, ordersSchema: false },
    ]);
    await create(randomUUID());
  });
});
