# Persistent payment idempotency

## Reproduced problem

Before this correction, the unchanged duplicate-charge scenario was executed
against real isolated services twice. Each run recorded one SUCCEEDED charge
while checkout stayed pending after a lost response, then two charges after the
second payment. The CLI returned 1. The integration suite independently compared
its HTTP evidence with provider PostgreSQL records.

The problem was an ambiguous outcome: the provider committed, but checkout could
not know that from the lost HTTP confirmation. A sequential PAID guard could not
help because the order was still pending. Correlation IDs identify individual
requests and cannot identify the logical payment across retries.

## Checkout operation identity

This version has one logical payment operation per order. Checkout stores its
UUID in checkout.orders.payment_idempotency_key, allocated on the first attempt
using one parameterized UPDATE with COALESCE and gen_random_uuid(). Competing
callers update the same row and reuse the committed key. A unique constraint
also prevents two orders from sharing a non-null key.

The UPDATE completes before checkout starts the provider request. Failure to
prepare it returns 503 / PAYMENT_PREPARATION_FAILED without contacting the
provider. Communication errors do not clear or replace the key. A new checkout
process reads and reuses it from PostgreSQL. Changing a request's correlation ID
does not change the operation key. Clients cannot override it through the pay body.

The HTTP adapter sends Idempotency-Key separately from the unchanged charge JSON.
It still validates a full HTTP 201 confirmation, matching UUID/reference/amount/
currency/SUCCEEDED status/date, before persisting PAID and providerChargeId. No
automatic retry was added. Concurrent confirmations with the same charge retain
the first paid timestamp; a different charge cannot overwrite an already-paid order.

## Provider atomicity and response replay

The provider stores the key in the charge row itself, so the key and charge
commit together. idempotency_key has a case-sensitive unique constraint and an
ASCII/length check. For a keyed request, one READ COMMITTED transaction:

1. Acquires pg_advisory_xact_lock(hashtextextended(key, 0)).
2. Reads an existing row for the exact key after obtaining the lock.
3. Returns the original row if reference, amount and currency match, or 409 if they differ.
4. Otherwise validates BRL and inserts the charge plus key in the same row.
5. Commits before returning HTTP 201.

This is not an unprotected SELECT-before-INSERT or a process-local lock. The
[transaction-level advisory lock](https://www.postgresql.org/docs/17/explicit-locking.html#ADVISORY-LOCKS)
serializes replicas, and the
[unique constraint](https://www.postgresql.org/docs/17/ddl-constraints.html#DDL-CONSTRAINTS-UNIQUE-CONSTRAINTS)
is the final database barrier against duplicate non-null keys. READ COMMITTED
gives the statement after the lock a fresh view of the committed row. Hash
collisions only serialize unrelated keys; comparisons and uniqueness use the
actual text key. Rollback releases the lock and leaves no key reservation or charge.

Replays return HTTP 201 with the original charge ID, reference, amount, currency,
status and createdAt. The response correlation header belongs to the current
request, while the stored business response remains the same. Parameters are never
overwritten by a replay. Equivalent UUID casing is the same reference.

Idempotency-Key accepts one case-sensitive ASCII value, 1..128 characters:
`^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$`. Empty, malformed, duplicate or overlength
headers return 400 / INVALID_IDEMPOTENCY_KEY. Validly shaped requests reusing an
existing key with a different reference, positive amount or currency (including
USD) return 409 / IDEMPOTENCY_KEY_CONFLICT. New charges remain BRL-only: a fresh
key with USD, or a no-key USD request, returns 400. Structural DTO violations
(for example a numeric string amount or invalid UUID) remain 400.

Keys are internal metadata and are not added to public order/charge DTOs or logs.
The proxy forwards Idempotency-Key unchanged. Its one-shot fault still waits for
the entire provider 201 response and then drops the connection without delivering
headers/body. A replayed response also qualifies as HTTP 201 if the fault is armed again.

## Missing keys, migrations and deployment

Requests to the provider without Idempotency-Key deliberately retain legacy
behavior: each valid POST creates an independent charge with a NULL key. Distinct
keys may also create independent charges for the same merchantReference. There is
still no uniqueness constraint or foreign key on that external reference.

Both new migrations add nullable columns and constraints without rewriting,
deleting or relabelling existing orders/charges. Existing paid orders remain paid;
old pending orders obtain a key at their next payment attempt. Existing charges
remain NULL-key legacy records. This cannot retroactively associate an old
unkeyed charge with a pending order, merge duplicates, or repair historical ambiguity.

Apply migrations before sending traffic to the new code:

```sh
pnpm db:payment-provider:up
pnpm db:checkout:up
```

With Compose, use `docker compose exec payment-provider node dist/migrate.js up`
and `docker compose exec checkout node dist/migrate.js up`. Roll out every provider
instance with key support before the new checkout. An old provider ignores the
header and cannot supply the guarantee. Do not mix old/new checkout versions
during an in-flight logical payment. The normal database-only/host-service setup
and optional proxy routing still apply.

Down migrations remove only their new columns/constraints and preserve business
rows, but discard idempotency protection. Do not roll them back with in-flight or
retryable operations. The database test suites verify upgrade from the preceding
schema with legacy rows, downgrade without deleting those rows, and table migration
rollback/reapplication only on their own disposable databases.

## Unchanged scenario and validation

Run exclusively against checkout configured to use the proxy:

```sh
pnpm install --frozen-lockfile
pnpm build:runner
pnpm faultlab duplicate-charge
```

The same nine steps and the same maximum-one rule now expect:

- First payment: controlled checkout error, pending order, one provider charge.
- Second payment: recovery of that original charge, PAID order, still one charge.
- CLI outcome satisfied, actual count 1, exit 0.

Version-1 JSON reports retain both snapshots, the checkout responses and provider
records. The rule is still evaluated from those records, never from logs or
checkout status. Controlled tests still exercise two-charge evidence and require
violated / exit 1. Infrastructure/preparation failures remain inconclusive / exit 2.

```sh
pnpm check
pnpm test:charges
pnpm test:orders
pnpm test:scenario
pnpm test:e2e
```

Real PostgreSQL tests cover identical replays, reference/amount/currency conflicts,
concurrent identical and conflicting requests, key format/bounds, transaction
rollback, direct uniqueness enforcement and concurrent checkout key allocation.
Proxy tests check the header both normally and across a dropped response. The
real-service suite runs the scenario twice, checks SQL evidence, restarts the
actual checkout container between a lost response and another attempt, and
checks concurrent HTTP payments. Docker-assigned ports are rediscovered after restart.

## Limits

This is a local idempotency protocol, not a distributed transaction or universal
exactly-once guarantee. A committed charge can coexist with a pending order until
a caller retries successfully. Deleting/expiring keys, losing databases, using a
different key, sending a legacy no-key request, old deployments or direct SQL
writes outside the service can invalidate the application-level guarantee.
Keys currently have no expiry and must remain with their charges. There is no
automatic reconciliation, background retry, compensation, authentication,
merchant-scoped key namespace, refund/new-payment-operation model, replay engine,
frontend or random exploration in this delivery.
