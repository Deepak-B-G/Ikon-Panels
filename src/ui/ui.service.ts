import { BadRequestException, Injectable } from '@nestjs/common';
import Redis from 'ioredis';
import { DynamoDBClient, GetItemCommand } from '@aws-sdk/client-dynamodb';

function isoNow() {
  return new Date().toISOString();
}

function safeJsonParse(s?: string) {
  if (!s) return {};
  try { return JSON.parse(s); } catch { return {}; }
}

@Injectable()
export class UiService {
  private readonly redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379');

  private readonly ddb = new DynamoDBClient({
    region: process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION,
  });

  private readonly STATE_TABLE =
    process.env.DEVICE_STATE_TABLE || 'ikon-device-state';

  private qKey(deviceId: string) {
    return `q:${deviceId}`;
  }

  // ---------- UI -> enqueue command for device ----------
  async enqueueCommand(body: any) {
    const deviceId = body?.deviceId;
    const action = body?.action;
    const payload = body?.payload || {};

    if (!deviceId || !action) throw new BadRequestException('deviceId and action required');

    const cmd = {
      cmdId: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
      action,
      payload,
      ts: isoNow(),
    };

    await this.redis.rpush(this.qKey(deviceId), JSON.stringify(cmd));

    return { ok: true, cmd };
  }

  // ---------- ✅ UI -> read latest telemetry from DynamoDB ----------
  async getLatestTelemetry(deviceId: string) {
    if (!deviceId) throw new BadRequestException('deviceId required');

    const res = await this.ddb.send(
      new GetItemCommand({
        TableName: this.STATE_TABLE,
        Key: { deviceId: { S: deviceId } },
      }),
    );

    const item = res.Item;

    // If device never sent telemetry yet, return clean defaults
    if (!item) {
      return {
        deviceId,
        ts: isoNow(),
        mode: 'stopped',
        power: 'OFF',
        volts: { r: 0, y: 0, b: 0 },
        amps: { r: 0, y: 0, b: 0 },
      };
    }

    const mode = item.mode?.S || 'stopped';
    const power = item.power?.S || 'OFF';
    const ts = item.lastTelemetryAt?.S || isoNow();

    const volts = safeJsonParse(item.volts?.S);
    const amps = safeJsonParse(item.amps?.S);

    return {
      deviceId,
      ts,
      mode,
      power,
      volts: {
        r: Number(volts.r ?? 0),
        y: Number(volts.y ?? 0),
        b: Number(volts.b ?? 0),
      },
      amps: {
        r: Number(amps.r ?? 0),
        y: Number(amps.y ?? 0),
        b: Number(amps.b ?? 0),
      },
    };
  }
}
