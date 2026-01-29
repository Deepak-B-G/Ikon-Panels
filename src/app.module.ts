import { Module } from '@nestjs/common';
import { HealthModule } from './health/health.module';
import { SimulationModule } from './simulation/simulation.module';

@Module({
  imports: [HealthModule, SimulationModule],
})
export class AppModule {}
