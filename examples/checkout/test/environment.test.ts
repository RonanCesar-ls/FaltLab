import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { validateEnvironment } from '../src/environment';

void describe('Checkout environment', () => {
  void it('defaults to development and port 3001', () => {
    assert.deepEqual(validateEnvironment({}), {
      NODE_ENV: 'development',
      PORT: 3001,
    });
  });

  void it('accepts an explicit environment and port', () => {
    assert.deepEqual(
      validateEnvironment({ NODE_ENV: 'production', PORT: '4011' }),
      {
        NODE_ENV: 'production',
        PORT: 4011,
      },
    );
  });

  void it('rejects an unsupported environment', () => {
    assert.throws(
      () => validateEnvironment({ NODE_ENV: 'staging' }),
      /NODE_ENV/,
    );
  });

  void it('rejects invalid ports', () => {
    for (const port of [
      '',
      'abc',
      '0',
      '-1',
      '65536',
      '3001.5',
      '3e3',
      ' 3001 ',
      3001,
    ]) {
      assert.throws(() => validateEnvironment({ PORT: port }), /PORT/);
    }
  });
});
