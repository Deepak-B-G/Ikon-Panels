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

  // Dry Run
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

  // ================= UTILS =================
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

          dryRunTripped: { BOOL: state.dryRunTripped },
          dryRunTrippedAt: state.dryRunTrippedAt
            ? { S: state.dryRunTrippedAt }
            : { NULL: true },

          restartPending: { BOOL: state.restartPending },
          restartAt: state.restartAt ? { S: state.restartAt } : { NULL: true },

          overloadTripped: { BOOL: state.overloadTripped },
          overloadTrippedAt: state.overloadTrippedAt
            ? { S: state.overloadTrippedAt }
            : { NULL: true },

          cyclePhase: state.cyclePhase
            ? { S: state.cyclePhase }
            : { NULL: true },

          cycleUntil: state.cycleUntil
            ? { S: state.cycleUntil }
            : { NULL: true },

          settings: { S: JSON.stringify(state.settings ?? {}) },
        },
      }),
    );
  }

  // ================= SETTINGS =================
  async saveSettings(deviceId: string, settings: any) {
    const state = await this.load(deviceId);

    if ('cyclicRunHrs' in settings || 'cyclicRunMins' in settings) {
      settings.cyclicRunMin =
        Number(settings.cyclicRunHrs || 0) * 60 +
        Number(settings.cyclicRunMins || 0);
    }

    if ('cyclicOffHrs' in settings || 'cyclicOffMins' in settings) {
      settings.cyclicOffMin =
        Number(settings.cyclicOffHrs || 0) * 60 +
        Number(settings.cyclicOffMins || 0);
    }

    state.settings = settings ?? {};
    await this.save(state);
    return { ok: true };
  }

  // ================= TELEMETRY =================
  async handleTelemetry(deviceId: string) {
    try {
      const state = await this.load(deviceId);
      const now = Date.now();

      const amps =
        state.mode === 'running' && state.powerOn
          ? {
              r: this.jitter(this.AMP_BASE, this.AMP_SPREAD),
              y: this.jitter(this.AMP_BASE, this.AMP_SPREAD),
              b: this.jitter(this.AMP_BASE, this.AMP_SPREAD),
            }
          : { r: 0, y: 0, b: 0 };

      // OVERLOAD
      if (
        state.mode === 'running' &&
        state.settings?.overloadEnabled
      ) {
        const limit = Number(state.settings?.overloadAmps || 0);
        if (limit > 0 && Math.max(amps.r, amps.y, amps.b) > limit) {
          state.overloadTripped = true;
          state.overloadTrippedAt = new Date(now).toISOString();
          state.mode = 'stopped';
          state.powerOn = false;
          state.restartPending = false;
        }
      }

      // DRY RUN
      if (
        state.mode === 'running' &&
        state.settings?.dryRunEnabled &&
        !state.dryRunTripped
      ) {
        if (!state.dryRunTrippedAt) {
          state.dryRunTrippedAt = new Date(now + 5000).toISOString();
        } else if (now >= new Date(state.dryRunTrippedAt).getTime()) {
          state.dryRunTripped = true;
          state.mode = 'stopped';
          state.powerOn = false;

          if (state.settings?.dryRunRestartEnabled) {
            const mins = Number(state.settings?.dryRunRestartDelayMin || 1);
            state.restartPending = true;
            state.restartAt = new Date(
              now + mins * 60 * 1000,
            ).toISOString();
          }
        }
      }

      // DRY RUN RESTART
      if (
        state.restartPending &&
        state.restartAt &&
        now >= new Date(state.restartAt).getTime()
      ) {
        state.restartPending = false;
        state.restartAt = null;
        state.dryRunTripped = false;
        state.dryRunTrippedAt = null;
        state.mode = 'running';
        state.powerOn = true;
      }

      // CYCLIC
      if (state.settings?.cyclicEnabled) {
        const runMin = Number(state.settings.cyclicRunMin || 0);
        const offMin = Number(state.settings.cyclicOffMin || 0);

        if (!state.cyclePhase) {
          state.cyclePhase = 'RUN';
          state.mode = 'running';
          state.powerOn = true;
          state.cycleUntil = new Date(
            now + runMin * 60 * 1000,
          ).toISOString();
        }

        if (state.cycleUntil && now >= new Date(state.cycleUntil).getTime()) {
          if (state.cyclePhase === 'RUN') {
            state.cyclePhase = 'OFF';
            state.mode = 'stopped';
            state.powerOn = false;
            state.cycleUntil = new Date(
              now + offMin * 60 * 1000,
            ).toISOString();
          } else {
            state.cyclePhase = 'RUN';
            state.mode = 'running';
            state.powerOn = true;
            state.cycleUntil = new Date(
              now + runMin * 60 * 1000,
            ).toISOString();
          }
        }
      } else {
        state.cyclePhase = null;
        state.cycleUntil = null;
      }

      await this.save(state);

      return {
        deviceId: state.deviceId,
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
    } catch (err) {
      console.error(err);
      throw new InternalServerErrorException('Telemetry error');
    }
  }

  // ================= COMMAND =================
  async handleCommand(deviceId: string, action: string) {
    try {
      const state = await this.load(deviceId);

      if (action === 'start') {
        state.mode = 'running';
        state.powerOn = true;
        state.overloadTripped = false;
        state.dryRunTripped = false;
        state.restartPending = false;
      }

      if (action === 'stop') {
        state.mode = 'stopped';
        state.powerOn = false;
        state.cyclePhase = null;
        state.cycleUntil = null;
        state.restartPending = false;
      }

      if (action === 'auto_on') state.autoStart = true;
      if (action === 'auto_off') state.autoStart = false;

      await this.save(state);
      return { ok: true };
    } catch (err) {
      console.error(err);
      throw new InternalServerErrorException('Command error');
    }
  }
}
