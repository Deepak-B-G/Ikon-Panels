import { BadRequestException, Injectable } from '@nestjs/common';
import Redis from 'ioredis';
import {
  DynamoDBClient,
  GetItemCommand,
  UpdateItemCommand,
} from '@aws-sdk/client-dynamodb';

function isoNow() {
  return new Date().toISOString();
}

function safeJsonParse<T = any>(s?: string): T {
  if (!s) return {} as T;
  try {
    return JSON.parse(s) as T;
  } catch {
    return {} as T;
  }
}

type RunAction = 'start' | 'stop';

type PendingCommand = {
  cmdId: string;
  action: string;
  payload: any;
  ts: string;
};

@Injectable()
export class UiService {
  private readonly redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379');

  private readonly ddb = new DynamoDBClient({
    region: process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION,
  });

  private readonly STATE_TABLE =
    process.env.DEVICE_STATE_TABLE || 'ikon-device-state';

  // ============================
  // Redis keys (separate slots)
  // ============================
  private runCmdKey(deviceId: string) {
    return `cmd:run:${deviceId}`; // start/stop slot
  }

  private settingsCmdKey(deviceId: string) {
    return `cmd:settings:${deviceId}`; // settings slot
  }

  private notifyQueueKey(deviceId: string) {
    return `q:${deviceId}`; // used to wake long-poll BLPOP
  }

  // ============================
  // Validation helpers
  // ============================
  private extract(body: any) {
    // Accept direct or wrapped response shapes
    // Primary expected: { deviceId, ... }
    // Some wrappers: { data: { ... } } or { data: { cmd: {...} } } or { cmd: {...} }
    let src = body;

    if (src?.data && typeof src.data === 'object') src = src.data;
    if (src?.cmd && typeof src.cmd === 'object') src = src.cmd;

    return src || {};
  }

  private validateRunCommand(body: any) {
    const src = this.extract(body);

    const deviceId = src?.deviceId;
    const action = String(src?.action || '').trim().toLowerCase() as RunAction;

    if (!deviceId) throw new BadRequestException('deviceId required');
    if (action !== 'start' && action !== 'stop') {
      throw new BadRequestException('action must be start or stop');
    }

    // optional payload, but start/stop typically empty
    const payload = src?.payload && typeof src.payload === 'object' ? src.payload : {};

    return { deviceId, action, payload };
  }

  private validateSettings(body: any) {
    const src = this.extract(body);

    const deviceId = src?.deviceId;
    const settings = src?.settings;

    if (!deviceId) throw new BadRequestException('deviceId required');
    if (!settings || typeof settings !== 'object') {
      throw new BadRequestException('settings (object) required');
    }

    return { deviceId, settings };
  }

  // ============================
  // UI: start/stop command
  // POST /api/v1/ui/command
  // ============================
  async enqueueRunCommand(body: any) {
    const { deviceId, action, payload } = this.validateRunCommand(body);

    const cmd: PendingCommand = {
      cmdId: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
      action,
      payload,
      ts: isoNow(),
    };

    // ✅ only touches run slot
    await this.redis.set(this.runCmdKey(deviceId), JSON.stringify(cmd));

    // ✅ wake any long-pollers
    try {
      await this.redis.rpush(this.notifyQueueKey(deviceId), `notify:${cmd.cmdId}`);
    } catch (e) {
      console.error('enqueueRunCommand: failed to notify list queue', e);
    }

    // Keep response lean (no redundant nested objects)
    return { ok: true, cmdId: cmd.cmdId, action: cmd.action, ts: cmd.ts };
  }

