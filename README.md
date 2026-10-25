# FaultLab

FaultLab is a TypeScript/pnpm monorepo for future fault-injection experiments.
It currently provides two independent NestJS services, isolated PostgreSQL
instances, versioned migrations, and a local Docker environment. Checkout supports
order creation and lookup. The payment provider independently creates and queries
fictitious successful charges. The services are not connected; order payment,
the fault engine, CLI, and scenario runner are not implemented.

## Requirements

- Docker Engine / Docker Desktop with Linux containers and Docker Compose v2.
- For running services on the host: Node.js 22.13+ on the 22.x line or Node.js 24+,
  and pnpm 10.33.0 (pinned in package.json).
- If needed, install pnpm with `npm install --global pnpm@10.33.0`.

Run all commands from the repository root (the directory containing compose.yaml).

## Run everything with Compose

Copy the Compose environment example. In PowerShell:

```powershell
Copy-Item .env.example .env
```

Or in a POSIX shell:

```sh
cp .env.example .env
```

The example passwords are public local-development values. Keep actual .env files
untracked. The root .env is used only by Compose for interpolation: it is never
loaded wholesale into an application container or copied into an image.

```sh
docker compose config --quiet
docker compose up -d --build --wait
docker compose exec checkout node dist/migrate.js up
docker compose exec payment-provider node dist/migrate.js up
docker compose ps
```

Compose waits for each database healthcheck before starting its application.
Application healthchecks call /health/ready. The Dockerfiles have build and runtime
stages; runtime images contain only that service's compiled files, migrations and
production dependencies, and run as the unprivileged node user. No local Node.js or
pnpm installation is needed for this mode.

| Service             | Host address          | Database / user                         |
| ------------------- | --------------------- | --------------------------------------- |
| checkout            | http://localhost:3001 | checkout / checkout_app                 |
| payment-provider    | http://localhost:3002 | payment_provider / payment_provider_app |
| checkout-db         | 127.0.0.1:5433        | checkout / checkout_app                 |
| payment-provider-db | 127.0.0.1:5434        | payment_provider / payment_provider_app |

All published ports bind to 127.0.0.1. Override host ports with CHECKOUT_PORT,
PAYMENT_PROVIDER_PORT, CHECKOUT_DB_PORT and PAYMENT_PROVIDER_DB_PORT in the root
.env. Containers continue to use their internal ports (3001/3002 and 5432).

Each application is attached only to its own database network and receives only
its own PGHOST, PGPORT, PGDATABASE, PGUSER and PGPASSWORD. The databases have
separate roles, data volumes and PostgreSQL processes. No shared database network
is created.

```sh
docker compose logs -f checkout payment-provider
docker compose down
```

The named volumes preserve database data across container recreation and normal
shutdown. PostgreSQL initialization variables apply only to a fresh volume;
changing a password in .env does not update an existing PostgreSQL role. To
intentionally discard all local database data, use `docker compose down --volumes`.

## Databases in Docker, services on the host

Prepare the root .env as above. Install the workspace and copy each service's
independent environment example. In PowerShell:

```powershell
pnpm install --frozen-lockfile
Copy-Item examples/checkout/.env.example examples/checkout/.env
Copy-Item examples/payment-provider/.env.example examples/payment-provider/.env
```

Or in a POSIX shell:

```sh
pnpm install --frozen-lockfile
cp examples/checkout/.env.example examples/checkout/.env
cp examples/payment-provider/.env.example examples/payment-provider/.env
```

The service examples match the root Compose defaults. If you customize database
names, users, passwords or published ports in the root .env, update the matching
service .env too. Host applications connect to 127.0.0.1:5433/5434; application
containers connect to checkout-db:5432 or payment-provider-db:5432 instead.

```sh
docker compose up -d --wait checkout-db payment-provider-db
pnpm db:checkout:up
pnpm db:payment-provider:up
pnpm dev
```

When switching from the full Compose stack, first stop the application containers
with `docker compose stop checkout payment-provider` to free ports 3001 and 3002.

Start one service independently with `pnpm --filter @faultlab/checkout dev` or
`pnpm --filter @faultlab/payment-provider dev`. Each filtered command runs in that
service's directory and reads only its own .env. Shell environment values take
precedence; avoid exporting shared PG* variables or PORT before starting both
services. Stop host development processes with Ctrl+C.

