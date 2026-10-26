import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../database.service';
import type { CreateOrderDto } from './dto/create-order.dto';
import type { Order } from './order';

const ORDER_COLUMNS = `
  id,
  amount_cents AS "amountCents",
  currency,
  status,
  provider_charge_id AS "providerChargeId",
  created_at AS "createdAt",
  updated_at AS "updatedAt"
`;

@Injectable()
export class OrdersRepository {
  constructor(private readonly database: DatabaseService) {}

  async create(input: CreateOrderDto): Promise<Order> {
    const result = await this.database.query<Order>(
      `INSERT INTO checkout.orders (amount_cents, currency)
       VALUES ($1, $2) RETURNING ${ORDER_COLUMNS}`,
      [input.amountCents, input.currency],
    );
    const order = result.rows[0];
    if (!order) {
      throw new Error('PostgreSQL did not return the created order.');
    }
    return order;
  }

  async findById(id: string): Promise<Order | null> {
    const result = await this.database.query<Order>(
      `SELECT ${ORDER_COLUMNS} FROM checkout.orders WHERE id = $1::uuid`,
      [id],
    );
    return result.rows[0] ?? null;
  }

  async markPaid(id: string, providerChargeId: string): Promise<Order> {
    const result = await this.database.query<Order>(
      `UPDATE checkout.orders SET status = 'PAID', provider_charge_id = $2::uuid,
       updated_at = CASE WHEN status = 'PENDING_PAYMENT' THEN CURRENT_TIMESTAMP ELSE updated_at END
       WHERE id = $1::uuid AND (status = 'PENDING_PAYMENT' OR provider_charge_id = $2::uuid)
       RETURNING ${ORDER_COLUMNS}`,
      [id, providerChargeId],
    );
    const order = result.rows[0];
    if (!order) throw new Error('PostgreSQL did not return the updated order.');
    return order;
  }

  async getOrCreatePaymentKey(id: string): Promise<string> {
    // UPDATE serializes competing callers on the order row. COALESCE reuses the committed key.
    const result = await this.database.query<{ key: string }>(
      `UPDATE checkout.orders
       SET payment_idempotency_key = COALESCE(payment_idempotency_key, gen_random_uuid())
       WHERE id = $1::uuid RETURNING payment_idempotency_key AS key`,
      [id],
    );
    const key = result.rows[0]?.key;
    if (!key) throw new Error('Payment operation could not be prepared.');
    return key;
  }
}
