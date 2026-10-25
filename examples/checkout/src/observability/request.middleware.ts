import { BadRequestException, Injectable } from '@nestjs/common';
import type { NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { JsonLogger } from './json-logger';
import {
  CORRELATION_HEADER,
  CORRELATION_ID_PATTERN,
  RequestContext,
} from './request-context';

function routeLabel(url: string): string {
  const path = url.split('?')[0] ?? '';
  const routes: Array<[RegExp, string]> = [
    [/^\/health\/?$/, '/health'],
    [/^\/health\/ready\/?$/, '/health/ready'],
    [/^\/orders\/?$/, '/orders'],
    [/^\/orders\/[^/]+\/pay\/?$/, '/orders/:id/pay'],
    [/^\/orders\/[^/]+\/?$/, '/orders/:id'],
  ];
  return routes.find(([pattern]) => pattern.test(path))?.[1] ?? '<unmatched>';
}

@Injectable()
export class RequestMiddleware implements NestMiddleware {
  constructor(
    private readonly context: RequestContext,
    private readonly logger: JsonLogger,
  ) {}

  use(request: Request, response: Response, next: NextFunction): void {
    const supplied = request.headers[CORRELATION_HEADER];
    const occurrences = request.rawHeaders.filter(
      (value, index) =>
        index % 2 === 0 && value.toLowerCase() === CORRELATION_HEADER,
    ).length;
    const valid =
      supplied === undefined ||
      (typeof supplied === 'string' &&
        occurrences === 1 &&
        CORRELATION_ID_PATTERN.test(supplied));
    const correlationId =
      valid && typeof supplied === 'string' ? supplied : randomUUID();
    response.setHeader(CORRELATION_HEADER, correlationId);
    const method = [
      'GET',
      'POST',
      'PUT',
      'PATCH',
      'DELETE',
      'HEAD',
      'OPTIONS',
      'TRACE',
      'CONNECT',
    ].includes(request.method)
      ? request.method
      : 'OTHER';
    const route = routeLabel(request.url);
    const start = performance.now();
    let completed = false;
    const complete = (outcome: 'finished' | 'aborted'): void => {
      if (completed) return;
      completed = true;
      this.logger.event(
        'request.completed',
        {
          method,
          route,
          statusCode: response.statusCode,
          durationMs: Math.round((performance.now() - start) * 100) / 100,
          outcome,
        },
        'info',
        correlationId,
      );
    };
    response.once('finish', () => complete('finished'));
    response.once('close', () =>
      complete(response.writableFinished ? 'finished' : 'aborted'),
    );
    this.context.run(correlationId, () => {
      this.logger.event('request.started', { method, route });
      if (!valid)
        next(new BadRequestException({ code: 'INVALID_CORRELATION_ID' }));
      else next();
    });
  }
}
