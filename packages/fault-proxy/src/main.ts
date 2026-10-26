import { loadConfig } from './config';
import { createFaultProxy, jsonLog } from './proxy';

async function main(): Promise<void> {
  const config = loadConfig(process.env);
  const proxy = createFaultProxy(config);
  await new Promise<void>((resolve, reject) => {
    proxy.server.once('error', reject);
    proxy.server.listen(config.port, config.host, resolve);
  });
  jsonLog({
    timestamp: new Date().toISOString(),
    service: 'fault-proxy',
    level: 'info',
    event: 'proxy.started',
    correlationId: null,
    port: config.port,
  });
  const shutdown = (): void => {
    void proxy.close().catch(() => {
      jsonLog({
        timestamp: new Date().toISOString(),
        service: 'fault-proxy',
        level: 'error',
        event: 'proxy.shutdown_failed',
        correlationId: null,
      });
      process.exitCode = 1;
    });
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

void main().catch(() => {
  jsonLog({
    timestamp: new Date().toISOString(),
    service: 'fault-proxy',
    level: 'error',
    event: 'proxy.start_failed',
    correlationId: null,
  });
  process.exitCode = 1;
});
