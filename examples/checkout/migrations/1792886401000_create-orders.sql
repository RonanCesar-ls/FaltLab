-- Up Migration
CREATE TABLE checkout.orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  amount_cents integer NOT NULL,
  currency text NOT NULL,
  status text NOT NULL DEFAULT 'PENDING_PAYMENT',
  provider_charge_id uuid,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT orders_amount_cents_range CHECK (amount_cents BETWEEN 1 AND 2147483647),
  CONSTRAINT orders_currency_brl CHECK (currency = 'BRL'),
  CONSTRAINT orders_status_valid CHECK (status IN ('PENDING_PAYMENT', 'PAID')),
  CONSTRAINT orders_status_charge_consistent CHECK (
    (status = 'PENDING_PAYMENT' AND provider_charge_id IS NULL)
    OR (status = 'PAID' AND provider_charge_id IS NOT NULL)
  )
);

-- Down Migration
DROP TABLE checkout.orders;
