import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { Redis } from 'ioredis';
import type { Request } from 'express';

@Injectable()
export class BrokerAuthGuard implements CanActivate {
  constructor(private readonly redis: Redis) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();
    const secret = process.env.JOVITA_BROKER_SHARED_SECRET;
    const timestamp = String(request.headers['x-broker-timestamp'] ?? '');
    const nonce = String(request.headers['x-broker-nonce'] ?? '');
    const signature = String(request.headers['x-broker-signature'] ?? '');
    const time = Number(timestamp);
    if (!secret || secret.length < 32 || !Number.isSafeInteger(time)
      || Math.abs(Date.now() - time) > 30_000 || !/^[0-9a-f-]{36}$/i.test(nonce)
      || !/^[0-9a-f]{64}$/i.test(signature)) throw new UnauthorizedException();
    const expected = createHmac('sha256', secret)
      .update(`${timestamp}\n${nonce}\n${request.path}\n${JSON.stringify(request.body ?? {})}`).digest();
    if (!timingSafeEqual(expected, Buffer.from(signature, 'hex'))) throw new UnauthorizedException();
    const claimed = await this.redis.set(`broker:nonce:${nonce}`, '1', 'PX', 60_000, 'NX');
    if (claimed !== 'OK') throw new UnauthorizedException();
    return true;
  }
}
