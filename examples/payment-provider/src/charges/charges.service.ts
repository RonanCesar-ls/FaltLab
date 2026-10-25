import { Injectable, NotFoundException } from '@nestjs/common';
import { ChargesRepository } from './charges.repository';
import { ChargeResponseDto } from './dto/charge-response.dto';
import type { CreateChargeDto } from './dto/create-charge.dto';

@Injectable()
export class ChargesService {
  constructor(private readonly repository: ChargesRepository) {}

  async create(input: CreateChargeDto): Promise<ChargeResponseDto> {
    const charge = await this.repository.create(input);
    return new ChargeResponseDto(charge);
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
