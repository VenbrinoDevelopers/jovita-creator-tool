import { Command } from 'commander';
import { resolve } from 'node:path';
import { discoverService } from '../lib/discover.js';
import { readServiceConfig, validateManifest } from '../lib/manifest.js';
import { compileApp } from '@jovita/sdk';
import { loadProjectDefinition, sdkProjectPath } from '../lib/sdk-project.js';
import { isRuntimeApp } from '@jovita/sdk';
import type { ServiceConfig } from '../types.js';

export const lintCommand = new Command('lint')
  .description('Lint service manifest for common issues')
  .argument('[service]', 'App directory; defaults to the current directory')
  .action(async (service: string | undefined) => {
    const root = resolve(service ?? process.cwd());
    const { manifestPath } = discoverService(root);

    const warnings: string[] = [];
    const info: string[] = [];

    try {
      const definition = sdkProjectPath(root) ? await loadProjectDefinition(root) : undefined;
      const config = definition
        ? isRuntimeApp(definition) ? definition.serviceConfig() : compileApp(definition)
        : readServiceConfig(manifestPath);
      const validation = validateManifest(config);

      if (!validation.valid) {
        for (const error of validation.errors) {
          warnings.push(`[ERROR] manifest.${error.field}: ${error.message}`);
        }
      }

      if (!config.description || config.description.length < 20) {
        warnings.push('[WARN] description is too short (should be at least 20 characters)');
      }

      if (config.description && config.description.length > 500) {
        warnings.push('[WARN] description is too long (should be under 500 characters)');
      }

      if (!config.logoUrl) {
        warnings.push('[WARN] logoUrl is missing');
      } else if (!config.logoUrl.startsWith('https://')) {
        warnings.push('[WARN] logoUrl should use HTTPS');
      }

      if (!config.billing) {
        info.push('[INFO] billing is not configured');
      }

      if (
        config.runtime?.execute?.mode !== 'brokered'
        && !config.auth
        && config.providers
        && config.providers.length > 0
      ) {
        warnings.push('[WARN] providers defined but no auth configured');
      }

      if (!config.compat) {
        info.push('[INFO] compat (compatibility) not specified');
      }

      if (config.runtime?.execute?.healthCheck) {
        info.push('[INFO] healthCheck is configured');
      }

      const result = {
        valid: validation.valid && warnings.filter((w) => w.startsWith('[ERROR]')).length === 0,
        service,
        errors: validation.errors.map((e) => `manifest.${e.field}: ${e.message}`),
        warnings: warnings.filter((w) => w.startsWith('[WARN]')).map((w) => w.replace('[WARN] ', '')),
        info: info.map((i) => i.replace('[INFO] ', '')),
      };

      console.log(JSON.stringify(result, null, 2));

      if (!result.valid) {
        process.exit(1);
      }
    } catch (err) {
      console.error(JSON.stringify({ valid: false, error: err instanceof Error ? err.message : String(err) }, null, 2));
      process.exit(1);
    }
  });
