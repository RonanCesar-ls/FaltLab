import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { Pool } from 'pg';
import { JsonLogger } from './observability/json-logger';
import type { Environment } from './environment';
import { DATABASE_POOL, DatabaseService } from './database.service';

@Module({
  imports: [ConfigModule],
  providers: [
    {
      provide: DATABASE_POOL,
      inject: [ConfigService, JsonLogger],
      useFactory: (
        config: ConfigService<Environment, true>,
        logger: JsonLogger,
      ): Pool => {
        const pool = new Pool(config.get('database', { infer: true }));
        pool.on('error', () => {
          logger.event(
            'database.connection_failed',
            { code: 'DATABASE_CONNECTION_FAILED' },
            'warn',
            null,
          );
        });
        return pool;
      },
    },
    DatabaseService,
  ],
  exports: [DatabaseService],
})
export class DatabaseModule {}
