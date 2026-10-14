import assert from 'node:assert/strict';
import { it } from 'vitest';
import { JovitaMediaLifecycle } from '../../src/providers/jovita-media/jovita-media.lifecycle.js';

it('status reports pre-dispatch failures as validation rather than asset finalization', () => {
  const adapter = new JovitaMediaLifecycle({}, {});
  const status = adapter.view({
    jobId: 'media-invalid', providerState: 'failed', assetState: 'pending', deliveryState: 'pending',
    failureCode: 'VIDEO_DURATION_UNSUPPORTED',
  });
  assert.equal(status.status, 'failed');
  assert.equal(status.failure_phase, 'validation');
  assert.equal(status.error.code, 'VIDEO_DURATION_UNSUPPORTED');
});
it('settled video status reports the verified invocation charge', async () => {
  const job = { jobId: 'video-1', invocationId: 'inv-1', providerState: 'succeeded',
    assetState: 'ready', deliveryState: 'delivered', billingState: 'settled' };
  const invocationModel = { findOne: query => {
    assert.equal(query.ownerId, 'owner-1');
    return { select: () => ({ lean: () => ({ exec: async () => ({ settledCredits: 600 }) }) }) };
  } };
  const adapter = new JovitaMediaLifecycle({ get: async () => job, providerRejectionDetails: async () => null }, {}, undefined, invocationModel);
  const result = await adapter.invoke({ capability: 'jovita.media.status', payload: { job_id: 'video-1' },
    ownerId: 'owner-1', environment: 'test', invocationId: 'inv-1', callId: 'status-1',
    operationId: 'status', pricingSnapshot: { mode: 'free' } });
  assert.equal(result.result.invocation_credits_charged, 600);
});
it('failed video status exposes only scoped, sanitized provider rejection details', async () => {
  const job = { jobId: 'video-failed', providerState: 'failed', assetState: 'pending',
    deliveryState: 'pending', billingState: 'settled', failureCode: 'PROVIDER_REJECTED' };
  const adapter = new JovitaMediaLifecycle({ get: async () => job,
    providerRejectionDetails: async () => ({ status: 400, code: 'INVALID_REFERENCE', message: 'Image reference is invalid' }) }, {}, undefined);
  const result = await adapter.invoke({ capability: 'jovita.media.status', payload: { job_id: 'video-failed' },
    ownerId: 'owner-1', environment: 'test', invocationId: 'inv-1', callId: 'status-2',
    operationId: 'status', pricingSnapshot: { mode: 'free' } });
  assert.deepEqual(result.result.provider_rejection,
    { status: 400, code: 'INVALID_REFERENCE', message: 'Image reference is invalid' });
});
