# Fault proxy

An independent TypeScript package using Node.js HTTP/HTTPS only. It is an opt-in
reverse proxy for observing a lost payment confirmation after the provider has
finished its response. It has no database, NestJS dependency or retry mechanism.

From the repository root:

```sh
pnpm install --frozen-lockfile
pnpm dev:proxy
pnpm test:proxy
```

`dev:proxy` compiles once and starts the server. For a compiled start, use
`pnpm --filter @faultlab/fault-proxy build`, then
`pnpm --filter @faultlab/fault-proxy start`. Ctrl+C/SIGTERM stops accepting new
requests and drains in-flight exchanges under the shutdown deadline.

Copy this package's .env.example to .env to customize it; existing shell variables
take precedence. The package loads only its own .env. It receives no PG credentials.

| Variable             | Default               | Meaning                                                                   |
| -------------------- | --------------------- | ------------------------------------------------------------------------- |
| HOST                 | 127.0.0.1             | Listening address; loopback by default                                    |
| PORT                 | 3003                  | TCP port, 1..65535                                                        |
| PAYMENT_PROVIDER_URL | http://127.0.0.1:3002 | Fixed HTTP(S) upstream; optional base path, no credentials/query/fragment |
| UPSTREAM_TIMEOUT_MS  | 5000                  | Total upstream exchange deadline, including body receipt, 1..60000        |
| SHUTDOWN_TIMEOUT_MS  | 10000                 | Grace period before destroying remaining connections, 1..60000            |

The proxy's PAYMENT_PROVIDER_URL points to the **actual provider**. Checkout's
PAYMENT_PROVIDER_URL points to the proxy only when explicitly enabled. Do not
point the proxy at itself. GET /health returns HTTP 200 and
`{"status":"ok","service":"fault-proxy"}`; it checks the proxy process, not the upstream.

## One-shot fault

POST /__faults/drop-next-charge-response returns HTTP 200 with `{"armed":true}`.
It arms a single in-memory flag. Arming again while armed is idempotent and does
not queue a second fault. Restarting the proxy clears the flag.

The next fully received HTTP 201 response to POST /charges (query strings allowed)
consumes the flag and destroys the caller connection without sending response
headers or body. The upstream request is sent normally. The proxy waits for the
complete response body before applying the fault; it never uses this fault to
cancel the upstream request. Completion uses Node's
[IncomingMessage.complete](https://nodejs.org/api/http.html#messagecomplete)
after the response end event. A controlled provider test verifies that the
operation is recorded and its response finishes before the client gets ECONNRESET.
For the real provider, HTTP 201 follows its PostgreSQL write confirmation.

Errors, non-201 responses, other methods/paths, truncated responses and upstream
timeouts do not consume the flag. With concurrent charges, the first eligible
response to finish while armed is dropped. It is not targeted to an order or a
correlation ID. The following successful responses are forwarded normally.

Normal forwarding preserves request/response bytes, status and end-to-end
headers, including X-Correlation-Id. Host is rewritten for the upstream and
hop-by-hop headers are removed. POST /charges responses with status 201 are
buffered until complete, even when unarmed, with a 1 MiB limit; larger responses
produce 502 / PROXY_RESPONSE_TOO_LARGE without consuming the fault. Other
responses stream. This is an HTTP/1 payment demonstrator, not a WebSocket,
tunnelling or unlimited streaming proxy.

Correlation IDs follow the service format (1..64 ASCII letters/digits/dot/hyphen/
underscore, starting with a letter/digit). Missing IDs generate a UUID and are
forwarded; invalid/duplicate IDs return 400 before forwarding or arming. Responses
preserve the upstream ID, or use the proxy request ID if the upstream omits it.
JSON events fault.armed and fault.applied contain correlationId. The latter also
contains armedCorrelationId to link the control request with the affected payment.
Logs omit bodies, URLs, credentials and raw exceptions.

Connection/protocol failures return 502 / PROXY_UPSTREAM_ERROR when headers have
not been sent. The configured deadline returns 504 / PROXY_UPSTREAM_TIMEOUT;
an already-started streamed response instead has its connection closed. Proxy
errors use statusCode, code, message and correlationId. An intentional drop emits
no HTTP response at all. A caller may disconnect before the upstream deadline;
the proxy still drains the upstream response. Graceful shutdown waits for these
exchanges too, then forcibly closes remaining connections at its own deadline.

The unauthenticated control endpoint is intended for a local test environment.
Keep the default loopback binding. This package observes the existing ambiguity;
checkout/provider enforce persistent idempotency independently of this transport
component. It does not retry or perform recovery itself. See the
[manual experiment](../../docs/fault-proxy.md) for the real services.
