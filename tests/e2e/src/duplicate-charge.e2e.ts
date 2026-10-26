import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { after, before, describe, it } from 'node:test';
import type { RunReport } from '@faultlab/core';
import { command } from './command';
import { fixture, http, order, verifyDatabase } from './fixture';
import { waitForService } from './readiness';
import { randomUUID } from 'node:crypto';
import { localPort } from './safety';

const {
  project,
  checkoutUrl: initialCheckoutUrl,
  providerUrl,
  artifactDirectory,
  db,
} = fixture();
let checkoutUrl = initialCheckoutUrl;
const proxyUrl = process.env['E2E_PROXY_URL'] ?? '';
assert.match(proxyUrl, /^http:\/\/127\.0\.0\.1:\d+$/);
const repository = resolve(__dirname, '../../..');
function record(value: unknown): Record<string, unknown> {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value));
  return value as Record<string, unknown>;
}

void describe('Duplicate-charge CLI against real HTTP services and PostgreSQL', () => {
  before(async () => {
    await verifyDatabase(db);
  });
  after(async () => {
    await db.end();
  });
  void it('reuses the stored operation key after a real checkout process restart and recovers the lost response', async () => {
    const created = order(
      (
        await http(checkoutUrl, '/orders', {
          method: 'POST',
          body: { amountCents: 12990, currency: 'BRL' },
          status: 201,
        })
      ).body,
    );
    await http(proxyUrl, '/__faults/drop-next-charge-response', {
      method: 'POST',
    });
    const firstCorrelation = randomUUID();
    const failed = await http(checkoutUrl, `/orders/${created.id}/pay`, {
      method: 'POST',
      correlationId: firstCorrelation,
      status: 503,
    });
    assert.equal(record(failed.body)['code'], 'PAYMENT_PROVIDER_UNAVAILABLE');
    const pending = order(
      (await http(checkoutUrl, '/orders/' + created.id)).body,
    );
    assert.equal(pending.status, 'PENDING_PAYMENT');
    const before = await db.query<{ id: string; key: string }>(
      'SELECT id, idempotency_key AS key FROM payment_provider.charges WHERE merchant_reference = $1::uuid',
      [created.id],
    );
    assert.equal(before.rows.length, 1);
    assert.match(before.rows[0]?.key ?? '', /^[0-9a-f-]{36}$/);
    assert.notEqual(before.rows[0]?.key, firstCorrelation);
    const compose = (args: string[]): Promise<string> =>
      command(
        'docker',
        [
          'compose',
          '--env-file',
          resolve(repository, 'tests/e2e/.env.example'),
          '-f',
          resolve(repository, 'tests/e2e/compose.yaml'),
          '-f',
          resolve(repository, 'tests/e2e/compose.duplicate-charge.yaml'),
          '-p',
          project,
          ...args,
        ],
        { cwd: repository, capture: true, timeoutMs: 30000 },
      );
    const container = await compose(['ps', '-q', 'checkout']);
    const startedAt = await command(
      'docker',
      ['inspect', '--format', '{{.State.StartedAt}}', container],
      { cwd: repository, capture: true },
    );
    await compose(['restart', '--timeout', '10', 'checkout']);
    const restartedAt = await command(
      'docker',
      ['inspect', '--format', '{{.State.StartedAt}}', container],
      { cwd: repository, capture: true },
    );
    assert.notEqual(
      startedAt,
      restartedAt,
      'Checkout must run in a new process instance.',
    );
    // Docker can allocate another ephemeral host port when the container restarts.
    const previousUrl = checkoutUrl;
    checkoutUrl =
      'http://127.0.0.1:' +
      localPort(await compose(['port', 'checkout', '3001']));
    console.log(
      JSON.stringify({
        event: 'checkout.restarted',
        publishedPortChanged: checkoutUrl !== previousUrl,
      }),
    );
    await waitForService(checkoutUrl, 'checkout', new AbortController().signal);
    const paid = order(
      (
        await http(checkoutUrl, `/orders/${created.id}/pay`, {
          method: 'POST',
          correlationId: randomUUID(),
        })
      ).body,
    );
    assert.equal(paid.status, 'PAID');
    assert.equal(paid.providerChargeId, before.rows[0]?.id);
    const after = await db.query<{ id: string; key: string }>(
      'SELECT id, idempotency_key AS key FROM payment_provider.charges WHERE merchant_reference = $1::uuid',
      [created.id],
    );
    assert.deepEqual(after.rows, before.rows);
  });

  void it('keeps concurrent checkout payment requests on one persisted provider charge', async () => {
    const created = order(
      (
        await http(checkoutUrl, '/orders', {
          method: 'POST',
          body: { amountCents: 12990, currency: 'BRL' },
          status: 201,
        })
      ).body,
    );
    const responses = await Promise.all(
      Array.from({ length: 8 }, () =>
        http(checkoutUrl, `/orders/${created.id}/pay`, {
          method: 'POST',
          correlationId: randomUUID(),
        }),
      ),
    );
    const orders = responses.map((response) => order(response.body));
    assert.ok(orders.every((value) => value.status === 'PAID'));
    assert.equal(
      new Set(orders.map((value) => value.providerChargeId)).size,
      1,
    );
    const stored = await db.query<{ id: string; key: string }>(
      'SELECT id, idempotency_key AS key FROM payment_provider.charges WHERE merchant_reference = $1::uuid',
      [created.id],
    );
    assert.equal(stored.rows.length, 1);
    assert.equal(stored.rows[0]?.id, orders[0]?.providerChargeId);
    assert.match(stored.rows[0]?.key ?? '', /^[0-9a-f-]{36}$/);
  });
  void it('returns exit 0 for the unchanged scenario with persistent idempotency and independently verifies persisted evidence for two unique runs', async () => {
    const orderIds = new Set<string>();
    const runIds = new Set<string>();
    for (const iteration of [1, 2]) {
      const directory = resolve(
        artifactDirectory,
        'scenario-reports',
        String(iteration),
      );
      const output = await command(
        process.execPath,
        [resolve(repository, 'packages/cli/dist/main.js'), 'duplicate-charge'],
        {
          cwd: repository,
          capture: true,
          timeoutMs: 60000,
          allowedExitCodes: [0],
          env: {
            ...process.env,
            FAULTLAB_CHECKOUT_URL: checkoutUrl,
            FAULTLAB_PROVIDER_URL: providerUrl,
            FAULTLAB_PROXY_URL: proxyUrl,
            FAULTLAB_REPORT_DIR: directory,
            FAULTLAB_READY_TIMEOUT_MS: '10000',
            FAULTLAB_REQUEST_TIMEOUT_MS: '5000',
          },
        },
      );
      assert.match(output, /Conclusion: SATISFIED/);
      const files = await readdir(directory);
      assert.equal(files.length, 1);
      const report = JSON.parse(
        await readFile(resolve(directory, files[0] ?? ''), 'utf8'),
      ) as RunReport;
      assert.equal(report.schemaVersion, 1);
      assert.equal(report.outcome, 'satisfied');
      assert.equal(report.rule.status, 'satisfied');
      assert.equal(report.timeline.length, 9);
      assert.ok(report.timeline.every((step) => step.status === 'passed'));
      const orderId = record(report.evidence['ids'])['orderId'];
      assert.equal(typeof orderId, 'string');
      assert.ok(!orderIds.has(String(orderId)));
      assert.ok(!runIds.has(report.runId));
      orderIds.add(String(orderId));
      runIds.add(report.runId);
      const first = record(report.evidence['afterLostResponse']);
      const final = record(report.evidence['afterSecondPayment']);
      assert.equal(record(first['order'])['status'], 'PENDING_PAYMENT');
      assert.equal(record(first['order'])['providerChargeId'], null);
      assert.ok(
        Array.isArray(first['charges']) && first['charges'].length === 1,
      );
      assert.equal(record(final['order'])['status'], 'PAID');
      assert.ok(Array.isArray(final['charges']));
      const observed = final['charges'] as unknown[];
      assert.deepEqual(
        observed,
        first['charges'],
        'Retry must recover the original charge, including its response data.',
      );
      const rows = await db.query<{
        id: string;
        merchantReference: string;
        amountCents: number;
        currency: string;
        status: string;
        createdAt: Date;
      }>(
        'SELECT id, merchant_reference AS "merchantReference", amount_cents AS "amountCents", currency, status, created_at AS "createdAt" FROM payment_provider.charges WHERE merchant_reference = $1::uuid ORDER BY created_at, id',
        [orderId],
      );
      assert.equal(
        rows.rows.length,
        1,
        'The corrected services must retain exactly one charge after the lost response.',
      );
      assert.equal(report.rule.actual, rows.rows.length);
      assert.deepEqual(
        observed,
        rows.rows.map((row) => ({
          ...row,
          createdAt: row.createdAt.toISOString(),
        })),
      );
      assert.ok(
        rows.rows.some(
          (row) => row.id === record(final['order'])['providerChargeId'],
        ),
      );
      assert.equal(report.failure, undefined);
    }
    assert.equal(orderIds.size, 2);
    assert.equal(runIds.size, 2);
  });
});
