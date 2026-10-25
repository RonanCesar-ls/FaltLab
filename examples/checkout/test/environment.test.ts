import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { validateEnvironment } from '../src/environment';

const credentials = {
  PGHOST: '127.0.0.1',
  PGDATABASE: 'checkout',
  PGUSER: 'checkout_app',
  PGPASSWORD: 'test-only',
};

void describe('checkout environment', () => {
  void it('validates service defaults and database pool limits', () => {
    const environment = validateEnvironment(credentials);
    assert.equal(environment.NODE_ENV, 'development');
    assert.equal(environment.PORT, 3001);
    assert.deepEqual(environment.payment, {
      baseUrl: 'http://127.0.0.1:3002/',
      timeoutMs: 2000,
    });
    assert.deepEqual(environment.database, {
      host: '127.0.0.1',
      port: 5433,
      database: 'checkout',
      user: 'checkout_app',
      password: 'test-only',
      max: 10,
      connectionTimeoutMillis: 2000,
      idleTimeoutMillis: 10000,
      query_timeout: 3000,
      statement_timeout: 3000,
      application_name: 'faultlab-checkout',
    });
  });

  void it('accepts explicit environment, ports and pool settings', () => {
    const environment = validateEnvironment({
      ...credentials,
      NODE_ENV: 'production',
      PORT: '4011',
      PGPORT: '5432',
      PGPOOL_MAX: '3',
      PGCONNECT_TIMEOUT_MS: '1000',
      PGQUERY_TIMEOUT_MS: '1500',
    });
    assert.equal(environment.NODE_ENV, 'production');
    assert.equal(environment.PORT, 4011);
    assert.equal(environment.database.port, 5432);
    assert.equal(environment.database.max, 3);
    assert.equal(environment.database.connectionTimeoutMillis, 1000);
    assert.equal(environment.database.statement_timeout, 1500);
  });

  void it('requires the service database credentials without logging values', () => {
    for (const key of ['PGHOST', 'PGDATABASE', 'PGUSER', 'PGPASSWORD']) {
      assert.throws(
        () => validateEnvironment({ ...credentials, [key]: '' }),
        new RegExp(key),
      );
      const config: Record<string, unknown> = { ...credentials };
      delete config[key];
      assert.throws(() => validateEnvironment(config), new RegExp(key));
    }
  });

  void it('rejects an unsupported environment', () => {
    assert.throws(
      () => validateEnvironment({ ...credentials, NODE_ENV: 'staging' }),
      /NODE_ENV/,
    );
  });

  void it('rejects invalid ports and pool timeouts', () => {
    for (const key of [
      'PORT',
      'PGPORT',
      'PGPOOL_MAX',
      'PGCONNECT_TIMEOUT_MS',
      'PGQUERY_TIMEOUT_MS',
      'PAYMENT_PROVIDER_TIMEOUT_MS',
    ]) {
      for (const value of [
        '',
        'abc',
        '0',
        '-1',
        '65536',
        '1.5',
        '3e3',
        ' 1 ',
        3001,
      ]) {
        assert.throws(
          () => validateEnvironment({ ...credentials, [key]: value }),
          new RegExp(key),
        );
      }
    }
  });

  void it('accepts an HTTP(S) provider base path and explicit timeout', () => {
    assert.deepEqual(
      validateEnvironment({
        ...credentials,
        PAYMENT_PROVIDER_URL: 'https://payments.example.test/api',
        PAYMENT_PROVIDER_TIMEOUT_MS: '1500',
      }).payment,
      { baseUrl: 'https://payments.example.test/api/', timeoutMs: 1500 },
    );
  });

  void it('rejects invalid provider URLs and embedded credentials', () => {
    for (const url of [
      '',
      123,
      'not-a-url',
      'ftp://host',
      'http://user:secret@host',
      'http://host?token=secret',
      'http://host/#secret',
    ]) {
      assert.throws(
        () =>
          validateEnvironment({ ...credentials, PAYMENT_PROVIDER_URL: url }),
        /PAYMENT_PROVIDER_URL/,
      );
    }
  });
});
