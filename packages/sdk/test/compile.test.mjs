import test from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { defineApp, provider, compileApp, defineRuntimeApp, defineSkillApp, commandTools, JovitaApp, JovitaTool } from '../dist/index.js';

test('command-backed defineApp retains CLI routing, grants, and storefront fields', () => {
  const app = defineApp({ id: 'leads', name: 'Leads', version: '1.0.0',
    category: 'sales', description: 'Find local businesses for outreach.',
    billing: { tier: 'free', entitlementKey: 'pack.leads' },
    tools: commandTools([{ id: 'find', argvPrefix: ['find'],
      capabilities: ['google.places.text_search'], billingRequired: true,
      activity: { kind: 'search', object: 'leads' } }]),
    healthCheck: { command: 'leads', args: ['--help'], operationId: 'find' },
  });
  const manifest = compileApp(app);
  assert.equal(manifest.runtime.execute.command, 'leads');
  assert.deepEqual(manifest.runtime.execute.operations[0].capabilities, ['google.places.text_search']);
  assert.equal(manifest.billing.entitlementKey, 'pack.leads');
  assert.equal(manifest.runtime.execute.healthCheck.operationId, 'find');
  assert.throws(() => commandTools([{ id: 'find', argvPrefix: ['a'], capabilities: [], billingRequired: false },
    { id: 'find', argvPrefix: ['b'], capabilities: [], billingRequired: false }]), /Duplicate/);
});

test('concise command tools infer routing and billing and generate a free health operation', () => {
  const app = defineApp({ id: 'local-leads', name: 'Local Leads', version: '1.0.0',
    description: 'Find local customers.', billing: { tier: 'free', entitlementKey: 'pack.local_leads' },
    tools: commandTools({
      search: { capabilities: ['google.places.text_search'] },
      generate: { capabilities: ['serper.maps.search'] },
    }),
  });
  const manifest = compileApp(app);
  assert.deepEqual(manifest.runtime.execute.operations, [
    { id: 'offline', argvPrefix: [], excludedArgs: ['search', 'generate'],
      capabilities: [], billingRequired: false, activity: { kind: 'read', object: 'Local Leads information', icon: 'document' } },
    { id: 'search', argvPrefix: ['search'], capabilities: ['google.places.text_search'], billingRequired: true,
      activity: { kind: 'run', object: 'search', icon: 'command' } },
    { id: 'generate', argvPrefix: ['generate'], capabilities: ['serper.maps.search'], billingRequired: true,
      activity: { kind: 'run', object: 'generate', icon: 'command' } },
  ]);
  assert.deepEqual(manifest.runtime.execute.healthCheck,
    { command: 'local-leads', args: ['--help'], operationId: 'offline' });
  assert.deepEqual(manifest.skill, { entry: 'skill/SKILL.md', assets: ['skill/SKILL.md'] });
  assert.deepEqual(manifest.compat, { minRuntimeVersion: '0.1.0' });
});

test('command tools retain explicit routing and paid local workflows', () => {
  const app = defineApp({ id: 'advanced', name: 'Advanced', version: '1.0.0',
    tools: commandTools({
      doctor: { argvPrefix: ['runtime', 'doctor'] },
      'create-fast': { argvPrefix: ['create'], requiredArgs: ['--profile', 'fast'],
        capabilities: ['openrouter.images.generate'], partialExitCodes: [2] },
      finalize: { billingRequired: true },
    }),
    healthCheck: { command: 'advanced', args: ['runtime', 'doctor'], operationId: 'doctor' },
  });
  const operations = compileApp(app).runtime.execute.operations;
  assert.equal(operations.length, 3);
  assert.deepEqual(operations[0], { id: 'doctor', argvPrefix: ['runtime', 'doctor'],
    capabilities: [], billingRequired: false, activity: { kind: 'read', object: 'doctor', icon: 'document' } });
  assert.deepEqual(operations[1].requiredArgs, ['--profile', 'fast']);
  assert.equal(operations[2].billingRequired, true);
});

