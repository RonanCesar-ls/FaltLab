# FaultLab

FaultLab is a pnpm/TypeScript monorepo for experimenting with payment failure
boundaries. This first version contains two NestJS services, separate PostgreSQL
instances, strict HTTP contracts, correlation IDs, JSON logs, migrations and
repeatable end-to-end tests. A small sequential executor and CLI run the first
fixed duplicate-charge experiment and save provider-backed evidence.

| Component                 | Responsibility                                           | Local port        |
| ------------------------- | -------------------------------------------------------- | ----------------- |
| examples/checkout         | Create, read and pay orders through HTTP                 | 3001              |
| examples/payment-provider | Create and read independent fictitious charges           | 3002              |
| checkout-db               | Checkout-owned PostgreSQL                                | 5433              |
| payment-provider-db       | Provider-owned PostgreSQL                                | 5434              |
| tests/e2e                 | Real HTTP services plus isolated PostgreSQL verification | Random test ports |
| packages/fault-proxy      | Optional one-shot loss of a completed payment response   | 3003              |

## Requirements

- Docker Engine / Docker Desktop with Linux containers and Docker Compose v2.
- For host services and workspace checks: Node.js 22.13+ on the 22.x line or
  Node.js 24+, and pnpm 10.33.0 (pinned in package.json).
- Install pnpm if needed: `npm install --global pnpm@10.33.0`.

Run commands from the repository root, where pnpm-workspace.yaml is located.

## Run the application with Compose

In PowerShell:

```powershell
Copy-Item .env.example .env
```

In a POSIX shell: `cp .env.example .env`. Do not overwrite an existing customized
.env. The example passwords are public local-development values. Actual .env
files are ignored by Git and excluded from Docker build contexts.

```sh
docker compose config --quiet
docker compose up -d --build --wait
docker compose exec checkout node dist/migrate.js up
docker compose exec payment-provider node dist/migrate.js up
```

Application startup does not run migrations. Apply both sets before paying an
order. Dockerfiles build in multiple stages and run the final applications as an
unprivileged user. Only each service's own database credentials are injected.
All published development ports bind to 127.0.0.1.

```powershell
$order = Invoke-RestMethod -Method Post -Uri 'http://localhost:3001/orders' -ContentType 'application/json' -Body '{"amountCents":12990,"currency":"BRL"}'
$paid = Invoke-RestMethod -Method Post -Uri "http://localhost:3001/orders/$($order.id)/pay" -Headers @{ 'X-Correlation-Id' = 'local-payment-1' }
Invoke-RestMethod -Uri "http://localhost:3001/orders/$($order.id)"
```

```sh
docker compose logs -f --no-log-prefix checkout payment-provider
docker compose down
```

Normal shutdown preserves development volumes. `docker compose down --volumes`
intentionally discards development database data. PostgreSQL initialization
password variables apply only to fresh volumes; editing .env does not change a
role already stored in a volume.

## Databases in Docker, services on the host

Prepare the root .env as above, then in PowerShell:

```powershell
pnpm install --frozen-lockfile
Copy-Item examples/checkout/.env.example examples/checkout/.env
Copy-Item examples/payment-provider/.env.example examples/payment-provider/.env
docker compose up -d --wait checkout-db payment-provider-db
pnpm db:checkout:up
pnpm db:payment-provider:up
pnpm dev
```

For POSIX shells, replace Copy-Item with cp. If switching from the full Compose
stack, first run `docker compose stop checkout payment-provider` to free the API
ports. Filter a single service with `pnpm --filter @faultlab/checkout dev` or
`pnpm --filter @faultlab/payment-provider dev`.

Each service reads its own .env; shell variables take precedence. Avoid exporting
shared PG* or PORT values before starting both services. If root Compose database
names, users, passwords or published ports change, update the corresponding
service .env too. Checkout's host PAYMENT_PROVIDER_URL defaults to
http://127.0.0.1:3002; Compose uses http://payment-provider:3002. Its finite
PAYMENT_PROVIDER_TIMEOUT_MS defaults to 2000 (valid range 1..60000).

For compiled host services, run `pnpm build`, then each service's filtered start
command in its own terminal. Ctrl+C stops development services; Compose SIGTERM
invokes Nest shutdown hooks and closes pg pools.

## First automated experiment

Prepare both services and the proxy using the [scenario guide](docs/duplicate-charge.md).
Checkout must route through the proxy; no other payments may run simultaneously
because its fault is global and single-use. From the repository root:

```sh
pnpm build:runner
pnpm faultlab duplicate-charge
```

Each run creates its own order. The CLI records the lost response, queries the
provider's charges, submits the second payment and evaluates at most one SUCCEEDED
charge. Reports are saved in reports/duplicate-charge/<runId>.json (Git-ignored).
Exit codes: 0 satisfied, 1 violated, 2 inconclusive. Persistent idempotency now
keeps the original charge on retry, so the current services should exit 0.
The executor still detects duplicate evidence as a violation. No data is deleted.
See the guide for exact startup, configuration, report fields and limitations.

## Checks and tests

