import { describe, expect, it } from 'vitest';
import { builtinOperationDefinitions } from '@jovita-ai/provider-catalog';
import { builtinExternalPlan } from '../../src/operations/broker-operation-plan.js';
import type { BuiltinOperationDefinition } from '../../src/catalog/builtin-operation.catalog.js';

describe('reviewed external operation plans', () => {
  it('normalizes multipart media from its reviewed preset and preserves its limits', () => {
    const row = builtinOperationDefinitions.find(item => item.executionKind === 'http-multipart');
    expect(row).toBeDefined();
    const { profile, operation, credentialScope, requestLimitBytes } =
      builtinExternalPlan(row as BuiltinOperationDefinition);
    expect(profile.baseUrl).toBe('https://external.api.recraft.ai/v1/');
    expect(profile.timeoutMs).toBe(120_000);
    expect(credentialScope).toBe('pack');
    expect(requestLimitBytes).toBe(8_000_000);
    expect(operation).toMatchObject({ capabilityId: row?.capability, executionKind: 'http-multipart',
      method: 'POST', path: '/images/removeBackground', mediaPreset: 'transparent-png-v1',
      evidenceCostMicros: 10_000, maxRequestBytes: 8_000_000,
      outputSchema: { required: ['b64_json', 'media_type'] } });
  });
});
