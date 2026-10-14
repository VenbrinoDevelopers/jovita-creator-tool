import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, relative, resolve, join } from 'node:path';
import { spawn } from 'node:child_process';
import { runCommand, walkFiles, sanitizeForFs, normalizeRelativePath, collectBundleFileIndex } from './utils.js';
import type { RuntimeBuildConfig, RuntimeBuildReport, RuntimePayload, RuntimeTarget } from '../types.js';

export const RUNTIME_TARGETS: Record<RuntimeTarget['id'], RuntimeTarget> = {
  'linux-arm64': { id: 'linux-arm64', os: 'linux', cpu: 'arm64', libc: 'glibc' },
  'linux-amd64': { id: 'linux-amd64', os: 'linux', cpu: 'x64', libc: 'glibc' },
};

export function resolveRuntimeTarget(value?: string): RuntimeTarget | undefined {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (!normalized) return undefined;
  const target = RUNTIME_TARGETS[normalized as RuntimeTarget['id']];
  if (!target) {
    throw new Error(`Unsupported runtime target: ${value}. Expected one of: ${Object.keys(RUNTIME_TARGETS).join(', ')}`);
  }
  return target;
}

export async function buildRuntimePayloadFromSource(
  runtimePath: string,
  serviceVersion: string,
  target?: RuntimeTarget,
  buildConfig?: RuntimeBuildConfig,
): Promise<RuntimePayload> {
  const packageJsonPath = resolve(runtimePath, 'package.json');
  if (!existsSync(packageJsonPath)) {
    throw new Error(`Runtime package.json not found at ${packageJsonPath}`);
  }

  await runCommand('npm', ['run', 'build'], {
    cwd: runtimePath,
    env: {
      ...(process.env as Record<string, string>),
      ...(target ? { JOVITA_RUNTIME_TARGET: target.id } : {}),
    },
  });

  const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf-8'));
  const packageVersion = String(packageJson.version ?? '').trim();
  if (serviceVersion && packageVersion && serviceVersion !== packageVersion) {
    throw new Error(`Service version ${serviceVersion} does not match runtime package version ${packageVersion}`);
  }

  const stagingRoot = await mkdtemp(join(tmpdir(), `jov-runtime-${sanitizeForFs(packageJson.name ?? 'app')}-`));
  const appRoot = resolve(stagingRoot, 'app');
  mkdirSync(appRoot, { recursive: true });

  copyRuntimePayloadFile(runtimePath, appRoot, 'package.json');
  if (existsSync(resolve(runtimePath, 'README.md'))) {
    copyRuntimePayloadFile(runtimePath, appRoot, 'README.md');
  }
  copyRuntimePayloadDirectory(runtimePath, appRoot, 'dist');

  // Package the public runtime with the signed miniapp so execution does not
  // depend on the creator machine's checkout or registry access.
  const clientDependency = packageJson.dependencies?.['@jovita-ai/runtime'];
  if (typeof clientDependency === 'string' && clientDependency.startsWith('file:')) {
    const clientTarball = resolve(runtimePath, clientDependency.slice(5));
    const tarballName = basename(clientTarball);
    if (!/^jovita(?:-ai)?-runtime-\d+\.\d+\.\d+\.tgz$/.test(tarballName) || !existsSync(clientTarball)) {
      throw new Error('The local @jovita-ai/runtime dependency must be a versioned runtime tarball');
    }
    const packageRoot = resolve(appRoot, 'vendor');
    mkdirSync(packageRoot, { recursive: true });
    writeFileSync(resolve(packageRoot, tarballName), readFileSync(clientTarball));
    const stagedManifest = { ...packageJson, dependencies: { ...packageJson.dependencies,
      '@jovita-ai/runtime': `file:vendor/${tarballName}` } };
    writeFileSync(resolve(appRoot, 'package.json'), JSON.stringify(stagedManifest, null, 2));
  }

  const installArgs = ['install', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'];
  if (target) {
    installArgs.push(`--os=${target.os}`, `--cpu=${target.cpu}`, `--libc=${target.libc}`);
  }
  await runCommand('npm', installArgs, {
    cwd: appRoot,
    env: process.env as Record<string, string>,
  });

  const buildReport = applyRuntimeBuildOptimizations(appRoot, buildConfig, target);

  const files = await collectBundleFileIndex(appRoot);
  return {
    root: appRoot,
    packageName: String(packageJson.name ?? 'app'),
    version: packageVersion || serviceVersion,
    files,
    target,
    ...(buildReport ? { buildReport } : {}),
  };
}

const PROTECTED_DOCUMENT_PATTERN = /^(?:licen[cs]e|copying|notice|copyright)(?:[._-].*)?$/i;
const PRUNED_DOCUMENT_PATTERN = /^(?:readme|changelog|changes|history)(?:[._-].*)?$/i;
const PRUNED_DIRECTORY_NAMES = new Set([
  '__tests__', 'test', 'tests', 'fixture', 'fixtures', 'example', 'examples',
  'doc', 'docs', 'documentation', 'coverage', 'benchmark', 'benchmarks', '__benchmarks__',
]);
const NON_RUNTIME_DEPENDENCY_DIRECTORIES = new Set([
  '.github', '.git', '.circleci', 'benchmark', 'benchmarks', '__benchmarks__',
]);

export function applyRuntimeBuildOptimizations(
  appRoot: string,
  buildConfig?: RuntimeBuildConfig,
  target?: RuntimeTarget,
): RuntimeBuildReport | undefined {
  const report: RuntimeBuildReport = {
    ...(buildConfig?.prunePreset ? { prunePreset: buildConfig.prunePreset } : {}),
    removedFiles: 0,
    removedBytes: 0,
    categories: {},
    omittedOptionalPackages: [],
  };
  const nodeModulesRoot = resolve(appRoot, 'node_modules');

  // npm packages frequently ship CI workflows and benchmarks. These are never
  // loaded by the app and should not become signed release files or review rows.
  if (existsSync(nodeModulesRoot)) pruneNonRuntimeDependencyDirectories(nodeModulesRoot, report);

  if (buildConfig?.prunePreset === 'production-node') {
    pruneProductionNodeTree(appRoot, nodeModulesRoot, report);
  }

  if (target) {
    for (const packageName of buildConfig?.omitOptionalPackages ?? []) {
      if (packageName === '@img/sharp-wasm32') assertSharpNativePayload(nodeModulesRoot, target);
      const packagePath = resolvePackageDirectory(nodeModulesRoot, packageName);
      if (!existsSync(packagePath)) continue;
      recordRemoval(report, 'optional-packages', packagePath);
      rmSync(packagePath, { recursive: true, force: true });
      report.omittedOptionalPackages.push(packageName);
    }
  }
  return report.removedFiles || report.omittedOptionalPackages.length || buildConfig?.prunePreset ? report : undefined;
}

function pruneNonRuntimeDependencyDirectories(directory: string, report: RuntimeBuildReport): void {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const path = resolve(directory, entry.name);
    if (NON_RUNTIME_DEPENDENCY_DIRECTORIES.has(entry.name.toLowerCase())) {
      recordRemoval(report, 'non-runtime-dependency-directories', path);
      rmSync(path, { recursive: true, force: true });
    } else {
      pruneNonRuntimeDependencyDirectories(path, report);
    }
  }
}

