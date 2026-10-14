import { curatedVoices } from './media-route-policy.js';
import { OpenRouterMediaClient } from './openrouter-media.client.js';
import { PRESET_VOICES, SPEECH_ROUTE_MODELS } from './media-route-policy.js';
import type { MiniappProviderCredentialService } from '../../saas-store/miniapp-provider-credential.service.js';

export type ApprovedVoice = { id: string; locale: string; accent: string; preview_url?: string; quality_reviewed?: boolean; rights_confirmed?: boolean };

function approved(config: Record<string, unknown>): ApprovedVoice[] {
  if (!Array.isArray(config.approvedVoices)) return [];
  return config.approvedVoices.filter((row): row is ApprovedVoice => Boolean(row && typeof row === 'object'
    && typeof row.id === 'string' && typeof row.locale === 'string' && typeof row.accent === 'string'
    && row.quality_reviewed === true && row.rights_confirmed === true));
}

function hasTariff(config: Record<string, unknown>): boolean {
  return typeof config.tariffVersion === 'string' && config.tariffVersion.trim().length > 0
    && Number.isSafeInteger(config.usdMicrosPerCharacter) && Number(config.usdMicrosPerCharacter) > 0
    && Number(config.usdMicrosPerCharacter) <= 100_000;
}

export async function qualifiedVoiceCatalog(credentials: MiniappProviderCredentialService | undefined, environment: string): Promise<Array<Record<string, unknown>>> {
  const voices: Array<Record<string, unknown>> = [];
  if (!credentials) return voices;
  if (await credentials.isReady(environment, 'voice-studio', 'openrouter')) {
    try {
      const config = await credentials.resolve(environment, 'voice-studio', 'openrouter');
      const live = await new OpenRouterMediaClient(String(config.apiKey)).discover('speech');
      for (const row of curatedVoices()) {
        const preset = PRESET_VOICES[String(row.id) as keyof typeof PRESET_VOICES];
        const profile = preset.profiles[0] as 'fast' | 'auto' | 'pro';
        const model = live.find(item => item.id === SPEECH_ROUTE_MODELS[profile]);
        if (model && (!Array.isArray(model.supported_voices) || model.supported_voices.includes(preset.providerId))) voices.push(row);
      }
    } catch { /* Do not advertise an unavailable route. */ }
  }
  if (await credentials.isReady(environment, 'voice-studio', 'elevenlabs')) {
    try {
      const config = await credentials.resolve(environment, 'voice-studio', 'elevenlabs');
      if (!hasTariff(config)) return voices;
      const configured = approved(config).filter(row => /^[a-zA-Z0-9]{20}$/.test(row.id));
      if (!configured.length) return voices;
      const params = new URLSearchParams({ page_size: '100' });
      for (const row of configured) params.append('voice_ids', row.id);
      const response = await fetch(`https://api.elevenlabs.io/v2/voices?${params}`, {
        headers: { 'xi-api-key': String(config.apiKey) }, signal: AbortSignal.timeout(20_000),
      });
      if (response.ok) {
        const body = await response.json() as { voices?: Array<{ voice_id?: string; preview_url?: string }> };
        const live = new Map((body.voices ?? []).map(row => [row.voice_id, row]));
        for (const row of configured) {
          const found = live.get(row.id);
          if (!found) continue;
          const preview = typeof found.preview_url === 'string' && found.preview_url.startsWith('https://') ? found.preview_url : undefined;
          voices.push({ id: `eleven:${row.id}`, languages: [row.locale], locale: row.locale,
            accent: row.accent, profiles: ['auto'], provider: 'elevenlabs', qualified: true,
            preview: preview ? { available: true, url: preview } : { available: false, reason: 'Ask the agent to make a short preview' } });
        }
      }
    } catch { /* A stale or unreachable provider is not advertised. */ }
  }
  return voices;
}

export async function assertQualifiedVoice(credentials: MiniappProviderCredentialService | undefined, environment: string, id: string, locale?: string): Promise<void> {
  const catalog = await qualifiedVoiceCatalog(credentials, environment);
  if (!catalog.some(row => row.id === id && (!locale || String(row.locale).toLowerCase() === locale.toLowerCase()))) {
    throw new Error(locale ? `No verified voice is available for ${locale}` : 'Selected voice is not currently qualified');
  }
}
