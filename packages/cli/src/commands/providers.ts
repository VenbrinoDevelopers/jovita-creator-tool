import { Command } from 'commander';
import { providerCatalog } from '@jovita-ai/sdk';

export const providersCommand = new Command('providers')
  .description('Browse supported provider methods and broker references')
  .argument('[provider]', 'provider name, such as openRouter')
  .option('--json', 'print the versioned catalog as JSON')
  .action((providerName: string | undefined, options: { json?: boolean }) => {
    const providers = providerName
      ? providerCatalog.providers.filter(provider => provider.id === providerName
        || provider.brokerProviderId === providerName) : providerCatalog.providers;
    if (!providers.length) throw new Error(`Unknown provider: ${providerName}`);
    if (options.json) {
      process.stdout.write(`${JSON.stringify({ schemaVersion: providerCatalog.schemaVersion,
        revision: providerCatalog.revision, providers }, null, 2)}\n`);
      return;
    }
    for (const provider of providers) {
      process.stdout.write(`${provider.name} (${provider.id})\n`);
      for (const operation of provider.operations) {
        process.stdout.write(`  ctx.providers.${provider.id}.${operation.method}(input)`
          + `  ${operation.reference}\n`);
      }
    }
  });
