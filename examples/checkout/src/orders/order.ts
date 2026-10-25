export interface Order {
  id: string;
  amountCents: number;
  currency: 'BRL';
  status: 'PENDING_PAYMENT' | 'PAID';
  providerChargeId: string | null;
  createdAt: Date;
  updatedAt: Date;
}
