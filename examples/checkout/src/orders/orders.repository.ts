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
       updated_at = CURRENT_TIMESTAMP WHERE id = $1::uuid RETURNING ${ORDER_COLUMNS}`,
      [id, providerChargeId],
    );
    const order = result.rows[0];
    if (!order) throw new Error('PostgreSQL did not return the updated order.');
    return order;
  }
}
