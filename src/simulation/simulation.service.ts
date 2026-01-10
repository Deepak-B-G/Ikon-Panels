import { Injectable, InternalServerErrorException } from '@nestjs/common';
import {
  DynamoDBClient,
  GetItemCommand,
  PutItemCommand,
} from '@aws-sdk/client-dynamodb';

type Mode = 'running' | 'stopped';

@Injectable()
export class SimulationService {
  private readonly ddb = new DynamoDBClient({});
  private readonly TABLE = process.env.TABLE_NAME || 'ikon-sim-state';

  // ------------------ utils ------------------

  private jitter(base: number, spread: number) {
    const v = base + (Math.random() * 2 - 1) * spread;
    return Math.round(v * 10) / 10;
  }

  // ------------------ LOAD / SAVE ------------------

  private async load(deviceId: string) {
    const res = await this.ddb.send(
      new GetItemCommand({
        TableName: this.TABLE,
        Key: { deviceId: { S: deviceId } },
      }),
    );

    if (res.Item) {
      return {
        deviceId,
        mode: (res.Item.mode?.S ?? 'stopped') as 'running' | 'stopped',
        autoStart: res.Item.autoStart?.BOOL ?? false,
        power: (res.Item.power?.S ?? 'OFF') as 'ON' | 'OFF',
        amps: res.Item.amps?.S
          ? JSON.parse(res.Item.amps.S)
          : { r: 0, y: 0, b: 0 },
        volts: res.Item.volts?.S
          ? JSON.parse(res.Item.volts.S)
          : { r: 230, y: 230, b: 230 },
        ts: res.Item.ts?.S ?? new Date().toISOString(),
      };
    }

    // ---------- default initialization ----------
    const init = {
      deviceId,
      mode: 'stopped' as const,
      autoStart: false,
      power: 'OFF' as const,
      amps: { r: 0, y: 0, b: 0 },
      volts: { r: 230, y: 230, b: 230 },
      ts: new Date().toISOString(),
    };

    await this.save(init);
    return init;
  }


  private async save(state: any) {
    await this.ddb.send(
      new PutItemCommand({
        TableName: this.TABLE,
        Item: {
          deviceId: { S: state.deviceId },
          mode: { S: state.mode },
          autoStart: { BOOL: state.autoStart },
          power: { S: state.power },
          amps: { S: JSON.stringify(state.amps) },
          volts: { S: JSON.stringify(state.volts) },
          ts: { S: state.ts },
        },
      }),
    );
  }

  // ------------------ SIMULATION TICK (same as Wix) ------------------

  private tick(prev: any) {
    const running = prev.mode === 'running';

    const power = running ? 'ON' : 'OFF';

    let amps;
    let volts;

    if (running) {
      amps = {
        r: this.jitter(10, 0.5),
        y: this.jitter(10, 0.5),
        b: this.jitter(10, 0.5),
      };

      volts = {
        r: this.jitter(230, 2),
        y: this.jitter(231, 2),
        b: this.jitter(229, 2),
      };
    } else {
      amps = { r: 0, y: 0, b: 0 };
      volts = { r: 230, y: 230, b: 230 };
    }

    return {
      ...prev,
      power,
      amps,
      volts,
      ts: new Date().toISOString(),
    };
  }

  // ------------------ PUBLIC API ------------------

  async handleTelemetry(deviceId: string) {
    try {
      let state = await this.load(deviceId);
      state = this.tick(state);
      await this.save(state);
      return state;
    } catch (err) {
      console.error(err);
      throw new InternalServerErrorException('Error fetching telemetry');
    }
  }

  async handleCommand(deviceId: string, action: string) {
    try {
      let state = await this.load(deviceId);

      if (action === 'start') state.mode = 'running';
      if (action === 'stop') state.mode = 'stopped';
      if (action === 'auto_on') state.autoStart = true;
      if (action === 'auto_off') state.autoStart = false;

      state = this.tick(state);
      await this.save(state);

      return {
        ok: true,
        state,
      };
    } catch (err) {
      console.error(err);
      throw new InternalServerErrorException('Error processing command');
    }
  }
}
