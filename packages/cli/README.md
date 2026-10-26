# CLI

From the repository root:

```sh
pnpm install --frozen-lockfile
pnpm build:runner
pnpm faultlab duplicate-charge
```

Prepare the real services and route checkout through the proxy first. See the
[scenario guide](../../docs/duplicate-charge.md) for prerequisites and exclusivity.
The CLI selects a definition from @faultlab/scenarios; the core stays generic.

Exit codes: 0 satisfied, 1 violated, 2 inconclusive. A detected violation is not a
CLI crash. Versioned reports go to reports/duplicate-charge/<runId>.json by default.
The CLI never loads application .env files, accepts PG credentials or deletes data.
The optional .env.example lists configuration. Load it explicitly with
`node --env-file=packages/cli/.env packages/cli/dist/main.js duplicate-charge`.

SIGINT/SIGTERM abort HTTP work and attempt to save an inconclusive report. If
storage is unwritable, REPORT_WRITE_FAILED is printed and exit 2 is returned;
a JSON file cannot be guaranteed without writable storage. Reports are never overwritten.
