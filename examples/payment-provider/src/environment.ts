import type { PoolConfig } from 'pg';

export interface Environment {
  NODE_ENV: 'development' | 'test' | 'production';
  PORT: number;
  database: PoolConfig & { database: string; user: string };
}

function integer(
  config: Record<string, unknown>,
  key: string,
  fallback: number,
  max: number,
): number {
  const raw = config[key] ?? String(fallback);
  if (typeof raw !== 'string' || !/^\d+$/.test(raw)) {
    throw new Error(
      key + ' must be a positive integer no greater than ' + max + '.',
    );
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || value > max) {
    throw new Error(
      key + ' must be a positive integer no greater than ' + max + '.',
    );
  }
  return value;
}

function required(config: Record<string, unknown>, key: string): string {
  const value = config[key];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(key + ' is required.');
  }
  return value;
}

export function validateEnvironment(
  config: Record<string, unknown>,
): Environment {
  const nodeEnv = config['NODE_ENV'] ?? 'development';
  if (
    nodeEnv !== 'development' &&
    nodeEnv !== 'test' &&
    nodeEnv !== 'production'
  ) {
    throw new Error('NODE_ENV must be development, test, or production.');
  }
  const queryTimeout = integer(config, 'PGQUERY_TIMEOUT_MS', 3000, 60000);
  return {
    NODE_ENV: nodeEnv,
    PORT: integer(config, 'PORT', 3002, 65535),
    database: {
      host: required(config, 'PGHOST'),
      port: integer(config, 'PGPORT', 5434, 65535),
      database: required(config, 'PGDATABASE'),
      user: required(config, 'PGUSER'),
      password: required(config, 'PGPASSWORD'),
      max: integer(config, 'PGPOOL_MAX', 10, 100),
      connectionTimeoutMillis: integer(
        config,
        'PGCONNECT_TIMEOUT_MS',
        2000,
        60000,
      ),
      idleTimeoutMillis: 10000,
      query_timeout: queryTimeout,
      statement_timeout: queryTimeout,
      application_name: 'faultlab-payment-provider',
    },
  };
}
