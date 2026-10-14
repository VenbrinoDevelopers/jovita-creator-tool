import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException, OnModuleInit, Optional } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { Model } from 'mongoose';
import { Cron } from '@nestjs/schedule';
import { SecretCryptoService } from '../security/secret-crypto.service.js';
import { ADMIN_CREDENTIALS, ARTIFACT_UPLOADS, MEDIA_PROCESSING,
  type UploadsService, type MediaProcessingService,
  type MiniappProviderCredentialService } from '../contracts/platform-ports.js';
import type { CapabilityCallInput, CapabilityCallResult } from '../contracts/capability.js';
import { BrokerConnection, type BrokerConnectionDocument, BrokerOperation, type BrokerOperationDocument,
  BrokerProviderProfile, type BrokerProviderProfileDocument, BrokerRouteGrant, type BrokerRouteGrantDocument,
  BrokerExecution, type BrokerExecutionDocument } from './broker-catalog.schema.js';
import { BrokerHttpTransport } from '../operations/broker-http-transport.js';
import { BrokerExecutionService } from '../operations/broker-execution.service.js';
import { BuiltinOperationCatalog, type BuiltinOperationDefinition } from './builtin-operation.catalog.js';
import { BrokerCatalogRules, SAFE_ID, SAFE_PATH } from './broker-catalog.rules.js';

const plain = (value: unknown): unknown => value === undefined ? undefined : JSON.parse(JSON.stringify(value));

@Injectable()
export class BrokerCatalogService implements OnModuleInit {
  private readonly rules = new BrokerCatalogRules();
  private readonly transport: BrokerHttpTransport;
  private readonly execution: BrokerExecutionService;
  constructor(
    @InjectModel(BrokerProviderProfile.name) private readonly profiles: Model<BrokerProviderProfileDocument>,
    @InjectModel(BrokerOperation.name) private readonly operations: Model<BrokerOperationDocument>,
    @InjectModel(BrokerConnection.name) private readonly connections: Model<BrokerConnectionDocument>,
    @InjectModel(BrokerRouteGrant.name) private readonly grants: Model<BrokerRouteGrantDocument>,
    @InjectModel(BrokerExecution.name) executions: Model<BrokerExecutionDocument>,
    private readonly crypto: SecretCryptoService,
    @Optional() @Inject(ADMIN_CREDENTIALS) adminCredentials?: MiniappProviderCredentialService,
    @Optional() builtinCatalog?: BuiltinOperationCatalog,
    @Optional() @Inject(ARTIFACT_UPLOADS) uploads?: UploadsService,
    @Optional() @Inject(MEDIA_PROCESSING) processing?: MediaProcessingService,
  ) {
    this.transport = new BrokerHttpTransport(crypto);
    this.execution = new BrokerExecutionService(executions, operations, profiles, crypto,
      this.transport, adminCredentials, builtinCatalog, uploads, processing);
  }

  async onModuleInit(): Promise<void> { await this.execution.onModuleInit(); }

  @Cron('0 3 * * *')
  async compactExecutionResults(): Promise<void> { await this.execution.compactExecutionResults(); }

  async list(creatorId: string) {
    const [profiles, operations, connections, grants] = await Promise.all([
      this.profiles.find({ creatorId }).lean(), this.operations.find({ creatorId }).lean(),
      this.connections.find({ creatorId }).lean(), this.grants.find({ creatorId }).lean(),
    ]);
    return { profiles, operations, connections, grants, minimumBuyerCredits: this.rules.minimumBuyerCredits() };
  }

  async pendingProfiles() {
    return this.profiles.find({ status: 'draft' })
      .select('profileId creatorId name summary docsUrl category baseUrl authMethod authHeader timeoutMs status createdAt')
      .sort({ createdAt: 1 }).lean();
  }

