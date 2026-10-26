# Duplicate-charge scenario

Rule: **an order may have at most one SUCCEEDED provider charge**.
The experiment observes current behavior without changing payment rules or
forcing a duplicate. GET /charges?merchantReference=<orderId> supplies charge
evidence. Logs and the checkout status never determine the charge count.

## Prerequisites and command

Follow the root README to install dependencies, start both PostgreSQL databases
and apply migrations. Then follow the
[host services/proxy setup](fault-proxy.md#start-the-databases-and-prepare-services).
Checkout must start with PAYMENT_PROVIDER_URL=http://127.0.0.1:3003; the proxy's
upstream remains http://127.0.0.1:3002. Restart checkout after changing its environment.
The default full Compose stack still routes directly and does not prepare this experiment.

Run **without other payments or concurrent scenarios**. The proxy's fault is a
global, in-memory single-use flag. Do not manually arm it first; the scenario
arms it. A fresh proxy process is recommended. If execution stops after arming,
restart the proxy before unrelated payments: there is no reset/status API or
per-order fault reservation in this version.

From the repository root, where pnpm-workspace.yaml is located:

```sh
pnpm install --frozen-lockfile
pnpm build:runner
pnpm faultlab duplicate-charge
```

Service terminals (each block in a separate shell):

```powershell
# Terminal 1
pnpm --filter @faultlab/payment-provider dev

# Terminal 2
$env:PAYMENT_PROVIDER_URL = 'http://127.0.0.1:3002'
$env:PORT = '3003'
pnpm dev:proxy

# Terminal 3: keep checkout's own PORT and PG configuration
$env:PAYMENT_PROVIDER_URL = 'http://127.0.0.1:3003'
pnpm --filter @faultlab/checkout dev
```

Run the scenario in a fourth terminal. It needs no database credentials and does
not implicitly load .env files. Its optional environment configuration is:

| Variable                    | Default                  | Meaning                                                 |
| --------------------------- | ------------------------ | ------------------------------------------------------- |
| FAULTLAB_CHECKOUT_URL       | http://127.0.0.1:3001    | Checkout HTTP base                                      |
| FAULTLAB_PROVIDER_URL       | http://127.0.0.1:3002    | Actual provider HTTP base                               |
| FAULTLAB_PROXY_URL          | http://127.0.0.1:3003    | Proxy control HTTP base                                 |
| FAULTLAB_REQUEST_TIMEOUT_MS | 5000                     | Each complete HTTP exchange, 1..60000 ms                |
| FAULTLAB_READY_TIMEOUT_MS   | 30000                    | Combined readiness deadline, 1..120000 ms               |
| FAULTLAB_REPORT_DIR         | reports/duplicate-charge | Absolute path or relative to invoking working directory |

URLs support HTTP(S) and base paths, without credentials, query or fragment.
The run has a 180-second total deadline. Readiness verifies checkout /health/ready,
provider /health/ready and proxy /health identities. Probes use bounded backoff
only after failure; there are no fixed startup sleeps or automatic retries of
state-changing requests.

## Steps and outcomes

1. Check readiness with a maximum deadline.
2. POST a fresh order (12990 cents, BRL).
3. Arm the next lost charge response.
4. Request payment once and record the checkout response.
5. Read the order and provider charges for its exact reference.
6. Verify preparation: a lost-confirmation 503/504, pending order and one charge.
7. Submit the second payment with normal forwarding.
8. Read the order and provider charges again.
9. Evaluate at most one distinct SUCCEEDED provider record.

| Outcome      | Exit | Meaning                                                                               |
| ------------ | ---- | ------------------------------------------------------------------------------------- |
| satisfied    | 0    | Prepared experiment, second payment confirmed, one charge remains                     |
| violated     | 1    | Final provider evidence contains more than one SUCCEEDED charge                       |
| inconclusive | 2    | Preparation, infrastructure, validation, cancellation or storage prevented completion |

Current services are expected to expose one charge while pending, then a second
charge and a PAID order. A detected violation is a valid experiment result.
pnpm may print ELIFECYCLE for the intentional exit 1; use
`node packages/cli/dist/main.js duplicate-charge` to avoid wrapper output.
In PowerShell, capture $LASTEXITCODE immediately after invoking the command.

If a prepared experiment instead confirms the second payment with one charge,
the CLI reports satisfied and records that behavior. It never changes the
application to force duplication. A first payment that succeeds normally (e.g.
checkout bypassed the proxy) is recorded but makes preparation inconclusive with
LOST_RESPONSE_NOT_OBSERVED. Unexpected initial charge counts are also inconclusive.
After valid preparation, two final provider records prove a violation even if
the second checkout response was an error or the order remained pending.

Each run has a fresh runId and server-generated order ID. Charge records must
have distinct UUIDs and match the order reference, amount, currency and SUCCEEDED
status. The initial charge must remain present in the final observation. Invalid
or ambiguous evidence is inconclusive. The CLI never reads SQL or deletes data;
repeated runs leave independent synthetic records for inspection.

## JSON report

Terminal output shows steps, conclusion, rule count, run ID and report path.
Reports have schemaVersion: 1 and include:

- runId, scenario, timestamps and outcome.
- timeline with attempted step IDs/titles, start/end, status and safe failure codes.
- rule ID/description/status, observed actual count and expected maximum;
  inconclusive executions use not_evaluated.
- evidence.ids.orderId and correlation IDs in evidence.responses.
- HTTP statuses and allowlisted relevant responses, including both payment attempts.
- evidence.afterLostResponse and evidence.afterSecondPayment with stored order
  snapshots and actual provider charge records/IDs/timestamps.
- evidence.preparation and safe failure information for incomplete runs.

URLs, environment dumps, authorization/cookie headers, PG credentials, stack
traces and raw exceptions are omitted. Unknown fields are discarded and HTTP
error messages normalized. Inconclusive runs retain validated evidence already
collected. Unique filenames are never overwritten; generated reports/ folders are
Git-ignored. Unwritable storage prints REPORT_WRITE_FAILED and exits 2; no JSON
file can be guaranteed without writable storage.

## Verification

```sh
pnpm check
pnpm test:scenario
pnpm test:e2e
```

pnpm check includes executor, scenario contract and CLI reporting tests. Root
lint/type/test commands first build the runner dependencies so linked TypeScript
declarations are available on a fresh checkout.

pnpm test:scenario provisions real checkout/provider/proxy containers and two real
PostgreSQL instances in an isolated random Compose project, with tmpfs data and
random loopback ports. It runs the actual CLI twice, accepts the expected exit 1
and independently compares reported records with provider SQL persistence. Both
order/run IDs must be unique. Expected duplicate detection makes the test pass.
Cleanup removes only that project's resources and preserves development volumes.
Reports/logs remain in Git-ignored tests/e2e/artifacts. The existing pnpm test:e2e
is a direct-path regression suite. CI runs both. Missing Docker explicitly fails
Docker-dependent commands.

No replay, random generation, shrinking, concurrent scheduler, distributed
idempotency or automatic recovery is implemented.
