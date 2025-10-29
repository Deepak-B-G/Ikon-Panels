import { Injectable, InternalServerErrorException } from '@nestjs/common';
import { IoTDataPlaneClient, PublishCommand } from '@aws-sdk/client-iot-data-plane';

@Injectable()
export class SimulationService {
  private readonly iot = new IoTDataPlaneClient({
    region: process.env.AWS_REGION || 'eu-north-1',
    endpoint: process.env.IOT_ENDPOINT, // e.g. a1b2c3d4e5f6-ats.iot.eu-north-1.amazonaws.com
  });

  async publishControl(deviceId: string, action: string) {
    try {
      const topic = `devices/${deviceId}/control`;
      const payload = JSON.stringify({ action });
      await this.iot.send(new PublishCommand({
        topic,
        qos: 1,
        payload: new TextEncoder().encode(payload),
      }));
      return { ok: true, published: topic, payload };
    } catch (err) {
      console.error('Error publishing control:', err);
      throw new InternalServerErrorException('Failed to publish control command');
    }
  }

  async processTelemetry(message: any) {
    console.log('Telemetry received:', JSON.stringify(message, null, 2));
    return { ok: true };
  }
}
