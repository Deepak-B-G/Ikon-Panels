import { IsOptional, IsString, MinLength } from 'class-validator';

export class TelemetryDto {
  @IsString()
  @MinLength(1)
  deviceId!: string;

  @IsOptional()
  volts?: any;

  @IsOptional()
  amps?: any;

  @IsOptional()
  @IsString()
  mode?: string;

  @IsOptional()
  @IsString()
  power?: string;

  @IsOptional()
  @IsString()
  ts?: string;
}
