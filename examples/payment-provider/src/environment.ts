export interface Environment {
  NODE_ENV: 'development' | 'test' | 'production';
  PORT: number;
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

  const rawPort = config['PORT'] ?? '3002';
  if (typeof rawPort !== 'string' || !/^\d+$/.test(rawPort)) {
    throw new Error('PORT must be an integer between 1 and 65535.');
  }

  const port = Number(rawPort);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('PORT must be an integer between 1 and 65535.');
  }

  return { NODE_ENV: nodeEnv, PORT: port };
}