To run compiled applications, use `pnpm build`, then in separate terminals run
`pnpm --filter @faultlab/checkout start` and
`pnpm --filter @faultlab/payment-provider start`.

## Migrations

Each service owns a migrations/ directory and uses node-pg-migrate. Timestamped SQL
files define both Up Migration and Down Migration sections. Migration history is
stored in public.pgmigrations in that service's own database, with the tool's
advisory locking and transactional execution. Migrations are explicit deployment
commands; application startup does not apply them automatically.

The initial migration creates an empty checkout or payment_provider schema. A
second checkout migration creates checkout.orders; a second provider migration
creates payment_provider.charges. The tool also creates its migration bookkeeping table. Reverting
the initial migration drops the empty schema without CASCADE; a schema containing
unexpected objects is not discarded. Reverting the orders migration drops the
orders table and its data. Reverting the charges migration drops the charges table
and its non-unique lookup index, along with the stored charges.

| Action                  | Host command                  | Full Compose command                                           |
| ----------------------- | ----------------------------- | -------------------------------------------------------------- |
| Checkout: apply pending | pnpm db:checkout:up           | docker compose exec checkout node dist/migrate.js up           |
| Checkout: revert latest | pnpm db:checkout:down         | docker compose exec checkout node dist/migrate.js down         |
| Provider: apply pending | pnpm db:payment-provider:up   | docker compose exec payment-provider node dist/migrate.js up   |
| Provider: revert latest | pnpm db:payment-provider:down | docker compose exec payment-provider node dist/migrate.js down |

Up applies all pending migrations; down reverts one migration per invocation.
Each command loads the same validated connection configuration as its service.

## Orders API (checkout only)

Apply the checkout migrations before using these routes. For an existing Compose
installation, rebuild checkout and apply the pending migration:

```sh
docker compose up -d --build --wait checkout
docker compose exec checkout node dist/migrate.js up
```

For a host checkout process, use `pnpm db:checkout:up` before starting it.

`POST /orders` requires exactly these JSON fields:

```json
{ "amountCents": 12990, "currency": "BRL" }
```

It returns HTTP 201 with the persisted order:

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

`amountCents` must be a JSON integer from 1 through 2147483647, inclusive. Numeric
strings, fractions, zero, negative numbers and values above the maximum return
HTTP 400. `currency` must be exactly the string `BRL`. Both fields are required;
nulls, non-object bodies and unknown fields also return 400. Supplying `id`,
`status`, `providerChargeId`, `createdAt` or `updatedAt` is rejected: UUIDs,
initial status and timestamps are controlled by the server. Initial timestamps
are equal and are returned as ISO 8601 UTC strings.

`GET /orders/:id` returns HTTP 200 with the same order representation, HTTP 400
for a malformed UUID, or HTTP 404 for a valid UUID that does not exist. This is a
single-order lookup; no order list or update route is implemented.

Example in PowerShell:

```powershell
$order = Invoke-RestMethod -Method Post -Uri 'http://localhost:3001/orders' -ContentType 'application/json' -Body '{"amountCents":12990,"currency":"BRL"}'
Invoke-RestMethod -Uri "http://localhost:3001/orders/$($order.id)"
```

The orders module separates controller, DTO validation, service and repository.
Repository queries use the existing pg pool and bound parameters. PostgreSQL
stores UUID identifiers, integer amounts and timestamptz dates, with NOT NULL,
primary key, amount range, BRL-only and status constraints. A PENDING_PAYMENT row
must have a null providerChargeId; a PAID row must have a non-null UUID. The API
only creates PENDING_PAYMENT rows. Checkout has no order-payment endpoint or provider call.

## Charges API (payment provider only)

Apply the provider migrations before using these routes. For an existing Compose
installation:

```sh
docker compose up -d --build --wait payment-provider
docker compose exec payment-provider node dist/migrate.js up
```

For a host provider process, use `pnpm db:payment-provider:up` before starting it.

`POST /charges` requires exactly these JSON fields:

```json
{
  "merchantReference": "f0156e6a-6fd7-4f5a-b2ea-df53db095c8c",
  "amountCents": 12990,
  "currency": "BRL"
}
```

After PostgreSQL confirms persistence, it returns HTTP 201 with the stored charge:

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

`merchantReference` must be a UUID. It is an external order reference: the provider
does not check whether an order exists, call checkout, or access its database.
There is no foreign key and no uniqueness constraint on this reference. Every
valid POST creates an independent fictitious charge with its own UUID, including
repeated or concurrent requests with identical bodies. There is no deduplication
or idempotency behavior in this stage.

