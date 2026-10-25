import 'reflect-metadata';
import assert from 'node:assert/strict';
import {
  Body,
  Controller,
  Get,
  HttpException,
  Param,
  Post,
  ValidationPipe,
} from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { IsInt } from 'class-validator';
import type { Server } from 'node:http';
import { after, before, beforeEach, describe, it } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import request from 'supertest';
import { configureHttpApplication } from '../src/observability/configure-http';
import { JSON_LOG_SINK, JsonLogger } from '../src/observability/json-logger';
import { ObservabilityModule } from '../src/observability/observability.module';
import { RequestContext } from '../src/observability/request-context';

const secret = 'SENSITIVE_password_pg_SQL_token';

class ProbeDto {
  @IsInt() amount!: number;
}

@Controller('probe')
class ProbeController {
  constructor(private readonly context: RequestContext) {}

  @Get('context/:delay')
  async contextProbe(
    @Param('delay') milliseconds: string,
  ): Promise<{ before: string | undefined; after: string | undefined }> {
    const before = this.context.getId();
    await delay(Number(milliseconds));
    return { before, after: this.context.getId() };
  }

  @Get('sql')
  sql(): never {
    throw new Error(
      'SELECT * FROM accounts; postgres://user:' +
        secret +
        '@private-host; stack trace',
    );
  }

  @Get('http-error')
  httpError(): never {
    throw new HttpException(
      { code: '23505', message: secret, sql: secret },
      400,
    );
  }

  @Get('known-error')
  knownError(): never {
    throw new HttpException(
      { code: 'PAYMENT_PROVIDER_TIMEOUT', message: secret },
      504,
    );
  }

  @Post('input')
  input(
    @Body(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true }))
    dto: ProbeDto,
  ): ProbeDto {
    return dto;
  }
}

