import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { beforeEach, describe, it } from 'node:test';
import { HttpException, NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Order } from '../src/orders/order';
import { OrdersRepository } from '../src/orders/orders.repository';
import { OrdersService } from '../src/orders/orders.service';
import type {
  PaymentConfirmation,
  PaymentGateway,
  PaymentRequest,
} from '../src/payments/payment-gateway';
import {
  PAYMENT_GATEWAY,
  PaymentGatewayError,
} from '../src/payments/payment-gateway';

void describe('Pay order use case through the PaymentGateway token', () => {
  let order: Order | null;
  let service: OrdersService;
  let requests: PaymentRequest[];
  let writes: number;
  let confirm: (request: PaymentRequest) => Promise<PaymentConfirmation>;
  let failWrite: boolean;
  beforeEach(async () => {
    order = {
      id: randomUUID(),
      amountCents: 12990,
      currency: 'BRL',
      status: 'PENDING_PAYMENT',
      providerChargeId: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    requests = [];
    writes = 0;
    failWrite = false;
    confirm = (request) =>
      Promise.resolve({
        ...request,
        id: randomUUID(),
        status: 'SUCCEEDED',
        createdAt: new Date().toISOString(),
      });
    const gateway: PaymentGateway = {
      createCharge: (request) => {
        requests.push(request);
        return confirm(request);
      },
    };
    const module = await Test.createTestingModule({
      providers: [
        OrdersService,
        { provide: PAYMENT_GATEWAY, useValue: gateway },
        {
          provide: OrdersRepository,
          useValue: {
            findById: (): Promise<Order | null> =>
              Promise.resolve(structuredClone(order)),
            markPaid: (_id: string, chargeId: string): Promise<Order> => {
              writes++;
              if (failWrite || !order)
                return Promise.reject(new Error('Private database failure.'));
              order = {
                ...order,
                status: 'PAID',
                providerChargeId: chargeId,
                updatedAt: new Date(),
              };
              return Promise.resolve(structuredClone(order));
            },
          },
        },
      ],
    }).compile();
    service = module.get(OrdersService);
  });
  void it('returns 404 without charging when the persisted order does not exist', async () => {
    order = null;
    await assert.rejects(service.pay(randomUUID()), NotFoundException);
    assert.equal(requests.length, 0);
    assert.equal(writes, 0);
  });
  void it('uses only persisted data, saves a valid confirmation, and returns the updated order', async () => {
    assert.ok(order);
    const original = structuredClone(order);
    const result = await service.pay(order.id);
    assert.deepEqual(requests, [
      {
        merchantReference: original.id,
        amountCents: original.amountCents,
        currency: original.currency,
      },
    ]);
    assert.equal(result.status, 'PAID');
    assert.ok(result.providerChargeId);
    assert.equal(result.amountCents, original.amountCents);
    assert.equal(result.createdAt, original.createdAt.toISOString());
    assert.equal(writes, 1);
  });
  void it('reuses a paid order on sequential calls without another provider request or write', async () => {
    assert.ok(order);
    const id = order.id;
    const first = await service.pay(id);
    assert.deepEqual(await service.pay(id), first);
    assert.equal(requests.length, 1);
    assert.equal(writes, 1);
  });
  for (const [kind, status] of [
    ['unavailable', 503],
    ['timeout', 504],
    ['invalid_response', 502],
    ['http_error', 502],
  ] as const) {
    void it(
      'preserves the pending order for ' + kind + ' without retries',
      async () => {
        assert.ok(order);
        const original = structuredClone(order);
        confirm = () => Promise.reject(new PaymentGatewayError(kind));
        await assert.rejects(
          service.pay(order.id),
          (error: unknown) =>
            error instanceof HttpException && error.getStatus() === status,
        );
        assert.deepEqual(order, original);
        assert.equal(writes, 0);
        assert.equal(requests.length, 1);
      },
    );
  }
  void it('handles an unexpected gateway error without exposing internal details or writing', async () => {
    assert.ok(order);
    confirm = () => Promise.reject(new Error('Private gateway credentials.'));
    await assert.rejects(
      service.pay(order.id),
      (error: unknown) =>
        error instanceof HttpException &&
        error.getStatus() === 503 &&
        !JSON.stringify(error.getResponse()).includes('Private'),
    );
    assert.equal(writes, 0);
    assert.equal(order.status, 'PENDING_PAYMENT');
  });
  for (const override of [
    { id: 'invalid' },
    { status: 'PENDING' },
    { merchantReference: randomUUID() },
    { amountCents: 1 },
    { currency: 'USD' },
  ]) {
    void it(
      'revalidates a gateway implementation that breaks its confirmation contract: ' +
        JSON.stringify(override),
      async () => {
        assert.ok(order);
        const original = structuredClone(order);
        confirm = (request) =>
          Promise.resolve({
            ...request,
            id: randomUUID(),
            status: 'SUCCEEDED',
            createdAt: new Date().toISOString(),
            ...override,
          } as PaymentConfirmation);
        await assert.rejects(
          service.pay(order.id),
          (error: unknown) =>
            error instanceof HttpException && error.getStatus() === 502,
        );
        assert.deepEqual(order, original);
        assert.equal(writes, 0);
      },
    );
  }
  void it('does not retry the charge if saving the confirmation fails', async () => {
    assert.ok(order);
    const original = structuredClone(order);
    failWrite = true;
    await assert.rejects(
      service.pay(order.id),
      (error: unknown) =>
        error instanceof HttpException && error.getStatus() === 503,
    );
    assert.deepEqual(order, original);
    assert.equal(requests.length, 1);
    assert.equal(writes, 1);
  });
});
