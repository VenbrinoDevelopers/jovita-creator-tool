import { builtinOperationDefinitions } from '@jovita-ai/provider-catalog';
import { describe, expect, it, vi } from 'vitest';
import { BuiltinOperationEngine } from '../../src/operations/builtin-operation.engine.js';
import type { BuiltinProviderExecutor } from '../../src/operations/builtin-provider-executor.js';

describe('reviewed built-in catalog', () => {
  it('registers and dispatches every current built-in ID through its declared provider', async () => {
    const invoked: string[] = [];
    const executors = [...new Set(builtinOperationDefinitions.map(item => item.providerId))].map(providerId => ({
      providerId,
      credentialSource: 'none' as const,
      credentialFields: [],
      validateCredential: () => undefined,
      invoke: vi.fn(async (input: { capability: string }) => {
        invoked.push(input.capability);
        return { result: { capability: input.capability }, providerCostMicros: 0, quantity: 1 };
      }),
    })) as unknown as BuiltinProviderExecutor[];
    const engine = new BuiltinOperationEngine(executors, undefined,
      builtinOperationDefinitions as any);
    const IDs = builtinOperationDefinitions.map(item => item.capability);
    expect(new Set(IDs).size).toBe(IDs.length);
    expect(IDs.some(id => /^(monid|serper|google\.places)\./.test(id))).toBe(false);
    expect(engine.registeredCapabilities().sort()).toEqual([...IDs].sort());
    for (const capability of IDs) {
      await expect(engine.invoke({ environment: 'test', ownerId: 'owner', packId: 'tool',
        capability, payload: {} })).resolves.toMatchObject({ result: { capability } });
    }
    expect(invoked.sort()).toEqual([...IDs].sort());
  });
});
