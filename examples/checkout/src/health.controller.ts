import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { DatabaseService } from './database.service';

@Controller('health')
export class HealthController {
  constructor(private readonly database: DatabaseService) {}

  @Get()
  health(): { status: string; service: string } {
    return { status: 'ok', service: 'checkout' };
  }

  @Get('ready')
  async ready(): Promise<{
    status: string;
    service: string;
    database: string;
  }> {
    try {
      await this.database.checkConnection();
      return { status: 'ok', service: 'checkout', database: 'ok' };
    } catch {
      throw new ServiceUnavailableException({
        status: 'unavailable',
        service: 'checkout',
        database: 'unavailable',
      });
    }
  }
}
