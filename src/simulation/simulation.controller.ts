import { Controller, Get, Post, Body, Query } from '@nestjs/common';
import { SimulationService } from './simulation.service';

@Controller('simulation')
export class SimulationController {
  constructor(private readonly simulationService: SimulationService) {}

  @Get('telemetry')
  async getTelemetry(@Query('deviceId') deviceId = 'pump-001') {
    return this.simulationService.handleTelemetry(deviceId);
  }

  @Post('command')
  async postCommand(@Body() body: { deviceId?: string; action?: string }) {
    const deviceId = body.deviceId || 'pump-001';
    const action = (body.action || '').toLowerCase();
    return this.simulationService.handleCommand(deviceId, action);
  }
}
