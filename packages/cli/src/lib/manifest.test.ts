import assert from 'node:assert/strict';
import test from 'node:test';
import { buildPublishedManifest, readServiceConfig, validateManifest } from './manifest.js';
import type { ServiceConfig } from '../types.js';
import { buildBundle, verifyBundleArtifact } from './bundle.js';
import JSZip from 'jszip';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function brokeredConfig(): ServiceConfig {
  return {
    id: 'future-miniapp',
    name: 'Future Mini-App',
    version: '1.0.0',
    category: 'productivity',
    description: 'A future mini-app that reuses registered provider capabilities.',
    activityProtocolVersion: 1,
    providers: [],
    skill: { entry: 'SKILL.md', assets: ['.'] },
    runtime: {
      execute: {
        command: 'future-miniapp',
        mode: 'brokered',
        protocolVersion: 1,
        operations: [
          {
            id: 'doctor',
            argvPrefix: ['doctor'],
            capabilities: [],
            billingRequired: false,
            activity: { kind: 'check', object: 'service health', icon: 'check' },
          },
          {
            id: 'search',
            argvPrefix: ['search'],
            capabilities: ['provider.search'],
            billingRequired: true,
            activity: { kind: 'search', object: 'provider records', icon: 'search' },
          },
        ],
        healthCheck: {
          command: 'future-miniapp',
          args: ['doctor'],
          operationId: 'doctor',
        },
      },
    },
  };
}

test('accepts a future mini-app that declares a reusable registered capability id', () => {
  assert.deepEqual(validateManifest(brokeredConfig()), { valid: true, errors: [] });
});

