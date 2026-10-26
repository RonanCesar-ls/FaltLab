import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
  void it('cancels an owned command together with its subprocesses', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'faultlab-e2e-process-'));
    const pidFile = join(directory, 'child.pid');
    const controller = new AbortController();
    const result = command(
      process.execPath,
      [
        '-e',
        `const {spawn}=require('node:child_process');
const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});
require('node:fs').writeFileSync(process.argv[1],String(child.pid));
setInterval(()=>{},1000);`,
        pidFile,
      ],
      { cwd: process.cwd(), signal: controller.signal, capture: true },
    ).then(
      () => new Error('Command unexpectedly succeeded.'),
      (error: unknown) => error,
    );
    try {
      let pid = 0;
      await waitUntil(
        'owned subprocess started',
        async () => {
          try {
            pid = Number(await readFile(pidFile, 'utf8'));
            return Number.isInteger(pid) && pid > 0;
          } catch {
            return false;
          }
        },
        5000,
        controller.signal,
      );
      controller.abort();
      assert.match(String(await result), /deadline/);
      await waitUntil(
        'owned subprocess stopped',
        () => {
          try {
            process.kill(pid, 0);
            return Promise.resolve(false);
          } catch (error) {
            return Promise.resolve(
              (error as NodeJS.ErrnoException).code === 'ESRCH',
            );
          }
        },
        5000,
        new AbortController().signal,
      );
    } finally {
      controller.abort();
      await result;
      await rm(pidFile, { force: true });
      await rmdir(directory);
    }
  });
});
