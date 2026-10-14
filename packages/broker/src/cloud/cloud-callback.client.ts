import { BadGatewayException, Injectable } from '@nestjs/common';
import { createHmac, randomUUID } from 'node:crypto';

/** Cloud-only callback. Standalone brokers do not need a Jovita server. */
@Injectable()
export class CloudCallbackClient {
  async post<T>(path: string, body: unknown): Promise<T> {
    const origin = process.env.JOVITA_SERVER_INTERNAL_URL;
    const secret = process.env.JOVITA_BROKER_SHARED_SECRET;
    if (!origin || !secret || secret.length < 32) {
      throw new BadGatewayException('Jovita Cloud callback is not configured');
    }
    const payload = JSON.stringify(body);
    const timestamp = String(Date.now());
    const nonce = randomUUID();
    const signature = createHmac('sha256', secret)
      .update(`${timestamp}\n${nonce}\n${path}\n${payload}`).digest('hex');
    const response = await fetch(new URL(path, origin), {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(30_000),
      headers: { 'content-type': 'application/json', 'x-broker-timestamp': timestamp,
        'x-broker-nonce': nonce, 'x-broker-signature': signature },
      body: payload,
    });
    if (!response.ok) throw new BadGatewayException(`Jovita Cloud callback failed: ${response.status}`);
    return await response.json() as T;
  }
}
