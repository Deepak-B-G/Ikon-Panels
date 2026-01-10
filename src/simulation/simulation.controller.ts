import { Controller, Get, Post, Body, Query } from '@nestjs/common';
import { SimulationService } from './simulation.service';

@Controller()
export class SimulationController {
  constructor(private readonly sim: SimulationService) {}

  // POST /command
  @Post('command')
  sendCommand(
    @Body() body: { deviceId: string; action: string },
  ) {
    return this.sim.handleCommand(body.deviceId, body.action);
  }

  // GET /telemetry?deviceId=pump-001
  @Get('telemetry')
  getTelemetry(@Query('deviceId') deviceId: string) {
    return this.sim.handleTelemetry(deviceId);
  }
}
