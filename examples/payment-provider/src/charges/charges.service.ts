import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  ChargesRepository,
  IdempotencyConflictError,
  UnsupportedCurrencyError,
} from './charges.repository';
import { ChargeResponseDto } from './dto/charge-response.dto';
import type { CreateChargeDto } from './dto/create-charge.dto';

@Injectable()
export class ChargesService {
  constructor(private readonly repository: ChargesRepository) {}

  async create(
    input: CreateChargeDto,
    idempotencyKey?: string,
  ): Promise<ChargeResponseDto> {
    try {
      const charge = await this.repository.create(input, idempotencyKey);
      return new ChargeResponseDto(charge);
    } catch (error) {
      if (error instanceof IdempotencyConflictError)
        throw new ConflictException({ code: 'IDEMPOTENCY_KEY_CONFLICT' });
      if (error instanceof UnsupportedCurrencyError)
        throw new BadRequestException();
      throw error;
    }
  }

  async findById(id: string): Promise<ChargeResponseDto> {
    const charge = await this.repository.findById(id);
    if (!charge) {
      throw new NotFoundException({ code: 'CHARGE_NOT_FOUND' });
    }
    return new ChargeResponseDto(charge);
  }

  async findByMerchantReference(
    merchantReference: string,
  ): Promise<ChargeResponseDto[]> {
    const charges =
      await this.repository.findByMerchantReference(merchantReference);
    return charges.map((charge) => new ChargeResponseDto(charge));
  }
}
