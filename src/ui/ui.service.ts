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

  // ============================
  // ✅ Latest-command-wins keys
  // ============================
  private cmdKey(deviceId: string) {
    return `cmd:${deviceId}`; // single-slot pending command
  }

  private validate(body: any) {
    // Accept multiple shapes. Primary expected shape is:
    // { deviceId, action, payload }
    // But callers may pass a wrapped API response like:
    // { status, message, data: { ok:true, cmd: { deviceId, action, payload } } }
    // or { cmd: { ... } }.
    let src = body;

    if (!src?.deviceId) {
      if (src?.data?.cmd) src = src.data.cmd;
      else if (src?.cmd) src = src.cmd;
    }

    const deviceId = src?.deviceId;
    const action = src?.action;
    const payload = src?.payload || {};

    if (!deviceId || !action) {
      throw new BadRequestException('deviceId and action required');
    }

    return { deviceId, action, payload };
  }

  // ---------------------------------------------------------
  // UI -> store latest command (overwrite older pending command)
  // ---------------------------------------------------------
  async enqueueCommand(body: any) {
    const { deviceId, action, payload } = this.validate(body);

    const cmd = {
      cmdId: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
      action,
      payload,
      ts: isoNow(),
    };

    // ✅ overwrite whatever was pending before (latest wins)
    await this.redis.set(this.cmdKey(deviceId), JSON.stringify(cmd));

    // Also notify any long-pollers waiting on the list queue so BLPOP wakes.
    // We push a short notification payload (includes cmdId for debugging).
    try {
      await this.redis.rpush(`q:${deviceId}`, `notify:${cmd.cmdId}`);
    } catch (e) {
      // Non-fatal: if push fails, command is still available via cmdKey for polling that checks it first
      console.error('enqueueCommand: failed to notify list queue', e);
    }

    return { ok: true, cmd };
  }

  // -----------------------------------------
  // OPTIONAL: debug helper (UI/admin tooling)
  // -----------------------------------------
  async peekLatestCommand(deviceId: string) {
    if (!deviceId) throw new BadRequestException('deviceId required');
    const raw = await this.redis.get(this.cmdKey(deviceId));
    return raw ? safeJsonParse(raw) : null;
  }

  // ------------------------------------------------
  // ✅ Device poll should use this (consume command)
  // Atomically: GET + DEL
  // ------------------------------------------------
  async consumeLatestCommand(deviceId: string) {
    if (!deviceId) throw new BadRequestException('deviceId required');

    // Use MULTI for atomicity: read then delete
    const key = this.cmdKey(deviceId);
    const multi = this.redis.multi();
    multi.get(key);
    multi.del(key);

    const res = await multi.exec();
    const raw = res?.[0]?.[1] as string | null;

    return raw ? safeJsonParse(raw) : null;
  }

  // -----------------------------
  // OPTIONAL: clear pending command
  // -----------------------------
  async clearLatestCommand(deviceId: string) {
    if (!deviceId) throw new BadRequestException('deviceId required');
    await this.redis.del(this.cmdKey(deviceId));
    return { ok: true };
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
