import { Command } from 'commander';
import { resolve } from 'node:path';
import { CreatorApi } from '../lib/creator-api.js';
import { readBundleManifest } from '../lib/bundle.js';

interface Catalog {
  profiles: Array<{ profileId: string; status: string }>;
  operations: Array<{ capabilityId: string; manifestAliases?: string[] }>;
  connections: Array<{ connectionId: string; profileId: string; testStatus: string }>;
  grants: Array<{ packId: string; capabilityId: string; status: string }>;
}

export const submitCommand = new Command('submit')
  .description('Upload a built .jov bundle and submit it for review')
  .argument('<bundle>', 'Built .jov file')
  .requiredOption('--price-cents <amount>', 'One-time app purchase price in cents, separate from call credits')
  .option('--release-id <id>', 'Finish grants and review submission for an existing draft release')
  .action(async (bundle: string, options) => {
    const priceCents = Number(options.priceCents);
    if (!Number.isSafeInteger(priceCents) || priceCents < 0 || priceCents > 100_000) {
      throw new Error('--price-cents must be an integer from 0 to 100000');
    }
    const api = new CreatorApi();
    const manifest = await readBundleManifest(resolve(bundle));
    const appId = String(manifest.packId ?? '');
    const release = options.releaseId
      ? { id: String(options.releaseId) }
      : await api.upload(resolve(bundle), priceCents);
    const declaration = manifest.broker as { providers?: Array<{ id: string; operations: Array<{ id: string; version: number }> }> } | undefined;
    const pending: string[] = [];
    if (declaration?.providers?.length) {
      const catalog = await api.request<Catalog>('/creator/tools/providers/catalog');
      for (const provider of declaration.providers) {
        const profile = catalog.profiles.find(row => row.profileId.endsWith(`-${provider.id}`));
        if (!profile || profile.status !== 'approved') {
          pending.push(`${provider.id}: provider host approval`);
          continue;
        }
        const connections = catalog.connections.filter(row => row.profileId === profile.profileId && row.testStatus === 'ok');
        if (connections.length !== 1) {
          pending.push(`${provider.id}: ${connections.length ? 'choose one tested connection in the dashboard' : 'test a connection with jov connect'}`);
          continue;
        }
        for (const operation of provider.operations) {
          const alias = `broker.${appId}.${provider.id}.${operation.id}.v${operation.version}`;
          const row = catalog.operations.find(candidate => candidate.manifestAliases?.includes(alias));
          if (!row) { pending.push(`${provider.id}.${operation.id}: catalog import`); continue; }
          if (catalog.grants.some(grant => grant.packId === appId && grant.capabilityId === row.capabilityId && grant.status === 'active')) continue;
          await api.request(`/creator/tools/${encodeURIComponent(appId)}/providers/grants`, 'POST', {
            connectionId: connections[0]!.connectionId, capabilityId: row.capabilityId,
          });
        }
      }
    }
    if (pending.length) {
      console.log(JSON.stringify({ ok: false, releaseId: release.id, status: 'draft', pending,
        next: 'Complete setup, then run jov submit on the same bundle with --release-id to finish.' }, null, 2));
      return;
    }
    const submitted = await api.request(`/creator/tools/releases/${encodeURIComponent(release.id)}/publish`, 'POST');
    console.log(JSON.stringify({ ok: true, releaseId: release.id, status: 'submitted-for-review', result: submitted }, null, 2));
  });
