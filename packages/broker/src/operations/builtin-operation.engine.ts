import {
  BadGatewayException,
  BadRequestException,
  HttpException,
  Inject,
  Injectable,
  Logger,
  NotImplementedException,
  Optional,
  OnModuleInit,
} from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { RedisService } from '../cloud/redis/redis.service.js';
import { BuiltinOperationCatalog } from '../catalog/builtin-operation.catalog.js';
import { builtinExternalPlan } from './broker-operation-plan.js';
import { BrokerCatalogService } from '../catalog/broker-catalog.service.js';
import { BUILTIN_PROVIDER_EXECUTORS } from './builtin-provider-executors.js';
import { credentialFields, hasAccountStatusDefinition, hasCredentialTest, readProviderAccountStatus,
  runCredentialTest, validateCredentialDefinition } from './credential-test.definitions.js';
import type { BuiltinProviderExecutor } from './builtin-provider-executor.js';
import type { MiniappPricingMode } from '../cloud/saas-store/schemas/miniapp-pricing-policy.schema.js';
import {
  ProviderOutcomeUnknownError,
  type CapabilityCallInput,
  type CapabilityCallResult,
  type MiniappCapabilityContract,
} from '../cloud/saas-store/capabilities/capability-operation.types.js';
import { validateCapabilityContract } from '../cloud/saas-store/capabilities/capability-contract.js';
import {
  assertBounded,
  boundedEnvInteger,
  boundedInteger,
  positiveInteger,
  safeQuantitySum,
} from '../cloud/saas-store/capabilities/capability-utils.js';

const MAX_REQUEST_BYTES = 512 * 1024;
// Keep plaintext below MongoDB's 16 MiB document limit after authenticated
// encryption expands the cached payload to base64.
const MAX_RESULT_BYTES = 10 * 1024 * 1024;

type BuiltinDefinition = Readonly<{
  capability: string;
  providerId: string;
  contractVersion: 1;
  unit: MiniappCapabilityContract['unit'];
  maxCallsPerInvocation: number;
  executionKind?: string;
  route?: unknown;
  maxRequestBytes?: number;
  maxResponseBytes?: number;
}>;
export const BUILTIN_OPERATION_TEST_OVERRIDE = Symbol('BUILTIN_OPERATION_TEST_OVERRIDE');

@Injectable()
export class BuiltinOperationEngine implements OnModuleInit {
  private readonly logger = new Logger(BuiltinOperationEngine.name);
  private readonly operationExecutors = new Map<string, BuiltinProviderExecutor>();
  private readonly operationDefinitions = new Map<string, BuiltinDefinition>();
  private definitionsData: readonly BuiltinDefinition[] = [];
  private readonly providers = new Map<string, BuiltinProviderExecutor>();
  private readonly circuits = new Map<string, {
    active: number;
    consecutiveFailures: number;
    openUntil: number;
  }>();

  constructor(
    @Inject(BUILTIN_PROVIDER_EXECUTORS)
    executors: readonly BuiltinProviderExecutor[],
    @Optional() private readonly redis?: RedisService,
    @Optional() @Inject(BUILTIN_OPERATION_TEST_OVERRIDE) definitions?: readonly BuiltinDefinition[],
    private readonly catalog?: BuiltinOperationCatalog,
    @Optional() private readonly brokerCatalog?: BrokerCatalogService,
  ) {
    if (definitions) this.definitionsData = definitions;
    for (const executor of executors) {
      const providerOwner = this.providers.get(executor.providerId);
      if (providerOwner && providerOwner !== executor) {
        throw new Error(`Duplicate mini-app provider executor: ${executor.providerId}`);
      }
      this.providers.set(executor.providerId, executor);
    }
    if (definitions?.length) this.register(definitions);
  }

  async onModuleInit(): Promise<void> {
    if (this.definitionsData.length) return;
    if (!this.catalog) throw new Error('Built-in operation catalog is unavailable');
    this.register(await this.catalog.load());
  }

  has(capability: string): boolean { return this.operationDefinitions.has(capability); }

  private register(definitions: readonly BuiltinDefinition[]): void {
    if (!definitions.length) throw new Error('Built-in operation catalog is empty');
    for (const definition of definitions) {
      const executor = this.providers.get(definition.providerId);
      if (!executor && definition.executionKind !== 'http-multipart') {
        throw new Error(`Missing built-in operation executor: ${definition.providerId}`);
      }
      validateCapabilityContract({
        id: definition.capability,
        contractVersion: definition.contractVersion,
        unit: definition.unit,
        maxCallsPerInvocation: definition.maxCallsPerInvocation,
      });
      if (this.operationExecutors.has(definition.capability)) throw new Error(`Duplicate built-in operation: ${definition.capability}`);
      if (executor) this.operationExecutors.set(definition.capability, executor);
      this.operationDefinitions.set(definition.capability, definition);
    }
    this.definitionsData = definitions;
  }

