import { readFileSync } from 'node:fs';
import type {
  BrokerOperation,
  JovitaActivityPhaseV1,
  JovitaActivitySpecV1,
  ServiceConfig,
  ManifestValidationResult,
  ManifestValidationError,
} from '../types.js';

export function readServiceConfig(configPath: string): ServiceConfig {
  const parsed = JSON.parse(readFileSync(configPath, 'utf-8'));
  if (parsed?.runtime?.injectedSecrets !== undefined) {
    throw new Error(
      'runtime.injectedSecrets is no longer supported; declare brokered operations and provider capabilities instead',
    );
  }
  return {
    id: requiredString(parsed, 'id'),
    name: requiredString(parsed, 'name'),
    version: requiredString(parsed, 'version'),
    category: requiredString(parsed, 'category'),
    description: requiredString(parsed, 'description'),
    logoUrl: optionalString(parsed.logoUrl),
    presentation: readPresentation(parsed.presentation),
    activityProtocolVersion: readActivityProtocolVersion(parsed.activityProtocolVersion),
    billing: parsed.billing,
    auth: parsed.auth,
    providers: Array.isArray(parsed.providers) ? parsed.providers : [],
    broker: parsed.broker,
    compat: parsed.compat,
    skill: {
      entry: 'SKILL.md',
      assets: ['.'],
    },
    runtime: parsed.runtime
      ? {
          ...(parsed.runtime.build ? { build: readRuntimeBuildConfig(parsed.runtime.build) } : {}),
          ...(parsed.runtime.execute ? { execute: parsed.runtime.execute } : {}),
        }
      : undefined,
  };
}

export function validateManifest(config: ServiceConfig): ManifestValidationResult {
  const errors: ManifestValidationError[] = [];

  if (!config.id || config.id.trim() === '') {
    errors.push({ field: 'id', message: 'id is required' });
  }

  if (!config.name || config.name.trim() === '') {
    errors.push({ field: 'name', message: 'name is required' });
  }

  if (!config.version || config.version.trim() === '') {
    errors.push({ field: 'version', message: 'version is required' });
  }

  if (!config.category || config.category.trim() === '') {
    errors.push({ field: 'category', message: 'category is required' });
  }

  if (!config.description || config.description.trim() === '') {
    errors.push({ field: 'description', message: 'description is required' });
  }

  validatePresentation(config.presentation, errors);

  if (config.runtime?.execute) {
    const execute = config.runtime.execute;
    if (!execute.command || execute.command.trim() === '') {
      errors.push({ field: 'runtime.execute.command', message: 'runtime.execute.command is required' });
    }
    if (execute.mode === 'brokered') {
      validateBrokerExecution(execute, errors);
    }
    validateActivityProtocol(config, errors);
  }
  validateRuntimeBuildConfig(config.runtime?.build, errors);
  validateBrokerDeclaration(config, errors);
  if ((config.runtime as unknown as Record<string, unknown> | undefined)?.injectedSecrets !== undefined) {
    errors.push({
      field: 'runtime.injectedSecrets',
      message: 'runtime.injectedSecrets is no longer supported; use brokered provider capabilities',
    });
  }

  return { valid: errors.length === 0, errors };
}

function readRuntimeBuildConfig(value: unknown): NonNullable<ServiceConfig['runtime']>['build'] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('runtime.build must be an object');
  }
  const source = value as Record<string, unknown>;
  const allowed = new Set(['prunePreset', 'omitOptionalPackages', 'sizeReport']);
  for (const key of Object.keys(source)) {
    if (!allowed.has(key)) throw new Error(`runtime.build.${key} is not supported`);
  }
  if (source.prunePreset !== undefined && source.prunePreset !== 'production-node') {
    throw new Error('runtime.build.prunePreset must be production-node');
  }
  if (source.sizeReport !== undefined && typeof source.sizeReport !== 'boolean') {
    throw new Error('runtime.build.sizeReport must be a boolean');
  }
  if (source.omitOptionalPackages !== undefined && !Array.isArray(source.omitOptionalPackages)) {
    throw new Error('runtime.build.omitOptionalPackages must be an array');
  }
  const omitOptionalPackages = (source.omitOptionalPackages as unknown[] | undefined)?.map((item, index) => {
    if (typeof item !== 'string' || !/^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/i.test(item)) {
      throw new Error(`runtime.build.omitOptionalPackages[${index}] must be a valid package name`);
    }
    return item;
  });
  return {
    ...(source.prunePreset ? { prunePreset: source.prunePreset as 'production-node' } : {}),
    ...(omitOptionalPackages ? { omitOptionalPackages } : {}),
    ...(source.sizeReport !== undefined ? { sizeReport: source.sizeReport } : {}),
  };
}

