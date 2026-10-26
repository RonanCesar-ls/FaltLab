import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { chargeCount, fixture, http, order, verifyDatabase } from './fixture';

const { project, checkoutUrl, artifactDirectory, db } = fixture();
const receipts: { kind: string; correlationId: string }[] = [];

void describe('Real checkout/provider HTTP payment and independent provider SQL verification', () => {
  before(async () => {
    await verifyDatabase(db);
  });
  after(async () => {
    await db.end();
    await writeFile(
      resolve(artifactDirectory, 'receipts.json'),
      JSON.stringify(receipts),
    );
  });

  void it('creates, pays, rereads, and proves exactly one matching provider charge before and after a sequential repeat', async () => {
    const created = order(
      (
        await http(checkoutUrl, '/orders', {
          method: 'POST',
          body: { amountCents: 12990, currency: 'BRL' },
          status: 201,
        })
      ).body,
    );
    assert.equal(created.status, 'PENDING_PAYMENT');
    assert.equal(created.providerChargeId, null);
    assert.equal(await chargeCount(db, created.id), 0);
    const correlationId = project + '.payment';
    const paid = order(
      (
        await http(checkoutUrl, `/orders/${created.id}/pay`, {
          method: 'POST',
          correlationId,
        })
      ).body,
    );
    assert.equal(paid.status, 'PAID');
    assert.ok(paid.providerChargeId);
    const fetched = order(
      (await http(checkoutUrl, '/orders/' + created.id)).body,
    );
    assert.deepEqual(fetched, paid);
    assert.equal(await chargeCount(db, created.id), 1);
    const charges = await db.query<{
      id: string;
      merchant_reference: string;
      amount_cents: number;
      currency: string;
      status: string;
    }>(
      'SELECT id, merchant_reference, amount_cents, currency, status FROM payment_provider.charges WHERE merchant_reference = $1::uuid',
      [created.id],
    );
    assert.deepEqual(charges.rows, [
      {
        id: paid.providerChargeId,
        merchant_reference: created.id,
        amount_cents: created.amountCents,
        currency: created.currency,
        status: 'SUCCEEDED',
      },
    ]);
    const repeatedId = project + '.repeat';
    const repeated = order(
      (
        await http(checkoutUrl, `/orders/${created.id}/pay`, {
          method: 'POST',
          body: {},
          correlationId: repeatedId,
        })
      ).body,
    );
    assert.deepEqual(repeated, paid);
    assert.equal(await chargeCount(db, created.id), 1);
    const after = await db.query<{ id: string }>(
      'SELECT id FROM payment_provider.charges WHERE merchant_reference = $1::uuid',
      [created.id],
    );
    assert.deepEqual(after.rows, [{ id: paid.providerChargeId }]);
    receipts.push(
      { kind: 'supplied', correlationId },
      { kind: 'sequential', correlationId: repeatedId },
    );
  });

  void it('generates a UUID for an unlabelled payment request and persists its successful charge', async () => {
    const created = order(
      (
        await http(checkoutUrl, '/orders', {
          method: 'POST',
          body: { amountCents: 1, currency: 'BRL' },
          status: 201,
        })
      ).body,
    );
    const response = await http(checkoutUrl, `/orders/${created.id}/pay`, {
      method: 'POST',
    });
    const paid = order(response.body);
    assert.equal(paid.status, 'PAID');
    assert.match(
      response.correlationId,
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    assert.equal(await chargeCount(db, created.id), 1);
    receipts.push({ kind: 'generated', correlationId: response.correlationId });
  });
});
