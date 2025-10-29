import { Controller, Get, Post, Body, Query } from '@nestjs/common';
import { SimulationService } from './simulation.service';

@Controller('simulation')
export class SimulationController {
  constructor(private readonly simulationService: SimulationService) {}

  // 🔹 GET telemetry data (subscribes from IoT Core topic)
  @Get('telemetry')
  async getTelemetry(@Query('deviceId') deviceId = 'pump-001') {
    return this.simulationService.getTelemetryFromIoT(deviceId);
  }

  // 🔹 POST command to device (publishes to IoT Core topic)
  @Post('control')
  async sendCommand(@Body() body: { deviceId?: string; action?: string }) {
    const deviceId = body.deviceId || 'pump-001';
    const action = (body.action || '').toLowerCase();
    return this.simulationService.publishControlToIoT(deviceId, action);
  }
}
