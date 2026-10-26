# HTTP API

Default origins are http://localhost:3001 (checkout) and http://localhost:3002
(provider). Requests and responses use JSON. Dates are ISO 8601 UTC strings backed
by timestamptz columns. Amounts are integer cents, from 1 through 2147483647.
Numeric strings, fractions, missing/null required values, unknown properties and
currencies other than the exact string BRL are rejected with HTTP 400.

## Checkout

### POST /orders

```json
{ "amountCents": 12990, "currency": "BRL" }
```

Returns 201 after persistence:

```json
{
  "id": "f0156e6a-6fd7-4f5a-b2ea-df53db095c8c",
  "amountCents": 12990,
  "currency": "BRL",
  "status": "PENDING_PAYMENT",
  "providerChargeId": null,
  "createdAt": "2026-10-25T18:00:00.000Z",
  "updatedAt": "2026-10-25T18:00:00.000Z"
}
```

IDs, status, providerChargeId and dates are server-controlled. Their presence in a
creation request is rejected. Database constraints enforce the amount range,
BRL, valid status and the status/charge relationship: pending means no charge ID;
paid means a non-null UUID charge ID. There is no order-list/general-update API.

### GET /orders/:id

Returns 200 with the stored order, 400 for a malformed UUID or 404 /
ORDER_NOT_FOUND for a valid UUID not present in checkout.

### POST /orders/:id/pay

Accepts no body or `{}`. Any supplied property is rejected with 400. It uses only
the order's persisted amount, currency and ID. Success returns HTTP 200 with the
updated order (PAID, non-null providerChargeId, updated updatedAt).

A missing order returns 404; a malformed UUID returns 400. An already-paid order
returns its existing state, without another charge, on sequential calls. A valid
provider confirmation is required before the local payment update. This is not a
distributed transaction or concurrency-safe idempotency protocol.

| Failure                                               | HTTP | code                               |
| ----------------------------------------------------- | ---- | ---------------------------------- |
| Connection/provider unavailable                       | 503  | PAYMENT_PROVIDER_UNAVAILABLE       |
| HTTP deadline, including body reads                   | 504  | PAYMENT_PROVIDER_TIMEOUT           |
| Invalid JSON, fields, matching data or success status | 502  | PAYMENT_PROVIDER_INVALID_RESPONSE  |
| Non-success provider HTTP, including redirects        | 502  | PAYMENT_PROVIDER_HTTP_ERROR        |
| Saving a valid confirmation fails                     | 503  | PAYMENT_CONFIRMATION_NOT_PERSISTED |

A provider failure does not write local payment state. It may still have
registered a charge before confirmation was lost. Subsequent attempts can create
another charge. Concurrent requests can charge twice. No retries, distributed
idempotency, compensation or reconciliation are implemented.

## Payment provider

An optional [HTTP fault proxy](fault-proxy.md) exposes GET /health and
POST /__faults/drop-next-charge-response on port 3003. It is activated only by
changing checkout's gateway URL; provider routes and schemas remain unchanged.

### POST /charges

```json
{
  "merchantReference": "f0156e6a-6fd7-4f5a-b2ea-df53db095c8c",
  "amountCents": 12990,
  "currency": "BRL"
}
```

Returns 201 only after PostgreSQL confirms persistence:

```json
{
  "id": "387c38f5-926f-4985-a9ca-41b65a1f72c3",
  "merchantReference": "f0156e6a-6fd7-4f5a-b2ea-df53db095c8c",
  "amountCents": 12990,
  "currency": "BRL",
  "status": "SUCCEEDED",
  "createdAt": "2026-10-25T18:00:00.000Z"
}
```

merchantReference must be a UUID but is an external reference. There is no foreign
key or uniqueness constraint, order lookup, checkout SQL access or deduplication.
Each valid request, including an identical repeat, creates an independent charge.
The ID, SUCCEEDED status and timestamp are controlled by the provider. A direct
POST /charges does not update any order. There is no real payment processing.

### GET /charges/:id

Returns 200 with a charge, 400 for malformed UUID or 404 / CHARGE_NOT_FOUND.

### GET /charges?merchantReference=UUID

