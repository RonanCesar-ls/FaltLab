import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { loadConfig } from '../src/config';

void describe('Fault proxy environment', () => {
  void it('defaults to a loopback-only proxy and the direct local provider', () => {
    const config = loadConfig({});
    assert.equal(config.host, '127.0.0.1');
    assert.equal(config.port, 3003);
    assert.equal(config.providerUrl.href, 'http://127.0.0.1:3002/');
    assert.equal(config.timeoutMs, 5000);
    assert.equal(config.shutdownTimeoutMs, 10000);
  });
  void it('accepts configured HTTP(S) upstreams, ports and deadlines', () => {
    const config = loadConfig({
      PORT: '3103',
      PAYMENT_PROVIDER_URL: 'https://provider.example/base/',
      UPSTREAM_TIMEOUT_MS: '7000',
      SHUTDOWN_TIMEOUT_MS: '9000',
    });
    assert.equal(config.port, 3103);
    assert.equal(config.providerUrl.href, 'https://provider.example/base/');
    assert.equal(config.timeoutMs, 7000);
    assert.equal(config.shutdownTimeoutMs, 9000);
  });
  void it('rejects invalid values without echoing credentials', () => {
    for (const env of [
      { PORT: '0' },
      { PORT: '65536' },
      { PORT: '3003.5' },
      { UPSTREAM_TIMEOUT_MS: '0' },
      { SHUTDOWN_TIMEOUT_MS: 'Infinity' },
      { PAYMENT_PROVIDER_URL: 'ftp://provider.example' },
      { PAYMENT_PROVIDER_URL: 'http://user:private-secret@provider.example' },
      { PAYMENT_PROVIDER_URL: 'http://provider.example?token=secret' },
      { PAYMENT_PROVIDER_URL: 'http://provider.example#fragment' },
    ])
      assert.throws(
        () => loadConfig(env),
        (error: unknown) =>
          error instanceof Error &&
          error.message.startsWith('Invalid configuration:') &&
          !error.message.includes('secret'),
      );
  });
});
