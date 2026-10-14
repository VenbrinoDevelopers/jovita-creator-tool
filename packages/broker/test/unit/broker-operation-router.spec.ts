import { describe, expect, it, vi } from 'vitest';
import { BrokerOperationRouter } from '../../src/operations/broker-operation.router.js';

describe('broker operation router', () => {
  it('resolves published and creator operations through the same entrypoint', async () => {
    const builtins = {
      has: vi.fn().mockImplementation((id: string) => id === 'serper.maps.search'),
      definitions: vi.fn().mockReturnValue([{ capability: 'serper.maps.search' }]),
      invoke: vi.fn().mockResolvedValue({ result: { places: [] }, providerCostMicros: 0, quantity: 1 }),
      estimateQuantityForCall: vi.fn().mockResolvedValue(20),
      activationRequirements: vi.fn().mockReturnValue(null),
    };
    const catalog = {
      definitions: vi.fn().mockResolvedValue([{ capability: 'broker.tool.search.query.v1' }]),
      invoke: vi.fn().mockResolvedValue({ result: { matches: [1] }, providerCostMicros: 0, quantity: 1 }),
      activationRequirements: vi.fn().mockResolvedValue({ ready: true }),
    };
    const router = new BrokerOperationRouter(builtins as never, catalog as never);
    expect((await router.definitions()).map(item => item.capability)).toEqual([
      'serper.maps.search', 'broker.tool.search.query.v1',
    ]);
    const base = { environment: 'test', ownerId: 'buyer', packId: 'tool', payload: {} };
    await router.invoke({ ...base, capability: 'serper.maps.search' });
    await router.invoke({ ...base, capability: 'broker.tool.search.query.v1' });
    expect(builtins.invoke).toHaveBeenCalledOnce();
    expect(catalog.invoke).toHaveBeenCalledOnce();
    await expect(router.estimate({ ...base, operationId: 'search', pricingMode: 'per_unit',
      capability: 'serper.maps.search' })).resolves.toBe(20);
    await expect(router.estimate({ ...base, operationId: 'search', pricingMode: 'fixed_success',
      capability: 'broker.tool.search.query.v1' })).resolves.toBe(1);
    await expect(router.activationRequirements('broker.tool.search.query.v1', 'tool', 'search'))
      .resolves.toEqual({ ready: true });
  });

  it('rejects an undeclared operation without dispatching to a provider', async () => {
    const builtins = { has: vi.fn().mockReturnValue(false), invoke: vi.fn() };
    const catalog = { invoke: vi.fn() };
    const router = new BrokerOperationRouter(builtins as never, catalog as never);
    expect(() => router.invoke({ environment: 'test', ownerId: 'buyer', packId: 'tool',
      capability: 'random.provider.call', payload: {} })).toThrow('Broker operation is not registered');
    expect(builtins.invoke).not.toHaveBeenCalled();
    expect(catalog.invoke).not.toHaveBeenCalled();
  });
});
