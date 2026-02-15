import { BadRequestException, Injectable, UnauthorizedException } from '@nestjs/common';
import Redis from 'ioredis';
import { DynamoDBClient, UpdateItemCommand } from '@aws-sdk/client-dynamodb';

function isoNow() {
  return new Date().toISOString();
}

type DeviceCommand = {
  cmdId: string;
  action: string;
  payload: any;
  ts: string;
};

function safeParseCmd(raw: string): DeviceCommand | null {
  try {
    const x: any = JSON.parse(raw);
    return {
      cmdId: String(x?.cmdId || `cmd-${Date.now()}`),
      action: String(x?.action || 'noop'),
      payload: x?.payload ?? {},
      ts: String(x?.ts || isoNow()),
    };
  } catch {
    return null;
  }
}

@Injectable()
export class DeviceService {
  private readonly redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379');

  private readonly ddb = new DynamoDBClient({
    region: process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION,
  });

  private readonly STATE_TABLE = process.env.DEVICE_STATE_TABLE || 'ikon-device-state';

  // ---------- SECURITY (minimal for now) ----------
  private verifyDevice(deviceId: string, deviceKey?: string) {
    if (!deviceId) throw new BadRequestException('deviceId required');

    const required = process.env.DEVICE_SHARED_KEY;
    if (!required) return; // bypass for early testing
    if (!deviceKey || deviceKey !== required) throw new UnauthorizedException('Unauthorized');
  }

  // ---------- QUEUE (wakeup) ----------
  private qKey(deviceId: string) {
    return `q:${deviceId}`; // wakeup list for BLPOP
  }

  // ---------- ✅ Separate pending slots ----------
  private runCmdKey(deviceId: string) {
    return `cmd:run:${deviceId}`; // start/stop
  }

  private settingsCmdKey(deviceId: string) {
    return `cmd:settings:${deviceId}`; // settings_apply
  }

  // Atomically fetch + delete BOTH slots
  async consumePending(deviceId: string): Promise<DeviceCommand[]> {
    if (!deviceId) throw new BadRequestException('deviceId required');

    const runKey = this.runCmdKey(deviceId);
    const setKey = this.settingsCmdKey(deviceId);

    const multi = this.redis.multi();
    multi.get(runKey);
    multi.get(setKey);
    multi.del(runKey);
    multi.del(setKey);

    const res = await multi.exec(); // [ [err,val], [err,val], ... ] | null
    const runRaw = (res?.[0]?.[1] as string | null) ?? null;
    const setRaw = (res?.[1]?.[1] as string | null) ?? null;

    const cmds: DeviceCommand[] = [];
    if (runRaw) {
      const c = safeParseCmd(runRaw);
      if (c) cmds.push(c);
    }
    if (setRaw) {
      const c = safeParseCmd(setRaw);
      if (c) cmds.push(c);
    }

    return cmds;
  }

  // ---------- LONG POLL ----------
  // Best practice: q:<deviceId> is only a wakeup. Real data is in cmd:* keys.
  async poll(deviceId: string, deviceKey?: string) {
    this.verifyDevice(deviceId, deviceKey);

    // 1) fast path: do we already have pending commands?
    const first = await this.consumePending(deviceId);
    if (first.length === 1) return { type: 'cmd', ts: isoNow(), cmd: first[0] };
    if (first.length > 1) return { type: 'cmds', ts: isoNow(), cmds: first };

    // 2) long-poll wait (30 seconds)
    const res = await this.redis.blpop(this.qKey(deviceId), 30);

    // 3) timeout -> noop
    if (!res) return { type: 'noop', ts: isoNow() };

    // 4) woke up -> consume again
    const afterWake = await this.consumePending(deviceId);
    if (afterWake.length === 1) return { type: 'cmd', ts: isoNow(), cmd: afterWake[0] };
    if (afterWake.length > 1) return { type: 'cmds', ts: isoNow(), cmds: afterWake };

    // rare: woke up but keys were empty (stale notify)
    return { type: 'noop', ts: isoNow() };
  }

  // ---------- ACK ----------
  async ack(
    body: { deviceId: string; cmdId: string; status?: string; note?: string },
    deviceKey?: string,
  ) {
    const deviceId = body.deviceId;
    const cmdId = body.cmdId;
    const status = body.status || 'ok';
    const note = body.note || '';

    this.verifyDevice(deviceId, deviceKey);

    await this.ddb.send(
      new UpdateItemCommand({
        TableName: this.STATE_TABLE,
        Key: { deviceId: { S: deviceId } },
        UpdateExpression: 'SET lastAckCmdId=:c, lastAckStatus=:s, lastAckNote=:n, lastAckAt=:t',
        ExpressionAttributeValues: {
          ':c': { S: String(cmdId) },
          ':s': { S: String(status) },
          ':n': { S: String(note) },
          ':t': { S: isoNow() },
        },
      }),
    );

    return { ok: true };
  }

  // ---------- TELEMETRY ----------
  async telemetry(
    body: { deviceId: string; volts?: any; amps?: any; mode?: string; power?: string; ts?: string },
    deviceKey?: string,
  ) {
    const deviceId = body.deviceId;
    this.verifyDevice(deviceId, deviceKey);

    const volts = body.volts || {};
    const amps = body.amps || {};
    const mode = body.mode || 'stopped';
    const power = body.power || 'OFF';
    const ts = body.ts || isoNow();

    await this.ddb.send(
      new UpdateItemCommand({
        TableName: this.STATE_TABLE,
        Key: { deviceId: { S: deviceId } },
        UpdateExpression: 'SET lastTelemetryAt=:t, #m=:m, #p=:p, volts=:v, amps=:a',
        ExpressionAttributeNames: { '#m': 'mode', '#p': 'power' },
        ExpressionAttributeValues: {
          ':t': { S: String(ts) },
          ':m': { S: String(mode) },
          ':p': { S: String(power) },
          ':v': { S: JSON.stringify(volts) },
          ':a': { S: JSON.stringify(amps) },
        },
      }),
    );

    return { ok: true };
  }
}
