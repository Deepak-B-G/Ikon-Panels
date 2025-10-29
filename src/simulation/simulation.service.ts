import { Injectable, InternalServerErrorException } from '@nestjs/common';
import {
  IoTDataPlaneClient,
  PublishCommand,
  GetThingShadowCommand,
} from '@aws-sdk/client-iot-data-plane';

@Injectable()
export class SimulationService {
  private readonly iot = new IoTDataPlaneClient({
    region: process.env.AWS_REGION || 'eu-north-1',
    endpoint: process.env.IOT_ENDPOINT,
  });

  // 🔹 Publish control commands to device
  async publishControlToIoT(deviceId: string, action: string) {
    try {
      const topic = `devices/${deviceId}/control`;
      const payload = JSON.stringify({ action });
      await this.iot.send(new PublishCommand({ topic, qos: 0, payload: Buffer.from(payload) }));
      return { ok: true, message: `Command '${action}' sent to ${deviceId}` };
    } catch (err) {
      console.error('Publish Error:', err);
      throw new InternalServerErrorException('Failed to publish command');
    }
  }

  // 🔹 Retrieve latest telemetry from IoT Core shadow
  async getTelemetryFromIoT(deviceId: string) {
    try {
      const command = new GetThingShadowCommand({ thingName: deviceId });
      const response = await this.iot.send(command);
      if (!response.payload) return { message: 'No telemetry found' };

      const shadow = JSON.parse(Buffer.from(response.payload).toString());
      return shadow.state?.reported || shadow;
    } catch (err) {
      console.error('Telemetry Error:', err);
      throw new InternalServerErrorException('Failed to fetch telemetry');
    }
  }
}
