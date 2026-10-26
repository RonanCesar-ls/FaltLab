# Scenarios

@faultlab/scenarios contains domain-specific definitions, separate from the generic
executor. It imports no application controllers, services or repositories and
interacts only through HTTP.

duplicate-charge observes a lost confirmation, one charge and a pending order,
submits a second payment and evaluates at most one SUCCEEDED provider charge.
Each run creates a fresh synthetic order (12990 cents, BRL) and never deletes data.
Run exclusively: the proxy has a global one-shot fault, not a per-order reservation.

Definitions copy only allowlisted response fields into reports, excluding URLs,
credentials, raw exceptions and arbitrary error messages. See the
[guide](../docs/duplicate-charge.md). Root pnpm test includes controlled-contract
tests; pnpm test:scenario checks real HTTP services and PostgreSQL persistence.
