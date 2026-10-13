import { Command } from 'commander';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { discoverService, validateServiceStructure, hasRuntime } from '../lib/discover.js';
import { readServiceConfig, validateManifest } from '../lib/manifest.js';
import { verifyBundleArtifact } from '../lib/bundle.js';
import { computeChecksum } from '../lib/signing.js';
import { walkFiles } from '../lib/utils.js';
import { prepareSdkProject, sdkProjectPath } from '../lib/sdk-project.js';

export const verifyCommand = new Command('verify')
  .description('Verify service structure and manifest')
  .argument('[service]', 'Path to service directory (optional if run from within service)')
  .action(async (service: string | undefined) => {
    if (service && service.endsWith('.jov') && existsSync(service)) {
      const bundlePath = resolve(service);
      const bundleBytes = readFileSync(bundlePath);
      const bundleManifest = await verifyBundleArtifact(bundlePath);
      const bundleChecksum = computeChecksum(bundleBytes);

      console.log(
        JSON.stringify(
          {
            valid: true,
            bundle: bundlePath,
            checksum: bundleChecksum,
            bundleManifest,
            note: 'Bundle structure and file hashes verified. Release signature is finalized by admin/server upload flow.',
          },
          null,
          2,
        ),
      );
      return;
    }

    const projectRoot = resolve(service ?? process.cwd());
    const prepared = sdkProjectPath(projectRoot) ? await prepareSdkProject(projectRoot) : undefined;
    try {
    const { serviceRoot, manifestPath, runtimePath, skillPath } = discoverService(prepared?.root ?? projectRoot);

    const issues: string[] = [];
    let manifestValid = false;

    const structure = validateServiceStructure({ serviceRoot, manifestPath, runtimePath, skillPath });
    if (!structure.valid) {
      issues.push(...structure.errors);
    }

    if (existsSync(manifestPath)) {
      try {
        const config = readServiceConfig(manifestPath);
        const validation = validateManifest(config);
        manifestValid = validation.valid;
        if (!validation.valid) {
          issues.push(...validation.errors.map((e) => `manifest.${e.field}: ${e.message}`));
        }
      } catch (err) {
        issues.push(`Failed to parse jovita.service.json: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    if (hasRuntime(runtimePath)) {
      const packageJsonPath = resolve(runtimePath, 'package.json');
      try {
        const pkg = JSON.parse(readFileSync(packageJsonPath, 'utf-8'));
        if (!pkg.name) issues.push('runtime/package.json: missing name field');
        if (!pkg.version) issues.push('runtime/package.json: missing version field');
        if (!pkg.main && !pkg.bin) issues.push('runtime/package.json: missing main or bin field');
      } catch (err) {
        issues.push(`Failed to parse runtime/package.json: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    const skillFiles = walkFiles(skillPath).filter((f) => !f.endsWith('.DS_Store'));
    if (skillFiles.length === 0) {
      issues.push('skill/ directory is empty');
    }

    const result = {
      valid: issues.length === 0,
      service: service ?? serviceRoot,
      serviceRoot: prepared ? projectRoot : serviceRoot,
      checks: {
        structure: structure.valid,
        manifest: manifestValid,
        hasRuntime: hasRuntime(runtimePath),
        skillFiles: skillFiles.length,
      },
      issues: issues.length > 0 ? issues : undefined,
    };

    console.log(JSON.stringify(result, null, 2));

    if (!result.valid) {
      process.exitCode = 1;
    }
    } finally { await prepared?.cleanup(); }
  });
