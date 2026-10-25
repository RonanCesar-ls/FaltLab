import { Equals, IsDefined, IsInt, Max, Min } from 'class-validator';

export class CreateOrderDto {
  @IsDefined()
  @IsInt()
  @Min(1)
  @Max(2_147_483_647)
  amountCents!: number;

  @IsDefined()
  @Equals('BRL')
  currency!: 'BRL';
}