To observe a provider charge whose confirmation never reaches checkout, use the
optional [fault proxy experiment](docs/fault-proxy.md). Start it with
`pnpm dev:proxy` and explicitly set checkout's PAYMENT_PROVIDER_URL to
http://127.0.0.1:3003 in checkout's terminal. The proxy's upstream remains
http://127.0.0.1:3002. Defaults and Compose continue to use the direct path.

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm test:orders
pnpm test:charges
pnpm test:e2e
pnpm test:proxy
pnpm test:scenario
```

| Command                                 | What it executes                                                                                                     | Docker required?             |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | ---------------------------- |
| pnpm check                              | Lint, formatting, strict types, unit/component/harness tests, workspace build                                        | No                           |
| pnpm format / pnpm format:check         | Write/check Prettier formatting                                                                                      | No                           |
| pnpm lint / pnpm typecheck / pnpm build | Individual workspace checks                                                                                          | No                           |
| pnpm test                               | Service unit/component tests, proxy HTTP tests and E2E harness unit tests                                            | No                           |
| pnpm test:proxy                         | Controlled HTTP provider, one-shot loss, correlation, deadlines and shutdown                                         | No                           |
| pnpm test:orders                        | Real checkout PostgreSQL, order/payment HTTP tests, migration down/up                                                | Yes                          |
| pnpm test:charges                       | Real provider PostgreSQL, charge HTTP/SQL tests, migration down/up                                                   | Yes                          |
| pnpm test:e2e                           | Build/run both services over HTTP, two real databases, direct provider SQL assertions, outage and correlation checks | Yes                          |
| pnpm test:scenario                      | Real idempotent scenario, checkout restart/concurrency and independent provider SQL evidence                         | Yes                          |
| pnpm docker:config                      | Validate development Compose using example values                                                                    | No daemon required           |
| pnpm test:integration                   | Existing infrastructure checks against configured service databases                                                  | Running configured databases |

The standalone orders/charges suites provision disposable databases automatically.
The E2E package uses tests/e2e/compose.yaml, fixed test-only credentials, random
localhost ports, a unique faultlab-e2e project, separate private networks and
PostgreSQL tmpfs data. It never loads the development .env or attaches to a
host/development volume. It runs alongside an existing development stack.

The E2E test creates an order, pays it, reads PAID back, queries the provider
PostgreSQL directly with pg, checks exactly one matching charge and repeats the
payment sequentially while retaining that one charge. It also stops the provider
process, verifies a controlled error and unchanged pending order, and checks the
same supplied/generated correlation ID in both services' JSON request logs.

Readiness is condition-driven and deadline-bounded: Compose healthchecks plus
HTTP /health/ready polling, never a fixed startup sleep. The runner bounds commands,
test processes and the total run. Finally cleanup runs on success, test failure,
timeout and handled SIGINT/SIGTERM, terminates owned child processes and removes
only its validated random Compose project's resources. No SQL cleanup or global
Docker pruning is performed. Forced process/host termination or an unreachable
Docker daemon can prevent cleanup; the printed project ID identifies any leftovers.

Diagnostics are saved under tests/e2e/artifacts/<project>/ (Git-ignored), including
application JSON logs and correlation receipts. Build caches/images are retained.
A missing Docker daemon fails the Docker-dependent command; tests are not skipped.

## CI

.github/workflows/ci.yml runs on main pushes, pull requests and manual dispatch.
It uses Node.js 24 and pinned pnpm, installs with --frozen-lockfile, then checks
formatting, lint, types, build, unit/component tests, PostgreSQL suites and E2E.
The duplicate-charge integration suite verifies one retained charge and exit 0
against provider SQL; controlled tests preserve detection of violated rules.
GitHub-hosted Ubuntu supplies Docker; no development credentials or external
payment service are needed. Actions are pinned by commit SHA and permissions are
read-only. E2E diagnostics are uploaded with a seven-day retention period.

## Guarantees and limitations

A valid provider confirmation precedes an atomic local PAID/charge-ID update.
Already-paid orders are reused on sequential calls. Invalid requests and provider
failures do not write local payment state. Correlation is isolated per request;
errors and JSON logs exclude SQL, stack traces and credentials.

Checkout persists one operation key per order before HTTP and reuses it on retry,
restart and concurrent calls. The provider stores that key atomically with the
charge, enforces uniqueness and returns the original charge for matching retries.
Reusing a key with different parameters returns 409. See the
[idempotency protocol, migration order and limits](docs/idempotency.md).

A charge may still coexist with a pending order after a lost response until the
caller retries. Legacy requests without a key and distinct keys remain independent;
historical unkeyed charges cannot be retroactively deduplicated. There are no
automatic retries, cross-service transactions, compensation or reconciliation.
This is a local demonstrator without authentication, real money or production guarantees.

## Documentation and components

- [Architecture and operational boundaries](docs/architecture.md)
- [HTTP API, validation, environment and error codes](docs/http-api.md)
- [Optional fault proxy: configuration and manual payment experiment](docs/fault-proxy.md)
- [Duplicate-charge scenario: prerequisites, command, evidence and exit codes](docs/duplicate-charge.md)
- [Persistent payment idempotency: correction, guarantees and limitations](docs/idempotency.md)
- [ADR 0002: persistent operation keys](docs/adr/0002-persistent-payment-idempotency.md)
- [ADR 0001: independent services and databases](docs/adr/0001-independent-services-and-databases.md)

packages/core contains the generic sequential executor, scenarios contains the
HTTP-only duplicate-charge definition, and packages/cli provides its terminal
command. Replay, random generation and shrinking are deferred.
