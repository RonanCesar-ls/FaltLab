export interface Charge {
  id: string;
  merchantReference: string;
  amountCents: number;
  currency: 'BRL';
  status: 'SUCCEEDED';
  createdAt: Date;
}
