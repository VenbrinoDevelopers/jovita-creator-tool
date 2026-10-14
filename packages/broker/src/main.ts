import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { json } from 'express';
import { BrokerModule } from './broker.module.js';

async function main() {
  if (!process.env.JOVITA_BROKER_SHARED_SECRET || process.env.JOVITA_BROKER_SHARED_SECRET.length < 32) {
    throw new Error('JOVITA_BROKER_SHARED_SECRET must contain at least 32 characters');
  }
  if (!process.env.JOVITA_DATA_ENCRYPTION_KEY || process.env.JOVITA_DATA_ENCRYPTION_KEY.length < 32) {
    throw new Error('JOVITA_DATA_ENCRYPTION_KEY must contain at least 32 characters');
  }
  const app = await NestFactory.create(BrokerModule, { bodyParser: false });
  app.use(json({ limit: '12mb' }));
  app.enableShutdownHooks();
  await app.listen(Number(process.env.BROKER_PORT ?? 19091), process.env.BROKER_HOST ?? '127.0.0.1');
}

void main().catch(error => { process.stderr.write(`${String(error)}\n`); process.exitCode = 1; });
