import assert from 'node:assert/strict';
import console from 'node:console';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import process from 'node:process';
import { Client } from 'pg';

const serviceDirectory = resolve(import.meta.dirname, '..');
const composeFile = resolve(serviceDirectory, '../../compose.test.yaml');
const project = `faultlab-charges-tests-${randomUUID().slice(0, 8)}`;
const composeArgs = [
  'compose',
  '-f',
  composeFile,
  '-p',
  project,
  '--profile',
  'charges-tests',
];

function compose(args, capture = false) {
  const result = spawnSync('docker', [...composeArgs, ...args], {
    encoding: 'utf8',
    stdio: capture ? ['ignore', 'pipe', 'inherit'] : 'inherit',
    timeout: 120_000,
  });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(`Docker Compose failed (${result.status}).`);
  return result.stdout?.trim();
}

function node(args, env) {
  const result = spawnSync(process.execPath, args, {
    cwd: serviceDirectory,
    env,
    stdio: 'inherit',
    timeout: 120_000,
  });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(`PostgreSQL test command failed (${result.status}).`);
}

async function verifyMigration(env, exists) {
  const client = new Client({
    host: env.PGHOST,
    port: Number(env.PGPORT),
    database: env.PGDATABASE,
    user: env.PGUSER,
    password: env.PGPASSWORD,
    connectionTimeoutMillis: 2000,
  });
  try {
    await client.connect();
    const result = await client.query('SELECT to_regclass($1) AS relation', [
      'payment_provider.charges',
    ]);
    assert.equal(
      result.rows[0].relation,
      exists ? 'payment_provider.charges' : null,
    );
  } finally {
    await client.end();
  }
}

try {
  compose([
    'up',
    '-d',
    '--wait',
    '--wait-timeout',
    '60',
    'payment-provider-test-db',
  ]);
  const address = compose(['port', 'payment-provider-test-db', '5432'], true);
  const match = /^127\.0\.0\.1:(\d+)$/.exec(address ?? '');
  assert.ok(match, 'Expected a PostgreSQL port published only on localhost.');
  const env = {
    ...process.env,
    NODE_ENV: 'test',
    PGQUERY_TIMEOUT_MS: '10000',
    PGHOST: '127.0.0.1',
    PGPORT: match[1],
    PGDATABASE: 'faultlab_payment_provider_test',
    PGUSER: 'faultlab_payment_provider_test',
    PGPASSWORD: 'faultlab_payment_provider_test_only',
    FAULTLAB_CHARGES_TEST_DATABASE: '1',
  };
  const migrate = (direction) =>
    node(['--require', 'ts-node/register', 'src/migrate.ts', direction], env);
  migrate('up');
  await verifyMigration(env, true);
  node(
    [
      '--test',
      'dist-test/test/database.integration.js',
      'dist-test/test/charges.postgres.js',
    ],
    env,
  );
  // The test data is disposable. Exercise rollback and reapplication on this database only.
  migrate('down');
  await verifyMigration(env, false);
  migrate('up');
  await verifyMigration(env, true);
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  try {
    compose(['down', '--volumes', '--remove-orphans']);
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
}
