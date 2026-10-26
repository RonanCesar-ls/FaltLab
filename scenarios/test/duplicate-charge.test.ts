import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';
import { exitCode } from '@faultlab/core';
import { runDuplicateCharge } from '../src';

function controlledHttp(
  mode:
    | 'duplicate'
    | 'deduplicate'
    | 'bypass'
    | 'no-charge'
    | 'second-error' = 'duplicate',
) {
  const timestamp = new Date().toISOString();
  let current:
    | {
        id: string;
        amountCents: number;
        currency: string;
        status: string;
        providerChargeId: string | null;
        createdAt: string;
        updatedAt: string;
      }
    | undefined;
  const ledger: {
    id: string;
    merchantReference: string;
    amountCents: number;
    currency: string;
    status: string;
    createdAt: string;
    internal: string;
  }[] = [];
  let armed = false;
  let payments = 0;
  const http: typeof fetch = (input, init) => {
    const url = new URL(
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.href
          : input.url,
    );
    const id = new Headers(init?.headers).get('x-correlation-id') ?? '';
    const respond = (status: number, body: unknown): Promise<Response> =>
      Promise.resolve(
        new Response(JSON.stringify(body), {
          status,
          headers: { 'x-correlation-id': id },
        }),
      );
    const error = (): Promise<Response> =>
      respond(503, {
        statusCode: 503,
        code: 'PAYMENT_PROVIDER_UNAVAILABLE',
        message: 'password=private-secret',
        correlationId: id,
        sql: 'private-secret',
      });
    if (url.pathname.endsWith('/health/ready'))
      return respond(200, {
        service:
          url.hostname === 'checkout.test' ? 'checkout' : 'payment-provider',
        status: 'ok',
        database: 'ok',
      });
    if (url.pathname === '/health')
      return respond(200, { service: 'fault-proxy', status: 'ok' });
    if (url.pathname === '/__faults/drop-next-charge-response') {
      armed = true;
      return respond(200, { armed: true, internal: 'private-secret' });
    }
    if (url.pathname === '/orders' && init?.method === 'POST') {
      assert.ok(typeof init.body === 'string');
      assert.deepEqual(JSON.parse(init.body), {
        amountCents: 12990,
        currency: 'BRL',
      });
      current = {
        id: randomUUID(),
        amountCents: 12990,
        currency: 'BRL',
        status: 'PENDING_PAYMENT',
        providerChargeId: null,
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      return respond(201, { ...current, internal: 'private-secret' });
    }
    if (!current) throw new Error('No controlled order');
    if (url.pathname === `/orders/${current.id}/pay`) {
      payments++;
      if (
        mode !== 'no-charge' &&
        (ledger.length === 0 || mode !== 'deduplicate')
      )
        ledger.push({
          id: randomUUID(),
          merchantReference: current.id,
          amountCents: current.amountCents,
          currency: 'BRL',
          status: 'SUCCEEDED',
          createdAt: timestamp,
          internal: 'private-secret',
        });
      if (armed && mode !== 'bypass') {
        armed = false;
        return error();
      }
      if (mode === 'second-error') return error();
      current = {
        ...current,
        status: 'PAID',
        providerChargeId: ledger.at(-1)?.id ?? null,
      };
      return respond(200, current);
    }
    if (url.pathname === `/orders/${current.id}`) return respond(200, current);
    if (url.pathname === '/charges') {
      assert.equal(url.searchParams.get('merchantReference'), current.id);
      return respond(200, ledger);
    }
    throw new Error('Unexpected controlled request');
  };
  return { http, ledger, payments: () => payments };
}
const env = {
  FAULTLAB_CHECKOUT_URL: 'http://checkout.test',
  FAULTLAB_PROVIDER_URL: 'http://provider.test',
  FAULTLAB_PROXY_URL: 'http://proxy.test',
  FAULTLAB_READY_TIMEOUT_MS: '100',
};

void describe('Duplicate-charge scenario outcomes and sanitized HTTP evidence', () => {
  void it('reports a violation from two distinct provider records, not from the order status', async () => {
    const service = controlledHttp();
    const report = await runDuplicateCharge(env, { http: service.http });
    assert.equal(report.outcome, 'violated');
    assert.equal(report.rule.actual, service.ledger.length);
    assert.equal(report.rule.actual, 2);
    assert.equal(report.timeline.length, 9);
    assert.equal(service.payments(), 2);
    assert.equal(exitCode(report.outcome), 1);
    assert.ok(!JSON.stringify(report).includes('private-secret'));
    assert.equal(report.failure, undefined);
  });
  void it('records a satisfied rule when the second payment returns the same single persisted charge', async () => {
    const service = controlledHttp('deduplicate');
    const report = await runDuplicateCharge(env, { http: service.http });
    assert.equal(report.outcome, 'satisfied');
    assert.equal(report.rule.actual, 1);
    assert.equal(exitCode(report.outcome), 0);
    assert.equal(service.payments(), 2);
  });
  void it('retains a proven violation even when the second checkout response is an error and the order remains pending', async () => {
    const service = controlledHttp('second-error');
    const report = await runDuplicateCharge(env, { http: service.http });
    assert.equal(report.outcome, 'violated');
    assert.equal(report.rule.actual, 2);
  });
  void it('treats a bypassed proxy as inconclusive preparation and records the observed paid order and single charge', async () => {
    const service = controlledHttp('bypass');
    const report = await runDuplicateCharge(env, { http: service.http });
    assert.equal(report.outcome, 'inconclusive');
    assert.equal(report.failure?.code, 'LOST_RESPONSE_NOT_OBSERVED');
    assert.equal(report.rule.status, 'not_evaluated');
    assert.equal(service.ledger.length, 1);
    assert.equal(service.payments(), 1);
    assert.ok(report.evidence['afterLostResponse']);
  });
  void it('does not call zero charges a satisfied rule when the experiment was not prepared', async () => {
    const service = controlledHttp('no-charge');
    const report = await runDuplicateCharge(env, { http: service.http });
    assert.equal(report.outcome, 'inconclusive');
    assert.equal(report.failure?.code, 'UNEXPECTED_INITIAL_CHARGE_COUNT');
    assert.equal(service.payments(), 1);
    assert.equal(service.ledger.length, 0);
  });
  void it('bounds unavailable-service readiness and never starts a payment', async () => {
    const report = await runDuplicateCharge(
      { ...env, FAULTLAB_READY_TIMEOUT_MS: '15' },
      { http: () => Promise.reject(new Error('password=private-secret')) },
    );
    assert.equal(report.outcome, 'inconclusive');
    assert.equal(report.failure?.code, 'READINESS_DEADLINE_EXCEEDED');
    assert.equal(report.timeline.length, 1);
    assert.ok(!JSON.stringify(report).includes('private-secret'));
  });
  void it('rejects credential-bearing configuration without storing it', async () => {
    const report = await runDuplicateCharge({
      FAULTLAB_CHECKOUT_URL: 'http://user:private-secret@localhost:3001',
    });
    assert.equal(report.outcome, 'inconclusive');
    assert.equal(report.failure?.code, 'INVALID_CONFIGURATION');
    assert.ok(!JSON.stringify(report).includes('private-secret'));
  });
});
