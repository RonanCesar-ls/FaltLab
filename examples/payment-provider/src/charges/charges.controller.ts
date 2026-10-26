import {
  Body,
  Controller,
  Get,
  Headers,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import { ChargesService } from './charges.service';
import { ChargesValidationPipe } from './charges-validation.pipe';
import { ChargeResponseDto } from './dto/charge-response.dto';
import { CreateChargeDto } from './dto/create-charge.dto';
import { ListChargesDto } from './dto/list-charges.dto';
import { IdempotencyKeyPipe } from './idempotency-key.pipe';

@Controller('charges')
export class ChargesController {
  constructor(private readonly charges: ChargesService) {}

  @Post()
  create(
    @Body(
      new ChargesValidationPipe([
        'merchantReference',
        'amountCents',
        'currency',
      ]),
    )
    input: CreateChargeDto,
    @Headers('idempotency-key') idempotencyHeader: unknown,
  ): Promise<ChargeResponseDto> {
    return this.charges.create(
      input,
      new IdempotencyKeyPipe().transform(idempotencyHeader),
    );
  }

  @Get()
  list(
    @Query(new ChargesValidationPipe(['merchantReference']))
    query: ListChargesDto,
  ): Promise<ChargeResponseDto[]> {
    return this.charges.findByMerchantReference(query.merchantReference);
  }

  @Get(':id')
  findById(
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<ChargeResponseDto> {
    return this.charges.findById(id);
  }
}