function validateRuntimeBuildConfig(
  build: NonNullable<ServiceConfig['runtime']>['build'] | undefined,
  errors: ManifestValidationError[],
): void {
  if (!build) return;
  if (build.prunePreset !== undefined && build.prunePreset !== 'production-node') {
    errors.push({ field: 'runtime.build.prunePreset', message: 'only production-node is supported' });
  }
  if (build.sizeReport !== undefined && typeof build.sizeReport !== 'boolean') {
    errors.push({ field: 'runtime.build.sizeReport', message: 'sizeReport must be a boolean' });
  }
  const seen = new Set<string>();
  for (const [index, packageName] of (build.omitOptionalPackages ?? []).entries()) {
    if (!/^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/i.test(packageName)) {
      errors.push({ field: `runtime.build.omitOptionalPackages[${index}]`, message: 'invalid package name' });
    } else if (seen.has(packageName)) {
      errors.push({ field: `runtime.build.omitOptionalPackages[${index}]`, message: 'package names must be unique' });
    }
    seen.add(packageName);
  }
}

function readActivityProtocolVersion(value: unknown): 1 | undefined {
  if (value === undefined) return undefined;
  if (value !== 1) throw new Error('activityProtocolVersion must be 1');
  return 1;
}

function validateActivityProtocol(config: ServiceConfig, errors: ManifestValidationError[]): void {
  const execute = config.runtime?.execute;
  if (!execute) return;
  const operations = Array.isArray(execute.operations) ? execute.operations : [];
  if (config.activityProtocolVersion !== 1) {
    errors.push({
      field: 'activityProtocolVersion',
      message: 'new executable Mini Apps must declare activityProtocolVersion 1',
    });
    return;
  }
  if (operations.length === 0) {
    errors.push({
      field: 'runtime.execute.operations',
      message: 'activity protocol v1 requires at least one declared operation',
    });
    return;
  }
  operations.forEach((operation, index) => {
    if (!operation.activity) {
      errors.push({
        field: `runtime.execute.operations[${index}].activity`,
        message: 'activity metadata is required by activity protocol v1',
      });
      return;
    }
    validateActivitySpec(operation.activity, `runtime.execute.operations[${index}].activity`, errors);
  });
}

const ACTIVITY_KINDS = new Set(['build', 'generate', 'check', 'test', 'search', 'list', 'read', 'write', 'prepare', 'publish', 'send', 'run']);
const ACTIVITY_ICONS = new Set(['build', 'check', 'test', 'search', 'folder', 'document', 'publish', 'send', 'command']);

function validateActivitySpec(spec: JovitaActivitySpecV1, path: string, errors: ManifestValidationError[]): void {
  validateActivityPhase(spec, path, errors);
  if (spec.target) {
    const target = spec.target;
    if (!['flag-value', 'positional', 'working-directory'].includes(target.source)) {
      errors.push({ field: `${path}.target.source`, message: 'unsupported target source' });
    }
    if (!['display-name', 'basename', 'path-tail', 'hostname'].includes(target.format)) {
      errors.push({ field: `${path}.target.format`, message: 'unsupported target format' });
    }
    if (!['before-object', 'after-object'].includes(target.placement)) {
      errors.push({ field: `${path}.target.placement`, message: 'unsupported target placement' });
    }
    if (target.source === 'flag-value' && (!target.key || !/^--[a-z0-9][a-z0-9-]{0,63}$/i.test(target.key))) {
      errors.push({ field: `${path}.target.key`, message: 'flag-value targets require a safe long flag' });
    }
    if (target.key && /(?:token|secret|password|credential|api[-_]?key|authorization)/i.test(target.key)) {
      errors.push({ field: `${path}.target.key`, message: 'target cannot reference sensitive arguments' });
    }
    if (target.source === 'positional' && (!Number.isInteger(target.index) || Number(target.index) < 0 || Number(target.index) > 32)) {
      errors.push({ field: `${path}.target.index`, message: 'positional target index must be from 0 to 32' });
    }
  }
  for (const [phaseId, phase] of Object.entries(spec.phases ?? {})) {
    if (!/^[a-z][a-z0-9-]{0,63}$/.test(phaseId)) {
      errors.push({ field: `${path}.phases.${phaseId}`, message: 'phase id must be a safe lowercase identifier' });
    }
    validateActivityPhase(phase, `${path}.phases.${phaseId}`, errors);
  }
}