  validateCredential(providerId: string, config: Record<string, unknown>): void {
    const executor = this.providers.get(providerId);
    if (!executor && hasCredentialTest(providerId)) return validateCredentialDefinition(providerId, config);
    if (!executor || executor.credentialSource !== 'admin') {
      throw new BadRequestException(`Provider credential executor is not registered: ${providerId}`);
    }
    executor.validateCredential(config);
  }

  registeredCapabilities(): string[] {
    return [...this.operationDefinitions.keys()].sort();
  }

  credentialOnlyProviders() {
    return [{ providerId: 'elevenlabs', credentialSource: 'admin' as const,
      credentialScope: 'pack' as const, credentialFields }];
  }

  async testCredential(
    providerId: string,
    config: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<void> {
    const executor = this.providers.get(providerId);
    if (!executor && hasCredentialTest(providerId)) return runCredentialTest(providerId, config, signal);
    if (!executor || executor.credentialSource !== 'admin') {
      throw new BadRequestException(`Provider credential executor is not registered: ${providerId}`);
    }
    executor.validateCredential(config);
    if (!executor.testCredential) {
      throw new BadRequestException(`Provider ${providerId} does not support credential testing`);
    }
    await executor.testCredential(config, signal);
  }

  async providerAccountStatus(
    providerId: string,
    config: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<import('../contracts/capability.js').ProviderAccountStatus> {
    const executor = this.providers.get(providerId);
    if (!executor && hasAccountStatusDefinition(providerId)) return readProviderAccountStatus(providerId, config, signal);
    if (!executor || executor.credentialSource !== 'admin') {
      throw new BadRequestException(`Provider credential executor is not registered: ${providerId}`);
    }
    executor.validateCredential(config);
    if (!executor.getAccountStatus) {
      throw new BadRequestException(`Provider ${providerId} does not expose account status`);
    }
    return executor.getAccountStatus(config, signal);
  }

  contract(capability: string): MiniappCapabilityContract {
    const definition = this.operationDefinitions.get(capability);
    if (!definition) {
      throw new NotImplementedException({
        code: 'CAPABILITY_NOT_ALLOWED',
        message: `Built-in operation is not registered: ${capability}`,
      });
    }
    return {
      id: definition.capability,
      contractVersion: definition.contractVersion,
      unit: definition.unit,
      maxCallsPerInvocation: definition.maxCallsPerInvocation,
    };
  }

  estimateQuantity(capability: string, payload: Record<string, unknown>): number {
    switch (this.contract(capability).unit) {
      case 'token':
        return safeQuantitySum(
          positiveInteger(payload.max_tokens ?? payload.maxTokens ?? 1, 'Requested token quantity'),
          Buffer.byteLength(JSON.stringify(payload)),
        );
      case 'image':
        return positiveInteger(payload.n ?? 1, 'Requested image quantity');
      case 'result':
        return boundedInteger(payload.pageSize ?? payload.num ?? payload.limit ?? 20, 1, 20);
      case 'byte':
        return boundedInteger(payload.size, 1, 512 * 1024 * 1024);
      case 'second':
        return boundedInteger(payload.max_duration_seconds, 1, 600);
      case 'request':
        return 1;
      case 'provider_credit':
        return boundedInteger(payload.max_provider_credits, 1, 5_000);
    }
  }

  async estimateQuantityForCall(input: Readonly<{
    capability: string;
    ownerId: string;
    packId: string;
    operationId: string;
    pricingMode: MiniappPricingMode;
    payload: Record<string, unknown>;
  }>): Promise<number> {
    const executor = this.operationExecutors.get(input.capability);
    const quantity = executor?.estimateQuantity
      ? await executor.estimateQuantity(input)
      : this.estimateQuantity(input.capability, input.payload);
    if (!Number.isSafeInteger(quantity) || quantity < 1) throw new BadRequestException('Invalid reserved capability quantity');
    return quantity;
  }

  definitions() {
    return this.definitionsData.map(operation => {
      const executor = this.providers.get(operation.providerId);
      return {
        capability: operation.capability,
        providerId: operation.providerId,
        credentialSource: executor?.credentialSource ?? 'admin',
        credentialScope: executor?.credentialScope ?? (operation.route as { credentialScope?: 'environment' | 'pack' } | undefined)?.credentialScope ?? 'pack',
        credentialFields: executor?.credentialFields ?? [{ key: 'apiKey', label: 'API key', type: 'secret', required: true }],
        contractVersion: operation.contractVersion,
        unit: operation.unit,
        maxCallsPerInvocation: operation.maxCallsPerInvocation,
        ...(operation.executionKind ? { executionKind: operation.executionKind } : {}),
        ...(operation.route ? { route: operation.route } : {}),
        ...(operation.maxRequestBytes ? { maxRequestBytes: operation.maxRequestBytes } : {}),
        ...(operation.maxResponseBytes ? { maxResponseBytes: operation.maxResponseBytes } : {}),
      };
    }).sort((left, right) => left.capability.localeCompare(right.capability));
  }

  definition(capability: string): ReturnType<BuiltinOperationEngine['definitions']>[number] {
    const definition = this.definitions().find((candidate) => candidate.capability === capability);
    if (!definition) {
      throw new NotImplementedException({
        code: 'CAPABILITY_NOT_ALLOWED',
        message: `Capability executor is not registered: ${capability}`,
      });
    }
    return definition;
  }

  activationRequirements(capability: string, packId: string, operationId: string) {
    const executor = this.operationExecutors.get(capability);
    if (!executor && this.operationDefinitions.get(capability)?.executionKind === 'http-multipart') return undefined;
    if (!executor) {
      throw new NotImplementedException({
        code: 'CAPABILITY_NOT_ALLOWED',
        message: `Capability executor is not registered: ${capability}`,
      });
    }
    return executor.activationRequirements?.({ capability, packId, operationId });
  }

  async invoke(input: CapabilityCallInput): Promise<CapabilityCallResult> {
    const definition = this.operationDefinitions.get(input.capability);
    if (!definition) {
      throw new NotImplementedException({ code: 'CAPABILITY_NOT_ALLOWED',
        message: `Built-in operation is not registered: ${input.capability}` });
    }
    const external = !this.operationExecutors.has(input.capability)
      && definition.executionKind === 'http-multipart';
    const requestLimit = external
      ? builtinExternalPlan(definition as import('../catalog/builtin-operation.catalog.js').BuiltinOperationDefinition).requestLimitBytes
      : definition.maxRequestBytes ?? MAX_REQUEST_BYTES;
    assertBounded(input.payload, requestLimit, 'Capability request');
    const executor = this.operationExecutors.get(input.capability);
    if (!executor && !external) {
      throw new NotImplementedException({
        code: 'CAPABILITY_NOT_ALLOWED',
        message: `Capability executor is not registered: ${input.capability}`,
      });
    }
    const circuitKey = `${input.environment}:${input.packId}:${input.capability}`;
    const circuit = this.circuits.get(circuitKey) ?? {
      active: 0, consecutiveFailures: 0, openUntil: 0,
    };
    this.circuits.set(circuitKey, circuit);
    if (circuit.openUntil > Date.now()) {
      throw this.unavailable('Provider circuit is temporarily open for this mini-app capability');
    }
    const concurrency = boundedEnvInteger('JOVITA_CAPABILITY_MAX_CONCURRENCY_PER_KEY', 8, 1, 100);
    if (circuit.active >= concurrency) {
      throw this.unavailable('Provider concurrency limit reached for this mini-app capability');
    }
    let distributedLease: { key: string; token: string } | false | undefined;
    let providerStarted = false;
    circuit.active += 1;
    try {
      if (await this.distributedCircuitOpen(circuitKey)) {
        throw this.unavailable('Provider circuit is temporarily open for this mini-app capability');
      }
      distributedLease = await this.acquireDistributedLease(circuitKey, concurrency);
      if (distributedLease === false) {
        throw this.unavailable('Provider concurrency limit reached for this mini-app capability');
      }
      providerStarted = true;
      const result = external
        ? await this.brokerCatalog!.invokeBuiltin(input,
          definition as import('../catalog/builtin-operation.catalog.js').BuiltinOperationDefinition)
        : await executor!.invoke(input);
      assertBounded(result.result, definition.maxResponseBytes ?? MAX_RESULT_BYTES, 'Capability result');
      if (!Number.isSafeInteger(result.providerCostMicros) || result.providerCostMicros < 0) {
        throw new BadGatewayException('Provider executor returned an invalid cost measurement');
      }
      if (!Number.isSafeInteger(result.quantity) || result.quantity < 0) {
        throw new BadGatewayException('Provider executor returned an invalid quantity measurement');
      }
      circuit.consecutiveFailures = 0;
      circuit.openUntil = 0;
      await this.resetDistributedCircuit(circuitKey);
      return result;
    } catch (error) {
      const circuitFailure = providerStarted && this.countsAsCircuitFailure(error);
      if (circuitFailure) {
        circuit.consecutiveFailures += 1;
        const threshold = boundedEnvInteger('JOVITA_CAPABILITY_CIRCUIT_FAILURE_THRESHOLD', 5, 1, 100);
        if (circuit.consecutiveFailures >= threshold) {
          circuit.openUntil = Date.now()
            + boundedEnvInteger('JOVITA_CAPABILITY_CIRCUIT_OPEN_MS', 30_000, 1_000, 600_000);
        }
        await this.recordDistributedFailure(circuitKey, threshold);
      } else if (providerStarted && error instanceof HttpException && error.getStatus() === 422) {
        const response = error.getResponse();
        const details = typeof response === 'object' && response !== null
          ? response as Record<string, unknown>
          : {};
        const code = String(details.code ?? 'PROVIDER_REQUEST_REJECTED')
          .replace(/[^A-Z0-9_]/g, '')
          .slice(0, 80);
        this.logger.log(
          `miniapp_capability.metric name=circuit_exclusion value=1 packId=${input.packId} capability=${input.capability} code=${code}`,
        );
      }
      throw error;
    } finally {
      circuit.active = Math.max(0, circuit.active - 1);
      await this.releaseDistributedLease(distributedLease);
    }
  }

  private unavailable(message: string): BadGatewayException {
    return new BadGatewayException({ code: 'PROVIDER_UNAVAILABLE', message });
  }

  private countsAsCircuitFailure(error: unknown): boolean {
    if (error instanceof ProviderOutcomeUnknownError) return true;
    if (!(error instanceof HttpException)) return false;
    const response = error.getResponse();
    const details = typeof response === 'object' && response !== null
      ? response as Record<string, unknown>
      : {};
    const code = String(details.code ?? '').toUpperCase();
    if (code === 'PROVIDER_PRICE_CHANGED' || code === 'PROVIDER_SCHEMA_CHANGED') return false;
    const status = error.getStatus();
    return status === 408 || status === 424 || status === 425 || status === 429 || status >= 500;
  }

  private async distributedCircuitOpen(key: string): Promise<boolean> {
    if (!this.redis?.isReady()) return false;
    try {
      const value = await this.redis.clientInstance.hget(this.redisCircuitKey(key), 'openUntil');
      return Number(value ?? 0) > Date.now();
    } catch { return false; }
  }

  private async acquireDistributedLease(
    key: string,
    limit: number,
  ): Promise<{ key: string; token: string } | false | undefined> {
    if (!this.redis?.isReady()) return undefined;
    const redisKey = this.redisConcurrencyKey(key);
    const token = randomUUID();
    const now = Date.now();
    const ttlMs = boundedEnvInteger('JOVITA_CAPABILITY_CONCURRENCY_LEASE_MS', 120_000, 5_000, 900_000);
    try {
      const acquired = await this.redis.clientInstance.eval(
        "redis.call('zremrangebyscore', KEYS[1], '-inf', ARGV[1]); "
        + "if redis.call('zcard', KEYS[1]) >= tonumber(ARGV[2]) then return 0 end; "
        + "redis.call('zadd', KEYS[1], ARGV[3], ARGV[4]); "
        + "redis.call('pexpire', KEYS[1], ARGV[5]); return 1",
        1, redisKey, String(now), String(limit), String(now + ttlMs), token, String(ttlMs * 2),
      );
      return Number(acquired) === 1 ? { key: redisKey, token } : false;
    } catch { return undefined; }
  }

  private async releaseDistributedLease(
    lease: { key: string; token: string } | false | undefined,
  ): Promise<void> {
    if (!lease || !this.redis?.isReady()) return;
    try { await this.redis.clientInstance.zrem(lease.key, lease.token); } catch { /* TTL releases it. */ }
  }

  private async recordDistributedFailure(key: string, threshold: number): Promise<void> {
    if (!this.redis?.isReady()) return;
    const redisKey = this.redisCircuitKey(key);
    try {
      const failures = await this.redis.clientInstance.hincrby(redisKey, 'failures', 1);
      const openMs = boundedEnvInteger('JOVITA_CAPABILITY_CIRCUIT_OPEN_MS', 30_000, 1_000, 600_000);
      if (failures >= threshold) {
        await this.redis.clientInstance.hset(redisKey, 'openUntil', String(Date.now() + openMs));
      }
      await this.redis.clientInstance.pexpire(redisKey, openMs * 2);
    } catch { /* In-process circuit remains active. */ }
  }

  private async resetDistributedCircuit(key: string): Promise<void> {
    if (!this.redis?.isReady()) return;
    try { await this.redis.clientInstance.del(this.redisCircuitKey(key)); } catch { /* Bounded TTL. */ }
  }

  private redisConcurrencyKey(key: string): string {
    return `miniapp:capability:concurrency:${createHash('sha256').update(key).digest('hex')}`;
  }

  private redisCircuitKey(key: string): string {
    return `miniapp:capability:circuit:${createHash('sha256').update(key).digest('hex')}`;
  }
}
