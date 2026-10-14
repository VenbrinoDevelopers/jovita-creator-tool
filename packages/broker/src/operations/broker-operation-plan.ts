import type { BrokerOperation } from '../catalog/broker-catalog.schema.js';
import type { BrokerProviderProfile } from '../catalog/broker-catalog.schema.js';
import type { BuiltinOperationDefinition } from '../catalog/builtin-operation.catalog.js';
import { BUILTIN_PROVIDER_CATALOG } from '../catalog/builtin-provider-catalog.js';

/** The execution contract shared by creator records and reviewed built-in records. */
export type RuntimeOperationPlan = Pick<BrokerOperation, 'capabilityId' | 'executionKind' | 'method' | 'path'
  | 'queryFields' | 'inputSchema' | 'outputSchema' | 'maxRequestBytes' | 'maxResponseBytes'
  | 'emptyResultIsNoResult' | 'poll' | 'mediaPreset'
  | 'requestMapping' | 'responseField' | 'artifact'>
  & { evidenceCostMicros?: number };

/** Normalize reviewed built-in records into the same plan used by creator operations. */
export function builtinExternalPlan(definition: BuiltinOperationDefinition): {
  profile: BrokerProviderProfile;
  operation: RuntimeOperationPlan;
  credentialScope: 'environment' | 'pack';
  requestLimitBytes: number;
} {
  const reviewed = BUILTIN_PROVIDER_CATALOG.find(item => item.profileId === definition.providerId);
  if (!reviewed?.baseUrl || !['bearer', 'header'].includes(reviewed.authMethod)) {
    throw new Error(`Built-in provider has no approved external profile: ${definition.providerId}`);
  }
  if (reviewed.authMethod === 'header' && (!('authHeader' in reviewed)
    || typeof reviewed.authHeader !== 'string' || !reviewed.authHeader)) {
    throw new Error(`Built-in provider has no authentication header: ${definition.providerId}`);
  }
  const route = definition.route ?? {};
  const baseUrl = String(route.baseUrl ?? reviewed.baseUrl);
  if (new URL(baseUrl).origin !== new URL(reviewed.baseUrl).origin) {
    throw new Error(`Built-in operation changed its approved host: ${definition.capability}`);
  }
  const credentialScope = route.credentialScope;
  if (credentialScope !== 'environment' && credentialScope !== 'pack') {
    throw new Error(`Built-in operation has no credential scope: ${definition.capability}`);
  }
  const requestLimitBytes = Number(route.requestLimitBytes ?? definition.maxRequestBytes);
  const common = {
    capabilityId: definition.capability, queryFields: [],
    inputSchema: { type: 'object' }, maxRequestBytes: requestLimitBytes,
    maxResponseBytes: definition.maxResponseBytes, emptyResultIsNoResult: false,
  };
  let operation: RuntimeOperationPlan;
  if (definition.executionKind === 'http-multipart') {
    if (route.mediaPreset !== 'transparent-png-v1') {
      throw new Error(`Built-in multipart operation has no reviewed media preset: ${definition.capability}`);
    }
    operation = { ...common, executionKind: 'http-multipart', method: String(route.method),
      path: String(route.path), mediaPreset: route.mediaPreset,
      outputSchema: { type: 'object', properties: { b64_json: { type: 'string' },
        media_type: { const: 'image/png' } }, required: ['b64_json', 'media_type'],
        additionalProperties: false }, evidenceCostMicros: Number(route.evidenceCostMicros ?? 0) };
  } else {
    throw new Error(`Built-in operation does not use the shared external engine: ${definition.capability}`);
  }
  return { profile: { ...reviewed, baseUrl } as unknown as BrokerProviderProfile,
    operation, credentialScope, requestLimitBytes };
}