function validateActivityPhase(phase: JovitaActivityPhaseV1, path: string, errors: ManifestValidationError[]): void {
  if (!ACTIVITY_KINDS.has(phase.kind)) errors.push({ field: `${path}.kind`, message: 'unsupported activity kind' });
  if (!phase.object || phase.object.length > 64 || /[\u0000-\u001f{}]/.test(phase.object)) {
    errors.push({ field: `${path}.object`, message: 'object must be safe text up to 64 characters' });
  }
  if (phase.article !== undefined && !['none', 'the'].includes(phase.article)) {
    errors.push({ field: `${path}.article`, message: 'article must be none or the' });
  }
  if (phase.icon !== undefined && !ACTIVITY_ICONS.has(phase.icon)) {
    errors.push({ field: `${path}.icon`, message: 'unsupported activity icon' });
  }
  for (const [state, label] of Object.entries(phase.labels ?? {})) {
    const placeholders = String(label).match(/{[^}]*}/g) ?? [];
    if (!['active', 'completed', 'failed'].includes(state) || !label || label.length > 96 || /[\u0000-\u001f]/.test(label) || placeholders.some((token) => token !== '{target}') || /[{}]/.test(label.replaceAll('{target}', ''))) {
      errors.push({ field: `${path}.labels.${state}`, message: 'label contains unsafe text or placeholders' });
    }
  }
}