  /** Import public declarations from a creator bundle. Re-uploading identical versions is safe. */
  async importManifest(creatorId: string, packId: string, raw: unknown, capabilities: unknown) {
    if (!/^[a-f0-9]{24}$/.test(creatorId) || !SAFE_ID.test(packId)) throw new BadRequestException('Invalid creator or tool ID');
    const declaration = this.rules.objectWithKeys(raw, ['providers'], 'broker');
    if (this.rules.containsCredentialField(declaration)) {
      throw new BadRequestException('Credentials belong in saved connections, not broker declarations');
    }
    if (!Array.isArray(declaration.providers) || !declaration.providers.length || declaration.providers.length > 10) {
      throw new BadRequestException('broker.providers must contain 1 to 10 providers');
    }
    if (!Array.isArray(capabilities) || !capabilities.every(value => typeof value === 'string')) {
      throw new BadRequestException('Manifest capabilities are invalid');
    }
    const referenced = new Set(capabilities as string[]);
    const declared = new Set<string>();
    const staged: Array<{ profileId: string; profile: Partial<BrokerProviderProfile>;
      operations: Array<Partial<BrokerOperation>> }> = [];
    for (const [index, entry] of declaration.providers.entries()) {
      const provider = this.rules.objectWithKeys(entry, ['id', 'name', 'summary', 'docsUrl', 'category',
        'baseUrl', 'authMethod', 'authHeader', 'timeoutMs', 'operations'], `broker.providers[${index}]`);
      const shortId = this.rules.id(provider.id, 'provider id');
      if (shortId.length > 32) throw new BadRequestException('Provider ID is too long');
      const profileId = `c${creatorId}-${shortId}`;
      if (staged.some(item => item.profileId === profileId)) throw new BadRequestException('Duplicate provider declaration');
      if (!Array.isArray(provider.operations) || !provider.operations.length || provider.operations.length > 50) {
        throw new BadRequestException('Each manifest provider needs 1 to 50 operations');
      }
      const operations: Array<Partial<BrokerOperation>> = [];
      for (const [operationIndex, item] of provider.operations.entries()) {
        const definition = this.rules.objectWithKeys(item, ['id', 'version', 'name', 'purpose', 'method', 'path',
          'executionKind', 'mediaPreset', 'requestMapping', 'responseField',
          'queryFields', 'inputSchema', 'outputSchema', 'buyerCredits', 'maxRequestBytes', 'maxResponseBytes',
          'providerCostNote', 'emptyResultIsNoResult', 'poll', 'artifact'], `broker.providers[${index}].operations[${operationIndex}]`);
        const operationId = this.rules.id(definition.id, 'operation id');
        const version = Number(definition.version);
        const aliasId = `broker.${packId}.${shortId}.${operationId}.v${version}`;
        if (!referenced.has(aliasId)) {
          throw new BadRequestException(`Declare ${aliasId} in runtime.execute.operations[].capabilities`);
        }
        if (declared.has(aliasId)) throw new BadRequestException('Duplicate broker operation declaration');
        declared.add(aliasId);
        operations.push({ profileId, operationId, version, name: definition.name as string,
          purpose: definition.purpose as string, method: definition.method as string, path: definition.path as string,
          executionKind: definition.executionKind as BrokerOperation['executionKind'] | undefined,
          poll: definition.poll as BrokerOperation['poll'] | undefined,
          artifact: definition.artifact as BrokerOperation['artifact'] | undefined,
          mediaPreset: definition.mediaPreset as BrokerOperation['mediaPreset'] | undefined,
          requestMapping: definition.requestMapping as BrokerOperation['requestMapping'] | undefined,
          responseField: definition.responseField as string | undefined,
          queryFields: definition.queryFields as string[] | undefined,
          inputSchema: definition.inputSchema as Record<string, unknown>,
          outputSchema: definition.outputSchema as Record<string, unknown>,
          buyerCredits: definition.buyerCredits as number,
          emptyResultIsNoResult: definition.emptyResultIsNoResult as boolean | undefined,
          maxRequestBytes: definition.maxRequestBytes as number | undefined,
          maxResponseBytes: definition.maxResponseBytes as number | undefined,
          providerCostNote: definition.providerCostNote as string });
      }
      staged.push({ profileId, profile: { profileId: shortId, name: provider.name as string,
        summary: provider.summary as string, docsUrl: provider.docsUrl as string,
        category: provider.category as string, baseUrl: provider.baseUrl as string,
        authMethod: provider.authMethod as BrokerProviderProfile['authMethod'],
        authHeader: provider.authHeader as string | undefined,
        timeoutMs: provider.timeoutMs as number | undefined }, operations });
    }
    for (const item of staged) {
      let profile = await this.profiles.findOne({ profileId: item.profileId });
      if (profile && (profile.creatorId !== creatorId
        || profile.baseUrl !== this.rules.baseUrl(item.profile.baseUrl, true)
        || profile.authMethod !== item.profile.authMethod
        || (profile.authHeader ?? '') !== (item.profile.authHeader ?? ''))) {
        throw new ConflictException('Manifest provider differs from its saved profile');
      }
      if (!profile) profile = await this.draftProfile(creatorId, item.profile);
      if (profile.status === 'rejected') throw new ConflictException('Manifest provider host was rejected');
      for (const operation of item.operations) {
        const capabilityId = `creator.${item.profileId}.${operation.operationId}.v${operation.version}`;
        const aliasId = `broker.${packId}.${item.profile.profileId}.${operation.operationId}.v${operation.version}`;
        const aliasOwner = await this.operations.findOne({ manifestAliases: aliasId }).lean();
        if (aliasOwner && aliasOwner.capabilityId !== capabilityId) {
          throw new ConflictException(`Manifest reference ${aliasId} is already bound to another operation`);
        }
        const existing = await this.operations.findOne({ capabilityId }).lean();
        if (existing) {
          const comparable = ['creatorId', 'profileId', 'operationId', 'version', 'name', 'purpose', 'method',
            'path', 'executionKind', 'poll', 'artifact', 'mediaPreset', 'requestMapping', 'responseField',
            'inputSchema', 'outputSchema', 'queryFields', 'buyerCredits', 'maxRequestBytes',
            'maxResponseBytes', 'providerCostNote', 'emptyResultIsNoResult'] as const;
          const expected = { ...operation, creatorId, executionKind: operation.executionKind ?? 'http-json',
            poll: operation.executionKind === 'http-poll'
              ? this.rules.pollDefinition(operation.poll, String(operation.method)) : undefined,
            artifact: operation.artifact === undefined ? undefined
              : this.rules.artifactDefinition(operation.artifact, operation.executionKind ?? 'http-json'),
            queryFields: operation.queryFields ?? [],
            maxRequestBytes: operation.maxRequestBytes ?? (operation.mediaPreset ? 8_000_000 : 32_768),
            maxResponseBytes: operation.maxResponseBytes ?? 1_048_576,
            emptyResultIsNoResult: operation.emptyResultIsNoResult ?? false };
          if (!comparable.every(field => isDeepStrictEqual(
            plain(field === 'emptyResultIsNoResult' ? existing[field] ?? false : existing[field]),
            plain(expected[field])))) {
            throw new ConflictException(`Manifest operation ${capabilityId} differs from its saved version`);
          }
        } else await this.createOperation(creatorId, operation, true);
        await this.operations.updateOne({ capabilityId }, { $addToSet: { manifestAliases: aliasId } });
      }
    }
    return { imported: declared.size, capabilityIds: [...declared].sort() };
  }