  // ============================
  // UI: save settings
  // POST /api/v1/ui/settings
  // ============================
  async saveSettings(body: any) {
    const { deviceId, settings } = this.validateSettings(body);

    const version = Date.now();
    const updatedAt = isoNow();

    // ✅ store settings in DynamoDB (does NOT overwrite telemetry fields)
    await this.ddb.send(
      new UpdateItemCommand({
        TableName: this.STATE_TABLE,
        Key: { deviceId: { S: deviceId } },
        UpdateExpression:
          'SET #settings = :s, settingsVersion = :v, settingsUpdatedAt = :t',
        ExpressionAttributeNames: {
          '#settings': 'settings',
        },
        ExpressionAttributeValues: {
          ':s': { S: JSON.stringify(settings) },
          ':v': { N: String(version) },
          ':t': { S: updatedAt },
        },
      }),
    );

    // ✅ enqueue a settings_apply command for device
    const cmd: PendingCommand = {
      cmdId: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
      action: 'settings_apply',
      payload: {
        settingsVersion: version,
        settings, // device needs actual settings (it can't read DynamoDB)
      },
      ts: updatedAt,
    };

    // ✅ only touches settings slot
    await this.redis.set(this.settingsCmdKey(deviceId), JSON.stringify(cmd));

    // ✅ wake any long-pollers
    try {
      await this.redis.rpush(this.notifyQueueKey(deviceId), `notify:${cmd.cmdId}`);
    } catch (e) {
      console.error('saveSettings: failed to notify list queue', e);
    }

    // ✅ UI response (NOT redundant)
    return {
      ok: true,
      deviceId,
      settingsVersion: version,
      settingsUpdatedAt: updatedAt,
      cmdId: cmd.cmdId,
    };
  }

  // ============================
  // UI: get latest settings once
  // GET /api/v1/ui/settings?deviceId=...
  // ============================
  async getLatestSettings(deviceId: string) {
    if (!deviceId) throw new BadRequestException('deviceId required');

    const res = await this.ddb.send(
      new GetItemCommand({
        TableName: this.STATE_TABLE,
        Key: { deviceId: { S: deviceId } },
      }),
    );

    const item = res.Item;
    if (!item) {
      return {
        deviceId,
        settings: {},
        settingsVersion: 0,
        settingsUpdatedAt: null,
      };
    }

    const settings = safeJsonParse(item.settings?.S);
    const settingsVersion = Number(item.settingsVersion?.N || 0);
    const settingsUpdatedAt = item.settingsUpdatedAt?.S || null;

    return { deviceId, settings, settingsVersion, settingsUpdatedAt };
  }

  // ============================
  // UI: telemetry (polling)
  // GET /api/v1/ui/telemetry?deviceId=...
  // ============================
  async getLatestTelemetry(deviceId: string) {
    if (!deviceId) throw new BadRequestException('deviceId required');

    const res = await this.ddb.send(
      new GetItemCommand({
        TableName: this.STATE_TABLE,
        Key: { deviceId: { S: deviceId } },
      }),
    );

    const item = res.Item;

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

  // ==========================================================
  // ✅ Device helper: consume BOTH pending commands atomically
  // DeviceService.poll() should call this.
  // ==========================================================
  async consumePending(deviceId: string): Promise<PendingCommand[]> {
    if (!deviceId) throw new BadRequestException('deviceId required');

    const runKey = this.runCmdKey(deviceId);
    const setKey = this.settingsCmdKey(deviceId);

    const multi = this.redis.multi();
    multi.get(runKey);
    multi.get(setKey);
    multi.del(runKey);
    multi.del(setKey);

    const res = await multi.exec();

    const runRaw = (res?.[0]?.[1] as string) || null;
    const setRaw = (res?.[1]?.[1] as string) || null;

    const cmds: PendingCommand[] = []; // ✅ fixes "never[]" TS inference
    if (runRaw) cmds.push(safeJsonParse<PendingCommand>(runRaw));
    if (setRaw) cmds.push(safeJsonParse<PendingCommand>(setRaw));

    return cmds;
  }

  // Optional debug peek
  async peekPending(deviceId: string) {
    if (!deviceId) throw new BadRequestException('deviceId required');
    const run = await this.redis.get(this.runCmdKey(deviceId));
    const settings = await this.redis.get(this.settingsCmdKey(deviceId));
    return {
      run: run ? safeJsonParse(run) : null,
      settings: settings ? safeJsonParse(settings) : null,
    };
  }
}
