import type { INestApplication } from '@nestjs/common';
import { JsonLogger } from './json-logger';
import { RequestMiddleware } from './request.middleware';

export function configureHttpApplication(app: INestApplication): void {
  const middleware = app.get(RequestMiddleware);
  // Register before app.init/listen so malformed JSON and size-limit errors get context too.
  app.use(middleware.use.bind(middleware));
  app.useLogger(app.get(JsonLogger));
}
