import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../database.service';
import type { Charge } from './charge';
import type { CreateChargeDto } from './dto/create-charge.dto';

const CHARGE_COLUMNS = `
  id,
  merchant_reference AS "merchantReference",
  amount_cents AS "amountCents",
  currency,
  status,
  created_at AS "createdAt"
`;

@Injectable()
export class ChargesRepository {
  constructor(private readonly database: DatabaseService) {}

  async create(input: CreateChargeDto): Promise<Charge> {
    const result = await this.database.query<Charge>(
      `INSERT INTO payment_provider.charges (merchant_reference, amount_cents, currency)
       VALUES ($1::uuid, $2, $3) RETURNING ${CHARGE_COLUMNS}`,
      [input.merchantReference, input.amountCents, input.currency],
    );
    const charge = result.rows[0];
    if (!charge) {
      throw new Error('PostgreSQL did not return the persisted charge.');
    }
    return charge;
  }

  async findById(id: string): Promise<Charge | null> {
    const result = await this.database.query<Charge>(
      `SELECT ${CHARGE_COLUMNS} FROM payment_provider.charges WHERE id = $1::uuid`,
      [id],
    );
    return result.rows[0] ?? null;
  }

  async findByMerchantReference(merchantReference: string): Promise<Charge[]> {
    const result = await this.database.query<Charge>(
      `SELECT ${CHARGE_COLUMNS} FROM payment_provider.charges
       WHERE merchant_reference = $1::uuid ORDER BY created_at ASC, id ASC`,
      [merchantReference],
    );
    return result.rows;
  }
}
