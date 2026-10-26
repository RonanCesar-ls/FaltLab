import { ExecutionFailure } from '@faultlab/core';

export interface ScenarioConfig {
  checkoutUrl: URL;
  providerUrl: URL;
  proxyUrl: URL;
  requestTimeoutMs: number;
  readyTimeoutMs: number;
}
function url(value: string): URL {
  try {
    const parsed = new URL(value);
    if (
      !['http:', 'https:'].includes(parsed.protocol) ||
      parsed.username ||
      parsed.password ||
      parsed.search ||
      parsed.hash
    )
      throw new Error();
    if (!parsed.pathname.endsWith('/')) parsed.pathname += '/';
    return parsed;
  } catch {
    throw new ExecutionFailure('INVALID_CONFIGURATION');
  }
}
function duration(value: string, maximum: number): number {
  if (!/^[1-9]\d*$/.test(value) || Number(value) > maximum)
    throw new ExecutionFailure('INVALID_CONFIGURATION');
  return Number(value);
}
export function loadConfig(env: NodeJS.ProcessEnv): ScenarioConfig {
  return {
    checkoutUrl: url(env['FAULTLAB_CHECKOUT_URL'] ?? 'http://127.0.0.1:3001'),
    providerUrl: url(env['FAULTLAB_PROVIDER_URL'] ?? 'http://127.0.0.1:3002'),
    proxyUrl: url(env['FAULTLAB_PROXY_URL'] ?? 'http://127.0.0.1:3003'),
    requestTimeoutMs: duration(
      env['FAULTLAB_REQUEST_TIMEOUT_MS'] ?? '5000',
      60000,
    ),
    readyTimeoutMs: duration(
      env['FAULTLAB_READY_TIMEOUT_MS'] ?? '30000',
      120000,
    ),
  };
}
