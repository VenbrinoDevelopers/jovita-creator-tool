import { builtinProviderBaseUrl } from '../../catalog/builtin-provider-catalog.js';

export const OPENROUTER_BASE_URL = builtinProviderBaseUrl('openrouter');

/** Worker-only media route. Published broker routes are loaded from MongoDB. */
export const OPENROUTER_VIDEO_GENERATE_ROUTE = { method: 'POST', path: 'videos' } as const;
