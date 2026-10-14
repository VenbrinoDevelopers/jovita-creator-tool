import JSZip from 'jszip';
import { readFileSync, statSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, resolve, relative } from 'node:path';
import { BUNDLE_FORMAT } from '../types.js';
import type { ServiceConfig, SkillIndexItem, RuntimePayload } from '../types.js';
import type { BundleSizeReport, RuntimeBuildReport } from '../types.js';
import { normalizeRelativePath, walkFiles } from './utils.js';
import { validateBrokerDeclaration, validateBrokerExecution } from './manifest.js';

export async function buildBundle({
  skillPath,
  config,
  skillIndex,
  runtimePayload,
}: {
  skillPath: string;
  config: ServiceConfig;
  skillIndex: SkillIndexItem[];
  runtimePayload?: RuntimePayload;
}): Promise<Buffer> {
  const zip = new JSZip();
  for (const row of skillIndex) {
    const sourcePath = resolve(skillPath, normalizeRelativePath(row.path));
    zip.file(`skill/${normalizeRelativePath(row.path)}`, readFileSync(sourcePath));
  }

  const bundleManifest: Record<string, unknown> = {
    format: BUNDLE_FORMAT,
    packId: config.id,
    version: config.version,
    target: runtimePayload?.target?.id ?? (runtimePayload ? undefined : 'any'),
    release: {
      name: config.name,
      category: config.category,
      description: config.description,
      logoUrl: config.logoUrl,
      activityProtocolVersion: config.activityProtocolVersion,
      auth: config.auth,
      providers: config.providers,
      compat: config.compat ?? { minRuntimeVersion: '0.1.0' },
    },
    ...(config.broker ? { broker: config.broker } : {}),
    skill: {
      entry: config.skill.entry,
      index: skillIndex,
    },
  };

  if (config.runtime?.execute) {
    (bundleManifest.runtime as Record<string, unknown>) = {
      ...((bundleManifest.runtime as Record<string, unknown>) ?? {}),
      execute: config.runtime.execute,
    };
  }

  if (runtimePayload) {
    for (const row of runtimePayload.files) {
      const sourcePath = resolve(runtimePayload.root, normalizeRelativePath(row.path));
      zip.file(`runtime/app/${normalizeRelativePath(row.path)}`, readFileSync(sourcePath));
    }
    (bundleManifest.runtime as Record<string, unknown>) = {
      ...((bundleManifest.runtime as Record<string, unknown>) ?? {}),
      payload: {
        packageName: runtimePayload.packageName,
        version: runtimePayload.version,
        files: runtimePayload.files,
        ...(runtimePayload.target ? { target: runtimePayload.target } : {}),
      },
    };
  }

  const manifestJson = JSON.stringify(bundleManifest, null, 2);
  if (Buffer.byteLength(manifestJson) > 4 * 1024 * 1024) {
    throw new Error('Bundle manifest exceeds the 4 MB publishing limit');
  }
  zip.file('manifest.json', manifestJson);
  const bytes = await zip.generateAsync({
    type: 'nodebuffer',
    compression: 'DEFLATE',
    compressionOptions: { level: 9 },
  });
  if (runtimePayload?.root) {
    await rm(dirname(runtimePayload.root), { recursive: true, force: true });
  }
  return Buffer.from(bytes);
}

export async function inspectBundleSize(
  bytes: Buffer,
  optimizations?: RuntimeBuildReport,
): Promise<BundleSizeReport> {
  const zip = await JSZip.loadAsync(bytes);
  const directories: BundleSizeReport['directories'] = {};
  let uncompressedBytes = 0;
  let fileCount = 0;
  for (const [path, entry] of Object.entries(zip.files)) {
    if (entry.dir) continue;
    const internal = entry as unknown as { _data?: { compressedSize?: number; uncompressedSize?: number } };
    const compressedBytes = Number(internal._data?.compressedSize ?? 0);
    const recordedUncompressed = Number(internal._data?.uncompressedSize ?? 0);
    const uncompressed = recordedUncompressed || Buffer.from(await entry.async('nodebuffer')).byteLength;
    const group = bundleDirectoryGroup(path);
    const row = directories[group] ?? { compressedBytes: 0, uncompressedBytes: 0, fileCount: 0 };
    row.compressedBytes += compressedBytes;
    row.uncompressedBytes += uncompressed;
    row.fileCount += 1;
    directories[group] = row;
    uncompressedBytes += uncompressed;
    fileCount += 1;
  }
  return {
    compressedBytes: bytes.byteLength,
    uncompressedBytes,
    fileCount,
    directories,
    ...(optimizations ? { optimizations } : {}),
  };
}

