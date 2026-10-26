import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { command } from './command';
import { waitUntil } from './readiness';
import { assertTestProject, localPort, newProject } from './safety';

void describe('E2E harness safety and readiness deadlines (no Docker required)', () => {
  void it('allows only unique E2E-owned project names', () => {
    const first = newProject();
    const second = newProject();
    assertTestProject(first);
    assertTestProject(second);
    assert.notEqual(first, second);
    for (const value of [
      'faultlab',
      'faultlab-checkout-tests-123',
      'faultlab-e2e-dev',
      'other-project',
    ])
      assert.throws(() => assertTestProject(value));
  });
  void it('accepts only an explicitly loopback-bound published port', () => {
    assert.equal(localPort('127.0.0.1:49152\n'), 49152);
    for (const value of [
      '0.0.0.0:49152',
      '[::]:49152',
      '127.0.0.1:0',
      '127.0.0.1:65536',
      'localhost:5432',
    ])
      assert.throws(() => localPort(value));
  });
  void it('continues only after a readiness probe succeeds', async () => {
    let attempts = 0;
    await waitUntil(
      'test service',
      () => Promise.resolve(++attempts === 2),
      500,
      new AbortController().signal,
    );
    assert.equal(attempts, 2);
  });
  void it('fails a permanently unready service at its deadline', async () => {
    await assert.rejects(
      waitUntil(
        'unready service',
        () => Promise.resolve(false),
        20,
        new AbortController().signal,
      ),
      /deadline exceeded/,
    );
  });
  void it('honors cancellation without starting commands or readiness work', async () => {
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      command(process.execPath, ['-e', 'process.exit(0)'], {
        cwd: process.cwd(),
        signal: controller.signal,
      }),
      /aborted/,
    );
    await assert.rejects(
      waitUntil(
        'cancelled service',
        () => Promise.resolve(true),
        500,
        controller.signal,
      ),
    );
  });
  void it('terminates and reaps an owned child process that exceeds its deadline', async () => {
    await assert.rejects(
      command(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
        cwd: process.cwd(),
        timeoutMs: 100,
        capture: true,
      }),
      /deadline/,
    );
  });
});
