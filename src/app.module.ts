import { Module } from '@nestjs/common';
import { AppController } from './health/health.controller';
import { HealthService } from './health/health.service';
import { SimulationModule } from './simulation/simulation.module';

@Module({
  imports: [SimulationModule],
  controllers: [AppController],
  providers: [HealthService],
})
export class AppModule {}
