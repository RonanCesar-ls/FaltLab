# ADR 0001: Separate checkout and provider services and databases

- Status: Accepted
- Date: 2026-10-25

## Context

FaultLab needs an observable failure boundary between an order state transition
and an external payment side effect. Sharing an application process, database
transaction or orders table would conceal that boundary and make communication
failures unrealistic. The initial version must remain small and independently
testable while reserving the future fault engine and CLI.

## Decision

Use independent NestJS checkout and fictitious provider services. Each owns its
PostgreSQL instance, database, role, migrations, pool, environment and Dockerfile.
Checkout invokes the provider only through its PaymentGateway HTTP adapter.
Application processes receive only their own database credentials. Separate
database networks are preserved; only the applications share an HTTP network.

The provider stores merchantReference as an external UUID without a foreign key
or uniqueness constraint. It does not validate order existence and every valid
request creates a separate charge. Checkout validates the returned confirmation
before atomically storing PAID and providerChargeId in its own database.

Use X-Correlation-Id and safe JSON logs for visibility across the HTTP boundary.
End-to-end tests may read provider SQL directly to verify effects, but production
checkout code may not. E2E runs use independent, disposable test resources.

## Consequences

- Individual application or database failures can be represented independently.
- Contracts, startup, migrations and readiness remain local to each service.
- The test can prove one provider charge for the successful sequential scenario
  without treating an API response as the only evidence of persistence.
- Cross-service atomicity is deliberately absent. A charge can exist while the
  order stays pending after a lost response or failed local update.
- Sequential paid-order reuse is useful but does not protect concurrent payments
  or a retry after an ambiguous outcome. More than one charge can result.
- There is additional operational/test setup: two processes, two databases,
  migrations, HTTP deadlines and lifecycle management.

Retries, distributed idempotency, reconciliation, compensation, concurrency-safe
payment orchestration and the FaultLab engine are separate future decisions.
This ADR does not claim production security or exactly-once payment semantics.

## Alternatives considered

1. One service and database: simpler setup, but no realistic HTTP failure boundary.
2. Two services sharing SQL: couples schemas/credentials and invites transaction
   assumptions that do not hold for an external provider.
3. A distributed transaction or idempotency protocol immediately: stronger scope
   and guarantees, but outside the intentionally limited first demonstrator.
