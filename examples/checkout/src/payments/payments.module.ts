import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import type { Environment } from '../environment';
import { HttpPaymentGateway } from './http-payment-gateway';
import { PAYMENT_GATEWAY, PAYMENT_HTTP_CLIENT } from './payment-gateway';
import { RequestContext } from '../observability/request-context';

@Module({
  imports: [ConfigModule],
  providers: [
    {
      provide: PAYMENT_HTTP_CLIENT,
      useFactory: (): typeof fetch => globalThis.fetch.bind(globalThis),
    },
    {
      provide: PAYMENT_GATEWAY,
      inject: [ConfigService, PAYMENT_HTTP_CLIENT, RequestContext],
      useFactory: (
        config: ConfigService<Environment, true>,
        http: typeof fetch,
        context: RequestContext,
      ): HttpPaymentGateway =>
        new HttpPaymentGateway(
          config.get('payment', { infer: true }),
          http,
          context,
        ),
    },
  ],
  exports: [PAYMENT_GATEWAY],
})
export class PaymentsModule {}
