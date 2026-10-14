import { BadGatewayException, HttpException, NotImplementedException, UnprocessableEntityException } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MiniappCapabilityContract } from '../../src/cloud/saas-store/capabilities/capability-operation.types.js';
import { builtinOperationDefinitions as BUILTIN_OPERATION_SEED } from '@jovita-ai/provider-catalog';
import type { BuiltinProviderExecutor } from '../../src/operations/builtin-provider-executor.js';
import { BuiltinOperationEngine } from '../../src/operations/builtin-operation.engine.js';
import { OpenRouterModelEngine } from '../../src/providers/openrouter/openrouter-model.engine.js';

type TestExecutor = BuiltinProviderExecutor & { contracts: MiniappCapabilityContract[] };

function adapter(
  capabilities: readonly string[],
  result: unknown = { ok: true },
  providerId = 'provider',
): TestExecutor {
  return {
    providerId,
    credentialSource: 'admin',
    credentialFields: [{ key: 'apiKey', label: 'API key', type: 'secret', required: true }],
    contracts: capabilities.map((id) => ({
      id,
      contractVersion: 1 as const,
      unit: 'request' as const,
      maxCallsPerInvocation: 4,
    })),
    validateCredential: vi.fn(),
    invoke: vi.fn().mockResolvedValue({
      result,
      providerCostMicros: 0,
      quantity: 1,
    }),
  };
}

function engine(executors: readonly BuiltinProviderExecutor[]): BuiltinOperationEngine {
  const definitions = executors.flatMap(executor => {
    const published = BUILTIN_OPERATION_SEED.filter(item => item.providerId === executor.providerId);
    if (published.length) return published;
    return (executor as TestExecutor).contracts.map(contract => ({
    capability: contract.id,
    providerId: executor.providerId,
    contractVersion: contract.contractVersion,
    unit: contract.unit,
    maxCallsPerInvocation: contract.maxCallsPerInvocation,
    maxRequestBytes: BUILTIN_OPERATION_SEED.find(item => item.capability === contract.id)?.maxRequestBytes,
  }));
  });
  return new BuiltinOperationEngine(executors, undefined, definitions);
}