test('publishes a declared provider operation with a portable tool scoped reference', async () => {
  const config = brokeredConfig();
  const ref = 'broker.future-miniapp.search1api.search.v1';
  config.runtime!.execute!.operations![1]!.capabilities = [ref];
  config.runtime!.execute!.operations![1]!.capabilityLimits = { [ref]: 2 };
  config.broker = { providers: [{
    id: 'search1api', name: 'Search1API', summary: 'Web search', docsUrl: 'https://s1.dev/docs',
    category: 'web-search', baseUrl: 'https://api.search1api.com/', authMethod: 'bearer',
    operations: [{ id: 'search', version: 1, name: 'Search', purpose: 'Search the web',
      method: 'POST', path: '/search', inputSchema: { type: 'object', additionalProperties: false,
        properties: { query: { type: 'string' } }, required: ['query'] },
      outputSchema: { type: 'object' }, buyerCredits: 20, providerCostNote: 'Creator pays upstream.' }],
  }] };
  assert.deepEqual(validateManifest(config), { valid: true, errors: [] });
  assert.deepEqual(buildPublishedManifest(config, [], { checksum: 'checksum', signature: 'signature' }).broker,
    config.broker);
  const archive = await JSZip.loadAsync(await buildBundle({ config, skillPath: '.', skillIndex: [] }));
  const bundled = JSON.parse(await archive.file('manifest.json')!.async('text'));
  assert.deepEqual(bundled.broker, config.broker);
  const directory = mkdtempSync(join(tmpdir(), 'jov-broker-manifest-'));
  try {
    const configPath = join(directory, 'jovita.service.json');
    writeFileSync(configPath, JSON.stringify(config));
    assert.deepEqual(readServiceConfig(configPath).broker, config.broker);
    const skill = 'Use the declared search route.';
    writeFileSync(join(directory, 'SKILL.md'), skill);
    const bundlePath = join(directory, 'tool.jov');
    writeFileSync(bundlePath, await buildBundle({ config, skillPath: directory,
      skillIndex: [{ path: 'SKILL.md', size: Buffer.byteLength(skill),
        sha256: createHash('sha256').update(skill).digest('hex') }] }));
    assert.deepEqual((await verifyBundleArtifact(bundlePath)).broker, config.broker);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('preserves safe async request mappings and media presets in signed bundles', async () => {
  const config = brokeredConfig();
  const ref = 'broker.future-miniapp.provider.run.v1';
  config.runtime!.execute!.operations![1]!.capabilities = [ref];
  config.broker = { providers: [{ id: 'provider', name: 'Provider', summary: 'Provider API',
    docsUrl: 'https://example.com/docs', category: 'tools', baseUrl: 'https://example.com/v1/',
    authMethod: 'bearer', operations: [{ id: 'run', version: 1, name: 'Run', purpose: 'Run a job',
      method: 'POST', path: '/run', executionKind: 'http-poll',
      requestMapping: { body: { provider: { const: 'example' }, input: { from: '$' } } },
      poll: { path: '/runs/{job_id}', jobIdField: 'id', statusField: 'status', resultField: 'output',
        successValue: 'done', failureValue: 'failed', failureValues: ['expired'], intervalMs: 1000, maxAttempts: 30 },
      artifact: { path: '/runs/{job_id}/content', kind: 'video', maxBytes: 250000000,
        retentionSeconds: 86400 },
      inputSchema: { type: 'object', additionalProperties: false }, outputSchema: { type: 'object' },
      buyerCredits: 20, providerCostNote: 'Creator pays upstream.' }] }] };
  assert.deepEqual(validateManifest(config), { valid: true, errors: [] });
  const archive = await JSZip.loadAsync(await buildBundle({ config, skillPath: '.', skillIndex: [] }));
  const bundled = JSON.parse(await archive.file('manifest.json')!.async('text'));
  assert.deepEqual(bundled.broker, config.broker);
  config.broker.providers[0]!.operations[0]!.artifact!.path = 'https://other.example/content/{job_id}';
  assert.ok(validateManifest(config).errors.some(error => error.field.endsWith('.artifact')));
  config.broker.providers[0]!.operations[0]!.artifact!.path = '/runs/{job_id}/content';
  config.broker.providers[0]!.operations[0]!.mediaPreset = 'transparent-png-v1';
  assert.ok(validateManifest(config).errors.some(error => error.field.endsWith('.mediaPreset')));
});

test('rejects credentials in provider declarations and undeclared operation references', () => {
  const config = brokeredConfig();
  config.broker = { providers: [{ id: 'search1api', name: 'Search1API', summary: 'Web search',
    docsUrl: 'https://s1.dev/docs', category: 'web-search', baseUrl: 'https://api.search1api.com/',
    authMethod: 'bearer', apiKey: 'secret', operations: [{ id: 'search', version: 1,
      name: 'Search', purpose: 'Search the web', method: 'POST', path: '/search',
      inputSchema: { type: 'object', additionalProperties: false }, outputSchema: { type: 'object' },
      buyerCredits: 20, providerCostNote: 'Creator pays upstream.' }] }] } as unknown as ServiceConfig['broker'];
  const result = validateManifest(config);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some(error => error.field === 'broker.providers[0]'));
});

test('rejects broker call limits outside the signed operation grants', () => {
  const config = brokeredConfig();
  config.runtime!.execute!.operations![1]!.capabilityLimits = { 'broker.other.search.v1': 4 };
  assert.ok(validateManifest(config).errors.some(error => error.field.includes('capabilityLimits')));
});

test('rejects an unbounded total broker call budget', () => {
  const config = brokeredConfig();
  const first = 'broker.future-miniapp.search1api.search.v1';
  const second = 'broker.future-miniapp.search1api.news.v1';
  config.runtime!.execute!.operations![1]!.capabilities = [first, second];
  config.runtime!.execute!.operations![1]!.capabilityLimits = { [first]: 64, [second]: 65 };
  assert.ok(validateManifest(config).errors.some(error => error.field.includes('capabilityLimits')));
});

test('preserves customer-facing presentation metadata in the published manifest', () => {
  const config = brokeredConfig();
  config.presentation = {
    details: 'A detailed explanation written for customers.',
    inputDescription: 'The goal and useful context.',
    outputDescription: 'A finished result to review.',
    highlights: ['Plan the work', 'Create the result', 'Review the output'],
    featuredPrompt: 'Help me prepare this project.',
    examplePrompts: [
      'Help me prepare this project.',
      'Turn these notes into a clear plan.',
      'Review this work and suggest improvements.',
    ],
  };

  const manifest = buildPublishedManifest(config, [], {
    checksum: 'sha256:example',
    signature: 'signature',
  });

  assert.deepEqual(manifest.presentation, config.presentation);
});

test('accepts build-only runtime optimization settings but never publishes them', () => {
  const config = brokeredConfig();
  config.runtime!.build = {
    prunePreset: 'production-node',
    omitOptionalPackages: ['@img/sharp-wasm32'],
    sizeReport: true,
  };
  assert.deepEqual(validateManifest(config), { valid: true, errors: [] });
  const published = buildPublishedManifest(config, [], { checksum: 'checksum', signature: 'signature' });
  assert.equal('build' in published.runtime, false);
});

test('rejects unsafe or unsupported runtime optimization settings', () => {
  const config = brokeredConfig();
  config.runtime!.build = {
    prunePreset: 'other' as 'production-node',
    omitOptionalPackages: ['../../outside'],
  };
  const validation = validateManifest(config);
  assert.equal(validation.valid, false);
  assert.ok(validation.errors.some((error) => error.field === 'runtime.build.prunePreset'));
  assert.ok(validation.errors.some((error) => error.field.startsWith('runtime.build.omitOptionalPackages')));
});

test('rejects non-string customer presentation metadata', () => {
  const config = brokeredConfig();
  config.presentation = {
    details: 42 as unknown as string,
    inputDescription: 'The goal and useful context.',
    outputDescription: 'A finished result to review.',
    highlights: [1, 'Create the result', 'Review the output'] as unknown as string[],
    featuredPrompt: 'Help me prepare this project.',
    examplePrompts: ['One example'] as unknown as string[],
  };

  const validation = validateManifest(config);

  assert.equal(validation.valid, false);
  assert.ok(validation.errors.some((error) => error.field === 'presentation.details'));
  assert.ok(validation.errors.some((error) => error.field === 'presentation.highlights[0]'));
  assert.ok(validation.errors.some((error) => error.field === 'presentation.examplePrompts'));
});

test('rejects ambiguous broker operation matching before publication', () => {
  const config = brokeredConfig();
  config.runtime!.execute!.operations![0]!.argvPrefix = [];
  config.runtime!.execute!.operations![0]!.excludedArgs = ['write'];

  const validation = validateManifest(config);

  assert.equal(validation.valid, false);
  assert.ok(validation.errors.some((error) => /overlaps/.test(error.message)));
});

test('rejects the retired runtime secret-injection contract', () => {
  const config = brokeredConfig();
  (config.runtime as unknown as Record<string, unknown>).injectedSecrets = [{
    key: 'OPENROUTER_API_KEY',
    env: 'OPENROUTER_API_KEY',
    allowedHosts: ['openrouter.ai'],
  }];

  const validation = validateManifest(config);

  assert.equal(validation.valid, false);
  assert.ok(validation.errors.some((error) => error.field === 'runtime.injectedSecrets'));
});

test('rejects destructive broker operations as installation health checks', () => {
  const config = brokeredConfig();
  config.runtime!.execute!.operations![0]!.destructive = true;

  const validation = validateManifest(config);

  assert.equal(validation.valid, false);
  assert.ok(validation.errors.some(
    (error) => error.field === 'runtime.execute.healthCheck.operationId',
  ));
});

test('accepts a completely new mini-app activity contract without product code changes', () => {
  const config = brokeredConfig();
  config.activityProtocolVersion = 1;
  for (const operation of config.runtime!.execute!.operations!) {
    operation.activity = {
      kind: operation.id === 'search' ? 'search' : 'check',
      object: operation.id === 'search' ? 'customer records' : 'service health',
      icon: operation.id === 'search' ? 'search' : 'check',
    };
  }
  assert.deepEqual(validateManifest(config), { valid: true, errors: [] });
});

test('rejects unsafe activity target selectors and arbitrary placeholders', () => {
  const config = brokeredConfig();
  config.activityProtocolVersion = 1;
  for (const operation of config.runtime!.execute!.operations!) {
    operation.activity = { kind: 'run', object: 'task', icon: 'command' };
  }
  config.runtime!.execute!.operations![1]!.activity = {
    kind: 'search',
    object: 'records',
    target: {
      source: 'flag-value',
      key: '--api-key',
      format: 'display-name',
      placement: 'after-object',
    },
    labels: { active: 'Searching for {rawCommand}' },
  };
  const validation = validateManifest(config);
  assert.equal(validation.valid, false);
  assert.ok(validation.errors.some((error) => error.field.endsWith('target.key')));
  assert.ok(validation.errors.some((error) => error.field.endsWith('labels.active')));
});
