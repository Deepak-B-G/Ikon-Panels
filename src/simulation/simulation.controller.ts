import { Controller, Post, Body } from '@nestjs/common';
import { SimulationService } from './simulation.service';

@Controller('simulation')
export class SimulationController {
  constructor(private readonly simulationService: SimulationService) {}

  @Post('command')
  async sendCommand(@Body() body: { deviceId?: string; action?: string }) {
    const deviceId = body.deviceId || 'pump-001';
    const action = body.action?.toLowerCase() || 'start';
    return this.simulationService.publishControl(deviceId, action);
  }
}