void describe('payment-provider correlation, sanitized errors and JSON request logs', () => {
  let app: INestApplication;
  let server: Server;
  let context: RequestContext;
  let logger: JsonLogger;
  let lines: string[] = [];
  before(async () => {
    const module = await Test.createTestingModule({
      imports: [ObservabilityModule],
      controllers: [ProbeController],
    })
      .overrideProvider(JSON_LOG_SINK)
      .useValue((line: string) => {
        lines.push(line);
      })
      .compile();
    app = module.createNestApplication({ logger: false });
    configureHttpApplication(app);
    await app.listen(0, '127.0.0.1');
    context = app.get(RequestContext);
    logger = app.get(JsonLogger);
    server = app.getHttpServer() as Server;
  });
  beforeEach(() => {
    lines = [];
  });
  after(async () => {
    await app?.close();
  });

  function logs(): Array<Record<string, unknown>> {
    return lines.map((line) => {
      const parsed: unknown = JSON.parse(line);
      assert.ok(parsed !== null && typeof parsed === 'object');
      const log = parsed as Record<string, unknown>;
      assert.equal(log['service'], 'payment-provider');
      assert.equal(typeof log['timestamp'], 'string');
      assert.equal(typeof log['level'], 'string');
      assert.equal(line.includes(secret), false);
      assert.equal(line.includes('postgres://'), false);
      return log;
    });
  }
  function errorBody(
    response: { body: unknown; headers: Record<string, unknown> },
    statusCode: number,
    code: string,
  ): Record<string, unknown> {
    const body = response.body as Record<string, unknown>;
    assert.deepEqual(Object.keys(body).sort(), [
      'code',
      'correlationId',
      'message',
      'statusCode',
    ]);
    assert.equal(body['statusCode'], statusCode);
    assert.equal(body['code'], code);
    assert.equal(typeof body['message'], 'string');
    assert.equal(typeof body['correlationId'], 'string');
    assert.equal(body['correlationId'], response.headers['x-correlation-id']);
    assert.equal(JSON.stringify(body).includes(secret), false);
    assert.equal(JSON.stringify(body).includes('postgres://'), false);
    return body;
  }

  void it('generates a UUID for absent correlation and logs exactly one start and finish', async () => {
    const response = await request(server).get('/probe/context/1').expect(200);
    const id = String(response.headers['x-correlation-id']);
    assert.match(
      id,
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    assert.deepEqual(response.body as unknown, { before: id, after: id });
    const entries = logs();
    assert.deepEqual(
      entries.map((entry) => entry['event']),
      ['request.started', 'request.completed'],
    );
    assert.ok(entries.every((entry) => entry['correlationId'] === id));
    assert.equal(entries[1]?.['statusCode'], 200);
    assert.equal(entries[1]?.['outcome'], 'finished');
    assert.equal(typeof entries[1]?.['durationMs'], 'number');
    assert.equal(context.getId(), undefined);
  });
  for (const id of ['A', 'Request_123.test-Case', 'a'.repeat(64)]) {
    void it('preserves an accepted identifier: ' + id, async () => {
      const response = await request(server)
        .get('/probe/context/1')
        .set('X-Correlation-Id', id)
        .expect(200);
      assert.equal(response.headers['x-correlation-id'], id);
      assert.deepEqual(response.body as unknown, { before: id, after: id });
      assert.ok(logs().every((entry) => entry['correlationId'] === id));
    });
  }
  for (const id of [
    '',
    'bad id',
    'bad,id',
    '/private',
    '.starts-with-dot',
    'a'.repeat(65),
    'postgres://user:password@host',
  ]) {
    void it(
      'rejects an invalid identifier with a new safe ID: ' + JSON.stringify(id),
      async () => {
        const response = await request(server)
          .get('/probe/context/1')
          .set('X-Correlation-Id', id)
          .expect(400);
        const body = errorBody(response, 400, 'INVALID_CORRELATION_ID');
        assert.match(String(body['correlationId']), /^[0-9a-f-]{36}$/);
        assert.notEqual(body['correlationId'], id);
        assert.deepEqual(
          logs().map((entry) => entry['event']),
          ['request.started', 'request.failed', 'request.completed'],
        );
      },
    );
  }
  void it('rejects repeated correlation headers instead of choosing one', async () => {
    const response = await request(server)
      .get('/probe/context/1')
      .set({ 'X-Correlation-Id': ['first', 'second'] })
      .expect(400);
    errorBody(response, 400, 'INVALID_CORRELATION_ID');
  });
  void it('isolates identifiers across concurrent async request continuations and completion logs', async () => {
    const ids = Array.from(
      { length: 30 },
      (_value, index) => 'parallel-' + index,
    );
    const responses = await Promise.all(
      ids.map((id, index) =>
        request(server)
          .get('/probe/context/' + (index % 5) * 5)
          .set('X-Correlation-Id', id)
          .expect(200),
      ),
    );
    for (const [index, response] of responses.entries()) {
      assert.deepEqual(response.body as unknown, {
        before: ids[index],
        after: ids[index],
      });
      assert.equal(response.headers['x-correlation-id'], ids[index]);
    }
    const entries = logs();
    for (const id of ids) {
      const matching = entries.filter((entry) => entry['correlationId'] === id);
      assert.equal(
        matching.filter((entry) => entry['event'] === 'request.started').length,
        1,
      );
      assert.equal(
        matching.filter((entry) => entry['event'] === 'request.completed')
          .length,
        1,
      );
    }
    assert.equal(context.getId(), undefined);
  });
  void it('sanitizes SQL/stack errors, logs a safe failure, and preserves HTTP 500', async () => {
    const response = await request(server)
      .get('/probe/sql')
      .set('X-Correlation-Id', 'safe-error-1')
      .expect(500);
    errorBody(response, 500, 'INTERNAL_SERVER_ERROR');
    assert.equal(
      logs().find((entry) => entry['event'] === 'request.failed')?.['code'],
      'INTERNAL_SERVER_ERROR',
    );
  });
  void it('does not trust arbitrary HttpException messages or SQL error codes', async () => {
    const response = await request(server).get('/probe/http-error').expect(400);
    errorBody(response, 400, 'BAD_REQUEST');
    logs();
  });
  void it('preserves a documented payment code and HTTP status but uses its public message', async () => {
    const response = await request(server)
      .get('/probe/known-error')
      .expect(504);
    const body = errorBody(response, 504, 'PAYMENT_PROVIDER_TIMEOUT');
    assert.equal(body['message'], 'Payment provider request timed out.');
    logs();
  });
  void it('standardizes DTO validation failures', async () => {
    const response = await request(server)
      .post('/probe/input')
      .send({ amount: '123', password: secret })
      .expect(400);
    errorBody(response, 400, 'BAD_REQUEST');
    logs();
  });
  void it('covers malformed JSON before Nest routes while keeping a supplied identifier', async () => {
    const response = await request(server)
      .post('/probe/input')
      .set('X-Correlation-Id', 'parse-error-1')
      .set('Content-Type', 'application/json')
      .send('{"password":"' + secret + '",')
      .expect(400);
    const body = errorBody(response, 400, 'BAD_REQUEST');
    assert.equal(body['correlationId'], 'parse-error-1');
    assert.deepEqual(
      logs().map((entry) => entry['event']),
      ['request.started', 'request.failed', 'request.completed'],
    );
  });
  void it('standardizes body-size errors with correlation', async () => {
    const response = await request(server)
      .post('/probe/input')
      .set('X-Correlation-Id', 'large-body-1')
      .send({ password: secret, data: 'x'.repeat(150_000) })
      .expect(413);
    errorBody(response, 413, 'PAYLOAD_TOO_LARGE');
    logs();
  });
  void it('does not log unknown paths, query values, headers or request bodies', async () => {
    const response = await request(server)
      .get('/' + secret + '?token=' + secret)
      .set('Authorization', 'Bearer ' + secret)
      .set('Cookie', 'token=' + secret)
      .expect(404);
    errorBody(response, 404, 'NOT_FOUND');
    assert.ok(
      logs()
        .filter((entry) => entry['route'])
        .every((entry) => entry['route'] === '<unmatched>'),
    );
  });
  void it('sanitizes framework exception arguments and marks background events without a stale request ID', () => {
    context.run('old-request', () => {
      logger.error(new Error(secret), 'SQL stack ' + secret);
      logger.event(
        'database.connection_failed',
        { code: 'DATABASE_CONNECTION_FAILED' },
        'warn',
        null,
      );
    });
    const entries = logs();
    assert.equal(entries[0]?.['correlationId'], 'old-request');
    assert.equal(entries[1]?.['correlationId'], null);
  });
});
