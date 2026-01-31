import { Module } from '@nestjs/common';
import { UiController } from './ui.controller';
import { UiService } from './ui.service';

@Module({
  controllers: [UiController],
  providers: [UiService],
})
export class UiModule {}
