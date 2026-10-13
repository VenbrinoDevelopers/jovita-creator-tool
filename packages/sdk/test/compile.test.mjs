import test from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { defineApp, provider, compileApp, JovitaApp, JovitaTool } from '../dist/index.js';

test('one route compiles to one priced operation and one limited tool grant', () => {
  const search = provider({ name: 'Search API', baseUrl: 'https://api.example.com', auth: 'bearer' });
  const app = defineApp({ id: 'search-app', name: 'Search App', version: '1.0.0', tools: {
    search: search.post('/search', { description: 'Find matching pages',
      input: z.object({ query: z.string().min(1) }), output: z.object({ results: z.array(z.string()) }),
      creditsPerCall: 10 }),
  } });
  const manifest = compileApp(app);
  const operation = manifest.broker.providers[0].operations[0];
  const tool = manifest.runtime.execute.operations.find(item => item.id === 'search');
  assert.equal(operation.buyerCredits, 10);
  assert.equal(operation.inputSchema.additionalProperties, false);
  assert.deepEqual(tool.capabilities, ['broker.search-app.search_api.search.v1']);
  assert.equal(tool.capabilityLimits[tool.capabilities[0]], 1);
  assert.equal(manifest.compat.minRuntimeVersion, '0.1.0');
  assert.doesNotMatch(JSON.stringify(manifest), /apiKey|accessToken|secret/i);
});

test('class apps can compose built-in operations without provider declarations', () => {
  class ExistingTool extends JovitaTool {
    constructor() { super({ id: 'lookup', description: 'Find a place',
      input: z.object({ query: z.string() }), output: z.object({ name: z.string() }),
      uses: [{ operation: 'google.places.text_search' }],
      activity: { kind: 'search', object: 'place' } }); }
  }
  class ExistingApp extends JovitaApp {
    static definition = { id: 'existing-app', name: 'Existing App', version: '1.0.0',
      category: 'lifestyle', description: 'Find useful places.' };
    lookup = this.register(new ExistingTool());
  }
  const manifest = compileApp(new ExistingApp());
  assert.equal(manifest.broker, undefined);
  const tool = manifest.runtime.execute.operations.find(item => item.id === 'lookup');
  assert.deepEqual(tool.capabilities, ['google.places.text_search']);
  assert.equal(tool.billingRequired, true);
});

test('reused provider keeps one connection profile and separate prices', () => {
  const api = provider({ name: 'Shared API', baseUrl: 'https://api.example.com', auth: 'bearer' });
  const app = defineApp({ id: 'multi-app', name: 'Multi App', version: '1.0.0', tools: {
    quick: api.get('/quick', { description: 'Quick lookup', input: z.object({ q: z.string() }),
      output: z.object({ text: z.string() }), creditsPerCall: 5 }),
    deep: api.post('/deep', { description: 'Deep lookup', input: z.object({ q: z.string() }),
      output: z.object({ text: z.string() }), creditsPerCall: 20 }),
  } });
  const manifest = compileApp(app);
  assert.equal(manifest.broker.providers.length, 1);
  assert.deepEqual(manifest.broker.providers[0].operations.map(item => item.buyerCredits), [5, 20]);
});
