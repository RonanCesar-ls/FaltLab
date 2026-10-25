import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database.module';
import { ChargesController } from './charges.controller';
import { ChargesRepository } from './charges.repository';
import { ChargesService } from './charges.service';

@Module({
  imports: [DatabaseModule],
  controllers: [ChargesController],
  providers: [ChargesService, ChargesRepository],
})
export class ChargesModule {}
