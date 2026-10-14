import { readFileSync, writeFileSync } from 'node:fs';

const catalog = JSON.parse(readFileSync(new URL('../src/catalog.json', import.meta.url), 'utf8'));
const safe = value => /^[a-z][A-Za-z0-9]*$/.test(value);
const lines = ['/** Generated from the versioned catalog. Do not edit directly. */',
  "import type { BuiltinInput, BuiltinOutput } from './operation-types.js';",
  'export const builtinReferences = {'];
for (const provider of catalog.providers) {
  if (!safe(provider.id)) throw new Error(`Invalid provider SDK name: ${provider.id}`);
  lines.push(`  ${provider.id}: {`);
  for (const operation of provider.operations) {
    if (!safe(operation.method)) throw new Error(`Invalid operation SDK name: ${operation.method}`);
    lines.push(`    ${operation.method}: ${JSON.stringify(operation.reference)},`);
  }
  lines.push('  },');
}
lines.push('} as const;', '',
  'export type BuiltinReferences = typeof builtinReferences;',
  'export type BuiltinProviderClient = {',
  '  [P in keyof BuiltinReferences]: {',
  '    [M in keyof BuiltinReferences[P]]: (input: BuiltinInput<BuiltinReferences[P][M] & string>) => Promise<BuiltinOutput<BuiltinReferences[P][M] & string>>;',
  '  };',
  '};', '');
writeFileSync(new URL('../src/generated.ts', import.meta.url), lines.join('\n'));