export function validateBrokerDeclaration(config: ServiceConfig, errors: ManifestValidationError[]): void {
  const broker = config.broker;
  if (broker === undefined) return;
  const row = broker && typeof broker === 'object' && !Array.isArray(broker)
    ? broker as unknown as Record<string, unknown> : {};
  if (containsCredentialField(row)) {
    errors.push({ field: 'broker', message: 'credentials and credential fields belong in saved connections' });
  }
  if (Object.keys(row).some((key) => key !== 'providers') || !Array.isArray(row.providers)
    || row.providers.length < 1 || row.providers.length > 10) {
    errors.push({ field: 'broker.providers', message: 'declare 1 to 10 providers without credentials' });
    return;
  }
  if (config.runtime?.execute?.mode !== 'brokered') {
    errors.push({ field: 'broker', message: 'broker declarations require a brokered runtime' });
  }
  const allowedProvider = new Set(['id', 'name', 'summary', 'docsUrl', 'category', 'baseUrl',
    'authMethod', 'authHeader', 'timeoutMs', 'operations']);
  const allowedOperation = new Set(['id', 'version', 'name', 'purpose', 'method', 'path',
    'executionKind', 'mediaPreset', 'requestMapping', 'responseField', 'queryFields',
    'maxProviderCostMicros', // accepted only to verify older signed bundles; broker ignores it
    'inputSchema', 'outputSchema', 'buyerCredits', 'maxRequestBytes', 'maxResponseBytes', 'providerCostNote',
    'emptyResultIsNoResult', 'poll', 'artifact']);
  const ids = new Set<string>();
  const referenced = new Set(config.runtime?.execute?.operations?.flatMap((operation) => operation.capabilities) ?? []);
  for (const [index, raw] of row.providers.entries()) {
    const provider = raw && typeof raw === 'object' && !Array.isArray(raw)
      ? raw as Record<string, unknown> : {};
    const path = `broker.providers[${index}]`;
    const id = String(provider.id ?? '');
    if (Object.keys(provider).some((key) => !allowedProvider.has(key)) || !/^[a-z][a-z0-9_-]{1,31}$/.test(id)
      || ids.has(id) || !Array.isArray(provider.operations) || provider.operations.length < 1
      || provider.operations.length > 50 || !['bearer', 'header'].includes(String(provider.authMethod))) {
      errors.push({ field: path, message: 'invalid or duplicate provider definition; keys belong in connections' });
      continue;
    }
    ids.add(id);
    for (const field of ['name', 'summary', 'docsUrl', 'category', 'baseUrl']) {
      if (typeof provider[field] !== 'string' || !String(provider[field]).trim()) {
        errors.push({ field: `${path}.${field}`, message: 'required text' });
      }
    }
    for (const field of ['docsUrl', 'baseUrl']) {
      try {
        if (new URL(String(provider[field])).protocol !== 'https:') throw new Error();
      } catch { errors.push({ field: `${path}.${field}`, message: 'public HTTPS URL required' }); }
    }
    for (const [operationIndex, rawOperation] of provider.operations.entries()) {
      const operation = rawOperation && typeof rawOperation === 'object' && !Array.isArray(rawOperation)
        ? rawOperation as Record<string, unknown> : {};
      const operationPath = `${path}.operations[${operationIndex}]`;
      const operationId = String(operation.id ?? '');
      const version = Number(operation.version);
      const ref = `broker.${config.id}.${id}.${operationId}.v${version}`;
      if (Object.keys(operation).some((key) => !allowedOperation.has(key))
        || !/^[a-z][a-z0-9_-]{1,63}$/.test(operationId)
        || !Number.isSafeInteger(version) || version < 1 || version > 1000
        || !['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(String(operation.method))
        || (operation.executionKind !== undefined && !['http-json', 'http-multipart', 'http-binary', 'http-sse', 'http-poll'].includes(String(operation.executionKind)))
        || typeof operation.path !== 'string' || !operation.path.startsWith('/')
        || !Number.isSafeInteger(operation.buyerCredits) || Number(operation.buyerCredits) < 1
        || (operation.emptyResultIsNoResult !== undefined && typeof operation.emptyResultIsNoResult !== 'boolean')
        || !operation.inputSchema || !operation.outputSchema) {
        errors.push({ field: operationPath, message: 'invalid operation definition; keys are not permitted' });
      }
      if (!referenced.has(ref)) errors.push({ field: operationPath, message: `add ${ref} to a runtime operation's capabilities` });
      if (operation.executionKind === 'http-poll') {
        const poll = operation.poll && typeof operation.poll === 'object' && !Array.isArray(operation.poll)
          ? operation.poll as Record<string, unknown> : {};
        if (operation.method !== 'POST' || typeof poll.path !== 'string'
          || !poll.path.includes('{job_id}') || typeof poll.jobIdField !== 'string'
          || typeof poll.statusField !== 'string' || typeof poll.successValue !== 'string'
          || typeof poll.failureValue !== 'string'
          || (poll.failureValues !== undefined && (!Array.isArray(poll.failureValues)
            || poll.failureValues.length > 8
            || !poll.failureValues.every(value => typeof value === 'string' && /^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(value))))
          || (poll.providerStatusField !== undefined && (typeof poll.providerStatusField !== 'string'
            || !/^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*){0,3}$/.test(poll.providerStatusField)))
          || (poll.noResultStatuses !== undefined && (poll.providerStatusField === undefined
            || !Array.isArray(poll.noResultStatuses) || poll.noResultStatuses.length > 8
            || !poll.noResultStatuses.every(status => Number.isSafeInteger(status)
              && status >= 400 && status <= 499)))
          || !Number.isSafeInteger(poll.intervalMs)
          || !Number.isSafeInteger(poll.maxAttempts)) {
          errors.push({ field: `${operationPath}.poll`, message: 'declare a bounded submit and poll contract' });
        }
      } else if (operation.poll !== undefined) {
        errors.push({ field: `${operationPath}.poll`, message: 'poll settings require http-poll execution' });
      }
      if (operation.artifact !== undefined) {
        const artifact = operation.artifact && typeof operation.artifact === 'object'
          && !Array.isArray(operation.artifact) ? operation.artifact as Record<string, unknown> : {};
        const maxBytes = Number(artifact.maxBytes);
        const retention = Number(artifact.retentionSeconds);
        const limit = artifact.kind === 'video' ? 250 * 1024 * 1024
          : artifact.kind === 'audio' ? 100 * 1024 * 1024 : 0;
        if (operation.executionKind !== 'http-poll'
          || Object.keys(artifact).some(key => !['path', 'kind', 'maxBytes', 'retentionSeconds', 'timeoutMs'].includes(key))
          || typeof artifact.path !== 'string' || !/^\/[A-Za-z0-9._~/-]*\{job_id\}[A-Za-z0-9._~/-]*$/.test(artifact.path)
          || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > limit
          || !Number.isSafeInteger(retention) || retention < 3600 || retention > 7 * 86400
          || (artifact.timeoutMs !== undefined && (!Number.isSafeInteger(artifact.timeoutMs)
            || Number(artifact.timeoutMs) < 1000 || Number(artifact.timeoutMs) > 600000))) {
          errors.push({ field: `${operationPath}.artifact`, message: 'declare a bounded same-host media download and retention' });
        }
      }
      if (operation.mediaPreset !== undefined && (operation.mediaPreset !== 'transparent-png-v1'
        || operation.executionKind !== 'http-multipart' || operation.method !== 'POST')) {
        errors.push({ field: `${operationPath}.mediaPreset`, message: 'select a reviewed multipart media preset' });
      }
      if (operation.requestMapping !== undefined && (operation.method === 'GET'
        || !['http-json', 'http-poll'].includes(String(operation.executionKind ?? 'http-json'))
        || !operation.requestMapping || typeof operation.requestMapping !== 'object'
        || Array.isArray(operation.requestMapping))) {
        errors.push({ field: `${operationPath}.requestMapping`, message: 'declare a bounded JSON request mapping' });
      }
      if (operation.responseField !== undefined && (typeof operation.responseField !== 'string'
        || !/^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*){0,3}$/.test(operation.responseField))) {
        errors.push({ field: `${operationPath}.responseField`, message: 'use a bounded response field path' });
      }
    }
  }
}

