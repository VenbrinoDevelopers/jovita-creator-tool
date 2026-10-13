import { Command } from 'commander';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { discoverService, hasRuntime } from '../lib/discover.js';
import { readServiceConfig, buildPublishedManifest } from '../lib/manifest.js';
import { collectSkillIndex } from '../lib/skill.js';
import { buildRuntimePayloadFromSource, resolveRuntimeTarget } from '../lib/runtime.js';
import { buildBundle, inspectBundleSize } from '../lib/bundle.js';
import { computeChecksum } from '../lib/signing.js';
import { sanitizeForFs } from '../lib/utils.js';
import { prepareSdkProject, sdkProjectPath } from '../lib/sdk-project.js';
import { CreatorApi } from '../lib/creator-api.js';

export const buildCommand = new Command('build')
  .description('Build a .jov bundle from a service directory')
  .argument('[service]', 'Path to service directory (defaults to the current service directory)')
  .option('--out-dir <path>', 'Output directory (defaults to <repo>/build/<service-id>)', undefined)
  .option('--target <target>', 'Runtime target: linux-arm64 or linux-amd64', undefined)
  .action(async (service: string | undefined, options) => {
    const projectRoot = resolve(service ?? process.cwd());
    const prepared = sdkProjectPath(projectRoot) ? await prepareSdkProject(projectRoot) : undefined;
    try {
    const { manifestPath, runtimePath, skillPath } = discoverService(prepared?.root ?? projectRoot);

    const config = readServiceConfig(manifestPath);
    let requestedTarget = options.target ?? process.env.JOVITA_RUNTIME_TARGET;
    if (!requestedTarget && (hasRuntime(runtimePath) || config.runtime?.execute)) {
      try {
        const target = await new CreatorApi().request<{ acceptedTarget: string }>('/creator/tools/releases/target');
        requestedTarget = target.acceptedTarget;
      } catch {
        throw new Error('Runtime target is unknown. Run jov login, set JOVITA_CREATOR_TOKEN, or pass --target linux-arm64|linux-amd64.');
      }
    }
    const runtimeTarget = resolveRuntimeTarget(requestedTarget);
    if ((hasRuntime(runtimePath) || config.runtime?.execute) && !runtimeTarget) {
      throw new Error('Executable Mini Apps require --target linux-arm64 or --target linux-amd64');
    }
    if (config.runtime?.execute && !hasRuntime(runtimePath)) {
      throw new Error('Executable Mini Apps require a runtime/package.json payload');
    }
    const outDir = resolve(options.outDir ?? resolve(projectRoot, 'build'));
    mkdirSync(outDir, { recursive: true });
    const skillIndex = await collectSkillIndex(skillPath);

    const runtimePayload = hasRuntime(runtimePath)
      ? await buildRuntimePayloadFromSource(runtimePath, config.version, runtimeTarget, config.runtime?.build)
      : undefined;

    const bundleBytes = await buildBundle({
      skillPath,
      config,
      skillIndex,
      runtimePayload,
    });
    const sizeReport = config.runtime?.build?.sizeReport
      ? await inspectBundleSize(bundleBytes, runtimePayload?.buildReport)
      : undefined;
    const bundleChecksum = computeChecksum(bundleBytes);
    const targetSuffix = runtimeTarget ? `-${runtimeTarget.id}` : '';
    const bundlePath = resolve(
      outDir,
      `${sanitizeForFs(config.id)}-${sanitizeForFs(config.version)}${targetSuffix}.jov`,
    );
    writeFileSync(bundlePath, bundleBytes);

    const releaseManifest = buildPublishedManifest(config, skillIndex, {
      checksum: bundleChecksum,
      signature: '',
    });

    const manifestPathOut = resolve(
      outDir,
      runtimeTarget ? `release-manifest-${runtimeTarget.id}.json` : 'release-manifest.json',
    );
    writeFileSync(manifestPathOut, `${JSON.stringify(releaseManifest, null, 2)}\n`, 'utf-8');

    const metadataPath = resolve(
      outDir,
      runtimeTarget ? `bundle-metadata-${runtimeTarget.id}.json` : 'bundle-metadata.json',
    );
    writeFileSync(
      metadataPath,
      `${JSON.stringify(
        {
          bundlePath,
          bundleChecksum,
          signing: 'Jovita signs the validated bundle after approval',
          manifestPath: manifestPathOut,
          runtimeTarget,
          ...(sizeReport ? { sizeReport } : {}),
        },
        null,
        2,
      )}\n`,
      'utf-8',
    );

    console.log(JSON.stringify({ ok: true, bundlePath, target: runtimeTarget?.id ?? 'any',
      checksum: bundleChecksum, files: [...skillIndex, ...(runtimePayload?.files ?? [])],
      manifestPath: manifestPathOut, ...(sizeReport ? { sizeReport } : {}) }, null, 2));
    } finally { await prepared?.cleanup(); }
  });
