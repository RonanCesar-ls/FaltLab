import { Injectable } from '@nestjs/common';
import { AsyncLocalStorage } from 'node:async_hooks';

export const CORRELATION_HEADER = 'x-correlation-id';
export const CORRELATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

@Injectable()
export class RequestContext {
  private readonly storage = new AsyncLocalStorage<{ correlationId: string }>();

  run<T>(correlationId: string, callback: () => T): T {
    return this.storage.run({ correlationId }, callback);
  }

  getId(): string | undefined {
    return this.storage.getStore()?.correlationId;
  }
}