  async draftProfile(creatorId: string, body: Partial<BrokerProviderProfile>) {
    const requestedId = this.rules.id(body.profileId, 'profileId');
    if (requestedId.length > 32 || !/^[a-f0-9]{24}$/.test(creatorId)) throw new BadRequestException('Invalid provider owner or ID');
    const profileId = `c${creatorId}-${requestedId}`;
    const baseUrl = this.rules.baseUrl(body.baseUrl, true);
    const docsUrl = this.rules.baseUrl(body.docsUrl);
    const authMethod = body.authMethod === 'bearer' || body.authMethod === 'header' ? body.authMethod : undefined;
    if (!authMethod) throw new BadRequestException('Select bearer or header authentication');
    const authHeader = authMethod === 'header' ? this.rules.text(body.authHeader, 80) : undefined;
    if (authHeader && (!/^[A-Za-z][A-Za-z0-9-]{0,79}$/.test(authHeader)
      || /^(host|content-length|content-type|transfer-encoding|connection|accept|cookie|set-cookie|proxy-authorization)$/i.test(authHeader))) {
      throw new BadRequestException('Invalid authentication header');
    }
    const timeoutMs = Number(body.timeoutMs ?? 30_000);
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 120_000) throw new BadRequestException('Invalid provider timeout');
    return this.profiles.create({ profileId, creatorId, name: this.rules.text(body.name, 100),
      summary: this.rules.text(body.summary, 500), docsUrl, category: this.rules.text(body.category, 80),
      baseUrl, authMethod, authHeader, timeoutMs, status: 'draft' });
  }

  async approveProfile(profileId: string, adminId: string) {
    const profile = await this.requireProfile(profileId);
    const host = new URL(profile.baseUrl).hostname;
    await this.transport.assertPublicHost(host);
    profile.status = 'approved'; profile.approvedBy = adminId; profile.approvedAt = new Date();
    return profile.save();
  }

  async createOperation(creatorId: string, body: Partial<BrokerOperation>, allowDraft = false) {
    const profile = await this.ownedProfile(creatorId, String(body.profileId ?? ''));
    if (profile.status !== 'approved' && (!allowDraft || profile.status !== 'draft')) {
      throw new ConflictException('Provider host approval is required');
    }
    const operationId = this.rules.id(body.operationId, 'operationId');
    const version = Number(body.version);
    if (!Number.isSafeInteger(version) || version < 1 || version > 1000) throw new BadRequestException('Invalid operation version');
    const method = String(body.method ?? '').toUpperCase();
    if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) throw new BadRequestException('Invalid HTTP method');
    const path = String(body.path ?? '');
    if (path !== '/' && (!SAFE_PATH.test(path) || path.includes('..') || path.includes('//'))) {
      throw new BadRequestException('Operation route must be a fixed path with optional named segments');
    }
    const executionKind = body.executionKind ?? 'http-json';
    if (!['http-json', 'http-multipart', 'http-binary', 'http-sse', 'http-poll'].includes(executionKind)) {
      throw new BadRequestException('Invalid operation executionKind');
    }
    if (['http-multipart', 'http-binary'].includes(executionKind) && method === 'GET') {
      throw new BadRequestException('This execution kind requires a request body');
    }
    const mediaPreset = body.mediaPreset;
    if (mediaPreset !== undefined && (mediaPreset !== 'transparent-png-v1'
      || executionKind !== 'http-multipart' || method !== 'POST')) {
      throw new BadRequestException('Media preset requires a multipart POST');
    }
    const poll = executionKind === 'http-poll' ? this.rules.pollDefinition(body.poll, method) : undefined;
    const artifact = body.artifact === undefined ? undefined : this.rules.artifactDefinition(body.artifact, executionKind);
    if (executionKind !== 'http-poll' && body.poll !== undefined) throw new BadRequestException('Poll settings require http-poll');
    const inputSchema = this.rules.schema(body.inputSchema, true);
    const outputSchema = this.rules.schema(body.outputSchema, false);
    const requestMapping = body.requestMapping === undefined ? undefined
      : this.rules.requestMapping(body.requestMapping, inputSchema, method, executionKind);
    const responseField = body.responseField === undefined ? undefined : this.rules.fieldPath(body.responseField);
    const pathFields = [...path.matchAll(/\{([a-z][a-z0-9_]{0,63})\}/g)].map(match => match[1]!);
    const queryFields = Array.isArray(body.queryFields) ? body.queryFields : [];
    if (!queryFields.every(field => typeof field === 'string' && /^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(field))
      || new Set(queryFields).size !== queryFields.length || queryFields.some(field => pathFields.includes(field))) {
      throw new BadRequestException('Invalid query field mapping');
    }
    const properties = inputSchema.properties as Record<string, unknown> | undefined;
    const required = Array.isArray(inputSchema.required) ? inputSchema.required : [];
    if ([...pathFields, ...queryFields].some(field => !properties || !(field in properties))
      || pathFields.some(field => !required.includes(field))) {
      throw new BadRequestException('Path and query fields must be declared in the input schema; path fields are required');
    }
    if ([...pathFields, ...queryFields].some(field => {
      const fieldSchema = properties?.[field];
      return !fieldSchema || typeof fieldSchema !== 'object' || Array.isArray(fieldSchema)
        || !['string', 'integer', 'number', 'boolean'].includes(String((fieldSchema as Record<string, unknown>).type));
    })) throw new BadRequestException('Path and query fields must have scalar schema types');
    const buyerCredits = Number(body.buyerCredits);
    if (body.emptyResultIsNoResult !== undefined && typeof body.emptyResultIsNoResult !== 'boolean') {
      throw new BadRequestException('Invalid empty-result rule');
    }
    const minimumBuyerCredits = this.rules.minimumBuyerCredits();
    if (!Number.isSafeInteger(buyerCredits) || buyerCredits < minimumBuyerCredits || buyerCredits > 100_000) {
      throw new BadRequestException(`Buyer price must be at least ${minimumBuyerCredits} credits so creator earnings are representable`);
    }
    const maxRequestBytes = this.rules.limit(body.maxRequestBytes, 1,
      mediaPreset ? 8_000_000 : 524_288, mediaPreset ? 8_000_000 : 32_768);
    const maxResponseBytes = this.rules.limit(body.maxResponseBytes, 1, 10_485_760, 1_048_576);
    const capabilityId = `creator.${profile.profileId}.${operationId}.v${version}`;
    return this.operations.create({ capabilityId, profileId: profile.profileId, creatorId, operationId,
      version, name: this.rules.text(body.name, 100), purpose: this.rules.text(body.purpose, 500), method, path,
      executionKind, poll, artifact, mediaPreset, requestMapping, responseField,
      inputSchema, outputSchema, queryFields, buyerCredits, maxRequestBytes, maxResponseBytes,
      emptyResultIsNoResult: body.emptyResultIsNoResult ?? false,
      providerCostNote: this.rules.text(body.providerCostNote, 500) });
  }

  async saveConnection(creatorId: string, body: { connectionId?: string; profileId: string; name: string; apiKey: string }) {
    const profile = await this.ownedProfile(creatorId, body.profileId);
    if (profile.status !== 'approved') throw new ConflictException('Provider host approval is required');
    const apiKey = String(body.apiKey ?? '');
    if (!apiKey || Buffer.byteLength(apiKey) > 8192 || /[\r\n]/.test(apiKey)) throw new BadRequestException('Invalid API key');
    const connectionId = body.connectionId ? this.rules.id(body.connectionId, 'connectionId') : `connection_${randomUUID()}`;
    const existing = await this.connections.findOne({ connectionId });
    if (existing && (existing.creatorId !== creatorId || existing.profileId !== profile.profileId)) throw new ForbiddenException();
    return this.connections.findOneAndUpdate({ connectionId }, { $set: {
      creatorId, profileId: profile.profileId, name: this.rules.text(body.name, 100),
      encryptedApiKey: this.crypto.encrypt(apiKey), keyFingerprint: createHash('sha256').update(apiKey).digest('hex').slice(0, 16),
      testStatus: 'untested',
    }, $unset: { testedAt: 1 } }, { upsert: true, new: true, setDefaultsOnInsert: true })
      .select('connectionId creatorId profileId name keyFingerprint testStatus testedAt').lean();
  }

  async testConnection(creatorId: string, connectionId: string, capabilityId?: string,
    sampleInput: Record<string, unknown> = {}, confirmProviderCharge = false) {
    const connection = await this.ownedConnection(creatorId, connectionId);
    const profile = await this.requireProfile(connection.profileId);
    await this.transport.assertPublicHost(new URL(profile.baseUrl).hostname);
    const operation = await this.operations.findOne({ profileId: profile.profileId,
      ...(capabilityId ? { capabilityId } : { method: 'GET' }) }).lean();
    if (!operation) throw new ConflictException('Create an operation before testing this connection');
    if (operation.method !== 'GET' && !confirmProviderCharge) {
      throw new ConflictException('Confirm a real provider call before testing a mutating operation');
    }
    this.rules.validate(operation.inputSchema, sampleInput, 'input');
    try {
      const result = await this.execution.invokePlan({ environment: 'connection-test', ownerId: creatorId,
        packId: `connection-test-${creatorId}`, capability: operation.capabilityId, payload: sampleInput,
        invocationId: `connection-test-${randomUUID()}`, callId: randomUUID() },
      profile, connection, operation);
      this.rules.validate(operation.outputSchema, result.result, 'output');
      connection.testStatus = 'ok'; connection.testedAt = new Date(); await connection.save();
    } catch (error) {
      connection.testStatus = 'failed'; connection.testedAt = new Date(); await connection.save();
      throw error;
    }
    return { connectionId, testStatus: 'ok', testedAt: connection.testedAt };
  }

  async grant(creatorId: string, body: { packId: string; connectionId: string; capabilityId: string }) {
    const connection = await this.ownedConnection(creatorId, body.connectionId);
    if (connection.testStatus !== 'ok') throw new ConflictException('Test the connection before granting it');
    const operation = await this.operations.findOne({ capabilityId: body.capabilityId, creatorId }).lean();
    if (!operation || operation.profileId !== connection.profileId) throw new ForbiddenException('Operation does not belong to this connection');
    const packId = this.rules.id(body.packId, 'packId');
    const grantId = `${creatorId}:${packId}:${operation.capabilityId}`;
    return this.grants.findOneAndUpdate({ grantId }, { $set: {
      creatorId, packId, connectionId: connection.connectionId, capabilityId: operation.capabilityId, status: 'active',
    } }, { upsert: true, new: true });
  }

  async revoke(creatorId: string, packId: string, capabilityId: string) {
    const grant = await this.grants.findOneAndUpdate({ creatorId, packId, capabilityId, status: 'active' },
      { $set: { status: 'revoked' } }, { new: true });
    if (!grant) throw new NotFoundException('Route grant not found');
    return grant;
  }

  async definitions() {
    // Draft declarations are visible for release validation; invoke and activation still require approval.
    const operations = await this.operations.find({}).lean();
    return operations.flatMap(operation => [operation.capabilityId, ...(operation.manifestAliases ?? [])].map(capability => ({ capability, providerId: operation.profileId,
      credentialSource: 'none' as const, credentialScope: 'pack' as const, credentialFields: [],
      contractVersion: 1 as const, unit: 'request' as const,
      maxCallsPerInvocation: 128, buyerCredits: operation.buyerCredits })));
  }

  async price(capabilityId: string) {
    const operation = await this.operationFor(capabilityId);
    if (!operation) throw new NotFoundException('Creator operation not found');
    return { buyerCredits: operation.buyerCredits };
  }

  async activationRequirements(capabilityId: string, packId: string) {
    const operation = await this.operationFor(capabilityId, packId);
    if (!operation) return { ready: false, reason: 'Creator operation is missing from the catalog' };
    const profile = await this.profiles.findOne({ profileId: operation.profileId, status: 'approved' }).lean();
    if (!profile) return { ready: false, reason: 'Provider host is awaiting approval' };
    const grant = await this.grants.findOne({ packId, capabilityId: operation.capabilityId, creatorId: operation.creatorId,
      status: 'active' }).lean();
    if (!grant) return { ready: false, reason: 'Grant this operation to the tool before activating its price' };
    const connection = await this.connections.findOne({ connectionId: grant.connectionId,
      creatorId: operation.creatorId, testStatus: 'ok' }).lean();
    if (!connection) return { ready: false, reason: 'Test the granted provider connection' };
    return { ready: true, credentialProviderIds: [] };
  }

  async invoke(input: CapabilityCallInput): Promise<CapabilityCallResult> {
    const operation = await this.operationFor(input.capability, input.packId);
    if (!operation) throw new NotFoundException('Creator operation not found');
    const profile = await this.requireProfile(operation.profileId);
    if (profile.status !== 'approved') throw new ForbiddenException('Provider host is not approved');
    const grant = await this.grants.findOne({ packId: input.packId, capabilityId: operation.capabilityId, status: 'active' }).lean();
    if (!grant || grant.creatorId !== operation.creatorId) throw new ForbiddenException('Tool has no grant for this route');
    const connection = await this.connections.findOne({ connectionId: grant.connectionId, creatorId: grant.creatorId, testStatus: 'ok' })
      .select('+encryptedApiKey').lean();
    if (!connection || connection.profileId !== profile.profileId) throw new ConflictException('Connection is unavailable');
    const pricing = input.pricingSnapshot ?? {};
    const declaredCallPrice = pricing.brokerCalls === true
      ? Number((pricing.brokerCallPrices as Record<string, unknown> | undefined)?.[input.capability])
      : Number(pricing.fixedCredits);
    if (process.env.BROKER_REQUIRE_PRICE_SNAPSHOT === '1'
      && (pricing.mode !== 'fixed_success' || declaredCallPrice !== operation.buyerCredits
        || Number(pricing.maxCredits) < operation.buyerCredits)) {
      throw new ConflictException('Published price does not match the approved operation');
    }
    return this.execution.invokePlan(input, profile, connection, operation);
  }

  async invokeBuiltin(input: CapabilityCallInput, definition: BuiltinOperationDefinition): Promise<CapabilityCallResult> {
    return this.execution.invokeBuiltin(input, definition);
  }

  reconcile(input: Parameters<BrokerExecutionService['reconcile']>[0]) {
    return this.execution.reconcile(input);
  }

  private async operationFor(capabilityId: string, packId?: string) {
    if (capabilityId.startsWith('broker.')) {
      if (packId && !capabilityId.startsWith(`broker.${packId}.`)) {
        throw new ForbiddenException('Broker reference belongs to another tool');
      }
      return this.operations.findOne({ manifestAliases: capabilityId }).lean();
    }
    return this.operations.findOne({ capabilityId }).lean();
  }

  private async requireProfile(profileId: string) {
    const row = await this.profiles.findOne({ profileId });
    if (!row) throw new NotFoundException('Provider profile not found');
    return row;
  }
  private async ownedProfile(creatorId: string, profileId: string) {
    const row = await this.requireProfile(profileId);
    if (row.creatorId !== creatorId) throw new ForbiddenException();
    return row;
  }
  private async ownedConnection(creatorId: string, connectionId: string) {
    const row = await this.connections.findOne({ connectionId }).select('+encryptedApiKey');
    if (!row || row.creatorId !== creatorId) throw new NotFoundException('Connection not found');
    return row;
  }

}
