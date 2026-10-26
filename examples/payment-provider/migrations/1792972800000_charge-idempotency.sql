-- Up Migration
-- NULL preserves existing and explicitly non-idempotent legacy requests.
ALTER TABLE payment_provider.charges ADD COLUMN idempotency_key text COLLATE "C";
ALTER TABLE payment_provider.charges ADD CONSTRAINT charges_idempotency_key_valid CHECK (
  idempotency_key IS NULL OR (
    octet_length(idempotency_key) BETWEEN 1 AND 128
    AND idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
  )
);
ALTER TABLE payment_provider.charges ADD CONSTRAINT charges_idempotency_key_unique UNIQUE (idempotency_key);

-- Down Migration
-- Existing charges survive rollback; their persisted deduplication keys do not.
ALTER TABLE payment_provider.charges DROP COLUMN idempotency_key;
