import assert from 'node:assert/strict';
import test from 'node:test';
import JSZip from 'jszip';
import { inspectBundleSize } from './bundle.js';

test('bundle size reporting includes compressed totals and stable directory groups', async () => {
  const zip = new JSZip();
  zip.file('manifest.json', '{}');
  zip.file('runtime/app/dist/index.js', 'export default true');
  zip.file('runtime/app/node_modules/example/index.js', 'module.exports = true');
  const bytes = Buffer.from(await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }));
  const report = await inspectBundleSize(bytes, {
    prunePreset: 'production-node',
    removedFiles: 1,
    removedBytes: 100,
    categories: { 'source-maps': { files: 1, bytes: 100 } },
    omittedOptionalPackages: [],
  });
  assert.equal(report.compressedBytes, bytes.byteLength);
  assert.equal(report.fileCount, 3);
  assert.equal(report.directories['runtime/app/dist']?.fileCount, 1);
  assert.equal(report.directories['runtime/app/node_modules']?.fileCount, 1);
  assert.equal(report.optimizations?.removedBytes, 100);
});
