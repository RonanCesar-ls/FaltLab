import { Equals, IsDefined, IsInt, IsUUID, Max, Min } from 'class-validator';

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
  @Equals('BRL')
  currency!: 'BRL';
}
