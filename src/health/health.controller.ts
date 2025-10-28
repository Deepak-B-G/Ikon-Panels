import { Controller, Get } from '@nestjs/common';
import { HealthService } from './health.service';

@Controller()
export class AppController {
  constructor(private readonly appService: HealthService) {}

  @Get('health')
  getHello(): string {
    return this.appService.getHello();
  }
}