`amountCents` must be a JSON integer from 1 through 2147483647, and `currency` must
be exactly `BRL`. Missing fields, numeric strings, fractions, out-of-range amounts,
invalid UUIDs/currencies, non-object bodies and unknown properties return HTTP 400.
`id`, `status` and `createdAt` are server-controlled and cannot be supplied in the
request. The database enforces UUID/integer/timestamptz types, required fields,
the amount range, BRL currency and SUCCEEDED status. The repository awaits the
parameterized INSERT before responding; persistence failures do not return 201.

| Route                                 | Result                                                                        |
| ------------------------------------- | ----------------------------------------------------------------------------- |
| `GET /charges/:id`                    | HTTP 200 with one charge, 400 for a malformed UUID, 404 if missing            |
| `GET /charges?merchantReference=UUID` | HTTP 200 with an array containing only that reference's charges; `[]` if none |

The list endpoint requires one valid merchantReference UUID. Missing, invalid,
repeated/array reference parameters and unknown query properties return HTTP 400;
there is no unfiltered list. Results sort by `createdAt ASC, id ASC` for stable
ordering, including equal creation timestamps. A non-unique index on
`(merchant_reference, created_at, id)` supports this query.

Example in PowerShell, using an arbitrary external UUID without contacting checkout:

```powershell
$reference = [guid]::NewGuid().ToString()
$body = @{ merchantReference = $reference; amountCents = 12990; currency = 'BRL' } | ConvertTo-Json
$charge = Invoke-RestMethod -Method Post -Uri 'http://localhost:3002/charges' -ContentType 'application/json' -Body $body
Invoke-RestMethod -Uri "http://localhost:3002/charges/$($charge.id)"
Invoke-RestMethod -Uri "http://localhost:3002/charges?merchantReference=$reference"
```

The charges module has its own controller, DTOs, service and repository and uses
only the provider's existing pg pool. Creating a charge does not update any order.

## Health and database lifecycle

| Endpoint          | Success                                            | Database unavailable                               |
| ----------------- | -------------------------------------------------- | -------------------------------------------------- |
| GET /health       | HTTP 200, status ok and service identity           | Still HTTP 200                                     |
| GET /health/ready | HTTP 200, status ok, service identity, database ok | HTTP 503, status unavailable, database unavailable |

For example:

```sh
curl http://localhost:3001/health
curl http://localhost:3001/health/ready
curl http://localhost:3002/health
curl http://localhost:3002/health/ready
```

PowerShell can use Invoke-RestMethod with the same URLs. Readiness performs a
parameterized query through the pg pool, verifying the connected database and user
against the service's configuration. It does not require a business schema and
does not return connection details on failure. /health checks only the process.

Each service creates one lazy pool. Connection acquisition and queries have finite
timeouts; idle client failures are handled and later checks can reconnect. Nest
shutdown hooks close the pool with pool.end() on application shutdown, including
SIGTERM from Compose. Compose allows ten seconds for graceful shutdown.

To check failure isolation on the full stack, stop checkout-db: checkout readiness
should become 503, checkout process health should remain 200, and provider readiness
should remain 200. Start checkout-db again to restore checkout readiness.

## Service environment

Each service's .env.example documents these settings. Missing credentials fail
startup validation; credentials have no code defaults.

| Variable             | Meaning                                     | Default             |
| -------------------- | ------------------------------------------- | ------------------- |
| NODE_ENV             | development, test, production               | development         |
| PORT                 | HTTP port, 1..65535                         | 3001 / 3002         |
| PGHOST               | PostgreSQL hostname (required)              | In the example only |
| PGPORT               | PostgreSQL port, 1..65535                   | 5433 / 5434 on host |
| PGDATABASE           | This service's database (required)          | In the example only |
| PGUSER               | This service's role (required)              | In the example only |
| PGPASSWORD           | This service's password (required)          | In the example only |
| PGPOOL_MAX           | Maximum pool size, 1..100                   | 10                  |
| PGCONNECT_TIMEOUT_MS | Connection/acquisition timeout, 1..60000 ms | 2000                |
| PGQUERY_TIMEOUT_MS   | Client/server query timeout, 1..60000 ms    | 3000                |

Idle connections expire after ten seconds. These PostgreSQL settings target the
local Docker environment.

