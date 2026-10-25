import 'reflect-metadata';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Server } from 'node:http';
import { after, before, describe, it } from 'node:test';
import request from 'supertest';
import { DatabaseService } from '../src/database.service';
import { HealthController } from '../src/health.controller';

void describe('checkout health endpoints', () => {
  let app: INestApplication;
  let available = true;
  const database = {
    checkConnection: (): Promise<void> =>
      available
        ? Promise.resolve()
        : Promise.reject(
            new Error(
              'Private connection details must not reach HTTP responses.',
            ),
          ),
  };

  before(async () => {
    const module = await Test.createTestingModule({
      controllers: [HealthController],
      providers: [{ provide: DatabaseService, useValue: database }],
    }).compile();
    app = module.createNestApplication();
    await app.init();
  });

  after(async () => {
    await app?.close();
  });

  void it('GET /health returns HTTP 200 and the service identity', async () => {
    await request(app.getHttpServer() as Server)
      .get('/health')
      .expect(200)
      .expect({ status: 'ok', service: 'checkout' });
  });

  void it('GET /health/ready returns HTTP 200 when its database is reachable', async () => {
    available = true;
    await request(app.getHttpServer() as Server)
      .get('/health/ready')
      .expect(200)
      .expect({ status: 'ok', service: 'checkout', database: 'ok' });
  });

  void it('returns readiness 503 without private details while process health stays 200', async () => {
    available = false;
    await request(app.getHttpServer() as Server)
      .get('/health/ready')
      .expect(503)
      .expect({
        status: 'unavailable',
        service: 'checkout',
        database: 'unavailable',
      });
    await request(app.getHttpServer() as Server)
      .get('/health')
      .expect(200)
      .expect({ status: 'ok', service: 'checkout' });
  });
});
