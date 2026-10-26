import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { chargeCount, fixture, http, order, verifyDatabase } from './fixture';

const { project, checkoutUrl, db } = fixture();

void describe('Real provider process unavailable, provider PostgreSQL still running', () => {
  before(async () => {
    await verifyDatabase(db);
  });
  after(async () => {
    await db.end();
  });

  void it('returns a controlled error and preserves the pending order without a charge', async () => {
    const created = order(
      (
        await http(checkoutUrl, '/orders', {
          method: 'POST',
          body: { amountCents: 500, currency: 'BRL' },
          status: 201,
        })
      ).body,
    );
    const correlationId = project + '.outage';
    const response = await fetch(checkoutUrl + `/orders/${created.id}/pay`, {
      method: 'POST',
      headers: { 'x-correlation-id': correlationId, connection: 'close' },
      signal: AbortSignal.timeout(5000),
    });
    assert.ok([503, 504].includes(response.status));
    const body: unknown = await response.json();
    assert.ok(body && typeof body === 'object');
    const error = body as Record<string, unknown>;
    assert.deepEqual(Object.keys(error).sort(), [
      'code',
      'correlationId',
      'message',
      'statusCode',
    ]);
    assert.equal(error['statusCode'], response.status);
    assert.equal(
      error['code'],
      response.status === 503
        ? 'PAYMENT_PROVIDER_UNAVAILABLE'
        : 'PAYMENT_PROVIDER_TIMEOUT',
    );
    assert.equal(error['correlationId'], correlationId);
    assert.equal(response.headers.get('x-correlation-id'), correlationId);
    assert.deepEqual(
      order((await http(checkoutUrl, '/orders/' + created.id)).body),
      created,
    );
    assert.equal(await chargeCount(db, created.id), 0);
    await http(checkoutUrl, '/health/ready');
  });
});