function pruneProductionNodeTree(directory: string, nodeModulesRoot: string, report: RuntimeBuildReport): void {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    const insideNodeModules = path === nodeModulesRoot || !relative(nodeModulesRoot, path).startsWith('..');
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      if (insideNodeModules && PRUNED_DIRECTORY_NAMES.has(entry.name.toLowerCase()) && !isNodePackageRoot(path, nodeModulesRoot)) {
        recordRemoval(report, 'non-runtime-directories', path);
        rmSync(path, { recursive: true, force: true });
        continue;
      }
      pruneProductionNodeTree(path, nodeModulesRoot, report);
      if (existsSync(path) && readdirSync(path).length === 0) rmSync(path, { recursive: true, force: true });
      continue;
    }
    if (!entry.isFile() || PROTECTED_DOCUMENT_PATTERN.test(entry.name)) continue;
    const lower = entry.name.toLowerCase();
    let category: string | undefined;
    if (lower.endsWith('.map')) category = 'source-maps';
    else if (/\.d\.(?:ts|cts|mts)$/.test(lower) && !isRuntimeDeclarationAsset(path, nodeModulesRoot)) category = 'typescript-declarations';
    else if (insideNodeModules && PRUNED_DOCUMENT_PATTERN.test(entry.name)) category = 'package-documentation';
    if (!category) continue;
    recordRemoval(report, category, path);
    rmSync(path, { force: true });
  }
}

