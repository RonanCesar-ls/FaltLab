import { Global, Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { ApiErrorFilter } from './api-error.filter';
import { JSON_LOG_SINK, JsonLogger, stdoutLogSink } from './json-logger';
import { RequestContext } from './request-context';
import { RequestMiddleware } from './request.middleware';

@Global()
@Module({
  providers: [
    RequestContext,
    RequestMiddleware,
    JsonLogger,
    { provide: JSON_LOG_SINK, useValue: stdoutLogSink },
    { provide: APP_FILTER, useClass: ApiErrorFilter },
  ],
  exports: [RequestContext, RequestMiddleware, JsonLogger],
})
export class ObservabilityModule {}
