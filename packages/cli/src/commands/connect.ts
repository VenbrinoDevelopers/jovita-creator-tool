import { Command } from 'commander';
import { resolve } from 'node:path';
import { loadSdkApp } from '../lib/sdk-project.js';
import { CreatorApi } from '../lib/creator-api.js';

interface Catalog {
  profiles: Array<{ profileId: string; name: string; status: string }>;
  operations: Array<{ capabilityId: string; profileId: string; operationId: string; version: number }>;
  connections: Array<{ connectionId: string; profileId: string; name: string; testStatus: string }>;
  grants: Array<{ packId: string; capabilityId: string; connectionId: string; status: string }>;
}

export const connectCommand = new Command('connect')
  .description('Create or rotate a provider connection and grant its routes to this app')
  .argument('<provider-id>', 'Provider ID declared by jovita.app.ts')
  .option('--dir <path>', 'App directory', '.')
  .option('--name <name>', 'Connection name')
  .option('--key-env <name>', 'Environment variable containing the provider API key')
  .option('--connection-id <id>', 'Existing connection ID to rotate')
  .option('--test-operation <id>', 'Operation ID to use for a real provider connection test')
  .option('--sample-input <json>', 'JSON input for the connection test', '{}')
  .option('--confirm-provider-charge', 'Allow a real non-GET test call')
  .action(async (providerId: string, options) => {
    const app = await loadSdkApp(resolve(options.dir));
    const provider = app.providers().find(row => row.config.id === providerId);
    if (!provider) throw new Error(`Provider ${providerId} is not declared by the app.`);
    const api = new CreatorApi();
    let catalog = await api.request<Catalog>('/creator/tools/providers/catalog');
    let profile = catalog.profiles.find(row => row.profileId.endsWith(`-${providerId}`));
    if (!profile) {
      const created = await api.request<{ profileId: string; status: string }>(
        '/creator/tools/providers/profiles', 'POST', { profileId: providerId, ...provider.config });
      profile = { ...created, name: provider.config.name };
    }
    if (profile.status !== 'approved') throw new Error('Provider host did not pass public HTTPS validation. Check its URL and DNS, then retry.');
    for (const operation of provider.operations()) {
      const capabilityId = `creator.${profile.profileId}.${operation.definition.id}.v${operation.definition.version ?? 1}`;
      if (catalog.operations.some(row => row.capabilityId === capabilityId)) continue;
      const { input, output, creditsPerCall, ...rest } = operation.definition;
      const { z } = await import('zod');
      const schema = (value: unknown) => value instanceof z.ZodType
        ? z.toJSONSchema(value, { target: 'draft-7' }) : value;
      await api.request('/creator/tools/providers/operations', 'POST', {
        ...rest, operationId: rest.id, profileId: profile.profileId, version: rest.version ?? 1,
        inputSchema: schema(input), outputSchema: schema(output), buyerCredits: creditsPerCall,
      });
    }
    catalog = await api.request<Catalog>('/creator/tools/providers/catalog');
    const keyName = options.keyEnv ?? 'JOVITA_PROVIDER_API_KEY';
    const apiKey = String(process.env[keyName] ?? '');
    if (!apiKey) throw new Error(`Set ${keyName} to the provider key. It will be sent only to Jovita and never written to the app.`);
    const connection = await api.request<{ connectionId: string }>('/creator/tools/providers/connections', 'POST', {
      ...(options.connectionId ? { connectionId: options.connectionId } : {}),
      profileId: profile.profileId, name: options.name ?? provider.config.name, apiKey,
    });
    const testOperation = options.testOperation ?? provider.operations().find(row => row.definition.method === 'GET')?.definition.id;
    if (!testOperation) {
      console.log(JSON.stringify({ ok: true, connectionId: connection.connectionId, status: 'untested',
        next: 'Choose a test operation and pass --test-operation, --sample-input, and --confirm-provider-charge if it is not GET.' }, null, 2));
      return;
    }
    const chosen = provider.operations().find(row => row.definition.id === testOperation);
    if (!chosen) throw new Error(`Unknown provider operation ${testOperation}`);
    const capabilityId = `creator.${profile.profileId}.${chosen.definition.id}.v${chosen.definition.version ?? 1}`;
    const sampleInput = JSON.parse(options.sampleInput) as Record<string, unknown>;
    await api.request(`/creator/tools/providers/connections/${encodeURIComponent(connection.connectionId)}/test`, 'POST', {
      capabilityId, sampleInput, confirmProviderCharge: Boolean(options.confirmProviderCharge),
    });
    const owned = await api.request<Array<{ packId: string }>>('/creator/tools/library');
    if (owned.some(row => row.packId === app.config.id)) {
      for (const operation of provider.operations()) {
        const id = `creator.${profile.profileId}.${operation.definition.id}.v${operation.definition.version ?? 1}`;
        await api.request(`/creator/tools/${encodeURIComponent(app.config.id)}/providers/grants`, 'POST', {
          connectionId: connection.connectionId, capabilityId: id,
        });
      }
    }
    console.log(JSON.stringify({ ok: true, connectionId: connection.connectionId,
      status: 'tested', grantedOperations: owned.some(row => row.packId === app.config.id) ? provider.operations().length : 0,
      next: owned.some(row => row.packId === app.config.id) ? undefined : 'jov submit will grant these operations after upload.' }, null, 2));
  });
