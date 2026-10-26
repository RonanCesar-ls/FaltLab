import {
  execute,
  ExecutionFailure,
  type Context,
  type Json,
  type Progress,
  type RunReport,
  type Scenario,
} from '@faultlab/core';
import { loadConfig, type ScenarioConfig } from './config';
import {
  charges,
  object,
  order,
  publicError,
  type Charge,
  type Order,
} from './contracts';
import { exchange, ready, type HttpResult } from './http';

interface Snapshot {
  order: Order;
  charges: Charge[];
}
interface State {
  config?: ScenarioConfig;
  created?: Order;
  firstPayment?: HttpResult;
  secondPayment?: HttpResult;
  first?: Snapshot;
  final?: Snapshot;
  requestNumber: number;
  responses: Json[];
}

export function duplicateCharge(
  env: NodeJS.ProcessEnv,
  http: typeof fetch = fetch,
): Scenario<State> {
  const requireConfig = (ctx: Context<State>): ScenarioConfig => {
    if (!ctx.state.config) throw new ExecutionFailure('MISSING_CONFIGURATION');
    return ctx.state.config;
  };
  const requireOrder = (ctx: Context<State>): Order => {
    if (!ctx.state.created) throw new ExecutionFailure('MISSING_ORDER');
    return ctx.state.created;
  };
  const request = async (
    ctx: Context<State>,
    base: URL,
    path: string,
    method = 'GET',
    body?: unknown,
    signal = ctx.signal,
    timeoutMs = requireConfig(ctx).requestTimeoutMs,
  ): Promise<HttpResult> =>
    exchange(
      http,
      base,
      path,
      `fl-${ctx.runId}-${++ctx.state.requestNumber}`,
      timeoutMs,
      signal,
      method,
      body,
    );
  const remember = (
    ctx: Context<State>,
    operation: string,
    result: HttpResult,
    body: Json,
  ): void => {
    ctx.state.responses.push({
      operation,
      status: result.status,
      correlationId: result.correlationId,
      body,
    });
    ctx.record('responses', ctx.state.responses);
  };
  const snapshot = async (
    ctx: Context<State>,
    phase: 'first' | 'final',
  ): Promise<Snapshot> => {
    const config = requireConfig(ctx);
    const created = requireOrder(ctx);
    const orderResult = await request(
      ctx,
      config.checkoutUrl,
      'orders/' + created.id,
    );
    if (orderResult.status !== 200)
      throw new ExecutionFailure('ORDER_QUERY_FAILED');
    const stored = order(orderResult.body, created.id);
    remember(ctx, phase + '-order', orderResult, stored);
    const chargeResult = await request(
      ctx,
      config.providerUrl,
      'charges?merchantReference=' + created.id,
    );
    if (chargeResult.status !== 200)
      throw new ExecutionFailure('CHARGES_QUERY_FAILED');
    const observed = charges(chargeResult.body, created);
    remember(ctx, phase + '-charges', chargeResult, observed);
    const result = { order: stored, charges: observed };
    ctx.record(
      phase === 'first' ? 'afterLostResponse' : 'afterSecondPayment',
      result,
    );
    return result;
  };
  const pay = async (
    ctx: Context<State>,
    phase: 'first' | 'second',
  ): Promise<HttpResult> => {
    const result = await request(
      ctx,
      requireConfig(ctx).checkoutUrl,
      'orders/' + requireOrder(ctx).id + '/pay',
      'POST',
    );
    const body =
      result.status === 200
        ? order(result.body, requireOrder(ctx).id)
        : publicError(result.body, result.status, result.correlationId);
    remember(ctx, phase + '-payment', result, body);
    // Keep only the sanitized body in scenario state, too.
    return { ...result, body };
  };
  return {
    id: 'duplicate-charge',
    rule: {
      id: 'at-most-one-succeeded-charge',
      description: 'An order may have at most one SUCCEEDED provider charge.',
    },
    steps: [
      {
        id: 'readiness',
        title: 'Check checkout, provider and proxy readiness',
        run: async (ctx) => {
          const config = loadConfig(env);
          ctx.state.config = config;
          await ready(
            async (signal, remaining) => {
              try {
                for (const [base, path, service] of [
                  [config.checkoutUrl, 'health/ready', 'checkout'],
                  [config.providerUrl, 'health/ready', 'payment-provider'],
                  [config.proxyUrl, 'health', 'fault-proxy'],
                ] as const) {
                  const result = await request(
                    ctx,
                    base,
                    path,
                    'GET',
                    undefined,
                    signal,
                    Math.min(config.requestTimeoutMs, remaining),
                  );
                  const body = object(result.body);
                  if (
                    result.status !== 200 ||
                    body['service'] !== service ||
                    body['status'] !== 'ok' ||
                    (service !== 'fault-proxy' && body['database'] !== 'ok')
                  )
                    return false;
                }
                return true;
              } catch {
                return false;
              }
            },
            config.readyTimeoutMs,
            ctx.signal,
          );
          ctx.record('readiness', {
            checkout: true,
            provider: true,
            proxy: true,
          });
        },
      },
      {
        id: 'create-order',
        title: 'Create a new order for this run',
        run: async (ctx) => {
          const result = await request(
            ctx,
            requireConfig(ctx).checkoutUrl,
            'orders',
            'POST',
            { amountCents: 12990, currency: 'BRL' },
          );
          if (result.status !== 201)
            throw new ExecutionFailure('ORDER_CREATION_FAILED');
          const created = order(result.body);
          if (created.status !== 'PENDING_PAYMENT')
            throw new ExecutionFailure('NEW_ORDER_NOT_PENDING');
          ctx.state.created = created;
          ctx.record('ids', { orderId: created.id });
          remember(ctx, 'create-order', result, created);
        },
      },
      {
        id: 'arm-fault',
        title: 'Arm one lost charge response',
        run: async (ctx) => {
          const result = await request(
            ctx,
            requireConfig(ctx).proxyUrl,
            '__faults/drop-next-charge-response',
            'POST',
          );
          if (result.status !== 200 || object(result.body)['armed'] !== true)
            throw new ExecutionFailure('FAULT_ARMING_FAILED');
          remember(ctx, 'arm-fault', result, { armed: true });
        },
      },
      {
        id: 'first-payment',
        title: 'Request payment and record the checkout response',
        run: async (ctx) => {
          ctx.state.firstPayment = await pay(ctx, 'first');
        },
      },
      {
        id: 'first-observation',
        title: 'Read the order and persisted provider charges',
        run: async (ctx) => {
          ctx.state.first = await snapshot(ctx, 'first');
        },
      },
      {
        id: 'check-preparation',
        title: 'Verify a pending order and one completed charge',
        run: (ctx) => {
          const first = ctx.state.first;
          const payment = ctx.state.firstPayment;
          if (!first || !payment)
            throw new ExecutionFailure('MISSING_FIRST_OBSERVATION');
          const code = object(payment.body)['code'];
          const lost =
            (payment.status === 503 &&
              code === 'PAYMENT_PROVIDER_UNAVAILABLE') ||
            (payment.status === 504 && code === 'PAYMENT_PROVIDER_TIMEOUT');
          const pending = first.order.status === 'PENDING_PAYMENT';
          ctx.record('preparation', {
            lostResponseObserved: lost,
            pending,
            succeededChargeCount: first.charges.length,
            expectedChargeCount: 1,
            matchesExpected: lost && pending && first.charges.length === 1,
          });
          if (!lost || !pending)
            throw new ExecutionFailure('LOST_RESPONSE_NOT_OBSERVED');
          if (first.charges.length !== 1)
            throw new ExecutionFailure('UNEXPECTED_INITIAL_CHARGE_COUNT');
          return Promise.resolve();
        },
      },
      {
        id: 'second-payment',
        title: 'Request payment a second time with normal forwarding',
        run: async (ctx) => {
          ctx.state.secondPayment = await pay(ctx, 'second');
        },
      },
      {
        id: 'final-observation',
        title: 'Read the final order and provider charges',
        run: async (ctx) => {
          ctx.state.final = await snapshot(ctx, 'final');
        },
      },
    ],
    verify: (ctx) => {
      const final = ctx.state.final;
      const first = ctx.state.first;
      if (!final || !first)
        throw new ExecutionFailure('MISSING_FINAL_OBSERVATION');
      if (
        !first.charges.every((charge) =>
          final.charges.some((row) => row.id === charge.id),
        )
      )
        throw new ExecutionFailure('INCONSISTENT_PROVIDER_EVIDENCE');
      // Multiple distinct SUCCEEDED records prove the rule violation even if checkout stayed pending.
      if (final.charges.length > 1)
        return Promise.resolve({
          satisfied: false,
          actual: final.charges.length,
          expected: { maximum: 1 },
        });
      if (
        ctx.state.secondPayment?.status !== 200 ||
        final.order.status !== 'PAID' ||
        !final.charges.some(
          (charge) => charge.id === final.order.providerChargeId,
        )
      )
        throw new ExecutionFailure('SECOND_PAYMENT_NOT_CONFIRMED');
      return Promise.resolve({
        satisfied: true,
        actual: final.charges.length,
        expected: { maximum: 1 },
      });
    },
  };
}

export function runDuplicateCharge(
  env: NodeJS.ProcessEnv,
  options: {
    http?: typeof fetch;
    signal?: AbortSignal;
    onProgress?: (event: Progress) => void;
  } = {},
): Promise<RunReport> {
  return execute(
    duplicateCharge(env, options.http),
    { requestNumber: 0, responses: [] },
    {
      timeoutMs: 180000,
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.onProgress ? { onProgress: options.onProgress } : {}),
    },
  );
}