## Commands and validation

| Command               | Purpose                                                                      |
| --------------------- | ---------------------------------------------------------------------------- |
| pnpm dev              | Start both host services in watch mode                                       |
| pnpm build            | Compile each service into its own dist/ directory                            |
| pnpm lint             | Run ESLint with type-aware TypeScript rules                                  |
| pnpm format           | Apply Prettier formatting                                                    |
| pnpm format:check     | Check formatting without changing files                                      |
| pnpm typecheck        | Check strict TypeScript types, including tests                               |
| pnpm test             | Run environment and HTTP health tests with a database stub                   |
| pnpm test:integration | Verify real PostgreSQL identity, parameters, readiness and pool shutdown     |
| pnpm test:orders      | Provision an isolated PostgreSQL and test orders, constraints and migrations |
| pnpm test:charges     | Provision an isolated provider PostgreSQL and test charges and persistence   |
| pnpm docker:config    | Validate Compose using the tracked example values                            |
| pnpm check            | Run lint, formatting check, types, unit/HTTP tests and build                 |

`pnpm check` requires no Docker or PostgreSQL server. Integration tests are
explicitly separate and fail if PostgreSQL is unavailable; they are not silently
skipped. With the databases running and service .env files prepared, run:

```sh
pnpm test:integration
```

Integration tests run each Nest application in-process, exercise the real pg pool,
verify parameterized values and the expected database/user, call both health
endpoints, close the application, and verify that the pool rejects further queries.
They do not create or delete business data. Docker image build, actual Compose
startup, readiness outage/recovery and migration up/down validation additionally
require a running Docker daemon. `pnpm docker:config` can run without the daemon.

The orders suite has its own automatic, disposable database:

```sh
pnpm test:orders
```

This command requires Docker and runs independently of the development stack. It
starts compose.test.yaml with a unique Compose project name, a random localhost
port, separate credentials and a tmpfs PostgreSQL data directory. It applies the
real migrations, runs checkout connection tests plus order HTTP/constraint tests,
verifies migration down/up, then removes its containers and network even on test
failure. It never attaches to development volumes or uses a service .env database
for the orders suite. PostgreSQL availability failures cause a nonzero exit;
tests are not skipped.

The suite covers creation and persisted lookup, both amount boundaries, UUID
400/404 cases, missing/unknown/server-controlled fields, numeric strings,
fractions, invalid currencies, direct SQL constraint violations and timestamp
types. Test fixtures for the PAID constraint do not implement a payment workflow.
`pnpm test:integration` remains the separate infrastructure suite against the
configured service databases; it does not run the disposable business suites.

The charges suite also provisions its own temporary PostgreSQL automatically:

```sh
pnpm test:charges
```

It targets only payment-provider-test-db in compose.test.yaml, using the
charges-tests profile, a unique project name, a separate network, random localhost
port, provider-only credentials and tmpfs storage. No checkout database or service
is started or accessed. It applies provider migrations, runs real connection and
HTTP/SQL tests, checks migration down/up, and cleans up even after a test failure.
The command needs Docker; database failures fail the command rather than skipping
tests. It can run alongside the development stack and the isolated orders suite.

Coverage includes independent/repeated/concurrent charges, visible committed rows
from another connection, a blocked INSERT that must not return 201 early, an
actual database write failure, lookup by ID, isolated reference filtering, stable
timestamp/UUID ordering, strict body/query validation and database constraints.
It also verifies that merchantReference has no foreign key or unique index and
that charging works with no orders schema present.

## Layout

```text
compose.yaml
compose.test.yaml     # Isolated PostgreSQL for test:orders and test:charges
examples/
  checkout/           # NestJS API, PostgreSQL pool, migrations, Dockerfile
  payment-provider/   # Independent NestJS provider, pool, migrations, Dockerfile
packages/
  core/               # Reserved for future fault-injection primitives
  cli/                # Reserved for a future command-line interface
scenarios/            # Reserved for future experiment definitions
docs/                 # Reserved for future documentation
```

Reserved directories still contain only purpose READMEs. TypeScript strict options,
ESLint and Prettier remain configured at the root.

References: [node-postgres queries](https://node-postgres.com/features/queries),
[pool lifecycle](https://node-postgres.com/apis/pool),
[node-pg-migrate](https://salsita.github.io/node-pg-migrate/), and
[Compose startup order](https://docs.docker.com/compose/how-tos/startup-order/).
