export interface ProviderTariffSnapshot {
  provider: 'elevenlabs';
  version: string;
  unit: 'second';
  usdMicrosPerUnit: number;
}

// ElevenAPI lists Eleven Music at USD 0.15/minute. Keep the source rate in a
// versioned server fixture so accepted jobs retain the tariff they were quoted
// under instead of depending on mutable process environment variables.
const ELEVEN_MUSIC_USD_MICROS_PER_SECOND = 2_500;
const ELEVENLABS_TARIFF_VERSION = 'elevenlabs-api-2026-09-07';

export function elevenLabsTariffForOperation(operationId: string): ProviderTariffSnapshot {
  const operation = operationId.split('-').slice(0, -1).join('-') || operationId;
  const multiplier = operation === 'separate-stems' && operationId.includes('2-stems') ? 0.5 : 1;
  if (!['generate', 'upload', 'extend', 'remix', 'replace-section', 'insert-section', 'separate-stems', 'score-video'].includes(operation)) {
    throw new Error(`No qualified ElevenLabs tariff for ${operation}`);
  }
  return {
    provider: 'elevenlabs',
    version: ELEVENLABS_TARIFF_VERSION,
    unit: 'second',
    usdMicrosPerUnit: Math.ceil(ELEVEN_MUSIC_USD_MICROS_PER_SECOND * multiplier),
  };
}

export function readElevenLabsTariff(
  pricingSnapshot: Record<string, unknown>,
  operationId: string,
): ProviderTariffSnapshot {
  const stored = pricingSnapshot.providerTariff;
  if (stored && typeof stored === 'object' && !Array.isArray(stored)) {
    const tariff = stored as Record<string, unknown>;
    if (tariff.provider !== 'elevenlabs' || tariff.unit !== 'second'
      || typeof tariff.version !== 'string' || !tariff.version.trim()
      || !Number.isSafeInteger(tariff.usdMicrosPerUnit) || Number(tariff.usdMicrosPerUnit) <= 0) {
      throw new Error('Invalid stored ElevenLabs tariff snapshot');
    }
    return tariff as unknown as ProviderTariffSnapshot;
  }
  // Additive migration path for jobs accepted before tariff snapshots were
  // embedded. The immutable versioned fixture makes their recovery deterministic.
  return elevenLabsTariffForOperation(operationId);
}
