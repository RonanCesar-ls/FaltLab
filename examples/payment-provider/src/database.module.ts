import { Logger, Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { Pool } from 'pg';
import type { Environment } from './environment';
import { DATABASE_POOL, DatabaseService } from './database.service';

@Module({
  imports: [ConfigModule],
  providers: [
    {
      provide: DATABASE_POOL,
      inject: [ConfigService],
      useFactory: (config: ConfigService<Environment, true>): Pool => {
        const pool = new Pool(config.get('database', { infer: true }));
        const logger = new Logger('PostgreSQL');
        pool.on('error', () => {
          logger.warn(
            'An idle PostgreSQL connection failed; the pool will reconnect on demand.',
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