Requires exactly one valid scalar reference. Missing, malformed, repeated/array
reference values or unknown query properties return 400. Success returns an array
(possibly empty) with only that reference's charges, ordered by createdAt ASC,
then id ASC. A non-unique composite index supports the stable ordering. There is
no unfiltered list endpoint or pagination in this version.

## Health (both services)

| Route             | Success                                   | Failure                    |
| ----------------- | ----------------------------------------- | -------------------------- |
| GET /health       | 200: status ok and service name           | Process check only         |
| GET /health/ready | 200: status ok, service name, database ok | 503 / DATABASE_UNAVAILABLE |

Readiness performs a parameterized pool query verifying the configured database
and user. It does not check business tables or the other service. Checkout
readiness remains successful while its provider is down, if checkout SQL is ready.

## Correlation

Every application response includes X-Correlation-Id. A caller may supply one
value matching `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`: 1..64 ASCII characters, first a
letter/digit, followed by letters/digits/dot/underscore/hyphen. It is preserved
exactly. Absent values generate a UUID. Empty, malformed, overlength or repeated
values return 400 / INVALID_CORRELATION_ID with a newly generated safe UUID;
invalid values are not echoed or logged.

Checkout forwards the same ID to the provider. AsyncLocalStorage isolates
concurrent request contexts and structured request logs use that ID. IDs are
opaque, non-sensitive metadata, not authentication or idempotency keys. HTTP
protocol rejections before application dispatch are outside this contract.

## Error envelope

```json
{
  "statusCode": 400,
  "code": "BAD_REQUEST",
  "message": "Invalid request.",
  "correlationId": "request-example-1"
}
```

The body and header correlation ID are the same. Public messages come from an
allowlist; raw SQL, exceptions, stack traces, connection strings and credentials
are never serialized into API errors. Success response bodies are unchanged by
correlation. The common codes are:

| HTTP        | Codes                                                        |
| ----------- | ------------------------------------------------------------ |
| 400         | BAD_REQUEST, INVALID_CORRELATION_ID                          |
| 404         | NOT_FOUND (unknown route), ORDER_NOT_FOUND, CHARGE_NOT_FOUND |
| 413         | PAYLOAD_TOO_LARGE                                            |
| 500         | INTERNAL_SERVER_ERROR                                        |
| 502/503/504 | Payment codes above; DATABASE_UNAVAILABLE for readiness 503  |

Malformed JSON and DTO/UUID failures use BAD_REQUEST. Internal database write
errors remain 500 unless mapped by a specific use case, such as the checkout
confirmation-update failure. Error status and code do not prove no external
side effect occurred.

## Environment and migrations

Each service validates NODE_ENV (development/test/production), PORT (1..65535),
PGHOST, PGDATABASE, PGUSER and PGPASSWORD (required), and PGPORT. Pool settings are
PGPOOL_MAX (1..100, default 10), PGCONNECT_TIMEOUT_MS (1..60000, default 2000), and
PGQUERY_TIMEOUT_MS (1..60000, default 3000). Idle connections expire after 10s.

Checkout additionally validates PAYMENT_PROVIDER_URL (HTTP(S) base URL without
credentials, query or fragment; optional base path) and
PAYMENT_PROVIDER_TIMEOUT_MS (1..60000, default 2000). Host default URL is
http://127.0.0.1:3002; Compose supplies http://payment-provider:3002.

Root migration commands are pnpm db:checkout:up/down and
pnpm db:payment-provider:up/down. Up applies pending migrations; down reverts one.
Compose equivalents execute node dist/migrate.js up/down inside the relevant
application. Table rollback deletes that table's data. Migrations are explicit,
versioned with node-pg-migrate and recorded separately in public.pgmigrations.

## Logging and security scope

Runtime logs are JSON with timestamp, service, level, event and correlationId.
Request start/end/failure records use route templates, status and elapsed time;
unknown routes use <unmatched>. Bodies, query values, raw URLs/IDs, cookies,
authorization, SQL, credentials and exception arguments are excluded. Background
events use null correlation. Tool/test-runner output is separate from runtime
JSON logs. Authentication, authorization and production secret/role management
are outside this demonstrator's scope.
