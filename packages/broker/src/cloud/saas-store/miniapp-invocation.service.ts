import { Injectable } from '@nestjs/common';
import { CloudCallbackClient } from '../cloud-callback.client.js';

@Injectable()
export class MiniappInvocationService {
  constructor(private readonly callback: CloudCallbackClient) {}
  settleDeferredCall(input: unknown): Promise<unknown> {
    return this.callback.post('/internal/jovita/settle-deferred', input);
  }
}
