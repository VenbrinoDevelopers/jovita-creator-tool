import { describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { model } from 'mongoose';
import { BrokerCatalogService } from '../../src/catalog/broker-catalog.service.js';
import { BrokerOperationSchema } from '../../src/catalog/broker-catalog.schema.js';
import { ProviderMediaValidationError } from '../../src/operations/provider-media.js';

const schema = { type: 'object', properties: { value: { type: 'string' } }, required: ['value'], additionalProperties: false };
const profile = { profileId: 'c0123456789abcdef01234567-search', creatorId: '0123456789abcdef01234567',
  baseUrl: 'https://example.com/', status: 'approved', authMethod: 'bearer', timeoutMs: 30000 };
const operation = { capabilityId: 'creator.c0123456789abcdef01234567-search.query.v1', profileId: profile.profileId,
  creatorId: profile.creatorId, buyerCredits: 5, inputSchema: schema, outputSchema: schema, maxRequestBytes: 1000,
  maxResponseBytes: 1000, method: 'POST', path: '/query' };
const input = { environment: 'test', ownerId: 'buyer', packId: 'tool', capability: operation.capabilityId,
  invocationId: 'invocation', callId: 'call', payload: { value: 'hi' },
  pricingSnapshot: { mode: 'fixed_success', fixedCredits: 5, maxCredits: 5 } };

function fixture(granted = true) {
  const operations = { findOne: vi.fn(() => ({ lean: async () => operation })),
    create: vi.fn(async (value: unknown) => value), updateOne: vi.fn(async () => ({ modifiedCount: 1 })) };
  const profiles = { findOne: vi.fn(async () => profile) };
  const grants = { findOne: vi.fn(() => ({ lean: async () => granted ? {
    creatorId: profile.creatorId, connectionId: 'connection', capabilityId: operation.capabilityId,
  } : null })) };
  const connections = { findOne: vi.fn(() => ({ select: () => ({ lean: async () => ({
    creatorId: profile.creatorId, profileId: profile.profileId, encryptedApiKey: 'secret', testStatus: 'ok',
  }) }) })) };
  const executions = { create: vi.fn(async () => ({})), updateOne: vi.fn(async () => ({ modifiedCount: 1 })),
    findOneAndUpdate: vi.fn(() => ({ lean: async () => ({ executionKey: 'invocation:call' }) })),
    findOne: vi.fn(() => ({ select: () => ({ lean: async () => ({ requestHash: 'mismatch', status: 'started' }) }) })) };
  const uploads = { storeWorkerOutput: vi.fn(async () => ({ attachmentId: 'private-attachment',
    kind: 'video', mimeType: 'video/mp4', size: 12, sha256: 'a'.repeat(64),
    expiresAt: new Date(Date.now() + 3600_000) })) };
  const processing = { probe: vi.fn(async () => ({ durationMs: 1000 })) };
  const service = new BrokerCatalogService(profiles as never, operations as never, connections as never,
    grants as never, executions as never, { encrypt: (value: string) => value, decrypt: (value: string) => value } as never,
    undefined, undefined, uploads as never, processing as never);
  const provider = vi.spyOn((service as any).transport, 'providerRequest').mockResolvedValue({ value: 'ok' });
  return { service, provider, executions, operations, profiles, uploads, processing };
}

describe('creator broker route enforcement', () => {
  it('preserves an empty output schema when serializing an operation', () => {
    const Operation = model('BrokerOperationEmptySchemaRegression', BrokerOperationSchema);
    expect(new Operation({ outputSchema: {} }).toObject().outputSchema).toEqual({});
  });

  it('rejects a route without a tool grant before dispatch', async () => {
    const { service, provider, executions } = fixture(false);
    await expect(service.invoke(input)).rejects.toThrow('Tool has no grant');
    expect(provider).not.toHaveBeenCalled();
    expect(executions.create).not.toHaveBeenCalled();
  });

  it('rotates a saved key at the same connection ID and requires a fresh test', async () => {
    const existing = { connectionId: 'connection_main', creatorId: profile.creatorId,
      profileId: profile.profileId };
    const connections = { findOne: vi.fn(async () => existing),
      findOneAndUpdate: vi.fn(() => ({ select: () => ({ lean: async () => ({
        ...existing, keyFingerprint: 'new-fingerprint', testStatus: 'untested',
      }) }) })) };
    const service = new BrokerCatalogService({ findOne: async () => profile } as never,
      {} as never, connections as never, {} as never, {} as never,
      { encrypt: (value: string) => `encrypted:${value}` } as never);
    await expect(service.saveConnection(profile.creatorId, { connectionId: 'connection_main',
      profileId: profile.profileId, name: 'Main', apiKey: 'rotated-key' }))
      .resolves.toMatchObject({ connectionId: 'connection_main', testStatus: 'untested' });
    expect(connections.findOneAndUpdate).toHaveBeenCalledWith({ connectionId: 'connection_main' },
      expect.objectContaining({ $set: expect.objectContaining({
        encryptedApiKey: 'encrypted:rotated-key', testStatus: 'untested',
      }), $unset: { testedAt: 1 } }), expect.anything());
  });

  it('rejects a stale buyer price before dispatch', async () => {
    const { service, provider } = fixture();
    process.env.BROKER_REQUIRE_PRICE_SNAPSHOT = '1';
    try {
      await expect(service.invoke({ ...input, pricingSnapshot: { mode: 'fixed_success', fixedCredits: 4, maxCredits: 4 } }))
        .rejects.toThrow('Published price does not match');
      expect(provider).not.toHaveBeenCalled();
    } finally {
      delete process.env.BROKER_REQUIRE_PRICE_SNAPSHOT;
    }
  });

  it('journals success and validates the provider result', async () => {
    const { service, provider, executions } = fixture();
    await expect(service.invoke(input)).resolves.toMatchObject({ result: { value: 'ok' }, quantity: 1 });
    expect(provider).toHaveBeenCalledOnce();
    expect(executions.create).toHaveBeenCalledOnce();
    expect(executions.updateOne).toHaveBeenCalledWith(expect.anything(),
      expect.objectContaining({ $set: expect.objectContaining({ status: 'succeeded' }) }));
  });

  it('does not report success when the execution journal cannot be completed', async () => {
    const { service, executions } = fixture();
    executions.updateOne.mockResolvedValueOnce({ modifiedCount: 0 });
    await expect(service.invoke(input)).rejects.toThrow('execution evidence could not be recorded');
  });

  it('replays a journaled success without dispatching the provider twice', async () => {
    const { service, provider, executions } = fixture();
    executions.create.mockRejectedValueOnce({ code: 11000 });
    const requestHash = createHash('sha256').update(JSON.stringify({ packId: input.packId,
      capability: input.capability, payload: input.payload })).digest('hex');
    executions.findOne.mockReturnValueOnce({ select: () => ({ lean: async () => ({
      requestHash, status: 'succeeded', encryptedResult: JSON.stringify({ value: 'cached' }),
    }) }) } as never);
    await expect(service.invoke(input)).resolves.toMatchObject({ result: { value: 'cached' } });
    expect(provider).not.toHaveBeenCalled();
  });

  it('rejects invalid provider output without returning a billable success', async () => {
    const { service, provider, executions } = fixture();
    provider.mockResolvedValue({ missing: true });
    await expect(service.invoke(input)).rejects.toThrow('Provider output failed its schema');
    expect(executions.updateOne).toHaveBeenCalledWith(expect.anything(),
      expect.objectContaining({ $set: expect.objectContaining({ status: 'failed' }) }));
  });

  it('records an explicitly empty result as a zero-charge call', async () => {
    const { service, operations, provider, executions } = fixture();
    operations.findOne.mockReturnValue({ lean: async () => ({ ...operation,
      outputSchema: { type: 'object' }, emptyResultIsNoResult: true }) } as never);
    provider.mockResolvedValue({});
    await expect(service.invoke(input)).resolves.toMatchObject({ result: {}, quantity: 0 });
    expect(executions.updateOne).toHaveBeenCalledWith(expect.anything(),
      expect.objectContaining({ $set: expect.objectContaining({ quantity: 0, status: 'succeeded' }) }));
  });

  it('rejects a named or JSON result exceeding the declared response limit', async () => {
    const { service, operations, provider } = fixture();
    operations.findOne.mockReturnValue({ lean: async () => ({ ...operation, maxResponseBytes: 10 }) } as never);
    provider.mockResolvedValue({ value: 'a result much larger than ten bytes' });
    await expect(service.invoke(input)).rejects.toThrow('Provider result exceeded its limit');
  });

  it('enforces the actual mapped request size and multipart budget', () => {
    const { service } = fixture();
    const mapped = (service as any).transport.mappedBody({ body: {
      first: { from: '$' }, second: { from: '$' },
    } }, { value: '1234567890' });
    expect(() => (service as any).transport.assertOutgoingRequestSize(JSON.stringify(mapped), 35))
      .toThrow('Mapped operation request is too large');
    expect(() => (service as any).transport.multipartBody({ file: {
      dataBase64: Buffer.alloc(100).toString('base64'), filename: 'image.png', contentType: 'image/png',
    } }, 100)).toThrow('Multipart operation request is too large');
  });

  it('blocks private, loopback and metadata addresses', () => {
    const { service } = fixture();
    const publicAddress = (service as any).transport.publicAddress.bind(service) as (value: string) => boolean;
    for (const address of ['127.0.0.1', '10.1.2.3', '172.16.1.1', '192.168.1.1', '169.254.169.254', '::1', 'fc00::1']) {
      expect(publicAddress(address), address).toBe(false);
    }
    expect(publicAddress('8.8.8.8')).toBe(true);
  });

  it('rejects a price that would round creator earnings to zero cents', async () => {
    const { service } = fixture();
    await expect(service.createOperation(profile.creatorId, { profileId: profile.profileId,
      operationId: 'cheap', version: 1, name: 'Cheap', purpose: 'Example', method: 'GET', path: '/query',
      inputSchema: schema, outputSchema: schema, buyerCredits: 1, providerCostNote: 'Provider bills per call',
    })).rejects.toThrow('creator earnings are representable');
  });

  it('keeps an approved API path as a directory for its operation routes', () => {
    const { service } = fixture();
    expect((service as any).rules.baseUrl('https://example.com/v1', true)).toBe('https://example.com/v1/');
    expect(new URL('search', (service as any).rules.baseUrl('https://example.com/v1', true)).pathname).toBe('/v1/search');
  });

  it('maps declared path and query fields without a provider adapter', () => {
    const { service } = fixture();
    const mapped = (service as any).transport.mapRequest(new URL('https://example.com/v1/'), {
      method: 'POST', path: '/people/{person_id}/enrich', queryFields: ['include_history'],
    }, { person_id: 'user/42', include_history: true, company: 'Acme' });
    expect(mapped.url.toString()).toBe('https://example.com/v1/people/user%2F42/enrich?include_history=true');
    expect(mapped.body).toEqual({ company: 'Acme' });
  });

  it('creates a versioned route with declarative mappings and an array output', async () => {
    const { service, operations } = fixture();
    const inputSchema = { type: 'object', properties: { person_id: { type: 'string' },
      limit: { type: 'integer' }, name: { type: 'string' } }, required: ['person_id'],
    additionalProperties: false };
    const outputSchema = { type: 'array', items: { type: 'object' } };
    await service.createOperation(profile.creatorId, { profileId: profile.profileId,
      operationId: 'people', version: 1, name: 'Find people', purpose: 'Find a person',
      method: 'POST', path: '/people/{person_id}/search', queryFields: ['limit'],
      inputSchema, outputSchema, buyerCredits: 5, providerCostNote: 'Provider bills per call',
    });
    expect(operations.create).toHaveBeenCalledWith(expect.objectContaining({
      capabilityId: `creator.${profile.profileId}.people.v1`, queryFields: ['limit'], outputSchema,
    }));
  });

  it('accepts a bounded JSON body mapping and extracts a declared result field', async () => {
    const { service, operations, provider } = fixture();
    await service.createOperation(profile.creatorId, { profileId: profile.profileId,
      operationId: 'mapped', version: 1, name: 'Mapped', purpose: 'Mapped request',
      method: 'POST', path: '/query', inputSchema: schema, outputSchema: schema,
      requestMapping: { body: { query: { from: 'value' }, mode: { const: 'short' } } },
      responseField: 'data', buyerCredits: 5, providerCostNote: 'Provider bills per call' });
    expect(operations.create).toHaveBeenCalledWith(expect.objectContaining({
      requestMapping: { body: { query: { from: 'value' }, mode: { const: 'short' } } },
      responseField: 'data',
    }));
    expect((service as any).transport.mappedBody({ body: { query: { from: 'value' }, mode: { const: 'short' } } },
      { value: 'coffee' })).toEqual({ query: 'coffee', mode: 'short' });
    provider.mockResolvedValue({ data: { value: 'found' } });
    operations.findOne.mockReturnValue({ lean: async () => ({ ...operation, responseField: 'data' }) } as never);
    await expect(service.invoke(input)).resolves.toMatchObject({ result: { value: 'found' } });
  });

  it('imports a manifest operation referenced by the tool without a saved key', async () => {
    const { service, operations } = fixture();
    operations.findOne.mockReturnValue({ lean: async () => null } as never);
    const broker = { providers: [{ id: 'search', name: 'Search', summary: 'Search results',
      docsUrl: 'https://example.com/docs', category: 'search', baseUrl: 'https://example.com',
      authMethod: 'bearer', operations: [{ id: 'query', version: 1, name: 'Query', purpose: 'Search',
        method: 'POST', path: '/query', inputSchema: schema, outputSchema: schema,
        buyerCredits: 5, providerCostNote: 'Provider bills per call' }] }] };
    const alias = 'broker.sample-tool.search.query.v1';
    await expect(service.importManifest(profile.creatorId, 'sample-tool', broker, [alias]))
      .resolves.toEqual({ imported: 1, capabilityIds: [alias] });
    expect(operations.create).toHaveBeenCalledWith(expect.objectContaining({
      capabilityId: operation.capabilityId, creatorId: profile.creatorId,
    }));
    expect(operations.updateOne).toHaveBeenCalledWith({ capabilityId: operation.capabilityId },
      { $addToSet: { manifestAliases: alias } });
    await expect(service.importManifest(profile.creatorId, 'sample-tool', {
      providers: [{ ...broker.providers[0], apiKey: 'must-not-be-in-the-manifest' }],
    }, [alias])).rejects.toThrow('Credentials belong in saved connections');
    await expect(service.importManifest(profile.creatorId, 'sample-tool', broker, []))
      .rejects.toThrow('Declare');
  });

  it('resolves a tool scoped reference to its saved operation and grant', async () => {
    const { service, operations } = fixture();
    const alias = 'broker.tool.search.query.v1';
    await expect(service.invoke({ ...input, capability: alias })).resolves.toMatchObject({
      result: { value: 'ok' },
    });
    expect(operations.findOne).toHaveBeenCalledWith({ manifestAliases: alias });
    await expect(service.invoke({ ...input, packId: 'other-tool', capability: alias }))
      .rejects.toThrow('another tool');
  });

  it('maps GET input into a query string and rejects non-scalar query values', () => {
    const { service } = fixture();
    const route = { method: 'GET', path: '/search', queryFields: [] };
    const mapped = (service as any).transport.mapRequest(new URL('https://example.com/v1/'), route,
      { q: 'red shoes', page: 2 });
    expect(mapped.url.toString()).toBe('https://example.com/v1/search?q=red+shoes&page=2');
    expect(mapped.body).toEqual({});
    expect(() => (service as any).transport.mapRequest(new URL('https://example.com/v1/'), route,
      { filters: ['red'] })).toThrow('Query field must be a string, number or boolean');
  });

  it('constructs bounded multipart fields and rejects arbitrary file metadata', () => {
    const { service } = fixture();
    const multipartBody = (service as any).transport.multipartBody.bind((service as any).transport) as
      (value: Record<string, unknown>, maxBytes: number) => FormData;
    const form = multipartBody({ prompt: 'portrait', image: { dataBase64: 'aW1hZ2U=',
      filename: 'source.png', contentType: 'image/png' } }, 10_000);
    expect(form.get('prompt')).toBe('portrait');
    expect(form.get('image')).toMatchObject({ name: 'source.png', type: 'image/png' });
    expect(() => multipartBody({ image: { dataBase64: 'aW1hZ2U=', filename: '../secret' } }, 10_000))
      .toThrow('Invalid multipart file');
  });

  it('collects bounded server sent events into an output contract', () => {
    const { service } = fixture();
    const streamEvents = (service as any).transport.streamEvents.bind((service as any).transport) as (value: string) => { events: unknown[] };
    expect(streamEvents('data: {"text":"hello"}\n\ndata: [DONE]\n\n').events)
      .toEqual([{ text: 'hello' }]);
    expect(() => streamEvents('event: ping\n\n')).toThrow('no result');
  });

  it('executes a declared asynchronous submit and poll contract', async () => {
    const { service, operations, provider } = fixture();
    const poll = { path: '/jobs/{job_id}', jobIdField: 'job.id', statusField: 'status',
      resultField: 'result', successValue: 'done', failureValue: 'failed', intervalMs: 250, maxAttempts: 2 };
    operations.findOne.mockReturnValue({ lean: async () => ({ ...operation,
      executionKind: 'http-poll', poll }) } as never);
    provider.mockResolvedValueOnce({ job: { id: 'job123' } })
      .mockResolvedValueOnce({ status: 'running' })
      .mockResolvedValueOnce({ status: 'done', result: { value: 'done' } });
    await expect(service.invoke(input)).resolves.toMatchObject({ result: { value: 'done' },
      providerRequestId: 'job123' });
    expect(provider).toHaveBeenCalledTimes(3);
    expect(provider.mock.calls[1]?.[2]).toMatchObject({ method: 'GET', path: '/jobs/{job_id}' });
  });

  it('charges one fixed creator call when a successful async provider reports zero results', async () => {
    const { service, operations, provider } = fixture();
    const poll = { path: '/jobs/{job_id}', jobIdField: 'job.id', statusField: 'status',
      resultField: 'result', successValue: 'done', failureValue: 'failed', intervalMs: 250, maxAttempts: 1 };
    operations.findOne.mockReturnValue({ lean: async () => ({ ...operation,
      executionKind: 'http-poll', poll }) } as never);
    provider.mockResolvedValueOnce({ job: { id: 'job123' } })
      .mockResolvedValueOnce({ status: 'done', resultCount: 0, result: { value: 'valid' } });
    await expect(service.invoke(input)).resolves.toMatchObject({ result: { value: 'valid' }, quantity: 1 });
  });

  it('releases a declared no-result poll outcome without charging a creator call', async () => {
    const { service, operations, provider } = fixture();
    const poll = { path: '/runs/{job_id}', jobIdField: 'runId', statusField: 'status',
      resultField: 'output', successValue: 'COMPLETED', failureValue: 'FAILED',
      providerStatusField: 'providerResponse.httpStatus', noResultStatuses: [404],
      intervalMs: 250, maxAttempts: 1 };
    operations.findOne.mockReturnValue({ lean: async () => ({ ...operation,
      executionKind: 'http-poll', poll, outputSchema: {} }) } as never);
    provider.mockResolvedValueOnce({ runId: 'run123', status: 'QUEUED' })
      .mockResolvedValueOnce({ status: 'COMPLETED', providerResponse: { httpStatus: 404 }, output: {} });
    await expect(service.invoke(input)).resolves.toMatchObject({ result: { noResult: true }, quantity: 0 });
  });

  it('recovers a creator async job with its original credential after key rotation', async () => {
    const { service, operations, provider, executions } = fixture();
    const poll = { path: '/jobs/{job_id}', jobIdField: 'job.id', statusField: 'status',
      resultField: 'result', successValue: 'done', failureValue: 'failed', intervalMs: 250, maxAttempts: 2 };
    operations.findOne.mockReturnValue({ lean: async () => ({ ...operation,
      executionKind: 'http-poll', poll }) } as never);
    executions.findOne.mockReturnValue({ select: () => ({ lean: async () => ({ status: 'started',
      requestHash: 'hash', upstreamRunId: 'job123', encryptedCredential: 'original-encrypted-key' }) }) } as never);
    provider.mockResolvedValue({ status: 'done', result: { value: 'completed' } });
    await expect(service.reconcile({ invocationId: 'invocation', callId: 'call',
      capability: operation.capabilityId, packId: 'tool', environment: 'test' }))
      .resolves.toMatchObject({ status: 'succeeded', result: { result: { value: 'completed' } } });
    expect(provider).toHaveBeenCalledOnce();
    expect(provider.mock.calls[0]?.[1]).toMatchObject({ encryptedApiKey: 'original-encrypted-key' });
    expect(provider.mock.calls[0]?.[2]).toMatchObject({ method: 'GET', path: '/jobs/{job_id}' });
  });

  it('reconciles a completed legacy run whose empty output schema was omitted by MongoDB', async () => {
    const { service, operations, provider, executions } = fixture();
    const poll = { path: '/runs/{job_id}', jobIdField: 'runId', statusField: 'status',
      resultField: 'output', successValue: 'COMPLETED', failureValue: 'FAILED',
      providerStatusField: 'providerResponse.httpStatus', intervalMs: 250, maxAttempts: 1 };
    operations.findOne.mockReturnValue({ lean: async () => ({ ...operation,
      executionKind: 'http-poll', poll, outputSchema: undefined }) } as never);
    executions.findOne.mockReturnValue({ select: () => ({ lean: async () => ({ status: 'started',
      requestHash: 'hash', upstreamRunId: 'run123', encryptedCredential: 'original-encrypted-key',
      ownerId: 'buyer' }) }) } as never);
    provider.mockResolvedValue({ status: 'COMPLETED', providerResponse: { httpStatus: 200 },
      output: { companies: [{ name: 'Example' }] } });
    await expect(service.reconcile({ invocationId: 'invocation', callId: 'call',
      capability: operation.capabilityId, packId: 'tool', environment: 'test' }))
      .resolves.toMatchObject({ status: 'succeeded',
        result: { result: { companies: [{ name: 'Example' }] } } });
    expect(provider).toHaveBeenCalledOnce();
  });

  it('rejects unbounded or unbound poll routes', () => {
    const { service } = fixture();
    const pollDefinition = (service as any).rules.pollDefinition.bind((service as any).rules) as (value: unknown, method: string) => unknown;
    expect(() => pollDefinition({ path: '/jobs/latest', jobIdField: 'id', statusField: 'status',
      successValue: 'done', failureValue: 'failed', intervalMs: 250, maxAttempts: 2 }, 'POST'))
      .toThrow('must contain {job_id}');
    expect(() => pollDefinition({ path: '/jobs/{job_id}', jobIdField: 'id', statusField: 'status',
      successValue: 'done', failureValue: 'failed', intervalMs: 10000, maxAttempts: 60 }, 'POST'))
      .toThrow('Invalid poll timing');
  });

  it('stores a declared completed video privately before recording billable success', async () => {
    const { service, operations, provider, executions, uploads, processing } = fixture();
    const poll = { path: '/videos/{job_id}', jobIdField: 'id', statusField: 'status',
      successValue: 'completed', failureValue: 'failed', failureValues: ['cancelled', 'expired'],
      intervalMs: 250, maxAttempts: 2 };
    operations.findOne.mockReturnValue({ lean: async () => ({ ...operation,
      executionKind: 'http-poll', poll, artifact: { path: '/videos/{job_id}/content',
        kind: 'video', maxBytes: 12, retentionSeconds: 3600 },
      outputSchema: { type: 'object', properties: { attachment_id: { type: 'string' } },
        required: ['attachment_id'] } }) } as never);
    provider.mockResolvedValueOnce({ id: 'job123', status: 'completed' });
    const download = vi.spyOn((service as any).transport, 'downloadMedia').mockResolvedValue({
      path: '/tmp/mock-video', mimeType: 'video/mp4', size: 12, sha256: 'a'.repeat(64),
    });
    await expect(service.invoke(input)).resolves.toMatchObject({
      result: { attachment_id: 'private-attachment', kind: 'video' }, quantity: 1,
      providerRequestId: 'job123',
    });
    expect(executions.create).toHaveBeenCalledWith(expect.objectContaining({ ownerId: 'buyer' }));
    expect(executions.updateOne).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      $set: expect.objectContaining({ upstreamRunId: 'job123' }),
    }));
    expect(download).toHaveBeenCalledWith(expect.anything(), expect.anything(),
      '/videos/{job_id}/content', 'job123', 'video', 12, expect.any(String), 30000);
    expect(processing.probe).toHaveBeenCalledWith(expect.any(String), 'video');
    expect(uploads.storeWorkerOutput).toHaveBeenCalledWith('buyer', expect.objectContaining({
      sourceKey: expect.stringMatching(/^broker:[a-f0-9]{64}$/),
      expiresAt: expect.any(Date),
    }));
    expect(executions.updateOne).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      $set: expect.objectContaining({ status: 'succeeded' }),
    }));
  });

  it('rejects a completed job that declares an expired terminal state', async () => {
    const { service, operations, provider, uploads } = fixture();
    const poll = { path: '/videos/{job_id}', jobIdField: 'id', statusField: 'status',
      successValue: 'completed', failureValue: 'failed', failureValues: ['expired'],
      intervalMs: 250, maxAttempts: 1 };
    operations.findOne.mockReturnValue({ lean: async () => ({ ...operation,
      executionKind: 'http-poll', poll, artifact: { path: '/videos/{job_id}/content',
        kind: 'video', maxBytes: 12, retentionSeconds: 3600 } }) } as never);
    provider.mockResolvedValueOnce({ id: 'job123', status: 'expired' });
    await expect(service.invoke(input)).rejects.toThrow('Provider job failed');
    expect(uploads.storeWorkerOutput).not.toHaveBeenCalled();
  });

  it('records malformed provider media as a known failure without a buyer charge', async () => {
    const { service, operations, provider, executions } = fixture();
    const poll = { path: '/videos/{job_id}', jobIdField: 'id', statusField: 'status',
      successValue: 'completed', failureValue: 'failed', intervalMs: 250, maxAttempts: 1 };
    operations.findOne.mockReturnValue({ lean: async () => ({ ...operation,
      executionKind: 'http-poll', poll, artifact: { path: '/videos/{job_id}/content',
        kind: 'video', maxBytes: 12, retentionSeconds: 3600 } }) } as never);
    provider.mockResolvedValueOnce({ id: 'job123', status: 'completed' });
    vi.spyOn((service as any).transport, 'downloadMedia')
      .mockRejectedValue(new ProviderMediaValidationError('Provider media signature mismatch'));
    await expect(service.invoke(input)).rejects.toThrow('not valid media');
    expect(executions.updateOne).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      $set: expect.objectContaining({ status: 'failed' }),
    }));
  });

  it('does not download the same completed job while another broker holds its media lease', async () => {
    const { service, operations, provider, executions } = fixture();
    const poll = { path: '/videos/{job_id}', jobIdField: 'id', statusField: 'status',
      successValue: 'completed', failureValue: 'failed', intervalMs: 250, maxAttempts: 1 };
    operations.findOne.mockReturnValue({ lean: async () => ({ ...operation,
      executionKind: 'http-poll', poll, artifact: { path: '/videos/{job_id}/content',
        kind: 'video', maxBytes: 12, retentionSeconds: 3600 } }) } as never);
    provider.mockResolvedValueOnce({ id: 'job123', status: 'completed' });
    executions.findOneAndUpdate.mockReturnValueOnce({ lean: async () => null } as never);
    const download = vi.spyOn((service as any).transport, 'downloadMedia');
    await expect(service.invoke(input)).rejects.toThrow('already being recovered');
    expect(download).not.toHaveBeenCalled();
  });

  it('requires bounded same-host media paths and retention', () => {
    const { service } = fixture();
    const artifactDefinition = (service as any).rules.artifactDefinition.bind((service as any).rules);
    expect(artifactDefinition({ path: '/videos/{job_id}/content', kind: 'video',
      maxBytes: 250 * 1024 * 1024, retentionSeconds: 86400 }, 'http-poll'))
      .toMatchObject({ kind: 'video', retentionSeconds: 86400 });
    expect(() => artifactDefinition({ path: 'https://evil.example/{job_id}', kind: 'video',
      maxBytes: 100, retentionSeconds: 86400 }, 'http-poll')).toThrow('Download path');
    expect(() => artifactDefinition({ path: '/videos/{job_id}', kind: 'video',
      maxBytes: 250 * 1024 * 1024 + 1, retentionSeconds: 86400 }, 'http-poll'))
      .toThrow('download limit');
  });

  it('accepts an OpenRouter-style video workflow as data without a provider executor', async () => {
    const { service, profiles, operations } = fixture();
    profiles.findOne.mockResolvedValue({ ...profile, baseUrl: 'https://openrouter.ai/api/v1/' });
    const inputSchema = { type: 'object', properties: { model: { type: 'string' },
      prompt: { type: 'string' } }, required: ['model', 'prompt'], additionalProperties: false };
    const outputSchema = { type: 'object', properties: { attachment_id: { type: 'string' },
      kind: { const: 'video' }, mime_type: { type: 'string' }, size: { type: 'integer' },
      sha256: { type: 'string' } }, required: ['attachment_id', 'kind', 'mime_type', 'size', 'sha256'],
      additionalProperties: false };
    await service.createOperation(profile.creatorId, { profileId: profile.profileId,
      operationId: 'video', version: 1, name: 'Video', purpose: 'Generate a video',
      method: 'POST', path: '/videos', executionKind: 'http-poll',
      poll: { path: '/videos/{job_id}', jobIdField: 'id', statusField: 'status',
        successValue: 'completed', failureValue: 'failed', failureValues: ['cancelled', 'expired'],
        intervalMs: 1000, maxAttempts: 60 },
      artifact: { path: '/videos/{job_id}/content', kind: 'video',
        maxBytes: 250 * 1024 * 1024, retentionSeconds: 86400, timeoutMs: 120000 },
      inputSchema, outputSchema, buyerCredits: 20, providerCostNote: 'Creator pays OpenRouter',
    });
    expect(operations.create).toHaveBeenCalledWith(expect.objectContaining({
      executionKind: 'http-poll', path: '/videos', buyerCredits: 20,
      artifact: expect.objectContaining({ path: '/videos/{job_id}/content', kind: 'video' }),
    }));
    expect((service as any).transport.mapRequest(new URL('https://openrouter.ai/api/v1/'),
      { method: 'POST', path: '/videos', queryFields: [] },
      { model: 'google/veo-3.1', prompt: 'Sunset' }).url.toString())
      .toBe('https://openrouter.ai/api/v1/videos');
  });
});
