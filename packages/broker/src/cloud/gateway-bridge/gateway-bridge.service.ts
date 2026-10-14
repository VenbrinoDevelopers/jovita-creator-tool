import { Injectable } from '@nestjs/common';
import { CloudCallbackClient } from '../cloud-callback.client.js';

@Injectable()
export class GatewayBridgeService {
  constructor(private readonly callback: CloudCallbackClient) {}
  emitEvent(ownerId: string, event: string, payload: unknown): Promise<boolean> {
    return this.callback.post<boolean>('/internal/jovita/gateway-event', { ownerId, event, payload });
  }
}
