import 'reflect-metadata';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import type { Environment } from './environment';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  const config = app.get(ConfigService<Environment, true>);
  app.enableShutdownHooks();
  await app.listen(config.get('PORT', { infer: true }));
}

bootstrap().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