function containsCredentialField(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsCredentialField);
  if (!value || typeof value !== 'object') return false;
  return Object.entries(value).some(([key, item]) => /^(?:api_?key|access_?token|refresh_?token|secret|password|authorization|credential)$/i.test(key)
    || containsCredentialField(item));
}

export function validateBrokerExecution(
  execute: NonNullable<NonNullable<ServiceConfig['runtime']>['execute']>,
  errors: ManifestValidationError[],
): void {
  if (execute.protocolVersion !== 1) {
    errors.push({
      field: 'runtime.execute.protocolVersion',
      message: 'brokered runtimes must declare protocolVersion 1',
    });
  }
  const operations = Array.isArray(execute.operations) ? execute.operations : [];
  if (operations.length === 0) {
    errors.push({
      field: 'runtime.execute.operations',
      message: 'brokered runtimes must declare at least one operation',
    });
    return;
  }
  const operationIds = new Set<string>();
  operations.forEach((operation, index) => {
    if (!/^[a-z][a-z0-9._-]{0,79}$/.test(operation.id)) {
      errors.push({
        field: `runtime.execute.operations[${index}].id`,
        message: 'operation id must be a lowercase safe identifier',
      });
    } else if (operationIds.has(operation.id)) {
      errors.push({
        field: `runtime.execute.operations[${index}].id`,
        message: 'operation ids must be unique',
      });
    }
    operationIds.add(operation.id);
    validateOperationArguments(operation, index, errors);
    const capabilityIds = new Set<string>();
    for (const [capabilityIndex, capability] of (operation.capabilities ?? []).entries()) {
      if (!/^[a-z][a-z0-9_-]*(?:\.[a-z][a-z0-9_-]*)+$/.test(capability)) {
        errors.push({
          field: `runtime.execute.operations[${index}].capabilities[${capabilityIndex}]`,
          message: 'capability must be a lowercase dotted identifier',
        });
      } else if (capabilityIds.has(capability)) {
        errors.push({
          field: `runtime.execute.operations[${index}].capabilities[${capabilityIndex}]`,
          message: 'capabilities must be unique within an operation',
        });
      }
      capabilityIds.add(capability);
    }
    if (operation.capabilityLimits !== undefined) {
      if (!operation.capabilityLimits || typeof operation.capabilityLimits !== 'object'
        || Array.isArray(operation.capabilityLimits)) {
        errors.push({ field: `runtime.execute.operations[${index}].capabilityLimits`,
          message: 'capability limits must map declared catalog references to maximum call counts' });
      } else for (const [capability, limit] of Object.entries(operation.capabilityLimits)) {
        if (!capabilityIds.has(capability) || !capability.startsWith('broker.')
          || !Number.isSafeInteger(limit) || limit < 1 || limit > 128) {
          errors.push({ field: `runtime.execute.operations[${index}].capabilityLimits.${capability}`,
            message: 'limit must be 1 to 128 calls for a declared broker reference' });
        }
      }
    }
    const catalogCallBudget = (operation.capabilities ?? []).filter(capability => capability.startsWith('broker.'))
      .reduce((sum, capability) => sum + (operation.capabilityLimits?.[capability] ?? 1), 0);
    if (catalogCallBudget > 512) {
      errors.push({ field: `runtime.execute.operations[${index}].capabilityLimits`,
        message: 'one runtime operation cannot declare more than 512 broker calls' });
    }
    if ((operation.capabilities ?? []).length > 0 && operation.billingRequired !== true) {
      errors.push({
        field: `runtime.execute.operations[${index}].billingRequired`,
        message: 'operations with managed capabilities require billing',
      });
    }
    if (operation.destructive !== undefined && typeof operation.destructive !== 'boolean') {
      errors.push({
        field: `runtime.execute.operations[${index}].destructive`,
        message: 'destructive must be a boolean',
      });
    }
  });
  for (let left = 0; left < operations.length; left += 1) {
    for (let right = left + 1; right < operations.length; right += 1) {
      if (brokerOperationsOverlap(operations[left]!, operations[right]!)) {
        errors.push({
          field: `runtime.execute.operations[${right}].argvPrefix`,
          message: `operation overlaps with ${operations[left]!.id}`,
        });
      }
    }
  }
  const healthOperationId = String(execute.healthCheck?.operationId ?? '').trim();
  const healthOperation = operations.find((operation) => operation.id === healthOperationId);
  if (!healthOperation) {
    errors.push({
      field: 'runtime.execute.healthCheck.operationId',
      message: 'brokered health checks must reference a declared operation',
    });
  } else if (
    healthOperation.billingRequired
    || healthOperation.capabilities.length > 0
    || healthOperation.destructive
  ) {
    errors.push({
      field: 'runtime.execute.healthCheck.operationId',
      message: 'the health-check operation must be offline and free',
    });
  }
}

