import { BadRequestException, ValidationPipe } from '@nestjs/common';
import type { ArgumentMetadata } from '@nestjs/common';

export class OrdersValidationPipe extends ValidationPipe {
  constructor() {
    super({
      whitelist: true,
      forbidNonWhitelisted: true,
      forbidUnknownValues: true,
      transform: false,
      transformOptions: { enableImplicitConversion: false },
    });
  }

  override async transform(
    value: unknown,
    metadata: ArgumentMetadata,
  ): Promise<unknown> {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      throw new BadRequestException('The order body must be a JSON object.');
    }
    // Check raw keys before class-transformer strips prototype-related properties.
    if (
      Object.keys(value).some(
        (key) => key !== 'amountCents' && key !== 'currency',
      )
    ) {
      throw new BadRequestException('Unknown order fields are not allowed.');
    }
    const validated: unknown = await super.transform(value, metadata);
    return validated;
  }
}
