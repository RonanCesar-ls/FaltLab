# FaultLab

FaultLab is a TypeScript/pnpm monorepo for future fault-injection experiments.
It currently provides two independent NestJS services, isolated PostgreSQL
instances, versioned migrations, and a local Docker environment. Order/payment
logic, the fault engine, CLI, and scenario runner are not implemented.

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

The initial migration creates only an empty checkout or payment_provider schema.
It does not create order, payment or other business tables. The tool creates only
its migration bookkeeping table. Reverting the initial migration drops the empty
schema without CASCADE; a schema containing unexpected objects is not discarded.

| Action                  | Host command                  | Full Compose command                                           |
| ----------------------- | ----------------------------- | -------------------------------------------------------------- |
| Checkout: apply pending | pnpm db:checkout:up           | docker compose exec checkout node dist/migrate.js up           |
| Checkout: revert latest | pnpm db:checkout:down         | docker compose exec checkout node dist/migrate.js down         |
| Provider: apply pending | pnpm db:payment-provider:up   | docker compose exec payment-provider node dist/migrate.js up   |
| Provider: revert latest | pnpm db:payment-provider:down | docker compose exec payment-provider node dist/migrate.js down |

Up applies all pending migrations; down reverts one migration per invocation.
Each command loads the same validated connection configuration as its service.

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

| Command               | Purpose                                                                  |
| --------------------- | ------------------------------------------------------------------------ |
| pnpm dev              | Start both host services in watch mode                                   |
| pnpm build            | Compile each service into its own dist/ directory                        |
| pnpm lint             | Run ESLint with type-aware TypeScript rules                              |
| pnpm format           | Apply Prettier formatting                                                |
| pnpm format:check     | Check formatting without changing files                                  |
| pnpm typecheck        | Check strict TypeScript types, including tests                           |
| pnpm test             | Run environment and HTTP health tests with a database stub               |
| pnpm test:integration | Verify real PostgreSQL identity, parameters, readiness and pool shutdown |
| pnpm docker:config    | Validate Compose using the tracked example values                        |
| pnpm check            | Run lint, formatting check, types, unit/HTTP tests and build             |

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

## Layout

```text
compose.yaml
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
