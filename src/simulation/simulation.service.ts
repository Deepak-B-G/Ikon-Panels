import { Injectable, InternalServerErrorException } from '@nestjs/common';
import { DynamoDBClient, GetItemCommand, PutItemCommand } from '@aws-sdk/client-dynamodb';

@Injectable()
export class SimulationService {
  private readonly ddb = new DynamoDBClient({});
  private readonly TABLE = process.env.TABLE_NAME || 'ikon-sim-state';
  private readonly MAX_RPM = 3000;
  private readonly RAMP_RPM_PER_SEC = 300;
  private readonly FILL_PER_SEC = 0.25;
  private readonly DRAIN_PER_SEC = 0.1;

  private clamp(v: number, lo: number, hi: number) {
    return Math.max(lo, Math.min(hi, v));
  }

  private async load(deviceId: string) {
    const res = await this.ddb.send(new GetItemCommand({
      TableName: this.TABLE,
      Key: { deviceId: { S: deviceId } },
    }));

    if (res.Item) {
      return {
        deviceId,
        mode: res.Item.mode.S,
        rpm: Number(res.Item.rpm.N),
        rpmTarget: Number(res.Item.rpmTarget.N),
        waterLevel: Number(res.Item.waterLevel.N),
        waterTarget: Number(res.Item.waterTarget.N),
        lastChange: res.Item.lastChange.S,
        lastSampleAt: res.Item.lastSampleAt?.S || res.Item.lastChange.S,
      };
    }

    // Default initialization
    const now = new Date().toISOString();
    const init = {
      deviceId, mode: 'stopped',
      rpm: 0, rpmTarget: this.MAX_RPM,
      waterLevel: 35.0, waterTarget: 100,
      lastChange: now, lastSampleAt: now,
    };
    await this.save(init);
    return init;
  }

  private async save(state: any) {
    await this.ddb.send(new PutItemCommand({
      TableName: this.TABLE,
      Item: {
        deviceId: { S: state.deviceId },
        mode: { S: state.mode },
        rpm: { N: String(state.rpm) },
        rpmTarget: { N: String(state.rpmTarget) },
        waterLevel: { N: String(state.waterLevel) },
        waterTarget: { N: String(state.waterTarget) },
        lastChange: { S: state.lastChange },
        lastSampleAt: { S: state.lastSampleAt },
      },
    }));
  }

  private evolve(prev: any, now: Date) {
    const last = new Date(prev.lastSampleAt || prev.lastChange);
    const elapsed = Math.max(0, (now.getTime() - last.getTime()) / 1000);
    const target = prev.mode === 'running' ? (prev.rpmTarget || this.MAX_RPM) : 0;

    let rpm = prev.rpm;
    if (rpm < target) rpm = Math.min(target, rpm + this.RAMP_RPM_PER_SEC * elapsed);
    else if (rpm > target) rpm = Math.max(target, rpm - this.RAMP_RPM_PER_SEC * elapsed);

    let water = prev.waterLevel;
    if (prev.mode === 'running')
      water = this.clamp(water + this.FILL_PER_SEC * elapsed, 0, 100);
    else
      water = this.clamp(water - this.DRAIN_PER_SEC * elapsed, 0, 100);

    return {
      ...prev,
      rpm: Math.round(rpm),
      waterLevel: Math.round(water * 10) / 10,
      lastSampleAt: now.toISOString(),
    };
  }

  async handleTelemetry(deviceId: string) {
    try {
      let state = await this.load(deviceId);
      const now = new Date();
      state = this.evolve(state, now);
      await this.save(state);
      return { deviceId, ts: now.toISOString(), rpm: state.rpm, waterLevel: state.waterLevel, mode: state.mode };
    } catch (err) {
      console.error(err);
      throw new InternalServerErrorException('Error fetching telemetry');
    }
  }

  async handleCommand(deviceId: string, action: string) {
    try {
      let state = await this.load(deviceId);
      const now = new Date();
      state = this.evolve(state, now);

      if (action === 'start') { state.mode = 'running'; state.lastChange = now.toISOString(); }
      else if (action === 'stop') { state.mode = 'stopped'; state.lastChange = now.toISOString(); }

      await this.save(state);
      return { ok: true, state };
    } catch (err) {
      console.error(err);
      throw new InternalServerErrorException('Error processing command');
    }
  }
}
