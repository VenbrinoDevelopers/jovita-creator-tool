import sharp from 'sharp';
import { describe, expect, it, vi } from 'vitest';
import { extractMediaResult, prepareMediaRequest } from '../../src/operations/media-presets.js';
import { BrokerCatalogService } from '../../src/catalog/broker-catalog.service.js';
import { builtinOperationDefinitions } from '@jovita-ai/provider-catalog';
import type { BuiltinOperationDefinition } from '../../src/catalog/builtin-operation.catalog.js';

const preset = 'transparent-png-v1';

describe('reviewed transparent PNG media preset', () => {
  it('maps a bounded input image into multipart fields', async () => {
    const bytes = await sharp({ create: { width: 256, height: 256, channels: 4,
      background: { r: 10, g: 20, b: 30, alpha: 0.5 } } }).png().toBuffer();
    const body = await prepareMediaRequest(preset, { image: `data:image/png;base64,${bytes.toString('base64')}` });
    expect(body.response_format).toBe('b64_json');
    expect(body.file).toMatchObject({ filename: 'source.png', contentType: 'image/png' });
    expect(body.file).toHaveProperty('dataBase64', bytes.toString('base64'));
  });

  it('rejects malformed and undersized images before provider dispatch', async () => {
    await expect(prepareMediaRequest(preset, { image: 'data:image/png;base64,Zm9v' }))
      .rejects.toThrow('malformed');
    const tiny = await sharp({ create: { width: 16, height: 16, channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 1 } } }).png().toBuffer();
    await expect(prepareMediaRequest(preset, { image: `data:image/png;base64,${tiny.toString('base64')}` }))
      .rejects.toThrow('256');
  });

  it('extracts an actual transparent PNG and rejects opaque output', async () => {
    const transparent = await sharp({ create: { width: 256, height: 256, channels: 4,
      background: { r: 1, g: 2, b: 3, alpha: 0 } } }).png().toBuffer();
    await expect(extractMediaResult(preset, { image: { b64_json: transparent.toString('base64') } }))
      .resolves.toEqual({ b64_json: transparent.toString('base64'), media_type: 'image/png' });
    const opaque = await sharp({ create: { width: 256, height: 256, channels: 4,
      background: { r: 1, g: 2, b: 3, alpha: 1 } } }).png().toBuffer();
    await expect(extractMediaResult(preset, { b64_json: opaque.toString('base64') }))
      .rejects.toThrow('transparency');
  });

  it('preserves the published result shape, provider request ID and cost evidence', async () => {
    const executions = { create: vi.fn(async () => ({})), updateOne: vi.fn(async () => ({ modifiedCount: 1 })) };
    const service = new BrokerCatalogService({} as never, {} as never, {} as never, {} as never,
      executions as never, { encrypt: (value: string) => value, decrypt: (value: string) => value } as never,
      { resolve: vi.fn(async () => ({ apiKey: 'key' })) } as never);
    vi.spyOn((service as any).transport, 'providerRequest').mockResolvedValue({
      __brokerResult: { b64_json: 'cG5n', media_type: 'image/png' }, __brokerRequestId: 'image-123',
    });
    const result = await service.invokeBuiltin({ environment: 'development', ownerId: 'buyer',
      packId: 'image-studio', capability: 'recraft.images.remove_background',
      invocationId: 'inv', callId: 'call', payload: { image: 'data:image/png;base64,cG5n' } },
    builtinOperationDefinitions.find(row => row.capability === 'recraft.images.remove_background')! as BuiltinOperationDefinition);
    expect(result).toEqual({ result: { b64_json: 'cG5n', media_type: 'image/png' },
      providerRequestId: 'image-123', providerCostMicros: 10_000, quantity: 1 });
  });
});
