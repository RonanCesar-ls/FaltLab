import { BadRequestException } from '@nestjs/common';
import type { PipeTransform } from '@nestjs/common';

export class IdempotencyKeyPipe implements PipeTransform<
  unknown,
  string | undefined
> {
  transform(value: unknown): string | undefined {
    // Absence is the documented legacy mode. Empty/duplicate/malformed headers are not absence.
    if (value === undefined) return undefined;
    if (
      typeof value !== 'string' ||
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)
    )
      throw new BadRequestException({ code: 'INVALID_IDEMPOTENCY_KEY' });
    return value;
  }
}
