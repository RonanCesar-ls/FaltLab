import 'reflect-metadata';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Server } from 'node:http';
import { after, before, describe, it } from 'node:test';
import request from 'supertest';
import { AppModule } from '../src/app.module';

void describe('Checkout health endpoint', () => {
  let app: INestApplication;

  before(async () => {
    const module = await Test.createTestingModule({
      imports: [AppModule],
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
});
