import 'reflect-metadata';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { createRequire } from 'node:module';
import type { Environment } from './environment';
import { configureHttpApplication } from './observability/configure-http';
import { JsonLogger, stdoutLogSink } from './observability/json-logger';
import { RequestContext } from './observability/request-context';

const startupLogger = new JsonLogger(new RequestContext(), stdoutLogSink);
async function bootstrap(): Promise<void> {
  // Defer environment validation until it is covered by the sanitized startup error handler.
  const requireApp = createRequire(__filename);
  const { AppModule } = requireApp(
    './app.module',
  ) as typeof import('./app.module');
  const app = await NestFactory.create(AppModule, {
    logger: startupLogger,
    abortOnError: false,
  });
  configureHttpApplication(app);
  const config = app.get(ConfigService<Environment, true>);
  app.enableShutdownHooks();
  const port = config.get('PORT', { infer: true });
  await app.listen(port);
  app.get(JsonLogger).event('application.started', { port });
}
bootstrap().catch(() => {
  startupLogger.event(
    'application.failed',
    { code: 'APPLICATION_STARTUP_FAILED' },
    'error',
  );
  process.exitCode = 1;
});
