import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { validateEnvironment } from '../src/environment';

void describe('Payment provider environment', () => {
  void it('defaults to development and port 3002', () => {
    assert.deepEqual(validateEnvironment({}), {
      NODE_ENV: 'development',
      PORT: 3002,
    });
  });

  void it('accepts an explicit environment and port', () => {
    assert.deepEqual(
      validateEnvironment({ NODE_ENV: 'production', PORT: '4012' }),
      {
        NODE_ENV: 'production',
        PORT: 4012,
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
      '3002.5',
      '3e3',
      ' 3002 ',
      3002,
    ]) {
      assert.throws(() => validateEnvironment({ PORT: port }), /PORT/);
    }
  });
});
