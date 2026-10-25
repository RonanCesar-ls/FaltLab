import { Inject, Injectable } from '@nestjs/common';
import type { OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Pool } from 'pg';
import type { QueryResult, QueryResultRow } from 'pg';
import type { Environment } from './environment';

export const DATABASE_POOL = Symbol('DATABASE_POOL');

@Injectable()
export class DatabaseService implements OnApplicationShutdown {
  constructor(
    @Inject(DATABASE_POOL) private readonly pool: Pool,
    private readonly config: ConfigService<Environment, true>,
  ) {}

  query<Row extends QueryResultRow>(
    text: string,
    values: unknown[],
  ): Promise<QueryResult<Row>> {
    return this.pool.query<Row>(text, values);
  }

  async checkConnection(): Promise<void> {
    const expected = this.config.get('database', { infer: true });
    const result = await this.query<{ ready: boolean }>(
      'SELECT current_database() = $1::text AND current_user = $2::text AS ready',
      [expected.database, expected.user],
    );
    if (result.rows[0]?.ready !== true) {
      throw new Error('Unexpected PostgreSQL connection identity.');
    }
  }

  async onApplicationShutdown(): Promise<void> {
    await this.pool.end();
  }
}
