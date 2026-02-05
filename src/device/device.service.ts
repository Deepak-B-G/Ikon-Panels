import { BadRequestException, Injectable, UnauthorizedException } from '@nestjs/common';
import Redis from 'ioredis';
import { DynamoDBClient, UpdateItemCommand } from '@aws-sdk/client-dynamodb';

function isoNow() {
  return new Date().toISOString();
}

@Injectable()
export class DeviceService {
  private readonly redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379');

  private readonly ddb = new DynamoDBClient({
    region: process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION,
  });

  private readonly STATE_TABLE = process.env.DEVICE_STATE_TABLE || 'ikon-device-state';

  // ---------- SECURITY (minimal for now) ----------
  // If DEVICE_SHARED_KEY is set, device must send x-device-key header matching it.
  private verifyDevice(deviceId: string, deviceKey?: string) {
    if (!deviceId) throw new BadRequestException('deviceId required');

    const required = process.env.DEVICE_SHARED_KEY;
    if (!required) return; // bypass for early testing
    if (!deviceKey || deviceKey !== required) throw new UnauthorizedException('Unauthorized');
  }

  // ---------- QUEUE KEY ----------
  private qKey(deviceId: string) {
    return `q:${deviceId}`; // command queue
  }

  // Single-slot latest-command key (used by UI)
  private cmdKey(deviceId: string) {
    return `cmd:${deviceId}`;
  }

  // ---------- LONG POLL ----------
  // Returns:
  // { type:"cmd", ts, cmd:{cmdId, action, payload, ts} } OR { type:"noop", ts }
  async poll(deviceId: string, deviceKey?: string) {
    this.verifyDevice(deviceId, deviceKey);
    // First: try the single-slot latest-command key (atomic GET+DEL)
    try {
      const cmdKey = this.cmdKey(deviceId);
      const multi = this.redis.multi();
      multi.get(cmdKey);
      multi.del(cmdKey);
      const mres = await multi.exec();
      const rawFromCmdKey = mres?.[0]?.[1] as string | null;

      if (rawFromCmdKey) {
        const raw = rawFromCmdKey;
        let cmd: any;
        try {
          cmd = JSON.parse(raw);
        } catch {
          cmd = { cmdId: `bad-${Date.now()}`, action: 'noop', payload: {}, ts: isoNow() };
        }

        // normalize basic fields
        cmd.cmdId = String(cmd.cmdId || `cmd-${Date.now()}`);
        cmd.action = String(cmd.action || 'noop');
        cmd.payload = cmd.payload || {};
        cmd.ts = cmd.ts || isoNow();

        return { type: 'cmd', ts: isoNow(), cmd };
      }
    } catch (e) {
      // If redis multi/exec failed for some reason, continue to list fallback
      console.error('poll: single-slot cmdKey check failed', e);
    }

    // Fallback: list-based queue (BLPOP) - blocks up to 25 seconds
    const key = this.qKey(deviceId);

    const res = await this.redis.blpop(key, 25);

    if (!res) {
      return { type: 'noop', ts: isoNow() };
    }

    const raw = res[1];

    // If the list entry is a notification (pushed by UI), fetch the real
    // command from the single-slot cmd key. Notification format: "notify:<cmdId>".
    let rawCmdJson: string | null = null;
    if (typeof raw === 'string' && raw.startsWith('notify')) {
      try {
        const cmdKey = this.cmdKey(deviceId);
        const cmdRes = await this.redis.get(cmdKey);
        if (!cmdRes) {
          // Nothing to consume (stale notify), return noop
          return { type: 'noop', ts: isoNow() };
        }
        rawCmdJson = cmdRes;
        // consume it
        await this.redis.del(cmdKey);
      } catch (e) {
        console.error('poll: failed to read/clear cmdKey after notify', e);
        return { type: 'noop', ts: isoNow() };
      }
    } else {
      rawCmdJson = raw as string;
    }

    let cmd: any;
    try {
      cmd = JSON.parse(rawCmdJson!);
    } catch {
      cmd = { cmdId: `bad-${Date.now()}`, action: 'noop', payload: {}, ts: isoNow() };
    }

    // normalize basic fields
    cmd.cmdId = String(cmd.cmdId || `cmd-${Date.now()}`);
    cmd.action = String(cmd.action || 'noop');
    cmd.payload = cmd.payload || {};
    cmd.ts = cmd.ts || isoNow();

    return { type: 'cmd', ts: isoNow(), cmd };
  }

  // ---------- ACK ----------
  async ack(body: { deviceId: string; cmdId: string; status?: string; note?: string }, deviceKey?: string) {
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
    body: {
      deviceId: string;
      volts?: any;
      amps?: any;
      mode?: string;
      power?: string;
      ts?: string;
    },
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
        ExpressionAttributeNames: {
          '#m': 'mode',
          '#p': 'power',
        },
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
