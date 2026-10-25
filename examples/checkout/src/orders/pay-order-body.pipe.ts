import { BadRequestException } from '@nestjs/common';
import type { PipeTransform } from '@nestjs/common';

export class PayOrderBodyPipe implements PipeTransform<unknown, undefined> {
  transform(value: unknown): undefined {
    if (
      value === undefined ||
      (value !== null &&
        typeof value === 'object' &&
        !Array.isArray(value) &&
        Object.keys(value).length === 0)
    ) {
      return undefined;
    }
    throw new BadRequestException(
      'Payment accepts no body or an empty object. Order data cannot be overridden.',
    );
  }
}
