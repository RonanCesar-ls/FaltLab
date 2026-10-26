import {
  IsDefined,
  IsInt,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

export class CreateChargeDto {
  @IsDefined()
  @IsUUID('all')
  merchantReference!: string;

  @IsDefined()
  @IsInt()
  @Min(1)
  @Max(2_147_483_647)
  amountCents!: number;

  @IsDefined()
  @IsString()
  @MaxLength(3)
  // Structural validation first: an existing key with another currency is a 409.
  // The repository still rejects every new non-BRL charge before insertion.
  currency!: string;
}
