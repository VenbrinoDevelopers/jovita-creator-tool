import { Command } from 'commander';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { isRuntimeApp } from '@jovita-ai/sdk';
import { loadProjectDefinition } from '../lib/sdk-project.js';
import { validateManifest } from '../lib/manifest.js';

export async function syncRuntimeManifest(root: string, check: boolean): Promise<'current' | 'updated'> {
  const definition = await loadProjectDefinition(root, { allowManifestDrift: true });
  if (!isRuntimeApp(definition)) throw new Error('jov sync applies to SDK declarations for existing command runtimes');
  const validation = validateManifest(definition.serviceConfig());
  if (!validation.valid) throw new Error(`Invalid SDK declaration: ${validation.errors.map(error => `${error.field}: ${error.message}`).join('; ')}`);
  const path = resolve(root, 'jovita.service.json');
  const saved = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) as unknown : undefined;
  if (isDeepStrictEqual(saved, definition.manifest)) return 'current';
  if (check) throw new Error('SDK declaration and jovita.service.json differ. Run jov sync to update the compatibility manifest.');
  writeFileSync(path, `${JSON.stringify(definition.manifest, null, 2)}\n`);
  return 'updated';
}

export const syncCommand = new Command('sync')
  .description('Write the compatibility manifest from an existing runtime SDK declaration')
  .argument('[service]', 'App directory; defaults to the current directory')
  .option('--check', 'Fail if the compatibility manifest differs')
  .action(async (service: string | undefined, options: { check?: boolean }) => {
    try {
      const root = resolve(service ?? process.cwd());
      const result = await syncRuntimeManifest(root, !!options.check);
      console.log(JSON.stringify({ service: root, manifest: result }));
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
  });
