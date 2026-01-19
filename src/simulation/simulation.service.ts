import { Injectable, InternalServerErrorException } from '@nestjs/common';
import {
  DynamoDBClient,
  GetItemCommand,
  PutItemCommand,
} from '@aws-sdk/client-dynamodb';

type Mode = 'running' | 'stopped';
type CyclePhase = 'RUN' | 'OFF' | null;

interface SimState {
  deviceId: string;

  // Motor
  mode: Mode;
  powerOn: boolean;
  autoStart: boolean;

  // Delays
  pendingPowerOn: boolean;
  powerOnAt: string | null;

  pendingAutoStart: boolean;
  autoStartAt: string | null;

  // Dry run
  dryRunTripped: boolean;
  dryRunTrippedAt: string | null;
  restartPending: boolean;
  restartAt: string | null;

  // Overload
  overloadTripped: boolean;
  overloadTrippedAt: string | null;

  // Cyclic
  cyclePhase: CyclePhase;
  cycleUntil: string | null;

  // Settings
  settings: Record<string, any>;
}

@Injectable()
export class SimulationService {
  private readonly ddb = new DynamoDBClient({});
  private readonly TABLE = process.env.TABLE_NAME || 'ikon-sim-state';

  private readonly AMP_BASE = 10;
  private readonly AMP_SPREAD = 2;
  private readonly VOLTS = { r: 230, y: 231, b: 229 };

  // ================= UTIL =================
  private jitter(base: number, spread: number) {
    return Math.round((base + (Math.random() * 2 - 1) * spread) * 10) / 10;
  }

  private parseJson(attr?: { S?: string }): Record<string, any> {
    if (!attr?.S) return {};
    try {
      return JSON.parse(attr.S);
    } catch {
      return {};
    }
  }

  private parseCyclePhase(v?: string): CyclePhase {
    return v === 'RUN' || v === 'OFF' ? v : null;
  }

  // ================= LOAD / SAVE =================
  private async load(deviceId: string): Promise<SimState> {
    const res = await this.ddb.send(
      new GetItemCommand({
        TableName: this.TABLE,
        Key: { deviceId: { S: deviceId } },
      }),
    );

    if (res.Item) {
      return {
        deviceId,
        mode: res.Item.mode?.S === 'running' ? 'running' : 'stopped',
        powerOn: res.Item.powerOn?.BOOL ?? false,
        autoStart: res.Item.autoStart?.BOOL ?? false,

        pendingPowerOn: res.Item.pendingPowerOn?.BOOL ?? false,
        powerOnAt: res.Item.powerOnAt?.S ?? null,

        pendingAutoStart: res.Item.pendingAutoStart?.BOOL ?? false,
        autoStartAt: res.Item.autoStartAt?.S ?? null,

        dryRunTripped: res.Item.dryRunTripped?.BOOL ?? false,
        dryRunTrippedAt: res.Item.dryRunTrippedAt?.S ?? null,
        restartPending: res.Item.restartPending?.BOOL ?? false,
        restartAt: res.Item.restartAt?.S ?? null,

        overloadTripped: res.Item.overloadTripped?.BOOL ?? false,
        overloadTrippedAt: res.Item.overloadTrippedAt?.S ?? null,

        cyclePhase: this.parseCyclePhase(res.Item.cyclePhase?.S),
        cycleUntil: res.Item.cycleUntil?.S ?? null,

        settings: this.parseJson(res.Item.settings),
      };
    }

    const init: SimState = {
      deviceId,
      mode: 'stopped',
      powerOn: false,
      autoStart: false,

      pendingPowerOn: false,
      powerOnAt: null,

      pendingAutoStart: false,
      autoStartAt: null,

      dryRunTripped: false,
      dryRunTrippedAt: null,
      restartPending: false,
      restartAt: null,

      overloadTripped: false,
      overloadTrippedAt: null,

      cyclePhase: null,
      cycleUntil: null,

      settings: {},
    };

    await this.save(init);
    return init;
  }

  private async save(state: SimState) {
    await this.ddb.send(
      new PutItemCommand({
        TableName: this.TABLE,
        Item: {
          deviceId: { S: state.deviceId },
          mode: { S: state.mode },
          powerOn: { BOOL: state.powerOn },
          autoStart: { BOOL: state.autoStart },

          pendingPowerOn: { BOOL: state.pendingPowerOn },
          powerOnAt: state.powerOnAt ? { S: state.powerOnAt } : { NULL: true },

          pendingAutoStart: { BOOL: state.pendingAutoStart },
          autoStartAt: state.autoStartAt ? { S: state.autoStartAt } : { NULL: true },

          dryRunTripped: { BOOL: state.dryRunTripped },
          dryRunTrippedAt: state.dryRunTrippedAt ? { S: state.dryRunTrippedAt } : { NULL: true },

          restartPending: { BOOL: state.restartPending },
          restartAt: state.restartAt ? { S: state.restartAt } : { NULL: true },

          overloadTripped: { BOOL: state.overloadTripped },
          overloadTrippedAt: state.overloadTrippedAt ? { S: state.overloadTrippedAt } : { NULL: true },

          cyclePhase: state.cyclePhase ? { S: state.cyclePhase } : { NULL: true },
          cycleUntil: state.cycleUntil ? { S: state.cycleUntil } : { NULL: true },

          settings: { S: JSON.stringify(state.settings ?? {}) },
        },
      }),
    );
  }