function validateOperationArguments(
  operation: BrokerOperation,
  index: number,
  errors: ManifestValidationError[],
): void {
  if (!Array.isArray(operation.argvPrefix)) {
    errors.push({
      field: `runtime.execute.operations[${index}].argvPrefix`,
      message: 'argvPrefix must be an array',
    });
    return;
  }
  const fields = ['argvPrefix', 'requiredArgs', 'excludedArgs'] as const;
  for (const field of fields) {
    for (const [valueIndex, value] of (operation[field] ?? []).entries()) {
      if (typeof value !== 'string' || !value || value.includes('\0') || value.length > 512) {
        errors.push({
          field: `runtime.execute.operations[${index}].${field}[${valueIndex}]`,
          message: 'operation arguments must be non-empty bounded strings without NUL bytes',
        });
      }
    }
  }
  const excluded = new Set(operation.excludedArgs ?? []);
  if (
    operation.argvPrefix.some((value) => excluded.has(value))
    || (operation.requiredArgs ?? []).some((value) => excluded.has(value))
  ) {
    errors.push({
      field: `runtime.execute.operations[${index}]`,
      message: 'operation argument constraints make this operation unreachable',
    });
  }
}

function brokerOperationsOverlap(left: BrokerOperation, right: BrokerOperation): boolean {
  const sharedPrefixLength = Math.min(left.argvPrefix.length, right.argvPrefix.length);
  for (let index = 0; index < sharedPrefixLength; index += 1) {
    if (left.argvPrefix[index] !== right.argvPrefix[index]) return false;
  }
  const leftExcluded = new Set(left.excludedArgs ?? []);
  const rightExcluded = new Set(right.excludedArgs ?? []);
  const forcedByLeft = new Set([...left.argvPrefix, ...(left.requiredArgs ?? [])]);
  const forcedByRight = new Set([...right.argvPrefix, ...(right.requiredArgs ?? [])]);
  if ([...forcedByLeft].some((value) => rightExcluded.has(value))) return false;
  if ([...forcedByRight].some((value) => leftExcluded.has(value))) return false;
  return true;
}

