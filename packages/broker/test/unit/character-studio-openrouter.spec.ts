import { describe, expect, it } from 'vitest';
import { mapOpenRouterResult } from '../../src/providers/openrouter/openrouter.mapper.js';

describe('Character Studio OpenRouter image metering', () => {
  it.each([
    ['black-forest-labs/flux.2-klein-4b', 0.014, 14_000],
    ['black-forest-labs/flux.2-pro', 0.03, 30_000],
    ['google/gemini-3.1-flash-image', 0.067, 67_000],
    ['google/gemini-3-pro-image', 0.134, 134_000],
  ])('captures authoritative usage for %s', (model, cost, micros) => {
    expect(mapOpenRouterResult(
      'openrouter.images.generate',
      { model, n: 1, input_references: [{ type: 'image_url', image_url: { url: 'https://signed.example/reference.webp' } }] },
      { id: `generation-${model}`, data: [{}], usage: { cost } },
    )).toMatchObject({ providerCostMicros: micros, quantity: 1 });
  });

  it('captures measured reference and BYOK upstream cost rather than estimating it locally', () => {
    expect(mapOpenRouterResult(
      'openrouter.images.generate',
      { model: 'black-forest-labs/flux.2-pro', n: 1, input_references: [{}, {}, {}, {}] },
      {
        id: 'generation-byok',
        is_byok: true,
        data: [{}],
        usage: { cost: 0.001, cost_details: { upstream_inference_cost: 0.0347 } },
      },
    )).toMatchObject({ providerCostMicros: 35_700, quantity: 1 });
  });
});
