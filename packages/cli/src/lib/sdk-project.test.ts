import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadProjectDefinition } from './sdk-project.js';
import { syncRuntimeManifest } from '../commands/sync.js';

test('an existing runtime has one SDK source and an explicitly synced compatibility manifest', async () => {
  const packageRoot = resolve(fileURLToPath(new URL('../../', import.meta.url)));
  const root = mkdtempSync(join(packageRoot, '.sdk-sync-test-'));
  try {
    mkdirSync(join(root, 'runtime'));
    writeFileSync(join(root, 'runtime/package.json'), '{"name":"test-app","version":"1.0.0","type":"module"}');
    writeFileSync(join(root, 'runtime/jovita.app.ts'), `import { defineRuntimeApp } from '@jovita-ai/sdk';
export default defineRuntimeApp({
  id: 'test-app', name: 'Test App', version: '1.0.0', category: 'productivity', activityProtocolVersion: 1,
  description: 'An existing command runtime',
  skill: { entry: 'skill/SKILL.md', assets: ['skill/SKILL.md'] },
  runtime: { execute: { command: 'test-app', mode: 'brokered', protocolVersion: 1,
    operations: [{ id: 'check', argvPrefix: ['check'], capabilities: [], billingRequired: false,
      activity: { kind: 'check', object: 'service health', icon: 'check' } }],
    healthCheck: { command: 'test-app', args: ['check'], operationId: 'check' } } },
});`);
    await assert.rejects(syncRuntimeManifest(root, true), /differ/);
    assert.equal(await syncRuntimeManifest(root, false), 'updated');
    assert.equal(await syncRuntimeManifest(root, true), 'current');
    assert.equal((await loadProjectDefinition(root)).manifest.id, 'test-app');
    const saved = JSON.parse(readFileSync(join(root, 'jovita.service.json'), 'utf8')) as { id: string };
    assert.equal(saved.id, 'test-app');
    writeFileSync(join(root, 'jovita.service.json'), '{}');
    await assert.rejects(loadProjectDefinition(root), /differ/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