test('custom health arguments use the generated free route without changing authored tools', () => {
  const tools = commandTools({ plan: { capabilities: ['openrouter.chat.generate'] } });
  const app = defineApp({ id: 'brandkit', name: 'Brandkit', version: '1.0.0',
    healthArgs: ['describe'], tools });
  const first = compileApp(app);
  const second = compileApp(app);
  assert.deepEqual(first, second);
  assert.deepEqual(first.runtime.execute.healthCheck,
    { command: 'brandkit', args: ['describe'], operationId: 'offline' });
  assert.deepEqual(first.runtime.execute.operations[0],
    { id: 'offline', argvPrefix: [], excludedArgs: ['plan'], capabilities: [],
      billingRequired: false, activity: { kind: 'read', object: 'Brandkit information', icon: 'document' } });
  assert.deepEqual(Object.keys(tools), ['plan']);
});

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

test('named runs and activity phases preserve the broker and AI contracts', () => {
  const monid = provider({ name: 'Monid', baseUrl: 'https://api.monid.ai/v1/', auth: 'bearer' });
  const app = defineApp({ id: 'lead-finder', name: 'Lead Finder', version: '1.0.0',
    compat: { serviceAliases: ['emailfinder'], executableAliases: ['emailfinder'] },
    tools: {
      search: monid.post('/run', { description: 'Find qualified leads',
        executionKind: 'named-run', providerName: 'sample', endpoint: '/search',
        input: z.object({ query: z.string() }), output: z.object({ leads: z.array(z.string()) }),
        creditsPerCall: 20,
        activity: { kind: 'search', object: 'leads', icon: 'search',
          phases: { collecting: { kind: 'read', object: 'sources' } } },
      }),
    },
  });
  const manifest = compileApp(app);
  assert.equal(manifest.compat.serviceAliases[0], 'emailfinder');
  assert.equal(manifest.broker.providers[0].operations[0].executionKind, 'named-run');
  assert.equal(manifest.broker.providers[0].operations[0].providerName, 'sample');
  assert.equal(manifest.runtime.execute.operations[1].activity.phases.collecting.kind, 'read');
});

test('existing command runtimes retain their complete typed release declaration', () => {
  const manifest = { id: 'existing', name: 'Existing', version: '1.0.0',
    category: 'productivity', description: 'Existing command runtime', providers: [],
    skill: { entry: 'SKILL.md', assets: ['.'] }, runtime: { execute: { command: 'existing',
      mode: 'brokered', protocolVersion: 1, operations: [{ id: 'health', argvPrefix: ['health'],
        capabilities: [], billingRequired: false, activity: { kind: 'check', object: 'health' } }] } } };
  assert.deepEqual(defineRuntimeApp(manifest).manifest, manifest);
});

test('compact command declarations supply broker protocol defaults', () => {
  const app = defineRuntimeApp({ id: 'existing', name: 'Existing', version: '1.0.0',
    description: 'Existing command runtime', operations: [{ id: 'health', argvPrefix: ['health'],
      capabilities: [], billingRequired: false, activity: { kind: 'check', object: 'health' } }],
    healthCheck: { command: 'existing', args: ['health'], operationId: 'health' } });
  assert.equal(app.manifest.runtime.execute.command, 'existing');
  assert.equal(app.manifest.runtime.execute.mode, 'brokered');
  assert.equal(app.manifest.activityProtocolVersion, 1);
  assert.equal(app.manifest.skill.entry, 'skill/SKILL.md');
  assert.equal(app.manifest.providers.length, 0);
});

test('metadata-only declarations produce skill-only apps without a runtime', () => {
  const app = defineSkillApp({ id: 'writing-skill', name: 'Writing Skill', version: '1.0.0',
    description: 'Help draft short messages.' });
  assert.equal(app.manifest.runtime, undefined);
  assert.equal(app.manifest.skill.entry, 'skill/SKILL.md');
  assert.equal(app.manifest.compat.minRuntimeVersion, '0.1.0');
});
