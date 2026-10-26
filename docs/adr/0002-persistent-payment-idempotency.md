# ADR 0002: Persist logical payment keys across the HTTP boundary

- Status: Accepted
- Date: 2026-10-26
- Extends the payment-failure behavior described in ADR 0001.

## Context

The duplicate-charge scenario reproduced two provider charges after the first
confirmation was lost. Checkout's sequential paid-order guard does not protect
a still-pending order, process restarts or concurrent attempts.

## Decision

Use one persisted UUID operation key per checkout order, allocated atomically
before contacting the provider and reused independently of correlation IDs.
Forward it in Idempotency-Key through the existing HTTP gateway and optional proxy.

Store the provider key and charge in the same row and transaction. Use a unique
constraint plus a transaction-level PostgreSQL advisory lock to serialize keyed
requests across instances. Matching parameters return the original record and
HTTP 201; changed parameters return 409. No key retains explicitly documented
legacy independent-charge behavior. Add nullable columns without deleting or
retroactively reidentifying existing data.

## Consequences

- Lost confirmations and checkout restarts recover the original keyed charge.
- Concurrent calls reuse one checkout operation key and one provider charge.
- Database durability and key retention are required; no in-memory cache is authoritative.
- Local PAID persistence still follows a validated confirmation; no transaction spans both databases.
- Legacy/unkeyed history cannot be repaired automatically and may already contain duplicates.
- Migration/rollout order matters, and downgrading discards key protection.
- The scenario and maximum-one rule remain unchanged; its current real-service expectation becomes satisfied.

Automatic retries, reconciliation, compensation and other payment operations are
separate work. See [the protocol and its tests](../idempotency.md).
