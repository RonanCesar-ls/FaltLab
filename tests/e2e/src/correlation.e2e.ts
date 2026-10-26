import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { before, describe, it } from 'node:test';
import { fixture } from './fixture';

const { artifactDirectory } = fixture();
let receipts: Array<{ kind: string; correlationId: string }>;
let logs: Array<Record<string, unknown>>;

void describe('Cross-service correlation in real application JSON logs', () => {
  before(async () => {
    const receiptData: unknown = JSON.parse(
      await readFile(resolve(artifactDirectory, 'receipts.json'), 'utf8'),
    );
    assert.ok(Array.isArray(receiptData));
    receipts = receiptData as typeof receipts;
    logs = (await readFile(resolve(artifactDirectory, 'services.log'), 'utf8'))
      .trim()
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => {
        const value: unknown = JSON.parse(line);
        assert.ok(value && typeof value === 'object');
        return value as Record<string, unknown>;
      });
  });
  for (const kind of ['supplied', 'generated']) {
    void it(
      'propagates the ' +
        kind +
        ' correlation ID into both services start/end logs',
      () => {
        const receipt = receipts.find((value) => value.kind === kind);
        assert.ok(receipt);
        for (const [service, route, status] of [
          ['checkout', '/orders/:id/pay', 200],
          ['payment-provider', '/charges', 201],
        ] as const) {
          const entries: Array<Record<string, unknown>> = logs.filter(
            (value) =>
              value['service'] === service &&
              value['correlationId'] === receipt.correlationId,
          );
          assert.equal(
            entries.filter(
              (value) =>
                value['event'] === 'request.started' &&
                value['route'] === route,
            ).length,
            1,
          );
          assert.equal(
            entries.filter(
              (value) =>
                value['event'] === 'request.completed' &&
                value['statusCode'] === status,
            ).length,
            1,
          );
        }
      },
    );
  }
  void it('confirms the sequential repeat never reached the provider', () => {
    const receipt = receipts.find((value) => value.kind === 'sequential');
    assert.ok(receipt);
    assert.ok(
      logs.some(
        (value) =>
          value['service'] === 'checkout' &&
          value['correlationId'] === receipt.correlationId,
      ),
    );
    assert.equal(
      logs.filter(
        (value) =>
          value['service'] === 'payment-provider' &&
          value['correlationId'] === receipt.correlationId,
      ).length,
      0,
    );
  });
});
