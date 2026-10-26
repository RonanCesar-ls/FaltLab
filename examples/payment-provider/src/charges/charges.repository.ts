import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../database.service';
import type { Charge } from './charge';
import type { CreateChargeDto } from './dto/create-charge.dto';

export class IdempotencyConflictError extends Error {}
export class UnsupportedCurrencyError extends Error {}

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

  async create(
    input: CreateChargeDto,
    idempotencyKey?: string,
  ): Promise<Charge> {
    const insert = async (
      client: Pick<DatabaseService, 'query'>,
    ): Promise<Charge> => {
      if (input.currency !== 'BRL') throw new UnsupportedCurrencyError();
      const result = await client.query<Charge>(
        `INSERT INTO payment_provider.charges (merchant_reference, amount_cents, currency, idempotency_key)
         VALUES ($1::uuid, $2, $3, $4) RETURNING ${CHARGE_COLUMNS}`,
        [
          input.merchantReference,
          input.amountCents,
          input.currency,
          idempotencyKey ?? null,
        ],
      );
      const charge = result.rows[0];
      if (!charge)
        throw new Error('PostgreSQL did not return the persisted charge.');
      return charge;
    };
    if (idempotencyKey === undefined) return insert(this.database);
    return this.database.transaction(async (client) => {
      // Cross-process serialization is scoped to the transaction. The UNIQUE constraint is
      // the final database guarantee; this is not an unprotected SELECT-before-INSERT.
      await client.query(
        'SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))',
        [idempotencyKey],
      );
      const existing = await client.query<Charge>(
        `SELECT ${CHARGE_COLUMNS} FROM payment_provider.charges WHERE idempotency_key = $1`,
        [idempotencyKey],
      );
      const charge = existing.rows[0];
      if (charge) {
        if (
          charge.merchantReference !== input.merchantReference.toLowerCase() ||
          charge.amountCents !== input.amountCents ||
          charge.currency !== input.currency
        )
          throw new IdempotencyConflictError();
        return charge;
      }
      return insert(client);
    });
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
