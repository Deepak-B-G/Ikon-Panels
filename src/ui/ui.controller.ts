import { Body, Controller, Post, Get, Query } from '@nestjs/common';
import { UiService } from './ui.service';

@Controller('ui')
export class UiController {
  constructor(private readonly svc: UiService) {}

  // POST /api/v1/ui/command  { deviceId, action, payload? }
  @Post('command')
  command(@Body() body: any) {
    return this.svc.enqueueCommand(body);
  }

  @Get('telemetry')
  telemetry(@Query('deviceId') deviceId: string) {
    return this.svc.getLatestTelemetry(deviceId);
  }
}
