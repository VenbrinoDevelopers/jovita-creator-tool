import { createHash } from 'node:crypto';

const FIELDS = ['capability', 'providerId', 'contractVersion', 'unit', 'maxCallsPerInvocation',
  'executionKind', 'route', 'maxRequestBytes', 'maxResponseBytes'] as const;

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => [key, canonical(item)]));
  return value;
}

export function builtinCatalogDigest(rows: readonly object[]): string {
  const contracts = rows.map(value => {
    const row = value as Record<string, unknown>;
    return Object.fromEntries(FIELDS.map(field => [field, row[field]]));
  })
    .sort((left, right) => String(left.capability).localeCompare(String(right.capability)));
  return createHash('sha256').update(JSON.stringify(canonical(contracts))).digest('hex');
}
