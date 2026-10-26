-- Up Migration
-- Legacy orders retain NULL until their next payment attempt; public order data is unchanged.
ALTER TABLE checkout.orders ADD COLUMN payment_idempotency_key uuid;
ALTER TABLE checkout.orders ADD CONSTRAINT orders_payment_idempotency_key_unique UNIQUE (payment_idempotency_key);

-- Down Migration
-- Rollback preserves orders but discards retry protection. Do not roll back with payments in flight.
ALTER TABLE checkout.orders DROP COLUMN payment_idempotency_key;
