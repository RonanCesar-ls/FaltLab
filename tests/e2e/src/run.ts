import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { command } from './command';
import { waitForService, waitForUnavailable } from './readiness';
import {
  assertIsolatedCompose,
  assertTestProject,
  localPort,
  newProject,
} from './safety';

const packageDirectory = resolve(__dirname, '..');
const repository = resolve(packageDirectory, '../..');
const project = newProject();
const artifacts = resolve(packageDirectory, 'artifacts', project);
const controller = new AbortController();
let interrupted: 'SIGINT' | 'SIGTERM' | undefined;
const onInterrupt = (): void => {
  interrupted = 'SIGINT';
  controller.abort();
};
const onTerminate = (): void => {
  interrupted = 'SIGTERM';
  controller.abort();
};
process.once('SIGINT', onInterrupt);
process.once('SIGTERM', onTerminate);
const totalDeadline = setTimeout(() => controller.abort(), 600_000);

function compose(args: string[], cleanup = false): Promise<string> {
  assertTestProject(project);
  return command(
    'docker',
    [
      'compose',
      '--env-file',
      resolve(packageDirectory, '.env.example'),
      '-f',
      resolve(packageDirectory, 'compose.yaml'),
      '-p',
      project,
      ...args,
    ],
    {
      cwd: repository,
      timeoutMs: cleanup ? 60_000 : 300_000,
      capture: args[0] !== 'up',
      ...(cleanup ? {} : { signal: controller.signal }),
    },
  );
}

async function saveLogs(): Promise<void> {
  await mkdir(artifacts, { recursive: true });
  const logs = await compose(
    ['logs', '--no-color', '--no-log-prefix', 'checkout', 'payment-provider'],
    true,
  );
  await writeFile(resolve(artifacts, 'services.log'), logs + '\n');
}

async function runTests(file: string, env: NodeJS.ProcessEnv): Promise<void> {
  // Direct node:test execution keeps each test module in this owned child, with no forked grandchildren.
  await command(process.execPath, [resolve(__dirname, file)], {
    cwd: packageDirectory,
    env,
    signal: controller.signal,
    timeoutMs: 120_000,
  });
}

async function main(): Promise<void> {
  console.log(JSON.stringify({ event: 'e2e.starting', project }));
  await mkdir(artifacts, { recursive: true });
  let ownsResources = false;
  try {
    const config: unknown = JSON.parse(
      await compose(['config', '--format', 'json']),
    );
    assertIsolatedCompose(config);
    ownsResources = true;
    await compose(['up', '-d', '--build', '--wait', '--wait-timeout', '120']);
    const checkoutUrl =
      'http://127.0.0.1:' +
      localPort(await compose(['port', 'checkout', '3001']));
    const providerUrl =
      'http://127.0.0.1:' +
      localPort(await compose(['port', 'payment-provider', '3002']));
    const providerPort = localPort(
      await compose(['port', 'provider-db', '5432']),
    );
    await compose(['exec', '-T', 'checkout', 'node', 'dist/migrate.js', 'up']);
    await compose([
      'exec',
      '-T',
      'payment-provider',
      'node',
      'dist/migrate.js',
      'up',
    ]);
    await Promise.all([
      waitForService(checkoutUrl, 'checkout', controller.signal),
      waitForService(providerUrl, 'payment-provider', controller.signal),
    ]);
    console.log(JSON.stringify({ event: 'e2e.ready', project }));
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      E2E_PROJECT: project,
      E2E_CHECKOUT_URL: checkoutUrl,
      E2E_PROVIDER_URL: providerUrl,
      E2E_PROVIDER_PGPORT: String(providerPort),
    };
    await runTests('payment.e2e.js', env);
    await saveLogs();
    await runTests('correlation.e2e.js', env);
    await compose(['stop', '--timeout', '10', 'payment-provider']);
    await waitForUnavailable(providerUrl, controller.signal);
    await runTests('outage.e2e.js', env);
    console.log(JSON.stringify({ event: 'e2e.passed', project }));
  } finally {
    if (ownsResources) {
      try {
        await saveLogs();
      } catch (error) {
        console.error('Could not capture E2E logs:', error);
      }
      // Never use the cancelled run signal for cleanup. Only this random project's resources are removed.
      await compose(
        ['down', '--volumes', '--remove-orphans', '--timeout', '10'],
        true,
      );
      const remaining = await command(
        'docker',
        [
          'ps',
          '-aq',
          '--filter',
          'label=com.docker.compose.project=' + project,
        ],
        { cwd: repository, capture: true, timeoutMs: 10_000 },
      );
      assert.equal(remaining, '', 'An owned E2E container survived cleanup.');
      console.log(JSON.stringify({ event: 'e2e.cleaned', project }));
    }
  }
}

main()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode =
      interrupted === 'SIGINT' ? 130 : interrupted === 'SIGTERM' ? 143 : 1;
  })
  .finally(() => {
    clearTimeout(totalDeadline);
    process.removeListener('SIGINT', onInterrupt);
    process.removeListener('SIGTERM', onTerminate);
  });
