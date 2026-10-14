import catalog from './catalog.json' with { type: 'json' };
export { builtinReferences } from './generated.js';
export type { BuiltinProviderClient, BuiltinReferences } from './generated.js';
export type { BuiltinInput, BuiltinOutput, BuiltinTypeOverrides } from './operation-types.js';

export interface CatalogOperation {
  reference: string;
  provider: string;
  method: string;
  purpose: string;
  maxCallsPerInvocation: number;
  executionKind: string;
  contractVersion: 1;
  unit: 'request' | 'result' | 'token' | 'image' | 'byte' | 'second' | 'provider_credit';
  maxRequestBytes: number;
  maxResponseBytes: number;
  route?: Record<string, unknown>;
  legacyAliases?: string[];
  legacyProviderIds?: Record<string, string>;
}

export interface CatalogProvider {
  id: string;
  brokerProviderId: string;
  name: string;
  category: string;
  docsUrl: string;
  summary: string;
  baseUrl: string;
  authMethod: 'bearer' | 'header' | 'oauth' | 'service' | 'internal';
  timeoutMs: number;
  providerCostNote: string;
  operations: CatalogOperation[];
}

export interface VersionedProviderCatalog {
  schemaVersion: 1;
  revision: string;
  providers: CatalogProvider[];
}

export const providerCatalog: VersionedProviderCatalog = catalog as VersionedProviderCatalog;
/** The broker's reviewed built-in migration rows come from the public catalog. */
export const builtinOperationDefinitions = providerCatalog.providers.flatMap(provider =>
  provider.operations.flatMap(operation => {
    const base = { providerId: provider.brokerProviderId, contractVersion: operation.contractVersion,
      unit: operation.unit, maxCallsPerInvocation: operation.maxCallsPerInvocation,
      executionKind: operation.executionKind, maxRequestBytes: operation.maxRequestBytes,
      maxResponseBytes: operation.maxResponseBytes,
      ...(operation.route ? { route: operation.route } : {}) };
    return [{ capability: operation.reference, ...base },
      ...(operation.legacyAliases ?? []).map(alias => ({ capability: alias,
        ...base, providerId: operation.legacyProviderIds?.[alias] ?? base.providerId }))];
  }));
const operations = new Map(providerCatalog.providers.flatMap(provider =>
  provider.operations.map(operation => [operation.reference, operation] as const)));
for (const operation of [...operations.values()]) for (const alias of operation.legacyAliases ?? []) {
  if (operations.has(alias)) throw new Error(`Catalog alias collides with an operation: ${alias}`);
  operations.set(alias, operation);
}

export function findCatalogOperation(reference: string): CatalogOperation | undefined {
  return operations.get(reference);
}

export function resolveCatalogReference(reference: string): string | undefined {
  return operations.get(reference)?.reference;
}
