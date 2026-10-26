import {
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import type {
  PaymentGateway,
  PaymentGatewayFailure,
  PaymentRequest,
} from '../payments/payment-gateway';
import {
  isPaymentConfirmation,
  PAYMENT_GATEWAY,
  PaymentGatewayError,
} from '../payments/payment-gateway';
import type { CreateOrderDto } from './dto/create-order.dto';
import { OrderResponseDto } from './dto/order-response.dto';
import { OrdersRepository } from './orders.repository';

@Injectable()
export class OrdersService {
  constructor(
    private readonly repository: OrdersRepository,
    @Inject(PAYMENT_GATEWAY) private readonly paymentGateway: PaymentGateway,
  ) {}

  async create(input: CreateOrderDto): Promise<OrderResponseDto> {
    return new OrderResponseDto(await this.repository.create(input));
  }

  async findById(id: string): Promise<OrderResponseDto> {
    const order = await this.repository.findById(id);
    if (!order) {
      throw new NotFoundException({ code: 'ORDER_NOT_FOUND' });
    }
    return new OrderResponseDto(order);
  }

  async pay(id: string): Promise<OrderResponseDto> {
    const order = await this.repository.findById(id);
    if (!order) throw new NotFoundException({ code: 'ORDER_NOT_FOUND' });
    if (order.status === 'PAID') return new OrderResponseDto(order);

    let idempotencyKey: string;
    try {
      // The statement commits before any HTTP side effect; never regenerate on a communication failure.
      idempotencyKey = await this.repository.getOrCreatePaymentKey(order.id);
    } catch {
      throw new ServiceUnavailableException({
        code: 'PAYMENT_PREPARATION_FAILED',
      });
    }

    const request: PaymentRequest = {
      merchantReference: order.id,
      amountCents: order.amountCents,
      currency: order.currency,
    };
    let providerChargeId: string;
    try {
      const confirmation = await this.paymentGateway.createCharge(
        request,
        idempotencyKey,
      );
      if (!isPaymentConfirmation(confirmation, request))
        throw new PaymentGatewayError('invalid_response');
      providerChargeId = confirmation.id;
    } catch (error: unknown) {
      const kind: PaymentGatewayFailure =
        error instanceof PaymentGatewayError ? error.kind : 'unavailable';
      const failures = {
        unavailable: {
          status: HttpStatus.SERVICE_UNAVAILABLE,
          code: 'PAYMENT_PROVIDER_UNAVAILABLE',
          message: 'Payment provider is unavailable.',
        },
        timeout: {
          status: HttpStatus.GATEWAY_TIMEOUT,
          code: 'PAYMENT_PROVIDER_TIMEOUT',
          message: 'Payment provider request timed out.',
        },
        invalid_response: {
          status: HttpStatus.BAD_GATEWAY,
          code: 'PAYMENT_PROVIDER_INVALID_RESPONSE',
          message: 'Payment provider returned an invalid confirmation.',
        },
        http_error: {
          status: HttpStatus.BAD_GATEWAY,
          code: 'PAYMENT_PROVIDER_HTTP_ERROR',
          message: 'Payment provider returned an HTTP error.',
        },
      };
      const failure = failures[kind];
      throw new HttpException(
        {
          statusCode: failure.status,
          code: failure.code,
          message: failure.message,
        },
        failure.status,
      );
    }

    try {
      return new OrderResponseDto(
        await this.repository.markPaid(order.id, providerChargeId),
      );
    } catch {
      throw new ServiceUnavailableException({
        statusCode: 503,
        code: 'PAYMENT_CONFIRMATION_NOT_PERSISTED',
        message: 'Payment confirmation could not be saved.',
      });
    }
  }
}
