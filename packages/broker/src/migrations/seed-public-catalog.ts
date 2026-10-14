import { createConnection } from 'mongoose';
import { builtinOperationDefinitions } from '@jovita-ai/provider-catalog';
import { builtinCatalogDigest } from '../catalog/builtin-catalog-digest.js';

/** Explicit migration: preserve the old broker's collection until the cutover is verified. */
async function main(): Promise<void> {
  const connection = await createConnection(process.env.DATABASE_URL ?? 'mongodb://127.0.0.1:27017',
    { dbName: process.env.DATABASE_NAME ?? 'jovita_broker' }).asPromise();
  try {
    const operations = connection.collection('broker_builtin_operations_public');
    const revisions = connection.collection('broker_catalog_revisions');
    const expected = builtinCatalogDigest(builtinOperationDefinitions);
    const existing = await operations.find({}).toArray();
    const approved = new Map(builtinOperationDefinitions.map(item => [item.capability, item]));
    if (existing.some(row => !approved.has(String(row.capability))
      || builtinCatalogDigest([row]) !== builtinCatalogDigest([approved.get(String(row.capability))!]))) {
      throw new Error('Public built-in catalog differs from its approved migration; resolve versions before seeding');
    }
    const present = new Set(existing.map(row => String(row.capability)));
    const missing = builtinOperationDefinitions.filter(item => !present.has(item.capability));
    if (missing.length) await operations.insertMany(missing.map(definition => ({ ...definition,
      createdAt: new Date(), updatedAt: new Date() })));
    await revisions.updateOne({ key: 'public-catalog-v1' }, { $set: {
      count: builtinOperationDefinitions.length, digest: expected,
    } }, { upsert: true });
    process.stdout.write(`Public broker catalog ready: ${builtinOperationDefinitions.length} operations\n`);
  } finally { await connection.close(); }
}

await main();