export function buildPublishedManifest(
  config: ServiceConfig,
  skillIndex: Array<{ path: string; sha256: string; size: number }>,
  bundle: { checksum: string; signature: string }
) {
  return {
    id: config.id,
    name: config.name,
    version: config.version,
    lifecycle: 'draft',
    category: config.category,
    description: config.description,
    logoUrl: config.logoUrl,
    activityProtocolVersion: config.activityProtocolVersion,
    auth: config.auth,
    providers: config.providers,
    ...(config.broker ? { broker: config.broker } : {}),
    billing: config.billing,
    compat: config.compat ?? { minRuntimeVersion: '0.1.0' },
    skill: {
      entry: config.skill.entry,
      index: skillIndex,
    },
    runtime: {
      ...(config.runtime?.execute ? { execute: config.runtime.execute } : {}),
      bundle,
    },
  };
}

function requiredString(source: Record<string, unknown> | null | undefined, key: string): string {
  const value = String(source?.[key] ?? '').trim();
  if (!value) throw new Error(`${key} is required`);
  return value;
}

function optionalString(value: unknown): string | undefined {
  const normalized = String(value ?? '').trim();
  return normalized || undefined;
}

function readPresentation(value: unknown): ServiceConfig['presentation'] {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('presentation must be an object');
  }
  const source = value as Record<string, unknown>;
  const highlights = source.highlights;
  if (!Array.isArray(highlights) || highlights.length !== 3) {
    throw new Error('presentation.highlights must contain exactly 3 items');
  }
  return {
    details: requiredPresentationString(source, 'details'),
    inputDescription: requiredPresentationString(source, 'inputDescription'),
    outputDescription: requiredPresentationString(source, 'outputDescription'),
    highlights: highlights.map((item, index) => {
      if (typeof item !== 'string' || !item.trim()) {
        throw new Error(`presentation.highlights[${index}] must be a non-empty string`);
      }
      return item.trim();
    }),
    featuredPrompt: requiredPresentationString(source, 'featuredPrompt'),
    examplePrompts: readExamplePrompts(source.examplePrompts),
  };
}

function readExamplePrompts(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length < 2 || value.length > 5) {
    throw new Error('presentation.examplePrompts must contain 2 to 5 items');
  }
  return value.map((item, index) => {
    if (typeof item !== 'string' || !item.trim()) {
      throw new Error(`presentation.examplePrompts[${index}] must be a non-empty string`);
    }
    return item.trim();
  });
}

function requiredPresentationString(source: Record<string, unknown>, key: string): string {
  const value = source[key];
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`presentation.${key} must be a non-empty string`);
  }
  return value.trim();
}

function validatePresentation(
  presentation: ServiceConfig['presentation'],
  errors: ManifestValidationError[],
): void {
  if (presentation === undefined) return;
  const raw = presentation as unknown;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    errors.push({
      field: 'presentation',
      message: 'presentation must be an object',
    });
    return;
  }
  const source = raw as Record<string, unknown>;
  for (const field of ['details', 'inputDescription', 'outputDescription', 'featuredPrompt'] as const) {
    if (typeof source[field] !== 'string' || !source[field].trim()) {
      errors.push({
        field: `presentation.${field}`,
        message: `presentation.${field} must be a non-empty string`,
      });
    }
  }
  const highlights = source.highlights;
  if (!Array.isArray(highlights) || highlights.length !== 3) {
    errors.push({
      field: 'presentation.highlights',
      message: 'presentation.highlights must contain exactly 3 items',
    });
    return;
  }
  highlights.forEach((highlight, index) => {
    if (typeof highlight !== 'string' || !highlight.trim()) {
      errors.push({
        field: `presentation.highlights[${index}]`,
        message: 'presentation highlights must be non-empty strings',
      });
    }
  });
  const examplePrompts = source.examplePrompts;
  if (examplePrompts !== undefined) {
    if (!Array.isArray(examplePrompts) || examplePrompts.length < 2 || examplePrompts.length > 5) {
      errors.push({
        field: 'presentation.examplePrompts',
        message: 'presentation.examplePrompts must contain 2 to 5 items',
      });
    } else {
      examplePrompts.forEach((prompt, index) => {
        if (typeof prompt !== 'string' || !prompt.trim()) {
          errors.push({
            field: `presentation.examplePrompts[${index}]`,
            message: 'example prompts must be non-empty strings',
          });
        }
      });
    }
  }
}
