import { Module } from '@nestjs/common';
import { ObservabilityModule } from './observability/observability.module';
import { ConfigModule } from '@nestjs/config';
import { DatabaseModule } from './database.module';
import { validateEnvironment } from './environment';
import { HealthController } from './health.controller';
import { OrdersModule } from './orders/orders.module';

@Module({
  imports: [
    ObservabilityModule,
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: '.env',
      validate: validateEnvironment,
    }),
    DatabaseModule,
    OrdersModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
