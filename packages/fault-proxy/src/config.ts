export interface ProxyConfig {
  host: string;
  port: number;
  providerUrl: URL;
  timeoutMs: number;
  shutdownTimeoutMs: number;
}

function integer(value: string, name: string, maximum: number): number {
  if (!/^[1-9]\d*$/.test(value) || Number(value) > maximum)
    throw new Error('Invalid configuration: ' + name);
  return Number(value);
}

export function loadConfig(env: NodeJS.ProcessEnv): ProxyConfig {
  const host = env['HOST'] ?? '127.0.0.1';
  if (!host || /[\s/\\]/.test(host))
    throw new Error('Invalid configuration: HOST');
  let providerUrl: URL;
  try {
    providerUrl = new URL(
      env['PAYMENT_PROVIDER_URL'] ?? 'http://127.0.0.1:3002',
    );
  } catch {
    throw new Error('Invalid configuration: PAYMENT_PROVIDER_URL');
  }
  if (
    !['http:', 'https:'].includes(providerUrl.protocol) ||
    providerUrl.username ||
    providerUrl.password ||
    providerUrl.search ||
    providerUrl.hash
  )
    throw new Error('Invalid configuration: PAYMENT_PROVIDER_URL');
  return {
    host,
    port: integer(env['PORT'] ?? '3003', 'PORT', 65535),
    providerUrl,
    timeoutMs: integer(
      env['UPSTREAM_TIMEOUT_MS'] ?? '5000',
      'UPSTREAM_TIMEOUT_MS',
      60000,
    ),
    shutdownTimeoutMs: integer(
      env['SHUTDOWN_TIMEOUT_MS'] ?? '10000',
      'SHUTDOWN_TIMEOUT_MS',
      60000,
    ),
  };
}
