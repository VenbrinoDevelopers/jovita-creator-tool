import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import test from 'node:test';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { applyRuntimeBuildOptimizations, resolveRuntimeTarget } from './runtime.js';
import { collectBundleFileIndex } from './utils.js';

test('runtime target is optional for architecture-independent miniapps', () => {
  assert.equal(resolveRuntimeTarget(), undefined);
  assert.equal(resolveRuntimeTarget(''), undefined);
});

test('production-node pruning only changes staged dependencies and preserves runtime and legal files', () => {
  const source = mkdtempSync(resolve(tmpdir(), 'jov-runtime-source-'));
  const staging = mkdtempSync(resolve(tmpdir(), 'jov-runtime-prune-'));
  try {
    writeFileSync(resolve(source, 'README.md'), 'source remains');
    const packageRoot = resolve(staging, 'node_modules/example');
    const astroTemplate = resolve(staging, 'node_modules/astro/templates/content/types.d.ts');
    mkdirSync(resolve(astroTemplate, '..'), { recursive: true });
    writeFileSync(astroTemplate, 'declare module "astro:content" {}');
    mkdirSync(resolve(staging, 'dist'), { recursive: true });
    writeFileSync(resolve(staging, 'dist/index.js'), 'export default true');
    writeFileSync(resolve(staging, 'dist/index.js.map'), '{}');
    writeFileSync(resolve(staging, 'dist/index.d.ts'), 'export {}');
    mkdirSync(resolve(packageRoot, 'tests'), { recursive: true });
    writeFileSync(resolve(packageRoot, 'index.js'), 'export default true');
    writeFileSync(resolve(packageRoot, 'package.json'), '{}');
    writeFileSync(resolve(packageRoot, 'LICENSE'), 'license');
    writeFileSync(resolve(packageRoot, 'NOTICE.md'), 'notice');
    writeFileSync(resolve(packageRoot, 'README.md'), 'readme');
    writeFileSync(resolve(packageRoot, 'index.js.map'), '{}');
    writeFileSync(resolve(packageRoot, 'index.d.ts'), 'export {}');
    writeFileSync(resolve(packageRoot, 'tests/fixture.json'), '{}');

    const report = applyRuntimeBuildOptimizations(staging, { prunePreset: 'production-node' });
    assert.ok((report?.removedFiles ?? 0) >= 4);
    assert.equal(existsSync(resolve(packageRoot, 'index.js')), true);
    assert.equal(existsSync(resolve(packageRoot, 'package.json')), true);
    assert.equal(existsSync(resolve(packageRoot, 'LICENSE')), true);
    assert.equal(existsSync(resolve(packageRoot, 'NOTICE.md')), true);
    assert.equal(existsSync(resolve(packageRoot, 'README.md')), false);
    assert.equal(existsSync(resolve(packageRoot, 'index.js.map')), false);
    assert.equal(existsSync(resolve(packageRoot, 'index.d.ts')), false);
    assert.equal(existsSync(resolve(packageRoot, 'tests')), false);
    assert.equal(existsSync(resolve(staging, 'dist/index.js')), true);
    assert.equal(existsSync(resolve(staging, 'dist/index.js.map')), false);
    assert.equal(existsSync(resolve(staging, 'dist/index.d.ts')), false);
    assert.equal(existsSync(astroTemplate), true, 'Astro reads this declaration as runtime template data');
    assert.equal(readFileSync(resolve(source, 'README.md'), 'utf8'), 'source remains');
  } finally {
    rmSync(source, { recursive: true, force: true });
    rmSync(staging, { recursive: true, force: true });
  }
});

test('optional Sharp WASM is removed only for a complete targeted native payload', () => {
  const staging = mkdtempSync(resolve(tmpdir(), 'jov-runtime-sharp-'));
  try {
    for (const packageName of ['sharp', '@img/sharp-linux-arm64', '@img/sharp-libvips-linux-arm64', '@img/sharp-wasm32']) {
      const path = resolve(staging, 'node_modules', ...packageName.split('/'));
      mkdirSync(path, { recursive: true });
      writeFileSync(resolve(path, 'package.json'), '{}');
    }
    writeFileSync(resolve(staging, 'node_modules/@img/sharp-linux-arm64/sharp.node'), 'native');
    writeFileSync(resolve(staging, 'node_modules/@img/sharp-libvips-linux-arm64/libvips.so.8'), 'native');
    const config = { omitOptionalPackages: ['@img/sharp-wasm32'] };
    assert.equal(applyRuntimeBuildOptimizations(staging, config), undefined);
    assert.equal(existsSync(resolve(staging, 'node_modules/@img/sharp-wasm32')), true);
    const report = applyRuntimeBuildOptimizations(staging, config, resolveRuntimeTarget('linux-arm64'));
    assert.deepEqual(report?.omittedOptionalPackages, ['@img/sharp-wasm32']);
    assert.equal(existsSync(resolve(staging, 'node_modules/@img/sharp-wasm32')), false);
    assert.equal(existsSync(resolve(staging, 'node_modules/@img/sharp-linux-arm64')), true);
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
});

test('Sharp WASM omission fails closed when a targeted native package is missing', () => {
  const staging = mkdtempSync(resolve(tmpdir(), 'jov-runtime-sharp-incomplete-'));
  try {
    for (const packageName of ['sharp', '@img/sharp-linux-arm64', '@img/sharp-wasm32']) {
      mkdirSync(resolve(staging, 'node_modules', ...packageName.split('/')), { recursive: true });
    }
    assert.throws(
      () => applyRuntimeBuildOptimizations(staging, { omitOptionalPackages: ['@img/sharp-wasm32'] }, resolveRuntimeTarget('linux-arm64')),
      /native Sharp payload.*incomplete/,
    );
    assert.equal(existsSync(resolve(staging, 'node_modules/@img/sharp-wasm32')), true);
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
});

test('runtime target maps public architecture names to npm selectors', () => {
  assert.deepEqual(resolveRuntimeTarget('linux-arm64'), {
    id: 'linux-arm64',
    os: 'linux',
    cpu: 'arm64',
    libc: 'glibc',
  });
  assert.deepEqual(resolveRuntimeTarget('linux-amd64'), {
    id: 'linux-amd64',
    os: 'linux',
    cpu: 'x64',
    libc: 'glibc',
  });
});

test('runtime target rejects unsupported values before packaging', () => {
  assert.throws(() => resolveRuntimeTarget('darwin-arm64'), /Unsupported runtime target/);
});

test('runtime payload index preserves executable intent', async () => {
  const root = mkdtempSync(resolve(tmpdir(), 'jov-runtime-index-'));
  try {
    const executablePath = resolve(root, 'vendor', 'gws');
    const regularPath = resolve(root, 'config.json');
    await import('node:fs/promises').then(({ mkdir }) => mkdir(resolve(root, 'vendor')));
    writeFileSync(executablePath, 'binary');
    chmodSync(executablePath, 0o755);
    writeFileSync(regularPath, '{}');

    const index = await collectBundleFileIndex(root);
    assert.equal(index.find((row) => row.path === 'vendor/gws')?.executable, true);
    assert.equal(index.find((row) => row.path === 'config.json')?.executable, undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
