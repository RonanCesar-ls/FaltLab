import { loadEnvFile } from 'node:process';
import { resolve } from 'node:path';
import { validateEnvironment } from './environment';

async function main(): Promise<void> {
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
    migrationsSchema: 'public',
    direction,
    ...(direction === 'down' ? { count: 1 } : {}),
    singleTransaction: true,
  });
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Migration failed.');
  process.exitCode = 1;
});
