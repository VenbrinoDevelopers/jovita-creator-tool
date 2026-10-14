import { describe, expect, it, vi } from 'vitest';
import { PlatformActionRegistry } from '../../src/operations/platform-action.registry.js';

const input = { environment: 'development', ownerId: 'owner', packId: 'tool',
  payload: { voice_id: 'voice', name: 'New name', confirm: 'delete',
    reference_asset_ids: ['asset'], consent_type: 'self', consent_confirmed: true, consent_text: 'I consent' } };

describe('Jovita-owned resource action registry', () => {
  it('routes five published voice-library IDs to owner-scoped service methods', async () => {
    const library = { list: vi.fn(async () => [{ id: 'voice' }]), show: vi.fn(async () => ({ id: 'voice' })),
      rename: vi.fn(async () => ({ id: 'voice' })), delete: vi.fn(async () => ({ deleted: true })),
      save: vi.fn(async () => ({ id: 'new' })) };
    const registry = new PlatformActionRegistry(library as never);
    for (const action of ['list', 'show', 'rename', 'delete', 'save']) {
      const capability = `jovita.voice-library.${action}`;
      expect(registry.has(capability)).toBe(true);
      await expect(registry.invoke({ ...input, capability })).resolves.toMatchObject({
        providerCostMicros: 0, quantity: 1,
      });
    }
    expect(library.show).toHaveBeenCalledWith('owner', 'voice');
    expect(library.rename).toHaveBeenCalledWith('owner', 'voice', 'New name');
    expect(library.delete).toHaveBeenCalledWith('owner', 'voice', 'delete');
    expect(library.save).toHaveBeenCalledWith('owner', expect.objectContaining({
      consentConfirmed: true, referenceAssetIds: ['asset'],
    }));
  });

  it('rejects unknown actions and invalid consent before creating owned resources', async () => {
    const library = { save: vi.fn() };
    const registry = new PlatformActionRegistry(library as never);
    await expect(registry.invoke({ ...input, capability: 'jovita.voice-library.unknown' }))
      .rejects.toThrow('Unknown platform action');
    await expect(registry.invoke({ ...input, capability: 'jovita.voice-library.save',
      payload: { ...input.payload, consent_type: 'other' } })).rejects.toThrow('consent type');
    expect(library.save).not.toHaveBeenCalled();
  });
});
