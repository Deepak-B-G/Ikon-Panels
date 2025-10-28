import { Module } from '@nestjs/common';
import { SimulationService } from './simulation.service';
import { SimulationController } from './simulation.controller';

@Module({
  controllers: [SimulationController],
  providers: [SimulationService],
})
export class SimulationModule {}
