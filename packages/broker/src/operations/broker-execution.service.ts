import { BadGatewayException, BadRequestException, ConflictException, ForbiddenException, HttpException, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { Model } from 'mongoose';
import { Ajv } from 'ajv';
import { SecretCryptoService } from '../security/secret-crypto.service.js';
import type { UploadsService, MediaProcessingService, MiniappProviderCredentialService } from '../contracts/platform-ports.js';
import { ProviderOutcomeUnknownError, type CapabilityCallInput, type CapabilityCallResult } from '../contracts/capability.js';
import { BrokerConnection, type BrokerExecutionDocument, type BrokerOperationDocument,
  type BrokerProviderProfileDocument, type BrokerProviderProfile } from '../catalog/broker-catalog.schema.js';
import { BuiltinOperationCatalog, type BuiltinOperationDefinition } from '../catalog/builtin-operation.catalog.js';
import { BrokerHttpTransport } from './broker-http-transport.js';
import { BrokerArtifactService } from './broker-artifact.service.js';
import { builtinExternalPlan, type RuntimeOperationPlan } from './broker-operation-plan.js';

const ajv = new Ajv({ allErrors: true, strict: true, removeAdditional: false });
const RESULT_RETENTION_MS = 48 * 60 * 60 * 1000;
type BrokerExecutionResult = CapabilityCallResult & { artifactExpiresAt?: Date };

/** Journals provider calls and resumes asynchronous work without resubmitting. */
export class BrokerExecutionService {
  private readonly artifacts?: BrokerArtifactService;
  constructor(
    private readonly executions: Model<BrokerExecutionDocument>,
    private readonly operations: Model<BrokerOperationDocument>,
    private readonly profiles: Model<BrokerProviderProfileDocument>,
    private readonly crypto: SecretCryptoService,
    private readonly transport: BrokerHttpTransport,
    private readonly adminCredentials?: MiniappProviderCredentialService,
    _builtinCatalog?: BuiltinOperationCatalog,
    uploads?: UploadsService,
    processing?: MediaProcessingService,
  ) {
    if (uploads && processing) this.artifacts = new BrokerArtifactService(transport, uploads, processing);
  }

  async onModuleInit(): Promise<void> {
    await this.compactExecutionResults();
  }

  async compactExecutionResults(): Promise<void> {
    // During a rolling deployment, an older broker may still write the old
    // whole-row TTL. Clear it before it can erase pending run IDs.
    await this.executions.updateMany({ expiresAt: { $exists: true } }, { $unset: { expiresAt: 1 } });
    await this.executions.updateMany({ status: 'succeeded', encryptedResult: { $exists: true },
      resultExpiresAt: { $exists: false } }, { $set: { resultExpiresAt: new Date(Date.now() + RESULT_RETENTION_MS) } });
    // Keep the call ID tombstone permanently; only the encrypted provider output
    // is pruned after the server's recovery window.
    await this.executions.updateMany({ status: 'succeeded', encryptedResult: { $exists: true },
      resultExpiresAt: { $lte: new Date() } },
      { $unset: { encryptedResult: 1 } });
  }

  async invokeBuiltin(input: CapabilityCallInput, definition: BuiltinOperationDefinition): Promise<CapabilityCallResult> {
    if (input.capability !== definition.capability) throw new BadRequestException('Built-in operation reference mismatch');
    if (!this.adminCredentials) throw new BadGatewayException('Provider credentials are unavailable');
    const { profile, operation, credentialScope } = builtinExternalPlan(definition);
    const config = credentialScope === 'environment'
      ? await this.adminCredentials.resolveEnvironment(input.environment, definition.providerId)
      : await this.adminCredentials.resolve(input.environment, input.packId, definition.providerId);
    const key = config.apiKey;
    if (typeof key !== 'string' || !key.trim()) throw new BadRequestException('Provider API key is missing');
    const connection = { encryptedApiKey: this.crypto.encrypt(key) } as BrokerConnection;
    return this.invokePlan(input, profile, connection, operation);
  }

  /** Polls recorded work only. This path has no upstream submit operation. */
  async reconcile(input: { invocationId: string; callId: string; capability: string;
    packId: string; environment: string }): Promise<{ status: 'pending' | 'succeeded' | 'succeeded_without_result' | 'failed';
      result?: CapabilityCallResult; errorCode?: string; providerCostMicros?: number;
      quantity?: number; providerRequestId?: string }> {
    const executionKey = `${input.invocationId}:${input.callId}`;
    const evidence = await this.executions.findOne({ executionKey, capabilityId: input.capability,
      packId: input.packId, environment: input.environment })
      .select('+encryptedResult +encryptedCredential').lean();
    if (!evidence) return { status: 'pending' };
    if (evidence.status === 'succeeded' && evidence.encryptedResult
      && (!evidence.resultExpiresAt || evidence.resultExpiresAt.getTime() > Date.now())) return { status: 'succeeded',
      result: { result: JSON.parse(this.crypto.decrypt(evidence.encryptedResult)),
        providerCostMicros: evidence.providerCostMicros ?? 0, quantity: evidence.quantity ?? 1,
        providerRequestId: evidence.providerRequestId,
        ...(evidence.resultExpiresAt ? { resultExpiresAt: evidence.resultExpiresAt.toISOString() } : {}) } };
    if (evidence.status === 'succeeded') return { status: 'succeeded_without_result',
      providerCostMicros: evidence.providerCostMicros ?? 0, quantity: evidence.quantity ?? 1,
      providerRequestId: evidence.providerRequestId };
    if (evidence.status === 'failed') return { status: 'failed', errorCode: evidence.errorCode ?? 'PROVIDER_REJECTED' };
    if (!evidence.upstreamRunId || !evidence.encryptedCredential) return { status: 'pending' };
    let profile: BrokerProviderProfile;
    let operation: RuntimeOperationPlan;
    const creator = await this.operationFor(input.capability, input.packId);
    if (!creator || !this.isAsync(creator)) return { status: 'pending' };
    profile = await this.requireProfile(creator.profileId);
    if (profile.status !== 'approved') return { status: 'pending' };
    operation = creator;
    const connection = { encryptedApiKey: evidence.encryptedCredential } as BrokerConnection;
    try {
      const result = await this.finishExecution(executionKey, evidence.requestHash, operation,
        await this.pollOperation(profile, connection, operation, evidence.upstreamRunId, undefined, true,
          { ownerId: evidence.ownerId, executionKey }));
      return { status: 'succeeded', result };
    } catch (error) {
      if (error instanceof ProviderOutcomeUnknownError) return { status: 'pending' };
      if (error instanceof HttpException) {
        await this.recordFailure(executionKey, error);
        const details = error.getResponse();
        return { status: 'failed', errorCode: details && typeof details === 'object'
          ? String((details as { code?: string }).code ?? 'PROVIDER_REJECTED') : 'PROVIDER_REJECTED' };
      }
      return { status: 'pending' };
    }
  }

  async invokePlan(input: CapabilityCallInput, profile: BrokerProviderProfile,
    connection: BrokerConnection, operation: RuntimeOperationPlan): Promise<CapabilityCallResult> {
    const payload = input.payload ?? {};
    if (Buffer.byteLength(JSON.stringify(payload)) > operation.maxRequestBytes) throw new BadRequestException('Operation input is too large');
    this.validate(operation.inputSchema, payload, 'input');
    if (!input.invocationId || !input.callId) throw new BadRequestException('Invocation evidence is required');
    const executionKey = `${input.invocationId}:${input.callId}`;
    const requestHash = createHash('sha256').update(JSON.stringify({ packId: input.packId,
      capability: input.capability, payload })).digest('hex');
    try {
      await this.executions.create({ executionKey, requestHash, capabilityId: input.capability,
        packId: input.packId, environment: input.environment, ownerId: input.ownerId, status: 'started' });
    } catch (error) {
      if (!(error && typeof error === 'object' && 'code' in error && error.code === 11000)) throw error;
      const existing = await this.executions.findOne({ executionKey }).select('+encryptedResult +encryptedCredential').lean();
      if (!existing || existing.requestHash !== requestHash
        || (existing.capabilityId && existing.capabilityId !== input.capability)
        || (existing.packId && existing.packId !== input.packId)
        || (existing.environment && existing.environment !== input.environment)
        || (existing.ownerId && existing.ownerId !== input.ownerId)) {
        throw new ConflictException('Call ID was reused with different input');
      }
      if (existing.status === 'succeeded' && existing.encryptedResult
        && (!existing.resultExpiresAt || existing.resultExpiresAt.getTime() > Date.now())) {
        return { result: JSON.parse(this.crypto.decrypt(existing.encryptedResult)),
          providerCostMicros: existing.providerCostMicros ?? 0, quantity: existing.quantity ?? 1,
          providerRequestId: existing.providerRequestId,
          ...(existing.resultExpiresAt ? { resultExpiresAt: existing.resultExpiresAt.toISOString() } : {}) };
      }
      if (existing.status === 'succeeded') {
        throw new ProviderOutcomeUnknownError('Prior provider result has expired; this call cannot be resubmitted');
      }
      if (existing.status === 'failed') throw new BadGatewayException({ code: existing.errorCode ?? 'PROVIDER_REJECTED', message: 'Provider call previously failed' });
      if (!existing.upstreamRunId || !this.isAsync(operation)) {
        throw new ProviderOutcomeUnknownError('Provider outcome is pending; this call cannot be resubmitted');
      }
      try {
        return await this.finishExecution(executionKey, requestHash, operation,
          await this.pollOperation(profile, existing.encryptedCredential
            ? { ...connection, encryptedApiKey: existing.encryptedCredential } : connection,
          operation, existing.upstreamRunId, undefined, false, { ownerId: input.ownerId, executionKey }));
      } catch (error) {
        if (error instanceof HttpException) await this.recordFailure(executionKey, error);
        throw error;
      }
    }
    try {
      const result = await this.executeOperation(profile, connection, operation, payload, executionKey, input.ownerId);
      return await this.finishExecution(executionKey, requestHash, operation, result);
    } catch (error) {
      if (error instanceof ProviderOutcomeUnknownError) throw error;
      if (error instanceof HttpException) {
        await this.recordFailure(executionKey, error);
        throw error;
      }
      throw new ProviderOutcomeUnknownError('Provider dispatch outcome is unknown; automatic retry is disabled');
    }
  }

  private async recordFailure(executionKey: string, error: HttpException): Promise<void> {
    const response = error.getResponse();
    const details = response && typeof response === 'object' ? response as { code?: string } : {};
    await this.executions.updateOne({ executionKey, status: 'started' },
      { $set: { status: 'failed', errorCode: String(details.code ?? 'PROVIDER_REJECTED') },
        $unset: { encryptedCredential: 1, artifactLeaseToken: 1, artifactLeaseUntil: 1 } });
  }

  private async finishExecution(executionKey: string, requestHash: string, operation: RuntimeOperationPlan,
    result: BrokerExecutionResult): Promise<CapabilityCallResult> {
    this.validate(operation.outputSchema, result.result, 'output');
    if (Buffer.byteLength(JSON.stringify(result.result)) > operation.maxResponseBytes) {
      throw new BadGatewayException('Provider result exceeded its limit');
    }
    if (operation.emptyResultIsNoResult && (Array.isArray(result.result)
      ? result.result.length === 0
      : result.result && typeof result.result === 'object' && Object.keys(result.result).length === 0)) {
      result.quantity = 0;
    }
    const resultExpiresAt = new Date(Math.min(Date.now() + RESULT_RETENTION_MS,
      result.artifactExpiresAt?.getTime() ?? Number.POSITIVE_INFINITY));
    const journal = await this.executions.updateOne({ executionKey, requestHash, status: 'started' },
      { $set: { status: 'succeeded', encryptedResult: this.crypto.encrypt(JSON.stringify(result.result)),
        resultExpiresAt,
        providerCostMicros: result.providerCostMicros, quantity: result.quantity,
        providerRequestId: result.providerRequestId },
      $unset: { encryptedCredential: 1, artifactLeaseToken: 1, artifactLeaseUntil: 1 } });
    if (journal.modifiedCount !== 1) {
      const saved = await this.executions.findOne({ executionKey, requestHash, status: 'succeeded' })
        .select('+encryptedResult').lean();
      if (saved?.encryptedResult) return { result: JSON.parse(this.crypto.decrypt(saved.encryptedResult)),
        providerCostMicros: saved.providerCostMicros ?? 0, quantity: saved.quantity ?? 1,
        providerRequestId: saved.providerRequestId,
        ...(saved.resultExpiresAt ? { resultExpiresAt: saved.resultExpiresAt.toISOString() } : {}) };
      throw new ProviderOutcomeUnknownError('Provider succeeded but execution evidence could not be recorded');
    }
    const { artifactExpiresAt: _retention, ...publicResult } = result;
    return { ...publicResult, ...(result.artifactExpiresAt
      ? { resultExpiresAt: resultExpiresAt.toISOString() } : {}) };
  }

  private isAsync(operation: RuntimeOperationPlan): boolean {
    return operation.executionKind === 'http-poll';
  }

  async executeOperation(profile: BrokerProviderProfile, connection: BrokerConnection,
    operation: RuntimeOperationPlan, payload: Record<string, unknown>, executionKey?: string,
    ownerId?: string): Promise<BrokerExecutionResult> {
    if (this.isAsync(operation)) {
      const submitted = await this.transport.providerRequest(profile, connection, operation, payload);
      const poll = operation.poll!;
      const jobId = this.transport.readField(submitted, poll.jobIdField);
      if (typeof jobId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(jobId)) {
        const status = Number((submitted as Record<string, unknown>).__httpStatus);
        if (status >= 400 && status < 500) {
          throw this.providerStatusError(status);
        }
        throw new ProviderOutcomeUnknownError('Provider accepted a job without a safe job ID');
      }
      if (executionKey) {
        const saved = await this.executions.updateOne({ executionKey, status: 'started', upstreamRunId: { $exists: false } },
          { $set: { upstreamRunId: jobId, encryptedCredential: connection.encryptedApiKey } });
        if (saved.modifiedCount !== 1) throw new ProviderOutcomeUnknownError('Provider run ID could not be recorded');
      }
      return this.pollOperation(profile, connection, operation, jobId, submitted, false,
        { ownerId, executionKey });
    }
    const response = await this.transport.providerRequest(profile, connection, operation, payload);
    const media = operation.mediaPreset ? response as { __brokerResult: unknown; __brokerRequestId?: string } : undefined;
    const output = media ? media.__brokerResult : response;
    const result = operation.responseField ? this.transport.readField(output, operation.responseField) : output;
    if (result === undefined) throw new BadGatewayException('Provider response lacks the declared result field');
    return { result,
      providerCostMicros: operation.evidenceCostMicros ?? 0, quantity: 1,
      providerRequestId: media?.__brokerRequestId };
  }

  private async pollOperation(profile: BrokerProviderProfile, connection: BrokerConnection,
    operation: RuntimeOperationPlan, jobId: string, submitted?: unknown,
    singleAttempt = false, context?: { ownerId?: string; executionKey?: string }): Promise<BrokerExecutionResult> {
    const poll = operation.poll!;
    const deadline = Date.now() + 150_000;
    const inspect = async (state: unknown): Promise<BrokerExecutionResult | undefined> => {
      const status = String(this.transport.readField(state, poll.statusField) ?? '').toUpperCase();
      if (status === poll.failureValue.toUpperCase()
        || poll.failureValues?.some(value => value.toUpperCase() === status)) {
        throw new BadGatewayException({ code: 'PROVIDER_JOB_FAILED', message: 'Provider job failed' });
      }
      // Only the declared terminal success may create billable evidence. New
      // provider statuses stay pending until we know what they mean.
      if (status !== poll.successValue.toUpperCase()) return;
      const row = state && typeof state === 'object' && !Array.isArray(state) ? state as Record<string, unknown> : {};
      const providerStatus = Number(poll.providerStatusField
        ? this.transport.readField(row, poll.providerStatusField) ?? 200
        : (row.providerResponse as Record<string, unknown> | undefined)?.httpStatus
          ?? row.__httpStatus ?? 200);
      const noResult = poll.noResultStatuses?.includes(providerStatus) ?? false;
      if (!Number.isSafeInteger(providerStatus) || providerStatus < 100 || providerStatus > 599) {
        throw new BadGatewayException('Provider returned an invalid result status');
      }
      if (providerStatus >= 400 && !noResult && poll.providerStatusField) {
        throw this.providerStatusError(providerStatus);
      }
      const artifact = operation.artifact
        ? await this.artifactResult(profile, connection, operation, jobId, context) : undefined;
      const result = artifact ? artifact.result
        : noResult
          ? { ...row, noResult: true } : poll.resultField ? this.transport.readField(state, poll.resultField)
            : operation.responseField ? this.transport.readField(state, operation.responseField) : state;
      if (result === undefined) throw new ProviderOutcomeUnknownError('Provider completed without the declared result');
      const reported = (row.billing as Record<string, unknown> | undefined)?.reportedCost as Record<string, unknown> | undefined;
      const costValue = Number(reported?.value ?? 0);
      const cost = Number.isFinite(costValue) && costValue >= 0
        ? reported?.unit === 'MICRO_DOLLAR' ? Math.ceil(costValue) : Math.ceil(costValue * 1_000_000) : 0;
      const count = Number(row.resultCount);
      const quantity = noResult ? 0
        : operation.capabilityId.startsWith('creator.') ? 1
          : Number.isSafeInteger(count) && count >= 0 ? count : 1;
      return { result, providerCostMicros: cost, quantity,
        providerRequestId: jobId, ...(artifact ? { artifactExpiresAt: artifact.expiresAt } : {}) };
    };
    if (submitted !== undefined) {
      const terminal = await inspect(submitted);
      if (terminal) return terminal;
    }
    const pollOperation = { ...operation, executionKind: 'http-json' as const,
      method: 'GET', path: poll.path, queryFields: [] };
    for (let attempt = 0; attempt < (singleAttempt ? 1 : poll.maxAttempts); attempt += 1) {
      if (deadline - Date.now() < poll.intervalMs + 1_000) break;
      if (attempt > 0) await delay(poll.intervalMs);
      let state: unknown;
      try { state = await this.transport.providerRequest(profile, connection, pollOperation, { job_id: jobId },
        singleAttempt ? 20_000 : Math.max(1, deadline - Date.now()),
        undefined); }
      catch { throw new ProviderOutcomeUnknownError('Provider job state could not be confirmed'); }
      const terminal = await inspect(state);
      if (terminal) return terminal;
    }
    throw new ProviderOutcomeUnknownError('Provider job is still pending; reservation needs reconciliation');
  }

  private async artifactResult(profile: BrokerProviderProfile, connection: BrokerConnection,
    operation: RuntimeOperationPlan, jobId: string, context?: { ownerId?: string; executionKey?: string }) {
    if (!this.artifacts || !context?.ownerId || !context.executionKey) {
      throw new BadGatewayException('Broker media storage is unavailable');
    }
    const leaseToken = randomUUID();
    const now = new Date();
    const leased = await this.executions.findOneAndUpdate({ executionKey: context.executionKey,
      status: 'started', upstreamRunId: jobId,
      $or: [{ artifactLeaseUntil: { $exists: false } }, { artifactLeaseUntil: { $lte: now } }] },
    { $set: { artifactLeaseToken: leaseToken,
      artifactLeaseUntil: new Date(now.getTime() + 11 * 60_000) } }, { new: true }).lean();
    if (!leased) throw new ProviderOutcomeUnknownError('Provider media is already being recovered');
    try {
      return await this.artifacts.fetchAndStore(profile, connection, operation, jobId,
        context.ownerId, context.executionKey);
    } catch (error) {
      await this.executions.updateOne({ executionKey: context.executionKey, status: 'started',
        artifactLeaseToken: leaseToken }, { $unset: { artifactLeaseToken: 1, artifactLeaseUntil: 1 } });
      if (error instanceof BadRequestException) throw new BadGatewayException('Provider media did not meet its declared limits');
      if (error instanceof BadGatewayException) {
        const detail = error.getResponse();
        if (detail && typeof detail === 'object'
          && (detail as { code?: string }).code === 'PROVIDER_INVALID_MEDIA') throw error;
      }
      // A completed provider job can be downloaded again. Keep its run ID and
      // reservation so storage or network interruptions can be reconciled.
      throw new ProviderOutcomeUnknownError('Provider completed, but media delivery needs reconciliation', error);
    }
  }

  private providerStatusError(status: number): HttpException {
    if (status === 429) return new ServiceUnavailableException({ code: 'PROVIDER_RATE_LIMITED', message: 'Provider is rate limited' });
    if (status === 402) return new BadRequestException({ code: 'PROVIDER_CREDITS_EXHAUSTED', message: 'Provider account has insufficient balance' });
    if (status === 400 || status === 422) return new BadRequestException({ code: 'PROVIDER_INVALID_INPUT', message: 'Provider rejected the request input' });
    return new BadGatewayException({ code: 'PROVIDER_REJECTED', message: `Provider returned HTTP ${status}` });
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

  private validate(schema: Record<string, unknown>, value: unknown, label: string) {
    const validator = ajv.compile(schema);
    if (!validator(value)) {
      if (label === 'input') throw new BadRequestException('Operation input failed its schema');
      throw new BadGatewayException('Provider output failed its schema');
    }
  }
  private async requireProfile(profileId: string) {
    const row = await this.profiles.findOne({ profileId });
    if (!row) throw new NotFoundException('Provider profile not found');
    return row;
  }
}
