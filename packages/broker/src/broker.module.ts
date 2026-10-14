import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { ScheduleModule } from '@nestjs/schedule';
import { Redis } from 'ioredis';
import { BrokerHealthController, BrokerController } from './broker.controller.js';
import { BrokerAuthGuard } from './internal-auth.guard.js';
import { SecretCryptoService } from './security/secret-crypto.service.js';
import { BrokerCatalogService } from './catalog/broker-catalog.service.js';
import { BrokerProviderProfile, BrokerProviderProfileSchema,
  BrokerOperation, BrokerOperationSchema, BrokerConnection, BrokerConnectionSchema,
  BrokerRouteGrant, BrokerRouteGrantSchema, BrokerExecution, BrokerExecutionSchema } from './catalog/broker-catalog.schema.js';

@Module({
  imports: [
    MongooseModule.forRoot(process.env.DATABASE_URL ?? 'mongodb://127.0.0.1:27017',
      { dbName: process.env.DATABASE_NAME ?? 'jovita_broker' }),
    MongooseModule.forFeature([
      { name: BrokerProviderProfile.name, schema: BrokerProviderProfileSchema },
      { name: BrokerOperation.name, schema: BrokerOperationSchema },
      { name: BrokerConnection.name, schema: BrokerConnectionSchema },
      { name: BrokerRouteGrant.name, schema: BrokerRouteGrantSchema },
      { name: BrokerExecution.name, schema: BrokerExecutionSchema },
    ]),
    ScheduleModule.forRoot(),
  ],
  controllers: [BrokerHealthController, BrokerController],
  providers: [
    { provide: Redis, useFactory: () => new Redis(process.env.REDIS_URL ?? 'redis://127.0.0.1:6379') },
    BrokerAuthGuard, SecretCryptoService, BrokerCatalogService,
  ],
})
export class BrokerModule {}
