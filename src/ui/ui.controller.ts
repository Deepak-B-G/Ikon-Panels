import { Body, Controller, Get, Post, Query } from '@nestjs/common';
import { UiService } from './ui.service';

@Controller('ui')
export class UiController {
  constructor(private readonly svc: UiService) {}

  /**
   * RUN CONTROL (Start/Stop)
   * POST /api/v1/ui/command
   * Body: { deviceId, action: "start" | "stop", payload?: {} }
   */
  @Post('command')
  command(@Body() body: any) {
    return this.svc.enqueueRunCommand(body);
  }


  /**
   * SETTINGS SAVE (Separate API)
   * POST /api/v1/ui/settings
   * Body: { deviceId, settings: { ... } }
   */
  @Post('settings')
  async saveSettings(@Body() body: any) {
    return this.svc.saveSettings(body);
  }

  /**
   * SETTINGS LOAD (Optional but recommended)
   * GET /api/v1/ui/settings?deviceId=pump-001
   */
  @Get('settings')
  async getSettings(@Query('deviceId') deviceId: string) {
    return this.svc.getLatestSettings(deviceId);
  }

  /**
   * TELEMETRY READ (UI reads latest telemetry)
   * GET /api/v1/ui/telemetry?deviceId=pump-001
   */
  @Get('telemetry')
  async telemetry(@Query('deviceId') deviceId: string) {
    return this.svc.getLatestTelemetry(deviceId);
  }
}
