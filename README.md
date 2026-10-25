# FaultLab

FaultLab is a TypeScript monorepo for future fault-injection experiments. This
first stage provides two independent NestJS services and shared development tools.
Only process health endpoints are implemented. There is no database, order or
payment logic, fault engine, CLI, or scenario runner yet.

## Requirements

- Node.js 22.13+ on the 22.x line, or Node.js 24+ (validated with Node.js 24).
- pnpm 10.33.0, pinned in `package.json`.

If pnpm is not available, install the pinned version:

```sh
npm install --global pnpm@10.33.0
```

## Install and run

Run all commands from the repository root:

```sh
pnpm install --frozen-lockfile
```

Create each service's environment file. In PowerShell:

```powershell
Copy-Item examples/checkout/.env.example examples/checkout/.env
Copy-Item examples/payment-provider/.env.example examples/payment-provider/.env
```

In a POSIX shell:

```sh
cp examples/checkout/.env.example examples/checkout/.env
cp examples/payment-provider/.env.example examples/payment-provider/.env
```

Start both services with automatic restart when their source files change:

```sh
pnpm dev
```

Or start one service independently:

```sh
pnpm --filter @faultlab/checkout dev
pnpm --filter @faultlab/payment-provider dev
```

Each filtered command runs in that service's directory. Each service reads its own
`.env`; an environment variable already set in the shell takes precedence. No root
`.env` is used. Stop development processes with Ctrl+C.

| Service          | Default URL                    | Health response                                |
| ---------------- | ------------------------------ | ---------------------------------------------- |
| Checkout         | `http://localhost:3001/health` | `{"status":"ok","service":"checkout"}`         |
| Payment provider | `http://localhost:3002/health` | `{"status":"ok","service":"payment-provider"}` |

Both endpoints return HTTP 200. These are process checks and have no external
dependencies. For example:

```sh
curl http://localhost:3001/health
curl http://localhost:3002/health
```

In PowerShell, you can also use `Invoke-RestMethod` with the same URLs.

## Environment

The tracked `.env.example` files contain only local, non-secret configuration.
Actual `.env` files are ignored by Git.

| Variable   | Accepted values                        | Checkout default | Payment provider default |
| ---------- | -------------------------------------- | ---------------- | ------------------------ |
| `NODE_ENV` | `development`, `test`, or `production` | `development`    | `development`            |
| `PORT`     | Integer from 1 to 65535                | `3001`           | `3002`                   |

Unset variables use these defaults, so copying the example files is optional when
using the defaults. Invalid values fail startup. Keep the ports distinct when
running both services on the same machine. Configure each service's `PORT` in its
own `.env`; exporting a single `PORT` before `pnpm dev` overrides both services.

## Root commands

| Command             | Purpose                                                       |
| ------------------- | ------------------------------------------------------------- |
| `pnpm dev`          | Start both services in watch mode                             |
| `pnpm build`        | Compile each service into its own `dist/` directory           |
| `pnpm lint`         | Run ESLint with type-aware TypeScript rules                   |
| `pnpm format`       | Format source, configuration, and documentation with Prettier |
| `pnpm format:check` | Check formatting without changing files                       |
| `pnpm typecheck`    | Check strict TypeScript types, including tests, without emit  |
| `pnpm test`         | Compile and run health endpoint and environment tests         |
| `pnpm check`        | Run lint, formatting check, type check, tests, and build      |

Tests use Node.js's built-in test runner, Nest's testing module, and Supertest.
The health tests start each application in-process, assert HTTP 200 and its service
identity, and close the application afterward. No Docker or external services are
required.

To run compiled applications, build first, then run these commands in separate
terminals:

```sh
pnpm build
pnpm --filter @faultlab/checkout start
pnpm --filter @faultlab/payment-provider start
```

The services enable Nest shutdown hooks for process termination.

## Layout

```text
examples/
  checkout/           # Independent NestJS service, port 3001
  payment-provider/   # Independent NestJS service, port 3002
packages/
  core/               # Reserved for future fault-injection primitives
  cli/                # Reserved for a future command-line interface
scenarios/            # Reserved for future experiment definitions
docs/                 # Reserved for future documentation
```

The reserved directories contain only purpose READMEs. They are not implemented
workspace packages yet. TypeScript strict options, ESLint, and Prettier are
configured at the root; each service has its own application, environment
validation, build configuration, and tests.

Tooling references: [NestJS](https://docs.nestjs.com/first-steps),
[pnpm workspaces](https://pnpm.io/workspaces), and
[typescript-eslint](https://typescript-eslint.io/getting-started/).
