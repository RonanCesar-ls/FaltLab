import { IsDefined, IsUUID } from 'class-validator';

export class ListChargesDto {
  @IsDefined()
  @IsUUID('all')
  merchantReference!: string;
}
