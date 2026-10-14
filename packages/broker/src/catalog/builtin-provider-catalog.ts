import { providerCatalog } from '@jovita-ai/provider-catalog';

/** Broker metadata comes from the same reviewed catalog that generates SDK names. */
export const BUILTIN_PROVIDER_CATALOG = [
  ...providerCatalog.providers.map(provider => ({
    profileId: provider.brokerProviderId,
    name: provider.name,
    category: provider.category,
    summary: provider.summary,
    docsUrl: provider.docsUrl,
    baseUrl: provider.baseUrl,
    authMethod: provider.authMethod,
    timeoutMs: provider.timeoutMs,
    providerCostNote: provider.providerCostNote,
  })),
  { ...providerCatalog.providers.find(provider => provider.id === 'cloudflare')!,
    profileId: 'jovita-product-capture', name: 'Product Capture' },
];

export function builtinProviderBaseUrl(profileId: string): string {
  const profile = BUILTIN_PROVIDER_CATALOG.find(item => item.profileId === profileId);
  if (!profile?.baseUrl) throw new Error(`Built-in provider has no approved origin: ${profileId}`);
  return profile.baseUrl.replace(/\/$/, '');
}
