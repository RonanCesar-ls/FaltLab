# Core

Domain-independent executor for sequential asynchronous steps and a final rule
verification. It knows no endpoints, orders, payments or databases. Definitions
live in the scenarios workspace package.

execute awaits each step, snapshots explicitly provided JSON evidence and records
start/end/status. A false rule is a completed violated run; an execution error is
inconclusive and stops following steps. Unknown exceptions are never serialized;
static ExecutionFailure codes identify known preparation failures.

Steps must honor context.signal for resource cleanup. The executor also bounds
the wait for a stuck step, but cannot forcibly stop arbitrary JavaScript or undo
external effects. The current definition uses finite, cancellable HTTP exchanges.

Run pnpm build:runner, then pnpm --filter @faultlab/core test from the repository
root. Root pnpm test includes these tests. No retries or replay are implemented.
