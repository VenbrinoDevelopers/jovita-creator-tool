import { createReadStream, statSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import JSZip from 'jszip';

export const infoCommand = new Command('info')
  .description('Show information about a .jov bundle')
  .argument('<bundle>', 'Path to .jov bundle file')
  .action(async (bundle: string) => {
    const bundlePath = resolve(bundle);

    try {
      const stats = statSync(bundlePath);
      const fileSize = stats.size;

      const zip = await JSZip.loadAsync(readFileSync(bundlePath));

      const manifestFile = zip.file('manifest.json');
      const manifest = manifestFile ? JSON.parse(await manifestFile.async('text')) : null;

      const skillFiles = Object.keys(zip.files)
        .filter((name) => name.startsWith('skill/') && !zip.files[name].dir)
        .sort();

      const runtimeFiles = Object.keys(zip.files)
        .filter((name) => name.startsWith('runtime/') && !zip.files[name].dir)
        .sort();

      const checksum = await computeFileChecksum(bundlePath);

      const result = {
        path: bundlePath,
        size: fileSize,
        sizeFormatted: formatBytes(fileSize),
        checksum,
        manifest: manifest
          ? {
              format: manifest.format,
              packId: manifest.packId,
              version: manifest.version,
              target: manifest.target ?? manifest.runtime?.payload?.target?.id ?? 'unknown',
              skill: {
                entry: manifest.skill?.entry,
                fileCount: skillFiles.length,
              },
              runtime: manifest.runtime?.execute
                ? {
                    command: manifest.runtime.execute.command,
                    hasHealthCheck: !!manifest.runtime.execute.healthCheck,
                    hasPayload: !!manifest.runtime.payload,
                    payloadPackage: manifest.runtime.payload?.packageName,
                    payloadVersion: manifest.runtime.payload?.version,
                    payloadTarget: manifest.runtime.payload?.target,
                    runtimeFileCount: runtimeFiles.length,
                  }
                : null,
            }
          : null,
        contents: {
          skill: skillFiles,
          runtime: runtimeFiles,
        },
      };

      console.log(JSON.stringify(result, null, 2));
    } catch (err) {
      console.error(JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }, null, 2));
      process.exit(1);
    }
  });

async function computeFileChecksum(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(filePath);
    stream.on('data', (data) => hash.update(data));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(2)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

import { Command } from 'commander';
