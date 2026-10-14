import { Injectable } from '@nestjs/common';
import { Redis } from 'ioredis';
@Injectable()
export class RedisService {
  constructor(readonly clientInstance: Redis) {}
  isReady(): boolean { return this.clientInstance.status === 'ready'; }
}
