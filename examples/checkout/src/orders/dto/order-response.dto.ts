import type { Order } from '../order';

export class OrderResponseDto {
  readonly id: string;
  readonly amountCents: number;
  readonly currency: 'BRL';
  readonly status: 'PENDING_PAYMENT' | 'PAID';
  readonly providerChargeId: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;

  constructor(order: Order) {
    this.id = order.id;
    this.amountCents = order.amountCents;
    this.currency = order.currency;
    this.status = order.status;
    this.providerChargeId = order.providerChargeId;
    this.createdAt = order.createdAt.toISOString();
    this.updatedAt = order.updatedAt.toISOString();
  }
}
