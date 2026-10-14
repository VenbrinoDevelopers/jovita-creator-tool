import { mapOpenRouterRequest as mapRequest } from '../../src/providers/openrouter/openrouter.mapper.js';
import { describe, expect, it } from 'vitest';
import { builtinOperationDefinitions } from '@jovita-ai/provider-catalog';
import { mapOpenRouterResult } from '../../src/providers/openrouter/openrouter.mapper.js';

const mapOpenRouterRequest = (capability: string, payload: Record<string, unknown>) => {
  const definition = builtinOperationDefinitions.find(item => item.capability === capability);
  return mapRequest(capability, payload, definition?.route as { method: 'GET' | 'POST'; path: string } | undefined);
};

describe('Image Studio OpenRouter contracts', () => {
  it('exposes brokered endpoint discovery', () => {
    const contract = builtinOperationDefinitions.find(item => item.capability === 'openrouter.images.model_endpoints.list');
    expect(contract).toMatchObject({ unit: 'result', maxCallsPerInvocation: 8 });
    expect(mapOpenRouterRequest('openrouter.images.model_endpoints.list', {
      model: 'bytedance-seed/seedream-5-0-pro',
    })).toEqual({
      route: { method: 'GET', path: 'images/models/bytedance-seed/seedream-5-0-pro/endpoints' },
      payload: {},
    });
  });

  it('rejects endpoint discovery path traversal', () => {
    expect(() => mapOpenRouterRequest('openrouter.images.model_endpoints.list', {
      model: '../models',
    })).toThrow('image model is invalid');
  });

  it('meters endpoint records and authoritative generation costs', () => {
    expect(mapOpenRouterResult(
      'openrouter.images.model_endpoints.list',
      { model: 'recraft/recraft-v4.1' },
      { id: 'recraft/recraft-v4.1', endpoints: [{ pricing: [] }] },
    )).toMatchObject({ providerCostMicros: 0, quantity: 1 });
    expect(mapOpenRouterResult(
      'openrouter.images.generate',
      { model: 'bytedance-seed/seedream-5-0-pro', n: 1 },
      { id: 'generation-1', data: [{}], usage: { cost: 0.045 } },
    )).toMatchObject({ providerRequestId: 'generation-1', providerCostMicros: 45_000, quantity: 1 });
    expect(mapOpenRouterResult(
      'openrouter.images.generate',
      { model: 'google/gemini-3.1-flash-lite-image', n: 1 },
      { id: 'generation-2', data: [{}], usage: { cost: 0.0336 } },
    )).toMatchObject({ providerCostMicros: 33_600, quantity: 1 });
  });
});
