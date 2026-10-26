import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { Client } from 'pg';
import { assertTestProject } from './safety';

export interface Order {
  id: string;
  amountCents: number;
  currency: 'BRL';
  status: 'PENDING_PAYMENT' | 'PAID';
  providerChargeId: string | null;
  createdAt: string;
  updatedAt: string;
}

export function fixture(): {
  project: string;
  checkoutUrl: string;
  providerUrl: string;
  artifactDirectory: string;
  db: Client;
} {
  const project = process.env['E2E_PROJECT'] ?? '';
  assertTestProject(project);
  const checkoutUrl = process.env['E2E_CHECKOUT_URL'] ?? '';
  const providerUrl = process.env['E2E_PROVIDER_URL'] ?? '';
  for (const url of [checkoutUrl, providerUrl])
    assert.match(url, /^http:\/\/127\.0\.0\.1:\d+$/);
  const port = Number(process.env['E2E_PROVIDER_PGPORT']);
  assert.ok(Number.isInteger(port) && port > 0 && port <= 65535);
  return {
    project,
    checkoutUrl,
    providerUrl,
    artifactDirectory: resolve(__dirname, '../artifacts', project),
    db: new Client({
      host: '127.0.0.1',
      port,
      database: 'faultlab_e2e_payment_provider',
      user: 'e2e_payment_provider',
      password: 'e2e_payment_provider_only',
      connectionTimeoutMillis: 2000,
      query_timeout: 3000,
      statement_timeout: 3000,
      application_name: 'faultlab-e2e-verifier',
    }),
  };
}

export async function verifyDatabase(db: Client): Promise<void> {
  await db.connect();
  const identity = await db.query<{ database: string; user: string }>(
    'SELECT current_database() AS database, current_user AS user',
  );
  assert.deepEqual(identity.rows, [
    { database: 'faultlab_e2e_payment_provider', user: 'e2e_payment_provider' },
  ]);
}

export async function http(
  url: string,
  path: string,
  options: {
    method?: string;
    body?: unknown;
    correlationId?: string;
    status?: number;
  } = {},
): Promise<{ body: unknown; correlationId: string }> {
  const response = await fetch(url + path, {
    method: options.method ?? 'GET',
    headers: {
      connection: 'close',
      ...(options.body === undefined
        ? {}
        : { 'content-type': 'application/json' }),
      ...(options.correlationId === undefined
        ? {}
        : { 'x-correlation-id': options.correlationId }),
    },
    ...(options.body === undefined
      ? {}
      : { body: JSON.stringify(options.body) }),
    signal: AbortSignal.timeout(5000),
  });
  const body: unknown = await response.json();
  assert.equal(response.status, options.status ?? 200, JSON.stringify(body));
  const correlationId = response.headers.get('x-correlation-id');
  assert.ok(correlationId);
  if (options.correlationId) assert.equal(correlationId, options.correlationId);
  return { body, correlationId };
}

export function order(value: unknown): Order {
  assert.ok(value && typeof value === 'object');
  const body = value as Record<string, unknown>;
  assert.equal(typeof body['id'], 'string');
  assert.equal(typeof body['amountCents'], 'number');
  assert.equal(body['currency'], 'BRL');
  assert.ok(body['status'] === 'PENDING_PAYMENT' || body['status'] === 'PAID');
  assert.ok(
    body['providerChargeId'] === null ||
      typeof body['providerChargeId'] === 'string',
  );
  assert.equal(typeof body['createdAt'], 'string');
  assert.equal(typeof body['updatedAt'], 'string');
  return value as Order;
}

export async function chargeCount(
  db: Client,
  reference: string,
): Promise<number> {
  const result = await db.query<{ count: number }>(
    'SELECT count(*)::int AS count FROM payment_provider.charges WHERE merchant_reference = $1::uuid',
    [reference],
  );
  assert.ok(result.rows[0]);
  return result.rows[0].count;
}
