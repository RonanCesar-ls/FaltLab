import { isISO8601, isUUID } from 'class-validator';

export const PAYMENT_GATEWAY = Symbol('PAYMENT_GATEWAY');
export const PAYMENT_HTTP_CLIENT = Symbol('PAYMENT_HTTP_CLIENT');

export interface PaymentRequest {
  merchantReference: string;
  amountCents: number;
  currency: 'BRL';
}

export interface PaymentConfirmation extends PaymentRequest {
  id: string;
  status: 'SUCCEEDED';
  createdAt: string;
}

export interface PaymentGateway {
  createCharge(
    request: PaymentRequest,
    idempotencyKey: string,
  ): Promise<PaymentConfirmation>;
}

export type PaymentGatewayFailure =
  'unavailable' | 'timeout' | 'invalid_response' | 'http_error';

export class PaymentGatewayError extends Error {
  constructor(readonly kind: PaymentGatewayFailure) {
    super('Payment provider request failed: ' + kind);
    this.name = 'PaymentGatewayError';
  }
}

export function isPaymentConfirmation(
  value: unknown,
  request: PaymentRequest,
): value is PaymentConfirmation {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    return false;
  const confirmation = value as Record<string, unknown>;
  return (
    typeof confirmation['id'] === 'string' &&
    isUUID(confirmation['id'], 'all') &&
    typeof confirmation['merchantReference'] === 'string' &&
    isUUID(confirmation['merchantReference'], 'all') &&
    confirmation['merchantReference'].toLowerCase() ===
      request.merchantReference.toLowerCase() &&
    confirmation['amountCents'] === request.amountCents &&
    confirmation['currency'] === request.currency &&
    confirmation['status'] === 'SUCCEEDED' &&
    typeof confirmation['createdAt'] === 'string' &&
    isISO8601(confirmation['createdAt'], {
      strict: true,
      strictSeparator: true,
    }) &&
    /T.*(?:Z|[+-]\d{2}:\d{2})$/.test(confirmation['createdAt']) &&
    Number.isFinite(Date.parse(confirmation['createdAt']))
  );
}
