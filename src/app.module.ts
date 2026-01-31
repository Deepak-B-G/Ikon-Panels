import { Module } from '@nestjs/common';
import { HealthModule } from './health/health.module';
import { SimulationModule } from './simulation/simulation.module';
import { DeviceModule } from './device/device.module';
import { UiModule } from './ui/ui.module';

@Module({
  imports: [HealthModule, SimulationModule, DeviceModule, UiModule],
})
export class AppModule {}
