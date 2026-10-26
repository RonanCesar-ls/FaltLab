import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { after, before, describe, it } from 'node:test';
import type { RunReport } from '@faultlab/core';
import { command } from './command';
import { fixture, verifyDatabase } from './fixture';

const { checkoutUrl, providerUrl, artifactDirectory, db } = fixture();
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
  void it('accepts exit 1 as the expected detected violation and independently verifies persisted evidence for two unique runs', async () => {
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
          allowedExitCodes: [1],
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
      assert.match(output, /Conclusion: VIOLATED/);
      const files = await readdir(directory);
      assert.equal(files.length, 1);
      const report = JSON.parse(
        await readFile(resolve(directory, files[0] ?? ''), 'utf8'),
      ) as RunReport;
      assert.equal(report.schemaVersion, 1);
      assert.equal(report.outcome, 'violated');
      assert.equal(report.rule.status, 'violated');
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
        2,
        'The current services should expose the duplicate-charge behavior.',
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
