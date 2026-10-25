import { JsonLogger, stdoutLogSink } from './observability/json-logger';
import { RequestContext } from './observability/request-context';
import { loadEnvFile } from 'node:process';
import { resolve } from 'node:path';
import { validateEnvironment } from './environment';

const logger = new JsonLogger(new RequestContext(), stdoutLogSink);

async function main(): Promise<void> {
  logger.event('migration.started');
  const direction = process.argv[2];
  if (direction !== 'up' && direction !== 'down') {
    throw new Error('Usage: migrate <up|down>');
  }
  try {
    loadEnvFile('.env');
  } catch (error: unknown) {
    if (!(
      error instanceof Error &&
      'code' in error &&
      error.code === 'ENOENT'
    )) {
      throw error;
    }
  }
  const environment = validateEnvironment(process.env);
  const { runner } = await import('node-pg-migrate');
  await runner({
    databaseUrl: environment.database,
    dir: resolve(__dirname, '../migrations'),
    migrationsTable: 'pgmigrations',
    logger: {
      info: () => undefined,
      warn: () =>
        logger.event('application.log', { code: 'MIGRATION_WARNING' }, 'warn'),
      error: () => undefined,
    },
    migrationsSchema: 'public',
    direction,
    ...(direction === 'down' ? { count: 1 } : {}),
    singleTransaction: true,
  });
  logger.event('migration.completed');
}

main().catch(() => {
  logger.event('migration.failed', { code: 'MIGRATION_FAILED' }, 'error');
  process.exitCode = 1;
});
