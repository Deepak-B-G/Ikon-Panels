import { IsString, MinLength } from 'class-validator';

export class PollQueryDto {
  @IsString()
  @MinLength(1)
  deviceId!: string;
}
