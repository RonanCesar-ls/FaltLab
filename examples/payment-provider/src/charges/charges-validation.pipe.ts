import { BadRequestException, ValidationPipe } from '@nestjs/common';
import type { ArgumentMetadata } from '@nestjs/common';

export class ChargesValidationPipe extends ValidationPipe {
  constructor(private readonly allowedFields: readonly string[]) {
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
      throw new BadRequestException('Charge input must be an object.');
    }
    // Inspect raw keys before class-transformer removes prototype-related fields.
    if (Object.keys(value).some((key) => !this.allowedFields.includes(key))) {
      throw new BadRequestException(
        'Unknown charge properties are not allowed.',
      );
    }
    const validated: unknown = await super.transform(value, metadata);
    return validated;
  }
}
