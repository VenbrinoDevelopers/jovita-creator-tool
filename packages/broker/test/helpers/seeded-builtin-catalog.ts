import { builtinOperationDefinitions } from '@jovita-ai/provider-catalog';
import { mapOpenRouterRequest as mapRequest } from '../../src/providers/openrouter/openrouter.mapper.js';

/** Reviewed catalog fixture. Production loads these rows from MongoDB. */
export const seededBuiltinCatalog = {
  all: () => builtinOperationDefinitions,
  find: (capability: string) => builtinOperationDefinitions.find(item => item.capability === capability),
  forProvider: (providerId: string) => builtinOperationDefinitions.filter(item => item.providerId === providerId),
};

export function mapOpenRouterRequest(capability: string, payload: Record<string, unknown>) {
  const definition = seededBuiltinCatalog.find(capability);
  return mapRequest(capability, payload,
    definition?.route as { method: 'GET' | 'POST'; path: string } | undefined);
}