describe('BuiltinOperationEngine', () => {
  afterEach(() => {
    delete process.env.JOVITA_CAPABILITY_MAX_CONCURRENCY_PER_KEY;
    delete process.env.JOVITA_CAPABILITY_CIRCUIT_FAILURE_THRESHOLD;
    delete process.env.JOVITA_CAPABILITY_CIRCUIT_OPEN_MS;
  });

  it('dispatches any registered capability without knowing a mini-app id', async () => {
    const reusable = adapter(['provider.search', 'provider.lookup'], { source: 'adapter' });
    const registry = engine([reusable]);

    const result = await registry.invoke({
      environment: 'development',
      ownerId: 'owner-1',
      packId: 'a-future-miniapp',
      capability: 'provider.search',
      payload: { query: 'coffee' },
    });

    expect(result.result).toEqual({ source: 'adapter' });
    expect(reusable.invoke).toHaveBeenCalledWith(expect.objectContaining({
      packId: 'a-future-miniapp',
      capability: 'provider.search',
    }));
    expect(registry.definitions()).toEqual([
      {
        capability: 'provider.lookup',
        providerId: 'provider',
        credentialSource: 'admin',
        credentialScope: 'pack',
        credentialFields: [{ key: 'apiKey', label: 'API key', type: 'secret', required: true }],
        contractVersion: 1,
        unit: 'request',
        maxCallsPerInvocation: 4,
      },
      {
        capability: 'provider.search',
        providerId: 'provider',
        credentialSource: 'admin',
        credentialScope: 'pack',
        credentialFields: [{ key: 'apiKey', label: 'API key', type: 'secret', required: true }],
        contractVersion: 1,
        unit: 'request',
        maxCallsPerInvocation: 4,
      },
    ]);
  });

  it('rejects duplicate capability ownership during startup', () => {
    const first = adapter(['provider.search']);
    const second = adapter(['provider.search'], { ok: true }, 'other-provider');
    expect(() => engine([
      first,
      second,
    ])).toThrow('Duplicate built-in operation: provider.search');
  });

  it('rejects malformed capability contracts during startup', () => {
    const malformed = adapter(['Provider Search']);
    expect(() => engine([malformed]))
      .toThrow('Invalid mini-app capability id: Provider Search');

    const invalidLimit = adapter(['provider.search']);
    invalidLimit.contracts = [{
      ...invalidLimit.contracts[0]!,
      maxCallsPerInvocation: 0,
    }];
    expect(() => engine([invalidLimit]))
      .toThrow('Invalid capability call limit for provider.search');
  });

  it('rejects undeclared provider protocols instead of becoming an HTTP proxy', async () => {
    const registry = engine([]);
    await expect(registry.invoke({
      environment: 'development',
      ownerId: 'owner-1',
      packId: 'future-app',
      capability: 'arbitrary.http.request',
      payload: { url: 'https://example.com' },
    })).rejects.toBeInstanceOf(NotImplementedException);
    expect(() => registry.validateCredential('unregistered-provider', { apiKey: 'secret' }))
      .toThrow('Provider credential executor is not registered');
  });

  it('exposes only the OpenRouter API key as Admin-managed credential input', () => {
    const openRouter = new OpenRouterModelEngine({} as never);

    expect(openRouter.credentialFields).toEqual([
      { key: 'apiKey', label: 'API key', type: 'secret', required: true },
    ]);
    expect(BUILTIN_OPERATION_SEED.find(item => item.capability === 'openrouter.images.generate')?.maxCallsPerInvocation)
      .toBe(32);
    expect(() => openRouter.validateCredential({ apiKey: 'test-key' })).not.toThrow();
    expect(() => openRouter.validateCredential({})).toThrow('OpenRouter apiKey is required');
  });

  it('meters the OpenRouter quantity requested by the mini-app without an adapter-specific ceiling', () => {
    const openRouter = new OpenRouterModelEngine({} as never);
    const registry = engine([openRouter]);

    expect(registry.estimateQuantity('openrouter.images.generate', { n: 10 })).toBe(10);
    expect(registry.estimateQuantity('openrouter.chat.generate', { max_tokens: 65_536 })).toBeGreaterThan(65_536);
  });

  it('registers Recraft background removal as a shared image capability', () => {
    const definition = BUILTIN_OPERATION_SEED.find(item => item.capability === 'recraft.images.remove_background')!;
    const registry = new BuiltinOperationEngine([], undefined, [definition] as never);

    expect(registry.definition('recraft.images.remove_background')).toMatchObject({
      providerId: 'recraft',
      unit: 'image',
      maxCallsPerInvocation: 32,
    });
    expect(registry.estimateQuantity('recraft.images.remove_background', {})).toBe(1);
  });

  it('reserves bounded seconds for transcription', () => {
    const openRouter = new OpenRouterModelEngine({} as never);
    const registry = engine([openRouter]);

    expect(registry.estimateQuantity('openrouter.audio.transcribe', { max_duration_seconds: 50 })).toBe(50);
    expect(() => registry.estimateQuantity('openrouter.audio.transcribe', { max_duration_seconds: 601 })).toThrow();
  });

  it('allows only the declared image capability to use the bounded large-request lane', async () => {
    const ordinaryAdapter = adapter(['provider.search'], { ok: true }, 'ordinary-provider');
    const recraftDefinition = BUILTIN_OPERATION_SEED.find(item => item.capability === 'recraft.images.remove_background')!;
    const ordinaryDefinition = { capability: 'provider.search', providerId: 'ordinary-provider',
      contractVersion: 1, unit: 'request', maxCallsPerInvocation: 4, maxRequestBytes: 524288 };
    const broker = { invokeBuiltin: vi.fn(async () => ({ result: { ok: true }, providerCostMicros: 10_000, quantity: 1 })) };
    const registry = new BuiltinOperationEngine([ordinaryAdapter], undefined,
      [recraftDefinition, ordinaryDefinition] as never, undefined, broker as never);
    const payload = { image: `data:image/webp;base64,${'a'.repeat(600_000)}` };

    await expect(registry.invoke({
      environment: 'development', ownerId: 'owner-1', packId: 'image-studio',
      capability: 'recraft.images.remove_background', payload,
    })).resolves.toBeTruthy();
    await expect(registry.invoke({
      environment: 'development', ownerId: 'owner-1', packId: 'other-pack',
      capability: 'provider.search', payload,
    })).rejects.toThrow('Capability request');
  });

  it('reserves provider credits from explicit bounded capability metadata', () => {
    const metered = adapter(['provider.enrich']);
    metered.contracts = [{ ...metered.contracts[0]!, unit: 'provider_credit' }];
    const registry = engine([metered]);

    expect(registry.estimateQuantity('provider.enrich', { max_provider_credits: 500 })).toBe(500);
    expect(() => registry.estimateQuantity('provider.enrich', { max_provider_credits: 0 })).toThrow();
    expect(() => registry.estimateQuantity('provider.enrich', { max_provider_credits: 5001 })).toThrow();
  });

  it('enforces concurrency per mini-app capability without coupling different packs', async () => {
    process.env.JOVITA_CAPABILITY_MAX_CONCURRENCY_PER_KEY = '1';
    let release!: () => void;
    const pending = new Promise<void>((resolvePromise) => { release = resolvePromise; });
    const slow = adapter(['provider.search']);
    slow.invoke = vi.fn(async () => {
      await pending;
      return { result: { ok: true }, providerCostMicros: 0, quantity: 1 };
    });
    const registry = engine([slow]);
    const input = {
      environment: 'development',
      ownerId: 'owner-1',
      packId: 'pack-1',
      capability: 'provider.search',
      payload: {},
    };
    const first = registry.invoke(input);
    await expect(registry.invoke(input)).rejects.toThrow('Provider concurrency limit reached');
    const otherPack = registry.invoke({ ...input, packId: 'pack-2' });
    release();
    await expect(first).resolves.toBeTruthy();
    await expect(otherPack).resolves.toBeTruthy();
  });

  it('rejects invalid authoritative measurements returned by an adapter', async () => {
    const invalid = adapter(['provider.search']);
    invalid.invoke = vi.fn().mockResolvedValue({
      result: { ok: true },
      providerCostMicros: -1,
      quantity: 1,
    });
    const registry = engine([invalid]);

    await expect(registry.invoke({
      environment: 'development',
      ownerId: 'owner-1',
      packId: 'pack-1',
      capability: 'provider.search',
      payload: {},
    })).rejects.toThrow('invalid cost measurement');
  });

  it('does not open the provider circuit for explicit request rejections', async () => {
    process.env.JOVITA_CAPABILITY_CIRCUIT_FAILURE_THRESHOLD = '1';
    const provider = adapter(['provider.generate']);
    provider.invoke = vi.fn()
      .mockRejectedValueOnce(new UnprocessableEntityException({
        code: 'IMAGE_GENERATION_RETRYABLE',
        message: 'The image model could not produce an image for this attempt.',
      }))
      .mockResolvedValueOnce({ result: { ok: true }, providerCostMicros: 0, quantity: 1 });
    const registry = engine([provider]);
    const input = {
      environment: 'development', ownerId: 'owner-1', packId: 'character-studio',
      capability: 'provider.generate', payload: {},
    };

    await expect(registry.invoke(input)).rejects.toBeInstanceOf(UnprocessableEntityException);
    await expect(registry.invoke(input)).resolves.toMatchObject({ result: { ok: true } });
    expect(provider.invoke).toHaveBeenCalledTimes(2);
  });

  it('still opens the provider circuit for genuine upstream failures', async () => {
    process.env.JOVITA_CAPABILITY_CIRCUIT_FAILURE_THRESHOLD = '1';
    process.env.JOVITA_CAPABILITY_CIRCUIT_OPEN_MS = '1000';
    const provider = adapter(['provider.generate']);
    provider.invoke = vi.fn().mockRejectedValue(new BadGatewayException('upstream unavailable'));
    const registry = engine([provider]);
    const input = {
      environment: 'development', ownerId: 'owner-1', packId: 'character-studio',
      capability: 'provider.generate', payload: {},
    };

    await expect(registry.invoke(input)).rejects.toThrow('upstream unavailable');
    await expect(registry.invoke(input)).rejects.toThrow('Provider circuit is temporarily open');
    expect(provider.invoke).toHaveBeenCalledTimes(1);
  });

  it.each(['PROVIDER_PRICE_CHANGED', 'PROVIDER_SCHEMA_CHANGED'])(
    'does not open the provider circuit for deterministic %s policy failures',
    async (code) => {
      process.env.JOVITA_CAPABILITY_CIRCUIT_FAILURE_THRESHOLD = '1';
      const provider = adapter(['provider.generate']);
      provider.invoke = vi.fn()
        .mockRejectedValueOnce(new BadGatewayException({ code, message: 'Pinned provider policy changed' }))
        .mockResolvedValueOnce({ result: { ok: true }, providerCostMicros: 0, quantity: 1 });
      const registry = engine([provider]);
      const input = {
        environment: 'development', ownerId: 'owner-1', packId: 'prospector',
        capability: 'provider.generate', payload: {},
      };

      await expect(registry.invoke(input)).rejects.toMatchObject({ response: { code } });
      await expect(registry.invoke(input)).resolves.toMatchObject({ result: { ok: true } });
      expect(provider.invoke).toHaveBeenCalledTimes(2);
    },
  );

  it('counts provider rate limits as circuit failures', async () => {
    process.env.JOVITA_CAPABILITY_CIRCUIT_FAILURE_THRESHOLD = '1';
    process.env.JOVITA_CAPABILITY_CIRCUIT_OPEN_MS = '1000';
    const provider = adapter(['provider.generate']);
    provider.invoke = vi.fn().mockRejectedValue(new HttpException('rate limited', 429));
    const registry = engine([provider]);
    const input = {
      environment: 'development', ownerId: 'owner-1', packId: 'character-studio',
      capability: 'provider.generate', payload: {},
    };

    await expect(registry.invoke(input)).rejects.toMatchObject({ status: 429 });
    await expect(registry.invoke(input)).rejects.toThrow('Provider circuit is temporarily open');
    expect(provider.invoke).toHaveBeenCalledTimes(1);
  });

  it('counts provider credential and account failures without treating them as request rejections', async () => {
    process.env.JOVITA_CAPABILITY_CIRCUIT_FAILURE_THRESHOLD = '1';
    process.env.JOVITA_CAPABILITY_CIRCUIT_OPEN_MS = '1000';
    const provider = adapter(['provider.generate']);
    provider.invoke = vi.fn().mockRejectedValue(new HttpException({
      code: 'PROVIDER_NOT_CONFIGURED',
      message: 'Provider credentials are invalid.',
    }, 424));
    const registry = engine([provider]);
    const input = {
      environment: 'development', ownerId: 'owner-1', packId: 'character-studio',
      capability: 'provider.generate', payload: {},
    };

    await expect(registry.invoke(input)).rejects.toMatchObject({ status: 424 });
    await expect(registry.invoke(input)).rejects.toThrow('Provider circuit is temporarily open');
    expect(provider.invoke).toHaveBeenCalledTimes(1);
  });

});
