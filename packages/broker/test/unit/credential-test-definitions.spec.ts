import { afterEach, describe, expect, it, vi } from 'vitest';
import { readProviderAccountStatus, runCredentialTest } from '../../src/operations/credential-test.definitions.js';

describe('approved credential-test definitions', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('does not register a provider-specific Monid wallet probe', async () => {
    await expect(runCredentialTest('monid', { apiKey: 'key' })).rejects.toThrow('not registered');
    await expect(readProviderAccountStatus('monid', { apiKey: 'key' })).rejects.toThrow('not registered');
  });

  it.each([
    ['elevenlabs', 'https://api.elevenlabs.io/v1/user', 'xi-api-key'],
    ['recraft', 'https://external.api.recraft.ai/v1/users/me', 'authorization'],
  ])('uses the fixed %s host and configured authentication', async (provider, url, header) => {
    const fetch = vi.fn(async () => new Response('{}'));
    vi.stubGlobal('fetch', fetch);
    await runCredentialTest(provider, { apiKey: 'secret' });
    expect(fetch.mock.calls[0]?.[0]).toBe(url);
    expect(new Headers(fetch.mock.calls[0]?.[1]?.headers).has(header)).toBe(true);
  });
});
