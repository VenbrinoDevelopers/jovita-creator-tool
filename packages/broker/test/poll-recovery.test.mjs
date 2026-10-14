import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BrokerExecutionService } from '../dist/operations/broker-execution.service.js';

test('pending submit is journaled and duplicate call resumes polling without resubmitting', async () => {
  const rows = new Map();
  const executions = {
    async create(row) {
      if (rows.has(row.executionKey)) throw { code: 11000 };
      rows.set(row.executionKey, { ...row });
    },
    findOne(query) {
      return { select() { return this; }, async lean() {
        const row = rows.get(query.executionKey);
        return row && (!query.status || row.status === query.status) ? { ...row } : null;
      } };
    },
    async updateOne(query, changes) {
      const row = rows.get(query.executionKey);
      if (!row || (query.status && row.status !== query.status)
        || (query.requestHash && row.requestHash !== query.requestHash)
        || (query.upstreamRunId?.$exists === false && row.upstreamRunId)) return { modifiedCount: 0 };
      Object.assign(row, changes.$set ?? {});
      for (const field of Object.keys(changes.$unset ?? {})) delete row[field];
      return { modifiedCount: 1 };
    },
  };
  const crypto = { encrypt: value => `enc:${value}`, decrypt: value => value.slice(4) };
  let submits = 0;
  let polls = 0;
  const transport = {
    readField: (value, path) => path.split('.').reduce((row, part) => row?.[part], value),
    async providerRequest(_profile, _connection, operation) {
      if (operation.method === 'POST') { submits += 1; return { jobId: 'job_123', status: 'queued' }; }
      polls += 1;
      if (polls === 1) throw new Error('poll connection dropped');
      return { status: 'complete', output: { answer: 'ready' } };
    },
  };
  const engine = new BrokerExecutionService(executions, {}, {}, crypto, transport);
  const operation = { capabilityId: 'creator.test.job.v1', executionKind: 'http-poll',
    method: 'POST', path: '/jobs', queryFields: [], inputSchema: { type: 'object' },
    outputSchema: { type: 'object', properties: { answer: { type: 'string' } },
      required: ['answer'] }, maxRequestBytes: 1024,
    maxResponseBytes: 1024, emptyResultIsNoResult: false,
    poll: { path: '/jobs/{job_id}', jobIdField: 'jobId', statusField: 'status',
      resultField: 'output', successValue: 'complete', failureValue: 'failed',
      intervalMs: 250, maxAttempts: 2 } };
  const input = { environment: 'test', ownerId: 'owner', packId: 'app',
    invocationId: 'invocation', callId: 'call', capability: operation.capabilityId,
    payload: { query: 'test' } };
  const profile = { baseUrl: 'https://provider.example/', authMethod: 'bearer', timeoutMs: 1000 };
  const connection = { encryptedApiKey: crypto.encrypt('dummy') };
  await assert.rejects(engine.invokePlan(input, profile, connection, operation),
    { code: 'INVOCATION_OUTCOME_UNKNOWN' });
  assert.equal(rows.get('invocation:call').upstreamRunId, 'job_123');
  const recovered = await engine.invokePlan(input, profile, connection, operation);
  assert.deepEqual(recovered.result, { answer: 'ready' });
  assert.equal(submits, 1);
  assert.equal(polls, 2);
  const replay = await engine.invokePlan(input, profile, connection, operation);
  assert.deepEqual(replay.result, recovered.result);
  assert.equal(submits, 1);
});

test('declared provider status releases a no-result call and rejects other provider errors', async () => {
  let providerStatus = 404;
  const transport = {
    readField: (value, path) => path.split('.').reduce((row, part) => row?.[part], value),
    async providerRequest(_profile, _connection, operation) {
      return operation.method === 'POST'
        ? { runId: 'run_1', status: 'QUEUED' }
        : { status: 'COMPLETED', providerResponse: { httpStatus: providerStatus }, output: {} };
    },
  };
  const engine = new BrokerExecutionService({}, {}, {}, {}, transport);
  const operation = { capabilityId: 'creator.test.lookup.v1', executionKind: 'http-poll',
    method: 'POST', path: '/run', queryFields: [], maxRequestBytes: 1024,
    maxResponseBytes: 1024, inputSchema: { type: 'object' }, outputSchema: {},
    poll: { path: '/runs/{job_id}', jobIdField: 'runId', statusField: 'status',
      resultField: 'output', successValue: 'COMPLETED', failureValue: 'FAILED',
      providerStatusField: 'providerResponse.httpStatus', noResultStatuses: [404],
      intervalMs: 250, maxAttempts: 1 } };
  const result = await engine.executeOperation({}, {}, operation, {});
  assert.equal(result.quantity, 0);
  assert.equal(result.result.noResult, true);
  providerStatus = 429;
  await assert.rejects(engine.executeOperation({}, {}, operation, {}),
    error => error.response?.code === 'PROVIDER_RATE_LIMITED');
});