  // ================= SETTINGS =================
  async saveSettings(deviceId: string, settings: any) {
    const state = await this.load(deviceId);

    settings.cyclicRunMin =
      Number(settings.cyclicRunHrs || 0) * 60 +
      Number(settings.cyclicRunMins || 0);

    settings.cyclicOffMin =
      Number(settings.cyclicOffHrs || 0) * 60 +
      Number(settings.cyclicOffMins || 0);

    state.settings = settings;
    await this.save(state);
    return { ok: true };
  }

  // ================= TELEMETRY =================
  async handleTelemetry(deviceId: string) {
    try {
      const state = await this.load(deviceId);
      const now = Date.now();

      // AUTO START DELAY
      if (state.pendingAutoStart && state.autoStartAt && now >= Date.parse(state.autoStartAt)) {
        state.pendingAutoStart = false;
        state.autoStartAt = null;
        state.powerOn = true;
        state.mode = 'running';
      }

      // POWER ON DELAY
      if (state.pendingPowerOn && state.powerOnAt && now >= Date.parse(state.powerOnAt)) {
        state.pendingPowerOn = false;
        state.powerOnAt = null;
        state.powerOn = true;
      }

      // CYCLIC
      if (state.settings?.cyclicEnabled) {
        const runMin = Number(state.settings.cyclicRunMin || 0);
        const offMin = Number(state.settings.cyclicOffMin || 0);

        if (!state.cyclePhase) {
          state.cyclePhase = 'RUN';
          state.mode = 'running';
          state.pendingPowerOn = false;
          state.powerOn = true;
          state.cycleUntil = new Date(now + runMin * 60000).toISOString();
        }

        if (state.cycleUntil && now >= Date.parse(state.cycleUntil)) {
          if (state.cyclePhase === 'RUN') {
            state.cyclePhase = 'OFF';
            state.mode = 'stopped';
            state.powerOn = false;
            state.cycleUntil = new Date(now + offMin * 60000).toISOString();
          } else {
            state.cyclePhase = 'RUN';
            state.mode = 'running';
            state.powerOn = true;
            state.cycleUntil = new Date(now + runMin * 60000).toISOString();
          }
        }
      }

      // AMPS
      const amps =
        state.mode === 'running' && state.powerOn
          ? {
              r: this.jitter(this.AMP_BASE, this.AMP_SPREAD),
              y: this.jitter(this.AMP_BASE, this.AMP_SPREAD),
              b: this.jitter(this.AMP_BASE, this.AMP_SPREAD),
            }
          : { r: 0, y: 0, b: 0 };

      // OVERLOAD
      if (state.mode === 'running' && state.settings?.overloadEnabled) {
        const limit = Number(state.settings.overloadAmps || 0);
        if (limit > 0 && Math.max(amps.r, amps.y, amps.b) > limit) {
          state.overloadTripped = true;
          state.overloadTrippedAt = new Date().toISOString();
          state.mode = 'stopped';
          state.powerOn = false;
        }
      }

      await this.save(state);

      return {
        deviceId,
        ts: new Date().toISOString(),
        mode: state.mode,
        autoStart: state.autoStart,
        power: state.powerOn ? 'ON' : 'OFF',
        amps,
        volts: {
          r: this.jitter(this.VOLTS.r, 2),
          y: this.jitter(this.VOLTS.y, 2),
          b: this.jitter(this.VOLTS.b, 2),
        },
      };
    } catch (e) {
      console.error(e);
      throw new InternalServerErrorException('Telemetry error');
    }
  }

  // ================= COMMAND =================
  async handleCommand(deviceId: string, action: string) {
    const state = await this.load(deviceId);
    const now = Date.now();

    if (action === 'start') {
      state.mode = 'running';

      if (state.settings?.powerOnDelayEnabled) {
        state.pendingPowerOn = true;
        state.powerOnAt = new Date(
          now + Number(state.settings.powerOnDelaySec || 0) * 1000,
        ).toISOString();
      } else {
        state.powerOn = true;
      }
    }

    if (action === 'stop') {
      state.mode = 'stopped';
      state.powerOn = false;
      state.pendingPowerOn = false;
      state.pendingAutoStart = false;
      state.cyclePhase = null;
      state.cycleUntil = null;
    }

    if (action === 'auto_on') {
      state.autoStart = true;
      if (state.settings?.autoStartDelayEnabled) {
        state.pendingAutoStart = true;
        state.autoStartAt = new Date(
          now + Number(state.settings.autoStartDelaySec || 0) * 1000,
        ).toISOString();
      }
    }

    if (action === 'auto_off') {
      state.autoStart = false;
      state.pendingAutoStart = false;
      state.autoStartAt = null;
    }

    await this.save(state);
    return { ok: true };
  }
}