function bundleDirectoryGroup(path: string): string {
  if (path === 'manifest.json') return 'manifest.json';
  if (path.startsWith('skill/')) return 'skill';
  if (path.startsWith('runtime/app/node_modules/')) return 'runtime/app/node_modules';
  if (path.startsWith('runtime/app/dist/catalog/')) return 'runtime/app/dist/catalog';
  if (path.startsWith('runtime/app/dist/')) return 'runtime/app/dist';
  if (path.startsWith('runtime/app/')) return 'runtime/app';
  return 'other';
}

export async function readBundleManifest(bundlePath: string): Promise<Record<string, unknown>> {
  const zip = await JSZip.loadAsync(readFileSync(bundlePath));
  const manifestContent = zip.file('manifest.json');
  if (!manifestContent) {
    throw new Error('Bundle does not contain manifest.json');
  }
  return JSON.parse(await manifestContent.async('text'));
}

export async function getBundleContents(bundlePath: string): Promise<string[]> {
  const zip = await JSZip.loadAsync(readFileSync(bundlePath));
  return Object.keys(zip.files).sort();
}

export async function verifyBundleArtifact(bundlePath: string): Promise<Record<string, unknown>> {
  const zip = await JSZip.loadAsync(readFileSync(bundlePath));
  const manifestContent = zip.file('manifest.json');
  if (!manifestContent) {
    throw new Error('Bundle does not contain manifest.json');
  }
  const manifestSize = Number((manifestContent as typeof manifestContent & { _data?: { uncompressedSize?: number } })._data?.uncompressedSize);
  if (!Number.isSafeInteger(manifestSize) || manifestSize > 4 * 1024 * 1024) {
    throw new Error('Bundle manifest exceeds the 4 MB publishing limit');
  }
  const manifest = JSON.parse(await manifestContent.async('text')) as Record<string, unknown>;
  if (manifest.format !== BUNDLE_FORMAT) {
    throw new Error(`Unsupported bundle format: ${String(manifest.format ?? '')}`);
  }
  if (manifest.broker !== undefined) {
    const errors: Array<{ field: string; message: string }> = [];
    const config = { id: String(manifest.packId ?? ''), broker: manifest.broker,
      runtime: { execute: (manifest.runtime as { execute?: unknown } | undefined)?.execute } } as ServiceConfig;
    validateBrokerDeclaration(config, errors);
    if (config.runtime?.execute?.mode === 'brokered') validateBrokerExecution(config.runtime.execute, errors);
    if (errors.length) throw new Error(`Bundle broker declaration is invalid: ${errors[0]!.field}: ${errors[0]!.message}`);
  }

  const skill = (manifest.skill ?? {}) as { entry?: unknown; index?: Array<{ path?: unknown; sha256?: unknown; size?: unknown }> };
  const skillIndex = Array.isArray(skill.index) ? skill.index : [];
  if (!String(skill.entry ?? '').trim()) {
    throw new Error('Bundle manifest skill.entry is required');
  }
  if (skillIndex.length === 0) {
    throw new Error('Bundle manifest skill.index is required');
  }
  for (const row of skillIndex) {
    const relativePath = normalizeRelativePath(String(row.path ?? ''));
    const entry = zip.file(`skill/${relativePath}`);
    if (!entry) {
      throw new Error(`Bundle skill file missing: ${relativePath}`);
    }
        const bytes = Buffer.from(await entry.async('nodebuffer'));
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    if (sha256 !== String(row.sha256 ?? '').trim().toLowerCase()) {
      throw new Error(`Bundle skill hash mismatch: ${relativePath}`);
    }
  }

  const runtime = (manifest.runtime ?? {}) as {
    payload?: {
      packageName?: unknown;
      version?: unknown;
      files?: Array<{ path?: unknown; sha256?: unknown; size?: unknown; executable?: unknown }>;
    };
  };
  const payload = runtime.payload;
  if (payload) {
    const files = Array.isArray(payload.files) ? payload.files : [];
    if (!String(payload.packageName ?? '').trim()) {
      throw new Error('Bundle runtime payload packageName is required');
    }
    if (!String(payload.version ?? '').trim()) {
      throw new Error('Bundle runtime payload version is required');
    }
    for (const row of files) {
      const relativePath = normalizeRelativePath(String(row.path ?? ''));
      if (row.executable !== undefined && typeof row.executable !== 'boolean') {
        throw new Error(`Bundle runtime executable flag is invalid: ${relativePath}`);
      }
      const entry = zip.file(`runtime/app/${relativePath}`);
      if (!entry) {
        throw new Error(`Bundle runtime file missing: ${relativePath}`);
      }
      const bytes = Buffer.from(await entry.async('nodebuffer'));
      const sha256 = createHash('sha256').update(bytes).digest('hex');
      if (sha256 !== String(row.sha256 ?? '').trim().toLowerCase()) {
        throw new Error(`Bundle runtime hash mismatch: ${relativePath}`);
      }
    }
  }

  return manifest;
}
