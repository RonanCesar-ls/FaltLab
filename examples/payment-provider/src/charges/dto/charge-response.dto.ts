import type { Charge } from '../charge';

export class ChargeResponseDto {
  readonly id: string;
  readonly merchantReference: string;
  readonly amountCents: number;
  readonly currency: 'BRL';
  readonly status: 'SUCCEEDED';
  readonly createdAt: string;

  constructor(charge: Charge) {
    this.id = charge.id;
    this.merchantReference = charge.merchantReference;
    this.amountCents = charge.amountCents;
    this.currency = charge.currency;
    this.status = charge.status;
    this.createdAt = charge.createdAt.toISOString();
  }
}
