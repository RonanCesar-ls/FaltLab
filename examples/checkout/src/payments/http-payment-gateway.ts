import type {
  PaymentConfirmation,
  PaymentGateway,
  PaymentRequest,
} from './payment-gateway';
import { isPaymentConfirmation, PaymentGatewayError } from './payment-gateway';

export interface HttpPaymentGatewayOptions {
  baseUrl: string;
  timeoutMs: number;
}

export class HttpPaymentGateway implements PaymentGateway {
  private readonly chargesUrl: URL;

  constructor(
    private readonly options: HttpPaymentGatewayOptions,
    private readonly http: typeof fetch,
  ) {
    this.chargesUrl = new URL(
      'charges',
      options.baseUrl.endsWith('/') ? options.baseUrl : options.baseUrl + '/',
    );
  }

  async createCharge(request: PaymentRequest): Promise<PaymentConfirmation> {
    const signal = AbortSignal.timeout(this.options.timeoutMs);
    try {
      const response = await this.http(this.chargesUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
        },
        body: JSON.stringify(request),
        redirect: 'manual',
        signal,
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new PaymentGatewayError('http_error');
      }
      if (
        response.status !== 201 ||
        !/^application\/(?:[\w.-]+\+)?json(?:;|$)/i.test(
          response.headers.get('content-type') ?? '',
        )
      ) {
        await response.body?.cancel();
        throw new PaymentGatewayError('invalid_response');
      }
      let confirmation: unknown;
      try {
        confirmation = await response.json();
      } catch (error: unknown) {
        if (signal.aborted) throw new PaymentGatewayError('timeout');
        if (error instanceof SyntaxError)
          throw new PaymentGatewayError('invalid_response');
        throw new PaymentGatewayError('unavailable');
      }
      if (!isPaymentConfirmation(confirmation, request))
        throw new PaymentGatewayError('invalid_response');
      return confirmation;
    } catch (error: unknown) {
      if (error instanceof PaymentGatewayError) throw error;
      throw new PaymentGatewayError(signal.aborted ? 'timeout' : 'unavailable');
    }
  }
}
