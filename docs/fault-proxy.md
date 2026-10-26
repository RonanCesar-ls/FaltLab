# Observe a lost payment response

For an automated version that repeats the payment and evaluates provider evidence,
see the [duplicate-charge scenario](duplicate-charge.md). Run it exclusively;
the proxy's one-shot fault is global.

The optional packages/fault-proxy inserts one HTTP boundary:

```text
checkout :3001 -> fault-proxy :3003 -> payment-provider :3002
```

The normal application path remains checkout -> provider, including the default
Compose configuration. No service source or business rule changes are required:
checkout's existing PAYMENT_PROVIDER_URL selects the path. This guide runs both
applications and the proxy on the host, with only PostgreSQL in Docker. Run all
commands from the repository root. Examples below use PowerShell.

## Start the databases and prepare services

Use the root README's installation instructions and preserve any existing .env
files. On a fresh checkout only:

```powershell
pnpm install --frozen-lockfile
Copy-Item .env.example .env
Copy-Item examples/checkout/.env.example examples/checkout/.env
Copy-Item examples/payment-provider/.env.example examples/payment-provider/.env
```

If the full Compose applications are running, stop those two containers before
using their API ports on the host. This preserves database data:

```powershell
docker compose stop checkout payment-provider
docker compose up -d --wait checkout-db payment-provider-db
pnpm db:checkout:up
pnpm db:payment-provider:up
```

The following terminals use the default ports and credentials in the examples.
If customized, keep each service's .env aligned with its own Compose database.

Terminal 1, the real provider:

```powershell
pnpm --filter @faultlab/payment-provider dev
```

Terminal 2, the optional proxy (the upstream points to the actual provider):

```powershell
$env:PORT = '3003'
$env:PAYMENT_PROVIDER_URL = 'http://127.0.0.1:3002'
$env:UPSTREAM_TIMEOUT_MS = '5000'
pnpm dev:proxy
```

Terminal 3, checkout (only this terminal overrides its gateway):

```powershell
$env:PAYMENT_PROVIDER_URL = 'http://127.0.0.1:3003'
pnpm --filter @faultlab/checkout dev
```

Do not export PORT=3003 in checkout's terminal or export one shared PG configuration
to both services. The proxy requires no database credentials. On POSIX shells,
equivalents are `PORT=3003 PAYMENT_PROVIDER_URL=http://127.0.0.1:3002 pnpm dev:proxy`
and `PAYMENT_PROVIDER_URL=http://127.0.0.1:3003 pnpm --filter @faultlab/checkout dev`.

In a fourth terminal, verify readiness explicitly before the experiment. Repeat a
probe only if it has not succeeded yet; do not use a fixed startup sleep:

```powershell
Invoke-RestMethod -TimeoutSec 3 http://127.0.0.1:3002/health/ready
Invoke-RestMethod -TimeoutSec 3 http://127.0.0.1:3003/health
Invoke-RestMethod -TimeoutSec 3 http://127.0.0.1:3001/health/ready
```

## Create, arm, pay once, and inspect both sides

Keep unrelated charge requests stopped while the single global fault is armed.
Create a fresh order for each experiment:

