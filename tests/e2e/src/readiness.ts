import { performance } from 'node:perf_hooks';
import { setTimeout as pollDelay } from 'node:timers/promises';

export async function waitUntil(
  description: string,
  probe: (signal: AbortSignal) => Promise<boolean>,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  let interval = 25;
  while (performance.now() < deadline) {
    signal.throwIfAborted();
    const remaining = Math.max(1, Math.ceil(deadline - performance.now()));
    const attempt = AbortSignal.any([
      signal,
      AbortSignal.timeout(Math.min(1000, remaining)),
    ]);
    if (await probe(attempt)) return;
    const pause = Math.min(interval, Math.max(0, deadline - performance.now()));
    if (pause > 0) await pollDelay(pause, undefined, { signal });
    interval = Math.min(interval * 2, 250);
  }
  throw new Error('Readiness deadline exceeded: ' + description);
}

export async function waitForService(
  url: string,
  service: string,
  signal: AbortSignal,
): Promise<void> {
  await waitUntil(
    service,
    async (attempt) => {
      try {
        const response = await fetch(url + '/health/ready', {
          signal: attempt,
        });
        const body: unknown = await response.json();
        if (!response.ok || body === null || typeof body !== 'object')
          return false;
        const health = body as Record<string, unknown>;
        return (
          health['service'] === service &&
          health['status'] === 'ok' &&
          health['database'] === 'ok'
        );
      } catch {
        return false;
      }
    },
    30_000,
    signal,
  );
}

export async function waitForUnavailable(
  url: string,
  signal: AbortSignal,
): Promise<void> {
  await waitUntil(
    'provider shutdown',
    async (attempt) => {
      try {
        const response = await fetch(url + '/health/ready', {
          signal: attempt,
        });
        await response.body?.cancel();
        return !response.ok;
      } catch {
        return true;
      }
    },
    15_000,
    signal,
  );
}
