-- Up Migration
CREATE TABLE payment_provider.charges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_reference uuid NOT NULL,
  amount_cents integer NOT NULL,
  currency text NOT NULL,
  status text NOT NULL DEFAULT 'SUCCEEDED',
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT charges_amount_cents_range CHECK (amount_cents BETWEEN 1 AND 2147483647),
  CONSTRAINT charges_currency_brl CHECK (currency = 'BRL'),
  CONSTRAINT charges_status_succeeded CHECK (status = 'SUCCEEDED')
);

CREATE INDEX charges_merchant_reference_created_at_id_idx
  ON payment_provider.charges (merchant_reference, created_at, id);

-- Down Migration
DROP TABLE payment_provider.charges;
