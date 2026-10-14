import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import { test } from 'node:test';

const origin = process.env.BROKER_INTEGRATION_URL;
const secret = process.env.JOVITA_BROKER_SHARED_SECRET;
const creatorId = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const packId = `echo-${randomUUID().slice(0, 8)}`;
const providerId = 'echo';
const profileId = `c${creatorId}-${providerId}`;
const reference = `broker.${packId}.${providerId}.lookup.v1`;
const capabilityId = `creator.${profileId}.lookup.v1`;

async function post(path, body = {}) {
  const payload = JSON.stringify(body);
  const timestamp = String(Date.now());
  const nonce = randomUUID();
  const signature = createHmac('sha256', secret)
    .update(`${timestamp}\n${nonce}\n${path}\n${payload}`).digest('hex');
  const response = await fetch(new URL(path, origin), { method: 'POST', body: payload,
    headers: { 'content-type': 'application/json', 'x-broker-timestamp': timestamp,
      'x-broker-nonce': nonce, 'x-broker-signature': signature } });
  const value = await response.json();
  assert.equal(response.status, 201, JSON.stringify(value));
  return value;
}

test('standalone manifest, approval, key test and rotation, grant, invoke and duplicate recovery',
  { skip: !origin || !secret }, async () => {
    const health = await fetch(new URL('/health', origin));
    assert.equal(health.status, 200);
    const broker = { providers: [{ id: providerId, name: 'Echo', summary: 'Test JSON echo',
      docsUrl: 'https://postman-echo.com/', category: 'testing', baseUrl: 'https://postman-echo.com/',
      authMethod: 'bearer', operations: [{ id: 'lookup', version: 1, name: 'Lookup',
        purpose: 'Return the supplied query', method: 'GET', path: '/get',
        inputSchema: { type: 'object', properties: { query: { type: 'string' } },
          required: ['query'], additionalProperties: false },
        outputSchema: { type: 'object' }, queryFields: ['query'], buyerCredits: 10,
        providerCostNote: 'The test uses a dummy credential.' }] }] };
    const imported = await post('/internal/broker/catalog/manifest/import',
      { creatorId, packId, broker, capabilities: [reference] });
    assert.deepEqual(imported.capabilityIds, [reference]);
    await post('/internal/broker/catalog/profile/approve', { profileId, adminId: creatorId });
    const connection = await post('/internal/broker/catalog/connection', { creatorId,
      connection: { profileId, name: 'Echo test', apiKey: 'dummy-key-one' } });
    assert.equal(connection.testStatus, 'untested');
    await post('/internal/broker/catalog/connection/test', { creatorId,
      connectionId: connection.connectionId, capabilityId, sampleInput: { query: 'first' } });
    await post('/internal/broker/catalog/grant', { creatorId,
      grant: { packId, connectionId: connection.connectionId, capabilityId } });
    const call = { environment: 'development', ownerId: creatorId, packId,
      invocationId: randomUUID(), callId: randomUUID(), operationId: 'lookup',
      capability: reference, payload: { query: 'first' } };
    const first = await post('/internal/broker/invoke', call);
    assert.equal(first.result.args.query, 'first');
    const replay = await post('/internal/broker/invoke', call);
    assert.deepEqual(replay.result, first.result);
    assert.equal(replay.quantity, first.quantity);
    assert.equal(replay.providerCostMicros, first.providerCostMicros);
    const rotated = await post('/internal/broker/catalog/connection', { creatorId,
      connection: { connectionId: connection.connectionId, profileId,
        name: 'Echo test', apiKey: 'dummy-key-two' } });
    assert.equal(rotated.testStatus, 'untested');
    await post('/internal/broker/catalog/connection/test', { creatorId,
      connectionId: connection.connectionId, capabilityId, sampleInput: { query: 'second' } });
    const second = await post('/internal/broker/invoke', { ...call,
      callId: randomUUID(), payload: { query: 'second' } });
    assert.equal(second.result.args.query, 'second');
  });
