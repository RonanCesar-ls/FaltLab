import { ExecutionFailure } from '@faultlab/core';

export type Order = {
  id: string;
  amountCents: number;
  currency: 'BRL';
  status: 'PENDING_PAYMENT' | 'PAID';
  providerChargeId: string | null;
  createdAt: string;
  updatedAt: string;
};
export type Charge = {
  id: string;
  merchantReference: string;
  amountCents: number;
  currency: 'BRL';
  status: 'SUCCEEDED';
  createdAt: string;
};
export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new ExecutionFailure('INVALID_HTTP_RESPONSE');
  return value as Record<string, unknown>;
}
export function uuid(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      value,
    )
  );
}
function date(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^\d{4}-\d{2}-\d{2}T[0-9:.]+Z$/.test(value) &&
    Number.isFinite(Date.parse(value))
  );
}
export function order(value: unknown, expectedId?: string): Order {
  const row = object(value);
  if (
    !uuid(row['id']) ||
    (expectedId && row['id'] !== expectedId) ||
    row['amountCents'] !== 12990 ||
    row['currency'] !== 'BRL' ||
    !date(row['createdAt']) ||
    !date(row['updatedAt']) ||
    !(
      (row['status'] === 'PENDING_PAYMENT' &&
        row['providerChargeId'] === null) ||
      (row['status'] === 'PAID' && uuid(row['providerChargeId']))
    )
  )
    throw new ExecutionFailure('INVALID_ORDER_RESPONSE');
  return {
    id: row['id'],
    amountCents: 12990,
    currency: 'BRL',
    status: row['status'],
    providerChargeId: row['providerChargeId'],
    createdAt: row['createdAt'],
    updatedAt: row['updatedAt'],
  };
}
export function charges(value: unknown, expectedOrder: Order): Charge[] {
  if (!Array.isArray(value))
    throw new ExecutionFailure('INVALID_CHARGES_RESPONSE');
  const rows: Charge[] = value.map((item: unknown) => {
    const row = object(item);
    if (
      !uuid(row['id']) ||
      row['merchantReference'] !== expectedOrder.id ||
      row['amountCents'] !== expectedOrder.amountCents ||
      row['currency'] !== expectedOrder.currency ||
      row['status'] !== 'SUCCEEDED' ||
      !date(row['createdAt'])
    )
      throw new ExecutionFailure('INVALID_CHARGES_RESPONSE');
    return {
      id: row['id'],
      merchantReference: expectedOrder.id,
      amountCents: expectedOrder.amountCents,
      currency: 'BRL',
      status: 'SUCCEEDED',
      createdAt: row['createdAt'],
    };
  });
  if (new Set(rows.map((row) => row.id)).size !== rows.length)
    throw new ExecutionFailure('INVALID_CHARGES_RESPONSE');
  return rows;
}

const publicCodes = new Set([
  'PAYMENT_PROVIDER_UNAVAILABLE',
  'PAYMENT_PROVIDER_TIMEOUT',
  'PAYMENT_PROVIDER_INVALID_RESPONSE',
  'PAYMENT_PROVIDER_HTTP_ERROR',
  'PAYMENT_CONFIRMATION_NOT_PERSISTED',
  'INTERNAL_SERVER_ERROR',
  'BAD_REQUEST',
  'ORDER_NOT_FOUND',
  'DATABASE_UNAVAILABLE',
]);
export function publicError(
  value: unknown,
  status: number,
  correlationId: string,
) {
  const row = object(value);
  if (
    row['statusCode'] !== status ||
    row['correlationId'] !== correlationId ||
    typeof row['code'] !== 'string'
  )
    throw new ExecutionFailure('INVALID_ERROR_RESPONSE');
  // Do not persist arbitrary provider/checkout messages, even if an endpoint is misconfigured.
  return {
    statusCode: status,
    code: publicCodes.has(row['code']) ? row['code'] : 'UNEXPECTED_HTTP_ERROR',
    message: 'Request rejected by the service.',
    correlationId,
  };
}
