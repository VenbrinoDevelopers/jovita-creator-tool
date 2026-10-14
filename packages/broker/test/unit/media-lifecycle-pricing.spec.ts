import { describe, expect, it, vi } from 'vitest';
import { JovitaMediaLifecycle } from '../../src/providers/jovita-media/jovita-media.lifecycle.js';

describe('media lifecycle pricing evidence', () => {
  it('activates only operations backed by implemented server routes', () => {
    const adapter = new JovitaMediaLifecycle({} as never, {} as never);
    expect(adapter.activationRequirements({ capability: 'jovita.media.submit', packId: 'video-studio', operationId: 'generate-auto' }))
      .toMatchObject({ ready: true, credentialProviderIds: ['openrouter'] });
    expect(adapter.activationRequirements({ capability: 'jovita.media.submit', packId: 'video-studio', operationId: 'lip-sync-auto' }))
      .toMatchObject({ ready: true, credentialProviderIds: ['openrouter'] });
    expect(adapter.activationRequirements({ capability: 'jovita.media.submit', packId: 'voice-studio', operationId: 'unimplemented-auto' }))
      .toMatchObject({ ready: false });
    expect(adapter.activationRequirements({ capability: 'jovita.media.submit', packId: 'music-studio', operationId: 'generate-pro' }))
      .toMatchObject({ ready: true, credentialProviderIds: ['elevenlabs'], billingUnit: 'second' });
  });

  it('reserves both upload and edit seconds before submitting a song revision', async () => {
    const uploads = { resolveRuntimeAttachment: vi.fn(async () => ({ kind: 'audio', durationMs: 45_024 })) };
    const adapter = new JovitaMediaLifecycle({} as never, uploads as never);
    const quantity = await adapter.estimateQuantity({ capability: 'jovita.media.submit', ownerId: 'owner',
      packId: 'music-studio', operationId: 'replace-section-auto', pricingMode: 'per_unit',
      payload: { studio: 'music-studio', operation: 'replace-section', profile: 'auto', request: {
        schema_version: '1', prompt: 'More hopeful', source_audio: 'source-1',
        duration: 15, start_ms: 0, end_ms: 15000, section_name: 'Verse',
      } } });
    expect(quantity).toBe(61);
    expect(uploads.resolveRuntimeAttachment).toHaveBeenCalledWith('owner', 'source-1');
  });

  it('rejects an edit with unverified source duration before dispatch', async () => {
    const adapter = new JovitaMediaLifecycle({} as never,
      { resolveRuntimeAttachment: vi.fn(async () => ({ kind: 'audio' })) } as never);
    await expect(adapter.estimateQuantity({ capability: 'jovita.media.submit', ownerId: 'owner',
      packId: 'music-studio', operationId: 'replace-section-auto', pricingMode: 'per_unit',
      payload: { studio: 'music-studio', operation: 'replace-section', profile: 'auto', request: {
        schema_version: '1', prompt: 'More hopeful', source_audio: 'source-1',
        duration: 15, start_ms: 0, end_ms: 15000, section_name: 'Verse',
      } } })).rejects.toThrow('Source duration must be verified');
  });
});
