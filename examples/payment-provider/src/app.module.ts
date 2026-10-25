import { Module } from '@nestjs/common';
import { ObservabilityModule } from './observability/observability.module';
import { ConfigModule } from '@nestjs/config';
import { DatabaseModule } from './database.module';
import { validateEnvironment } from './environment';
import { HealthController } from './health.controller';
import { ChargesModule } from './charges/charges.module';

@Module({
  imports: [
    ObservabilityModule,
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: '.env',
      validate: validateEnvironment,
    }),
    DatabaseModule,
    ChargesModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
