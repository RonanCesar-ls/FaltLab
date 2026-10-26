import { Inject, Injectable } from '@nestjs/common';
import type { OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Pool } from 'pg';
import type { PoolClient, QueryResult, QueryResultRow } from 'pg';
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

  async transaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    let discard = false;
    try {
      await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch {
        discard = true;
      }
      throw error;
    } finally {
      client.release(discard);
    }
  }

  async onApplicationShutdown(): Promise<void> {
    await this.pool.end();
  }
}
