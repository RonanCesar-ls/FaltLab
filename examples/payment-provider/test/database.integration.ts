import 'reflect-metadata';
import { configureHttpApplication } from '../src/observability/configure-http';
import { JSON_LOG_SINK } from '../src/observability/json-logger';
import assert from 'node:assert/strict';
import type { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import type { Server } from 'node:http';
import { after, before, describe, it } from 'node:test';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { DatabaseService } from '../src/database.service';
import type { Environment } from '../src/environment';

void describe('payment-provider PostgreSQL integration (requires its running database)', () => {
  let app: INestApplication;
  let database: DatabaseService;
  before(async () => {
    const module = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(JSON_LOG_SINK)
      .useValue(() => undefined)
      .compile();
    app = module.createNestApplication();
    configureHttpApplication(app);
    await app.init();
    database = app.get(DatabaseService);
  });
  after(async () => {
    if (app) {
      await app.close();
      await assert.rejects(
        database.query('SELECT $1::int AS value', [1]),
        /pool after calling end/,
      );
    }
  });

  void it('connects with only its configured database identity and parameterizes values', async () => {
    const expected = app
      .get(ConfigService<Environment, true>)
      .get('database', { infer: true });
    const input = "Robert'); DROP SCHEMA public; --";
    const result = await database.query<{
      value: string;
      database: string;
      username: string;
    }>(
      'SELECT $1::text AS value, current_database() AS database, current_user AS username',
      [input],
    );
    assert.deepEqual(result.rows, [
      { value: input, database: expected.database, username: expected.user },
    ]);
  });

  void it('serves process health and readiness against PostgreSQL', async () => {
    await request(app.getHttpServer() as Server)
      .get('/health')
      .expect(200)
      .expect({ status: 'ok', service: 'payment-provider' });
    await request(app.getHttpServer() as Server)
      .get('/health/ready')
      .expect(200)
      .expect({ status: 'ok', service: 'payment-provider', database: 'ok' });
  });
});
