import { Body, Controller, Get, HttpException, Post, ServiceUnavailableException, UseGuards } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import type { Connection } from 'mongoose';
import { Redis } from 'ioredis';
import { BrokerAuthGuard } from './internal-auth.guard.js';
import { BrokerCatalogService } from './catalog/broker-catalog.service.js';
import { ProviderOutcomeUnknownError, type CapabilityCallInput } from './contracts/capability.js';

@Controller('health')
export class BrokerHealthController {
  constructor(@InjectConnection() private readonly mongo: Connection, private readonly redis: Redis) {}
  @Get()
  async check() {
    if (this.mongo.readyState !== 1 || await this.redis.ping() !== 'PONG') {
      throw new ServiceUnavailableException('Broker dependencies are not ready');
    }
    return { status: 'ok' };
  }
}

@Controller('internal/broker')
@UseGuards(BrokerAuthGuard)
export class BrokerController {
  constructor(private readonly catalog: BrokerCatalogService) {}

  @Post('catalog-snapshot')
  async snapshot() { return { definitions: await this.catalog.definitions(), credentialProviders: [] }; }
  @Post('activation-requirements')
  requirements(@Body() body: { capability: string; packId: string }) {
    return this.catalog.activationRequirements(body.capability, body.packId);
  }
  @Post('estimate')
  estimate() { return { quantity: 1 }; }
  @Post('invoke')
  async invoke(@Body() body: CapabilityCallInput) {
    try { return await this.catalog.invoke(body); }
    catch (error) {
      if (error instanceof ProviderOutcomeUnknownError) {
        throw new HttpException({ code: error.code, message: error.message }, 409);
      }
      throw error;
    }
  }
  @Post('reconcile-call')
  reconcile(@Body() body: Parameters<BrokerCatalogService['reconcile']>[0]) { return this.catalog.reconcile(body); }
  @Post('catalog/list')
  list(@Body() body: { creatorId: string }) { return this.catalog.list(body.creatorId); }
  @Post('catalog/profile/draft')
  draft(@Body() body: { creatorId: string; profile: Parameters<BrokerCatalogService['draftProfile']>[1] }) {
    return this.catalog.draftProfile(body.creatorId, body.profile);
  }
  @Post('catalog/profile/approve')
  approve(@Body() body: { profileId: string; adminId: string }) { return this.catalog.approveProfile(body.profileId, body.adminId); }
  @Post('catalog/profile/pending')
  pending() { return this.catalog.pendingProfiles(); }
  @Post('catalog/operation')
  operation(@Body() body: { creatorId: string; operation: Parameters<BrokerCatalogService['createOperation']>[1] }) {
    return this.catalog.createOperation(body.creatorId, body.operation);
  }
  @Post('catalog/manifest/import')
  importManifest(@Body() body: { creatorId: string; packId: string; broker: unknown; capabilities: unknown }) {
    return this.catalog.importManifest(body.creatorId, body.packId, body.broker, body.capabilities);
  }
  @Post('catalog/connection')
  connection(@Body() body: { creatorId: string; connection: Parameters<BrokerCatalogService['saveConnection']>[1] }) {
    return this.catalog.saveConnection(body.creatorId, body.connection);
  }
  @Post('catalog/connection/test')
  testConnection(@Body() body: { creatorId: string; connectionId: string; capabilityId?: string;
    sampleInput?: Record<string, unknown>; confirmProviderCharge?: boolean }) {
    return this.catalog.testConnection(body.creatorId, body.connectionId, body.capabilityId,
      body.sampleInput ?? {}, body.confirmProviderCharge === true);
  }
  @Post('catalog/grant')
  grant(@Body() body: { creatorId: string; grant: Parameters<BrokerCatalogService['grant']>[1] }) {
    return this.catalog.grant(body.creatorId, body.grant);
  }
  @Post('catalog/grant/revoke')
  revoke(@Body() body: { creatorId: string; packId: string; capabilityId: string }) {
    return this.catalog.revoke(body.creatorId, body.packId, body.capabilityId);
  }
  @Post('catalog/price')
  price(@Body() body: { capabilityId: string }) { return this.catalog.price(body.capabilityId); }
}
