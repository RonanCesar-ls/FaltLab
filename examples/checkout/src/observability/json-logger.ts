import { Inject, Injectable } from '@nestjs/common';
import type { LoggerService } from '@nestjs/common';
import { RequestContext } from './request-context';

export const JSON_LOG_SINK = Symbol('JSON_LOG_SINK');
export type JsonLogSink = (line: string) => void;
export const stdoutLogSink: JsonLogSink = (line) => {
  process.stdout.write(line + '\n');
};

type LogEvent =
  | 'request.started'
  | 'request.completed'
  | 'request.failed'
  | 'database.connection_failed'
  | 'application.started'
  | 'application.failed'
  | 'application.log'
  | 'migration.started'
  | 'migration.completed'
  | 'migration.failed';
interface LogFields {
  method?: string;
  route?: string;
  statusCode?: number;
  durationMs?: number;
  code?: string;
  outcome?: 'finished' | 'aborted';
  port?: number;
}

@Injectable()
export class JsonLogger implements LoggerService {
  constructor(
    private readonly context: RequestContext,
    @Inject(JSON_LOG_SINK) private readonly sink: JsonLogSink,
  ) {}

  event(
    event: LogEvent,
    fields: LogFields = {},
    level: 'info' | 'warn' | 'error' = 'info',
    correlationId: string | null = this.context.getId() ?? null,
  ): void {
    this.sink(
      JSON.stringify({
        timestamp: new Date().toISOString(),
        service: 'checkout',
        level,
        event,
        correlationId,
        ...fields,
      }),
    );
  }

  // Nest may pass exception objects and stack traces. Never serialize those arguments.
  log(...args: unknown[]): void {
    void args;
    this.event('application.log');
  }
  error(...args: unknown[]): void {
    void args;
    this.event('application.log', { code: 'APPLICATION_ERROR' }, 'error');
  }
  warn(...args: unknown[]): void {
    void args;
    this.event('application.log', { code: 'APPLICATION_WARNING' }, 'warn');
  }
  debug(...args: unknown[]): void {
    void args; /* Framework debug arguments are intentionally not recorded. */
  }
  verbose(...args: unknown[]): void {
    void args; /* Framework verbose arguments are intentionally not recorded. */
  }
  fatal(...args: unknown[]): void {
    void args;
    this.event('application.failed', { code: 'APPLICATION_FAILED' }, 'error');
  }
}
