import { Catch, HttpException, Injectable } from '@nestjs/common';
import type { ArgumentsHost, ExceptionFilter } from '@nestjs/common';
import type { Response } from 'express';
import { randomUUID } from 'node:crypto';
import { JsonLogger } from './json-logger';
import {
  CORRELATION_HEADER,
  CORRELATION_ID_PATTERN,
  RequestContext,
} from './request-context';

const publicErrors = {
  PAYMENT_PREPARATION_FAILED: {
    status: 503,
    message: 'Payment operation could not be prepared.',
  },
  INVALID_CORRELATION_ID: {
    status: 400,
    message:
      'X-Correlation-Id must be one ASCII identifier of 1 to 64 characters, starting with a letter or digit and containing only letters, digits, dot, underscore or hyphen.',
  },
  ORDER_NOT_FOUND: { status: 404, message: 'Order not found.' },
  CHARGE_NOT_FOUND: { status: 404, message: 'Charge not found.' },
  DATABASE_UNAVAILABLE: {
    status: 503,
    message: 'The service database is unavailable.',
  },
  PAYMENT_PROVIDER_UNAVAILABLE: {
    status: 503,
    message: 'Payment provider is unavailable.',
  },
  PAYMENT_PROVIDER_TIMEOUT: {
    status: 504,
    message: 'Payment provider request timed out.',
  },
  PAYMENT_PROVIDER_INVALID_RESPONSE: {
    status: 502,
    message: 'Payment provider returned an invalid confirmation.',
  },
  PAYMENT_PROVIDER_HTTP_ERROR: {
    status: 502,
    message: 'Payment provider returned an HTTP error.',
  },
  PAYMENT_CONFIRMATION_NOT_PERSISTED: {
    status: 503,
    message: 'Payment confirmation could not be saved.',
  },
} as const;

const defaultErrors: Record<number, { code: string; message: string }> = {
  400: { code: 'BAD_REQUEST', message: 'Invalid request.' },
  401: { code: 'UNAUTHORIZED', message: 'Authentication required.' },
  403: { code: 'FORBIDDEN', message: 'Access denied.' },
  404: { code: 'NOT_FOUND', message: 'Resource not found.' },
  405: { code: 'METHOD_NOT_ALLOWED', message: 'Method not allowed.' },
  413: { code: 'PAYLOAD_TOO_LARGE', message: 'Request body is too large.' },
  415: { code: 'UNSUPPORTED_MEDIA_TYPE', message: 'Unsupported media type.' },
  422: { code: 'UNPROCESSABLE_ENTITY', message: 'Invalid request.' },
  429: { code: 'TOO_MANY_REQUESTS', message: 'Too many requests.' },
  500: {
    code: 'INTERNAL_SERVER_ERROR',
    message: 'An internal error occurred.',
  },
  502: { code: 'BAD_GATEWAY', message: 'Upstream service failed.' },
  503: { code: 'SERVICE_UNAVAILABLE', message: 'Service unavailable.' },
  504: { code: 'GATEWAY_TIMEOUT', message: 'Upstream service timed out.' },
};

export function apiError(
  exception: unknown,
  correlationId: string,
): {
  statusCode: number;
  code: string;
  message: string;
  correlationId: string;
} {
  let statusCode = 500;
  let response: unknown;
  if (exception instanceof HttpException) {
    statusCode = exception.getStatus();
    response = exception.getResponse();
  } else if (
    exception !== null &&
    typeof exception === 'object' &&
    'type' in exception
  ) {
    if (exception.type === 'entity.too.large') statusCode = 413;
    if (exception.type === 'entity.parse.failed') statusCode = 400;
  }
  if (!Number.isInteger(statusCode) || statusCode < 400 || statusCode > 599)
    statusCode = 500;
  if (
    response !== null &&
    typeof response === 'object' &&
    'code' in response &&
    typeof response.code === 'string' &&
    Object.hasOwn(publicErrors, response.code)
  ) {
    const code = response.code as keyof typeof publicErrors;
    const known = publicErrors[code];
    if (known.status === statusCode)
      return { statusCode, code, message: known.message, correlationId };
  }
  const fallback = defaultErrors[statusCode] ?? {
    code: 'HTTP_ERROR',
    message: 'Request failed.',
  };
  return { statusCode, ...fallback, correlationId };
}

@Catch()
@Injectable()
export class ApiErrorFilter implements ExceptionFilter {
  constructor(
    private readonly context: RequestContext,
    private readonly logger: JsonLogger,
  ) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    const header = response.getHeader(CORRELATION_HEADER);
    const correlationId =
      this.context.getId() ??
      (typeof header === 'string' && CORRELATION_ID_PATTERN.test(header)
        ? header
        : randomUUID());
    const body = apiError(exception, correlationId);
    this.logger.event(
      'request.failed',
      { statusCode: body.statusCode, code: body.code },
      body.statusCode >= 500 ? 'error' : 'warn',
      correlationId,
    );
    if (!response.headersSent) {
      response.setHeader(CORRELATION_HEADER, correlationId);
      response.status(body.statusCode).json(body);
    }
  }
}
