import { ExecutionFailure } from '@faultlab/core';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';

export interface HttpResult {
  status: number;
  correlationId: string;
  body: unknown;
}
export async function exchange(
  http: typeof fetch,
  base: URL,
  path: string,
  correlationId: string,
  timeoutMs: number,
  signal: AbortSignal,
  method = 'GET',
  body?: unknown,
): Promise<HttpResult> {
  try {
    const response = await http(new URL(path, base), {
      method,
      redirect: 'manual',
      headers: {
        'x-correlation-id': correlationId,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]),
    });
    if (response.headers.get('x-correlation-id') !== correlationId) {
      await response.body?.cancel();
      throw new ExecutionFailure('INVALID_CORRELATION_RESPONSE');
    }
    // All persisted data is separately parsed through domain allowlists.
    const reader = response.body?.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    if (reader) {
      try {
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) break;
          const bytes: unknown = chunk.value;
          if (!(bytes instanceof Uint8Array))
            throw new ExecutionFailure('INVALID_HTTP_RESPONSE');
          size += bytes.length;
          if (size > 1024 * 1024) {
            await reader.cancel();
            throw new ExecutionFailure('HTTP_RESPONSE_TOO_LARGE');
          }
          chunks.push(bytes);
        }
      } finally {
        reader.releaseLock();
      }
    }
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    return { status: response.status, correlationId, body: parsed };
  } catch (error) {
    if (error instanceof ExecutionFailure) throw error;
    throw new ExecutionFailure('HTTP_EXCHANGE_FAILED');
  }
}

export async function ready(
  probe: (signal: AbortSignal, remaining: number) => Promise<boolean>,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<void> {
  const end = performance.now() + timeoutMs;
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]);
  let interval = 25;
  while (performance.now() < end && !deadline.aborted) {
    const remaining = Math.max(1, Math.ceil(end - performance.now()));
    if (await probe(deadline, remaining)) return;
    const pause = Math.min(interval, Math.max(0, end - performance.now()));
    if (pause > 0) {
      try {
        await delay(pause, undefined, { signal: deadline });
      } catch {
        break;
      }
    }
    interval = Math.min(interval * 2, 250);
  }
  throw new ExecutionFailure('READINESS_DEADLINE_EXCEEDED');
}