```powershell
$checkout = 'http://127.0.0.1:3001'
$provider = 'http://127.0.0.1:3002'
$proxy = 'http://127.0.0.1:3003'
$paymentId = 'manual-payment-' + [guid]::NewGuid().ToString('N')
$armId = 'manual-arm-' + [guid]::NewGuid().ToString('N')

$order = Invoke-RestMethod -TimeoutSec 5 -Method Post -Uri "$checkout/orders" -ContentType 'application/json' -Body '{"amountCents":12990,"currency":"BRL"}'
Invoke-RestMethod -TimeoutSec 5 -Method Post -Uri "$proxy/__faults/drop-next-charge-response" -Headers @{ 'X-Correlation-Id' = $armId }

$failure = $null
try {
  $null = Invoke-RestMethod -TimeoutSec 5 -Method Post -Uri "$checkout/orders/$($order.id)/pay" -Headers @{ 'X-Correlation-Id' = $paymentId }
} catch {
  $failure = $_.ErrorDetails.Message | ConvertFrom-Json
}
if ($failure.statusCode -ne 503 -or $failure.code -ne 'PAYMENT_PROVIDER_UNAVAILABLE' -or $failure.correlationId -ne $paymentId) { throw 'Expected a controlled checkout error with the payment correlation ID.' }
$failure | ConvertTo-Json

$pending = Invoke-RestMethod -TimeoutSec 5 -Uri "$checkout/orders/$($order.id)"
$charges = @(Invoke-RestMethod -TimeoutSec 5 -Uri "$provider/charges?merchantReference=$($order.id)")
if ($pending.status -ne 'PENDING_PAYMENT' -or $null -ne $pending.providerChargeId) { throw 'Order did not remain pending.' }
if ($charges.Count -ne 1) { throw 'Expected exactly one persisted provider charge.' }
if ($charges[0].merchantReference -ne $order.id -or $charges[0].amountCents -ne $order.amountCents -or $charges[0].currency -ne $order.currency -or $charges[0].status -ne 'SUCCEEDED') { throw 'Charge does not match the order.' }
$pending | ConvertTo-Json
$charges | ConvertTo-Json
```

Expected observation: checkout responds 503 / PAYMENT_PROVIDER_UNAVAILABLE with
the payment correlation ID. The proxy's client socket error becomes a controlled
checkout error; the checkout HTTP connection itself remains usable. The order is
pending with no providerChargeId, while GET /charges reads one matching SUCCEEDED
charge from provider PostgreSQL. Proxy logs show fault.armed with armId, then
fault.applied with paymentId and armedCorrelationId=armId. Both applications log
the paymentId too.

Optionally inspect the provider database directly with the default Compose role
and database names (adjust if customized):

```powershell
@"
SELECT id, merchant_reference, amount_cents, currency, status
FROM payment_provider.charges
WHERE merchant_reference = '$($order.id)'::uuid;
"@ | docker compose exec -T payment-provider-db psql -U payment_provider_app -d payment_provider
```

The fault has now been consumed. With persistent idempotency, retrying the original
payment recovers the same charge and confirms PAID without another provider row:

```powershell
$paid = Invoke-RestMethod -TimeoutSec 5 -Method Post -Uri "$checkout/orders/$($order.id)/pay"
$after = @(Invoke-RestMethod -TimeoutSec 5 -Uri "$provider/charges?merchantReference=$($order.id)")
if ($paid.status -ne 'PAID' -or $after.Count -ne 1 -or $paid.providerChargeId -ne $charges[0].id -or $after[0].id -ne $charges[0].id) { throw 'Expected recovery of the original charge.' }
```

The pre-fix implementation created a second charge here. See the
[correction and migration prerequisites](idempotency.md). A fresh order can also
be paid normally without rearming. No automatic retry or exploration is performed.

## Restore the direct path and run checks

Stop checkout with Ctrl+C. In its terminal, remove the override and restart it:

```powershell
Remove-Item Env:PAYMENT_PROVIDER_URL
pnpm --filter @faultlab/checkout dev
```

Its service .env must still contain the direct URL http://127.0.0.1:3002. Stop the
proxy with Ctrl+C. To return to the full Compose stack, first stop the host
services, then follow the normal root README Compose commands. The default
Compose gateway never uses the proxy.

```sh
pnpm test:proxy
pnpm check
pnpm docker:config
pnpm test:e2e
```

Proxy tests start a controlled HTTP provider and use event/promise gates rather
than startup sleeps. They verify exact bytes/status/correlation, completed
upstream operation before connection loss, one-shot consumption, ignored errors,
concurrent completion order, truncated bodies, whole-response timeout and bounded
graceful shutdown. They need no Docker or PostgreSQL. Existing E2E remains a
regression check for the default direct path. Root test/build/type checks and CI
automatically include the new workspace package. See its
[configuration and limits](../packages/fault-proxy/README.md).
