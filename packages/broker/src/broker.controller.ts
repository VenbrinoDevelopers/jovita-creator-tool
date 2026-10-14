import { Body, Controller, Get, HttpException, Post, ServiceUnavailableException, UseGuards } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import type { Connection } from 'mongoose';
import { Redis } from 'ioredis';
import { BrokerAuthGuard } from './internal-auth.guard.js';
import { BrokerCatalogService } from './catalog/broker-catalog.service.js';
import { BuiltinOperationEngine } from './operations/builtin-operation.engine.js';
import { BrokerOperationRouter } from './operations/broker-operation.router.js';
import { MiniappProviderCredentialService } from './credentials/admin-credential.service.js';
import { GoogleWorkspaceAuthService } from './cloud/saas-store/google-workspace-auth.service.js';
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
  constructor(private readonly catalog: BrokerCatalogService,
    private readonly builtins: BuiltinOperationEngine,
    private readonly operations: BrokerOperationRouter,
    private readonly credentials: MiniappProviderCredentialService,
    private readonly google: GoogleWorkspaceAuthService) {}

  @Post('catalog-snapshot')
  async snapshot() { return { definitions: await this.operations.definitions(),
    credentialProviders: this.builtins.credentialOnlyProviders() }; }
  @Post('activation-requirements')
  requirements(@Body() body: { capability: string; packId: string; operationId: string }) {
    return this.operations.activationRequirements(body.capability, body.packId, body.operationId);
  }
  @Post('estimate')
  async estimate(@Body() body: Parameters<BuiltinOperationEngine['estimateQuantityForCall']>[0]) {
    return { quantity: await this.operations.estimate(body) };
  }
  @Post('invoke')
  async invoke(@Body() body: CapabilityCallInput) {
    try { return await this.operations.invoke(body); }
    catch (error) {
      if (error instanceof ProviderOutcomeUnknownError) {
        throw new HttpException({ code: error.code, message: error.message,
          diagnostics: error.diagnostics, measurement: error.measurement }, 409);
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

  @Post('google/connection')
  async googleConnection(@Body() body: { ownerId: string }) {
    const row = await this.google.getConnection(body.ownerId);
    if (!row) return null;
    const object = row.toObject();
    delete object.refreshTokenEncrypted;
    delete object.accessTokenEncrypted;
    return object;
  }
  @Post('google/start-consent')
  startConsent(@Body() body: { ownerId: string;
    manifest: Parameters<GoogleWorkspaceAuthService['startProviderConsent']>[1];
    input: Parameters<GoogleWorkspaceAuthService['startProviderConsent']>[2] }) {
    return this.google.startProviderConsent(body.ownerId, body.manifest, body.input);
  }
  @Post('google/auth-status')
  authStatus(@Body() body: { ownerId: string; authSessionId: string }) {
    return this.google.getAuthSessionStatus(body.ownerId, body.authSessionId);
  }
  @Post('google/finalize')
  async finalizeGoogle(@Body() body: Parameters<GoogleWorkspaceAuthService['finalizeGoogleSignIn']>[0]): Promise<Record<string, unknown>> {
    return await this.google.finalizeGoogleSignIn(body) as unknown as Record<string, unknown>;
  }
  @Post('google/disconnect')
  disconnectGoogle(@Body() body: { ownerId: string }) {
    return this.google.disconnectService(body.ownerId).then(() => ({ ok: true }));
  }

  @Post('test-credential')
  async testCredential(@Body() body: { providerId: string; config: Record<string, unknown> }) {
    await this.builtins.testCredential(body.providerId, await this.testConfig(body.providerId, body.config));
    return { ok: true };
  }
  @Post('provider-account-status')
  accountStatus(@Body() body: { providerId: string; config: Record<string, unknown> }) {
    return this.testConfig(body.providerId, body.config)
      .then(config => this.builtins.providerAccountStatus(body.providerId, config));
  }
  @Post('credential/put')
  putCredential(@Body() body: Parameters<MiniappProviderCredentialService['put']>[0]) {
    this.builtins.validateCredential(body.providerId, body.config);
    return this.credentials.put(body);
  }
  @Post('credential/creator/put')
  putCreatorCredential(@Body() body: Parameters<MiniappProviderCredentialService['putCreator']>[0]) {
    this.builtins.validateCredential(body.providerId, body.config);
    return this.credentials.putCreator(body);
  }
  @Post('credential/creator/list')
  listCreatorCredentials(@Body() body: { creatorId: string }) { return this.credentials.listCreator(body.creatorId); }
  @Post('credential/creator/bindings')
  listCreatorBindings(@Body() body: { creatorId: string }) { return this.credentials.listCreatorBindings(body.creatorId); }
  @Post('credential/creator/bind')
  bindCreatorCredential(@Body() body: Parameters<MiniappProviderCredentialService['bindCreator']>[0]) {
    return this.credentials.bindCreator(body);
  }
  @Post('credential/creator/promote')
  promoteCreatorCredential(@Body() body: Parameters<MiniappProviderCredentialService['promotePackToCreator']>[0]) {
    return this.credentials.promotePackToCreator(body);
  }
  @Post('credential/ready')
  ready(@Body() body: { environment: string; packId: string; providerId: string }) {
    return this.credentials.isReady(body.environment, body.packId, body.providerId);
  }
  @Post('credential/reference')
  async reference(@Body() body: { environment: string; packId: string; providerId: string }) {
    const row = await this.credentials.resolveForTest(body.environment, body.packId, body.providerId);
    return { configFingerprint: row.configFingerprint };
  }
  @Post('credential/list')
  listCredentials(@Body() body: { packId?: string }) { return this.credentials.list(body.packId); }
  @Post('credential/remove')
  removeCredential(@Body() body: { environment: string; packId: string; providerId: string }) {
    return this.credentials.remove(body.environment, body.packId, body.providerId);
  }
  @Post('credential/record-test')
  recordTest(@Body() body: { args: Parameters<MiniappProviderCredentialService['recordTest']> }) {
    return this.credentials.recordTest(...body.args);
  }
  @Post('credential/record-environment-test')
  recordEnvironmentTest(@Body() body: { args: Parameters<MiniappProviderCredentialService['recordEnvironmentTest']> }) {
    return this.credentials.recordEnvironmentTest(...body.args);
  }

  private async testConfig(providerId: string, config: Record<string, unknown>) {
    const ref = config?.__brokerCredentialRef;
    if (!ref || typeof ref !== 'object' || Array.isArray(ref)) return config;
    const locator = ref as Record<string, unknown>;
    if (locator.providerId !== providerId) throw new Error('Credential reference provider mismatch');
    return (await this.credentials.resolveForTest(String(locator.environment),
      String(locator.packId), providerId)).config;
  }
}