function isRuntimeDeclarationAsset(path: string, nodeModulesRoot: string): boolean {
  return normalizeRelativePath(relative(nodeModulesRoot, path)) === 'astro/templates/content/types.d.ts';
}

function isNodePackageRoot(path: string, nodeModulesRoot: string): boolean {
  const parts = normalizeRelativePath(relative(nodeModulesRoot, path)).split('/');
  return parts.length === 1 || (parts.length === 2 && parts[0]!.startsWith('@'));
}

function resolvePackageDirectory(nodeModulesRoot: string, packageName: string): string {
  const resolved = resolve(nodeModulesRoot, ...packageName.split('/'));
  if (resolved !== nodeModulesRoot && !relative(nodeModulesRoot, resolved).startsWith('..')) return resolved;
  throw new Error(`Unsafe optional package path: ${packageName}`);
}

function assertSharpNativePayload(nodeModulesRoot: string, target: RuntimeTarget): void {
  const cpu = target.cpu;
  const sharpPackage = resolvePackageDirectory(nodeModulesRoot, 'sharp');
  const bindingPackage = resolvePackageDirectory(nodeModulesRoot, `@img/sharp-linux-${cpu}`);
  const libvipsPackage = resolvePackageDirectory(nodeModulesRoot, `@img/sharp-libvips-linux-${cpu}`);
  const required = [sharpPackage, bindingPackage, libvipsPackage];
  const missing = required.filter((path) => !existsSync(path));
  const hasBinding = existsSync(bindingPackage) && walkFiles(bindingPackage).some((path) => path.endsWith('.node'));
  const hasLibvips = existsSync(libvipsPackage) && walkFiles(libvipsPackage).some((path) => /libvips[^/]*\.so(?:\.|$)/.test(path));
  if (missing.length || !hasBinding || !hasLibvips) {
    throw new Error(`Cannot omit @img/sharp-wasm32: native Sharp payload for ${target.id} is incomplete`);
  }
}

function recordRemoval(report: RuntimeBuildReport, category: string, path: string): void {
  const measurement = measurePath(path);
  const row = report.categories[category] ?? { files: 0, bytes: 0 };
  row.files += measurement.files;
  row.bytes += measurement.bytes;
  report.categories[category] = row;
  report.removedFiles += measurement.files;
  report.removedBytes += measurement.bytes;
}

function measurePath(path: string): { files: number; bytes: number } {
  const stat = lstatSync(path);
  if (!stat.isDirectory()) return { files: 1, bytes: stat.size };
  return readdirSync(path).reduce((total, name) => {
    const measured = measurePath(resolve(path, name));
    return { files: total.files + measured.files, bytes: total.bytes + measured.bytes };
  }, { files: 0, bytes: 0 });
}

function copyRuntimePayloadDirectory(packageDir: string, appRoot: string, relativePath: string): void {
  const sourceDir = resolve(packageDir, relativePath);
  if (!existsSync(sourceDir) || !statSync(sourceDir).isDirectory()) {
    throw new Error(`Runtime payload directory missing: ${relativePath}`);
  }
  for (const filePath of walkFiles(sourceDir)) {
    const relativeFilePath = normalizeRelativePath(relative(packageDir, filePath));
    copyRuntimePayloadFile(packageDir, appRoot, relativeFilePath);
  }
}

function copyRuntimePayloadFile(packageDir: string, appRoot: string, relativePath: string): void {
  const normalized = normalizeRelativePath(relativePath);
  const sourcePath = resolve(packageDir, normalized);
  if (!existsSync(sourcePath) || !statSync(sourcePath).isFile()) {
    throw new Error(`Runtime payload file missing: ${normalized}`);
  }
  const targetPath = resolve(appRoot, normalized);
  mkdirSync(dirname(targetPath), { recursive: true });
  writeFileSync(targetPath, readFileSync(sourcePath));
  if ((statSync(sourcePath).mode & 0o111) !== 0) {
    chmodSync(targetPath, 0o755);
  }
}
