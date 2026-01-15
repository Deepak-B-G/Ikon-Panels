import { Controller, Get, Post, Query, Body } from '@nestjs/common';
import { SimulationService } from './simulation.service';

@Controller()
export class SimulationController {
  constructor(private readonly sim: SimulationService) {}

  @Get('telemetry')
  async getTelemetry(
    @Query('deviceId') deviceId: string,
  ) {
    return this.sim.handleTelemetry(deviceId);
  }


  @Post('command')
  async sendCommand(
    @Body()
    body: {
      deviceId: string;
      action: string;
    },
  ) {
    return this.sim.handleCommand(body.deviceId, body.action);
  }


  @Post('settings')
  async saveSettings(
    @Body()
    body: {
      deviceId: string;
      settings: Record<string, any>;
    },
  ) {
    return this.sim.saveSettings(body.deviceId, body.settings);
  }
}
