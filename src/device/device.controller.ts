import { Body, Controller, Get, Headers, Post, Query, UsePipes, ValidationPipe } from '@nestjs/common';
import { DeviceService } from './device.service';
import { ok } from '../common/http/response';
import { PollQueryDto } from './dto/poll.dto';
import { AckDto } from './dto/ack.dto';
import { TelemetryDto } from './dto/telemetry.dto';

@Controller('device')
@UsePipes(
  new ValidationPipe({
    transform: true,
    whitelist: true,
    forbidNonWhitelisted: true,
  }),
)
export class DeviceController {
  constructor(private readonly svc: DeviceService) {}

  // SIM800C long-poll:
  // GET /api/v1/device/poll?deviceId=pump-001
  @Get('poll')
  async poll(
    @Query() q: PollQueryDto,
    @Headers('x-device-key') deviceKey?: string,
  ) {
    const data = await this.svc.poll(q.deviceId, deviceKey);
    return ok('Poll executed', data);
  }

  // Device acknowledges it executed cmd
  // POST /api/v1/device/ack
  @Post('ack')
  async ack(@Body() body: AckDto, @Headers('x-device-key') deviceKey?: string) {
    const data = await this.svc.ack(body, deviceKey);
    return ok('Ack saved', data);
  }

  // Device sends telemetry
  // POST /api/v1/device/telemetry
  @Post('telemetry')
  async telemetry(@Body() body: TelemetryDto, @Headers('x-device-key') deviceKey?: string) {
    const data = await this.svc.telemetry(body, deviceKey);
    return ok('Telemetry saved', data);
  }
}
