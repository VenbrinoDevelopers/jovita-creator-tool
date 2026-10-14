import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { SecretCryptoService } from '../../core/security/secret-crypto.service.js';
import { MediaJob } from './media-job.schema.js';
import { assertProviderTransition, mediaRequestHash, pollDelayMs, validateCost, type CostSource, type ProviderState } from './media-job.state.js';
import { MEDIA_JOB_LEASE_MS } from './media-job-timing.js';

const MAX_AUTOMATED_ATTEMPTS = 50;

// Only immutable local evidence writes are retried here, never a provider POST.
async function retryAudioJournalWrite<T>(write: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try { return await write(); }
    catch (error) {
      if (attempt === 2) throw error;
      await delay(100 * (attempt + 1));
    }
  }
}

export interface MediaJobSubmission {
  ownerId: string; environment: string; conversationId: string; packId: string;
  invocationId: string; callId: string; operationId: string; submissionId: string;
  provider: string; model: string; request: Record<string, unknown>; pricingSnapshot: Record<string, unknown>;
}

/** Internal store: callers derive owner/invocation/pricing from authenticated server context. */
@Injectable()
export class MediaJobService {
  constructor(@InjectModel(MediaJob.name) private readonly jobs: Model<MediaJob>, private readonly crypto: SecretCryptoService) {}

  /** Internal encrypted recovery journal, not a user-visible attachment. Each BSON document is bounded. */
  async saveAudioResult(job: MediaJob, bytes: Buffer, evidence: Record<string, unknown>): Promise<void> {
    if (!bytes.length || bytes.length > 100 * 1024 * 1024) throw new ConflictException('Invalid audio journal size');
    await this.readWork(job); // Verify current ownership/lease fencing before accepting evidence.
    const journal = this.jobs.db.collection<any>('media_job_audio_results');
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const chunkSize = 1024 * 1024;
    const count = Math.ceil(bytes.length / chunkSize);
    for (let index = 0; index < count; index++) {
      const chunk = bytes.subarray(index * chunkSize, (index + 1) * chunkSize);
      await retryAudioJournalWrite(() => journal.updateOne({ _id: `${job.jobId}:${sha256}:${index}` }, { $setOnInsert: {
        ownerId: job.ownerId, environment: job.environment, jobId: job.jobId,
        encrypted: this.crypto.encrypt(chunk.toString('base64')),
      } }, { upsert: true, writeConcern: { w: 'majority' } }));
    }
    const manifest = { ownerId: job.ownerId, environment: job.environment, jobId: job.jobId,
      sha256, size: bytes.length, count, evidenceHash: mediaRequestHash(evidence), evidenceEncrypted: this.crypto.encrypt(JSON.stringify(evidence)) };
    await retryAudioJournalWrite(() => journal.updateOne({ _id: `${job.jobId}:manifest` }, { $setOnInsert: manifest }, { upsert: true, writeConcern: { w: 'majority' } }));
    const stored = await journal.findOne({ _id: `${job.jobId}:manifest` });
    if (stored?.sha256 !== sha256 || stored.evidenceHash !== manifest.evidenceHash || stored.ownerId !== job.ownerId || stored.environment !== job.environment) {
      throw new ConflictException('Conflicting audio recovery evidence');
    }
  }

  async readAudioResult(job: MediaJob): Promise<{ bytes: Buffer; evidence: Record<string, unknown> } | null> {
    const journal = this.jobs.db.collection<any>('media_job_audio_results');
    const scope = { ownerId: job.ownerId, environment: job.environment, jobId: job.jobId };
    const manifest = await journal.findOne({ _id: `${job.jobId}:manifest`, ...scope });
    if (!manifest) return null;
    if (!Number.isSafeInteger(manifest.count) || manifest.count < 1 || manifest.count > 100
      || !Number.isSafeInteger(manifest.size) || manifest.size < 1 || manifest.size > 100 * 1024 * 1024) throw new ConflictException('Invalid audio journal');
    const chunks: Buffer[] = [];
    for (let index = 0; index < manifest.count; index++) {
      const row = await journal.findOne({ _id: `${job.jobId}:${manifest.sha256}:${index}`, ...scope });
      if (!row) throw new ConflictException('Audio journal chunk missing');
      const chunk = Buffer.from(this.crypto.decrypt(row.encrypted), 'base64');
      if (chunk.length > 1024 * 1024) throw new ConflictException('Audio journal chunk exceeds limit');
      chunks.push(chunk);
    }
    const bytes = Buffer.concat(chunks);
    if (bytes.length !== manifest.size || createHash('sha256').update(bytes).digest('hex') !== manifest.sha256) throw new ConflictException('Audio journal checksum mismatch');
    const evidence = JSON.parse(this.crypto.decrypt(manifest.evidenceEncrypted));
    if (mediaRequestHash(evidence) !== manifest.evidenceHash) throw new ConflictException('Audio journal evidence mismatch');
    return { bytes, evidence };
  }

  async submit(input: MediaJobSubmission): Promise<MediaJob> {
    for (const key of ['ownerId', 'environment', 'conversationId', 'packId', 'invocationId', 'callId', 'operationId', 'submissionId', 'provider', 'model'] as const) {
      if (typeof input[key] !== 'string' || !input[key].trim() || input[key].length > 200) throw new ConflictException(`Invalid media job ${key}`);
    }
    const { request, ...fields } = input;
    const requestHash = mediaRequestHash({ request, model: input.model, provider: input.provider, operationId: input.operationId });
    const key = { environment: input.environment, invocationId: input.invocationId, submissionId: input.submissionId };
    const existing = await this.jobs.findOne(key).lean();
    if (existing) return this.replay(existing, input, requestHash);
    const jobId = `media_${randomUUID()}`;
    try {
      const created = await this.jobs.create({ ...fields, jobId, requestHash,
        requestEncrypted: this.crypto.encrypt(JSON.stringify(request)), deliveryKey: `media:${jobId}:originals` });
      const publicRecord = created.toObject();
      delete publicRecord.requestEncrypted;
      return publicRecord;
    } catch (error) {
      if (typeof error !== 'object' || error === null || !('code' in error) || error.code !== 11000) throw error;
      const winner = await this.jobs.findOne(key).lean();
      if (!winner) throw error;
      return this.replay(winner, input, requestHash);
    }
  }

  private replay(job: MediaJob, input: MediaJobSubmission, hash: string): MediaJob {
    if (job.ownerId !== input.ownerId || job.packId !== input.packId || job.conversationId !== input.conversationId
      || job.requestHash !== hash) throw new ConflictException('Submission ID already belongs to a different media request');
    return job;
  }

  async get(ownerId: string, environment: string, jobId: string): Promise<MediaJob> {
    const job = await this.jobs.findOne({ ownerId, environment, jobId }).lean();
    if (!job) throw new NotFoundException('Media job not found');
    return job;
  }

  async providerRejectionDetails(job: MediaJob): Promise<{ status: number; code?: string; message?: string } | null> {
    if (job.failureCode !== 'PROVIDER_REJECTED') return null;
    const stored = await this.jobs.findOne({ ownerId: job.ownerId, environment: job.environment,
      jobId: job.jobId }).select('+resultEncrypted').lean();
    if (!stored?.resultEncrypted || !stored.terminalEvidenceHash) return null;
    try {
      const result = JSON.parse(this.crypto.decrypt(stored.resultEncrypted)) as Record<string, unknown>;
      if (mediaRequestHash(result) !== stored.terminalEvidenceHash
        || result.rejected !== true || !Number.isSafeInteger(result.status)) return null;
      return {
        status: Number(result.status),
        ...(typeof result.provider_code === 'string' ? { code: result.provider_code } : {}),
        ...(typeof result.provider_message === 'string' ? { message: result.provider_message } : {}),
      };
    } catch { return null; }
  }

  async lease(now = new Date()): Promise<MediaJob | null> {
    // A paid POST may have reached the provider even when its response was
    // lost. Enforce the no-resubmit rule in the store, not in worker folklore.
    await this.jobs.updateMany({
      providerState: 'dispatching',
      leaseUntil: { $lte: now },
      deadLetteredAt: { $exists: false },
    }, {
      $set: {
        providerState: 'unknown',
        failureCode: 'DISPATCH_OUTCOME_UNKNOWN',
        deadLetteredAt: now,
      },
      $unset: { leaseToken: 1, leaseUntil: 1 },
      $inc: { revision: 1 },
    }).exec();
    await this.jobs.updateMany({
      attempts: { $gte: MAX_AUTOMATED_ATTEMPTS },
      deadLetteredAt: { $exists: false },
      $nor: [{ providerState: 'succeeded', assetState: 'ready', deliveryState: 'pending' }],
      $or: [
        { billingState: { $ne: 'settled' } },
        { providerState: 'succeeded', deliveryState: { $ne: 'delivered' } },
        { providerState: { $in: ['queued', 'running', 'unknown'] } },
      ],
    }, {
      $set: { failureCode: 'RETRY_LIMIT_EXCEEDED', deadLetteredAt: now },
      $unset: { leaseToken: 1, leaseUntil: 1 },
      $inc: { revision: 1 },
    }).exec();
    return this.jobs.findOneAndUpdate({
      nextAttemptAt: { $lte: now },
      deadLetteredAt: { $exists: false },
      $and: [
        { $or: [
          { attempts: { $lt: MAX_AUTOMATED_ATTEMPTS } },
          { providerState: 'succeeded', assetState: 'ready', deliveryState: 'pending' },
        ] },
        { $or: [{ leaseUntil: { $exists: false } }, { leaseUntil: { $lte: now } }] },
        { $or: [
          { providerState: { $in: ['queued', 'dispatching', 'running'] } },
          { providerState: 'unknown', providerRequestId: { $type: 'string' } },
          { providerState: { $in: ['succeeded', 'failed', 'cancelled'] }, billingState: { $ne: 'settled' } },
          { providerState: 'succeeded', deliveryState: { $ne: 'delivered' } },
        ] },
      ],
    }, { $set: { leaseToken: randomUUID(), leaseUntil: new Date(now.getTime() + MEDIA_JOB_LEASE_MS) }, $inc: { attempts: 1, revision: 1 } },
    { returnDocument: 'after', sort: { nextAttemptAt: 1 } }).lean();
  }

  async requeueForReconciliation(ownerId: string, environment: string, jobId: string): Promise<MediaJob> {
    const current = await this.get(ownerId, environment, jobId);
    if (!current.deadLetteredAt) return current;
    if (current.providerState === 'unknown' && !current.providerRequestId) {
      throw new ConflictException('Unknown paid submission has no provider identity and requires manual evidence');
    }
    const updated = await this.jobs.findOneAndUpdate(
      { ownerId, environment, jobId, deadLetteredAt: { $exists: true } },
      {
        $set: { nextAttemptAt: new Date(), attempts: 0 },
        $unset: { deadLetteredAt: 1, failureCode: 1, leaseToken: 1, leaseUntil: 1 },
        $inc: { revision: 1 },
      },
      { returnDocument: 'after' },
    ).lean();
    if (!updated) throw new ConflictException('Media job reconciliation state changed');
    return updated;
  }

  async recoverySummary(environment: string): Promise<{ deadLettered: number; unsettled: number; undelivered: number }> {
    const [deadLettered, unsettled, undelivered] = await Promise.all([
      this.jobs.countDocuments({ environment, deadLetteredAt: { $exists: true } }).exec(),
      this.jobs.countDocuments({ environment, billingState: { $ne: 'settled' } }).exec(),
      this.jobs.countDocuments({ environment, providerState: 'succeeded', deliveryState: { $ne: 'delivered' } }).exec(),
    ]);
    return { deadLettered, unsettled, undelivered };
  }

  /** Provider work is complete, so replay can only recover local persistence. */
  async listRecoverableAssetDeadLetters(limit = 100): Promise<MediaJob[]> {
    return this.jobs.find({
      providerState: 'succeeded',
      assetState: 'pending',
      deadLetteredAt: { $exists: true },
    }).sort({ deadLetteredAt: 1 }).limit(Math.max(1, Math.min(500, limit))).lean();
  }

  /**
   * Jobs that exhausted retries before dispatch have no possible provider
   * charge. Finalize them locally so their invocation reservation is released;
   * never revive them into a new paid submission during reconciliation.
   */
  async listTerminalizablePreDispatchDeadLetters(limit = 100): Promise<MediaJob[]> {
    return this.jobs.find({
      provider: 'openrouter',
      providerState: 'queued',
      providerRequestId: { $exists: false },
      billingState: { $ne: 'settled' },
      deadLetteredAt: { $exists: true },
    }).sort({ deadLetteredAt: 1 }).limit(Math.max(1, Math.min(500, limit))).lean();
  }

  async finalizePreDispatchDeadLetter(ownerId: string, environment: string, jobId: string): Promise<MediaJob | null> {
    const evidence = { code: 'PRE_DISPATCH_RETRY_LIMIT_EXCEEDED', rejected: true };
    return this.jobs.findOneAndUpdate({
      ownerId, environment, jobId,
      provider: 'openrouter',
      providerState: 'queued',
      providerRequestId: { $exists: false },
      billingState: { $ne: 'settled' },
      deadLetteredAt: { $exists: true },
    }, {
      $set: {
        providerState: 'failed',
        providerCostMicros: 0,
        costSource: 'openrouter_usage',
        billingState: 'measured',
        failureCode: evidence.code,
        terminalEvidenceHash: mediaRequestHash(evidence),
        resultEncrypted: this.crypto.encrypt(JSON.stringify(evidence)),
        leaseToken: randomUUID(),
        leaseUntil: new Date(Date.now() + MEDIA_JOB_LEASE_MS),
        nextAttemptAt: new Date(),
        attempts: 0,
      },
      $unset: { deadLetteredAt: 1 },
      $inc: { revision: 1 },
    }, { returnDocument: 'after' }).lean();
  }

  private fence(job: MediaJob, now = new Date()) {
    if (!job.leaseToken) throw new ConflictException('Media job lease required');
    return { jobId: job.jobId, leaseToken: job.leaseToken, leaseUntil: { $gt: now }, revision: job.revision };
  }

  private async mutate(
    job: MediaJob,
    set: Record<string, unknown>,
    unset: Record<string, 1> = {},
    inc: Record<string, number> = {},
  ): Promise<MediaJob> {
    const next = await this.jobs.findOneAndUpdate(this.fence(job), {
      $set: set, $inc: { revision: 1, ...inc }, ...(Object.keys(unset).length ? { $unset: unset } : {}),
    }, { returnDocument: 'after' }).lean();
    if (!next) throw new ConflictException('Media job lease or revision changed');
    return next;
  }

  async heartbeat(job: MediaJob): Promise<void> {
    if (!job.leaseToken) throw new ConflictException('Media job lease required');
    const result = await this.jobs.updateOne(
      { jobId: job.jobId, leaseToken: job.leaseToken, leaseUntil: { $gt: new Date() } },
      { $set: { leaseUntil: new Date(Date.now() + MEDIA_JOB_LEASE_MS) } },
    ).exec();
    if (!result.matchedCount) throw new ConflictException('Media job lease changed');
  }

  /** Commit dispatching BEFORE the only paid POST. Reclaimed dispatching jobs become unknown, never queued. */
  transition(job: MediaJob, state: ProviderState, providerRequestId?: string): Promise<MediaJob> {
    if (['succeeded', 'failed', 'cancelled'].includes(state)) throw new ConflictException('Terminal evidence is required');
    assertProviderTransition(job.providerState, state);
    if (providerRequestId && (providerRequestId.length > 200 || (job.providerRequestId && job.providerRequestId !== providerRequestId))) {
      throw new ConflictException('Provider request identity changed');
    }
    return this.mutate(job, { providerState: state, ...(providerRequestId ? { providerRequestId } : {}) });
  }

  quarantineUnknownDispatch(job: MediaJob): Promise<MediaJob> {
    if (job.providerState !== 'dispatching') throw new ConflictException('Only an in-flight dispatch can be quarantined');
    return this.mutate(job, { providerState: 'unknown', failureCode: 'DISPATCH_OUTCOME_UNKNOWN', deadLetteredAt: new Date() }, { leaseToken: 1, leaseUntil: 1 });
  }

  async beginPoll(job: MediaJob): Promise<{ job: MediaJob; callId: string }> {
    if (!job.providerRequestId || !['running', 'unknown'].includes(job.providerState)) throw new ConflictException('No pollable provider job');
    if (job.pendingPollId) return { job, callId: job.pendingPollId };
    const callId = `${job.jobId}:poll:${job.pollSequence}`;
    return { job: await this.mutate(job, { pendingPollId: callId }), callId };
  }

  finishPoll(job: MediaJob): Promise<MediaJob> {
    if (!job.pendingPollId) throw new ConflictException('No pending poll');
    // A successful status check is normal progress, not a processing failure.
    // Return this lease's attempt so a long render retains the full retry
    // budget for actual polling or asset-finalization errors.
    return this.mutate(job, { pollSequence: job.pollSequence + 1, nextAttemptAt: new Date(Date.now() + pollDelayMs(job.pollSequence)) }, { pendingPollId: 1 }, { attempts: -1 });
  }

  async terminal(job: MediaJob, state: 'succeeded' | 'failed' | 'cancelled', result: Record<string, unknown>, failureCode?: string): Promise<MediaJob> {
    if (failureCode !== undefined && !/^[A-Z][A-Z0-9_]{0,79}$/.test(failureCode)) {
      throw new ConflictException('Invalid media terminal failure code');
    }
    const hash = mediaRequestHash(result);
    if (job.terminalEvidenceHash) {
      if (job.terminalEvidenceHash !== hash || job.providerState !== state) throw new ConflictException('Conflicting terminal evidence');
      return job;
    }
    assertProviderTransition(job.providerState, state);
    return this.mutate(job, { providerState: state, terminalEvidenceHash: hash, resultEncrypted: this.crypto.encrypt(JSON.stringify(result)),
      ...(failureCode ? { failureCode } : {}) });
  }

  async measure(job: MediaJob, micros: number, source: CostSource, tariffVersion?: string, billableQuantity?: number): Promise<MediaJob> {
    validateCost(micros, source, tariffVersion);
    if (billableQuantity !== undefined && (!Number.isSafeInteger(billableQuantity) || billableQuantity < 1)) {
      throw new ConflictException('Invalid media billable quantity');
    }
    if (job.providerCostMicros !== null && job.providerCostMicros !== undefined) {
      if (job.providerCostMicros !== micros || job.costSource !== source || job.tariffVersion !== tariffVersion
        || Number(job.billableQuantity ?? 0) !== Number(billableQuantity ?? 0)) {
        throw new ConflictException('Conflicting provider cost evidence');
      }
      return job;
    }
    return this.mutate(job, { providerCostMicros: micros, costSource: source,
      ...(tariffVersion ? { tariffVersion } : {}),
      ...(billableQuantity !== undefined ? { billableQuantity, billableUnit: 'second' } : {}),
      billingState: 'measured' });
  }

  async cancel(ownerId: string, environment: string, jobId: string): Promise<MediaJob> {
    const queued = await this.jobs.findOneAndUpdate({ ownerId, environment, jobId, providerState: 'queued' }, {
      $set: { cancellationRequested: true, providerState: 'cancelled', providerCostMicros: 0, billingState: 'measured' },
      $inc: { revision: 1 },
    }, { returnDocument: 'after' }).lean();
    if (queued) return queued;
    const current = await this.jobs.findOneAndUpdate({ ownerId, environment, jobId }, {
      $set: { cancellationRequested: true }, $inc: { revision: 1 },
    }, { returnDocument: 'after' }).lean();
    if (!current) throw new NotFoundException('Media job not found');
    return current;
  }

  release(job: MediaJob, delayMs = 2_000): Promise<MediaJob> {
    return this.mutate(job, { nextAttemptAt: new Date(Date.now() + Math.max(1_000, Math.min(60_000, delayMs))) }, { leaseToken: 1, leaseUntil: 1 });
  }

  async readWork(job: MediaJob): Promise<{ request: Record<string, unknown>; result?: Record<string, unknown> }> {
    const current = await this.jobs.findOne(this.fence(job)).select('+requestEncrypted +resultEncrypted').lean();
    if (!current) throw new ConflictException('Media job lease or revision changed');
    return { request: JSON.parse(this.crypto.decrypt(current.requestEncrypted)),
      ...(current.resultEncrypted ? { result: JSON.parse(this.crypto.decrypt(current.resultEncrypted)) } : {}) };
  }

  assetsReady(job: MediaJob, assetIds: string[]): Promise<MediaJob> {
    if (job.providerState !== 'succeeded' || !assetIds.length || assetIds.length > 20
      || assetIds.some(id => typeof id !== 'string' || !id || id.length > 200)
      || new Set(assetIds).size !== assetIds.length) throw new ConflictException('Invalid media result assets');
    if (job.assetState === 'ready') {
      if (JSON.stringify(job.assetIds) !== JSON.stringify(assetIds)) throw new ConflictException('Published media assets cannot be replaced');
      return Promise.resolve(job);
    }
    return this.mutate(job, { assetIds, assetState: 'ready', deliveryDeadlineAt: new Date(Date.now() + 24 * 60 * 60_000) });
  }

  assetFailed(job: MediaJob, failureCode: string): Promise<MediaJob> {
    if (job.providerState !== 'succeeded' || job.assetState === 'ready'
      || !/^[A-Z][A-Z0-9_]{0,79}$/.test(failureCode)) {
      throw new ConflictException('Invalid media persistence failure');
    }
    return this.mutate(job, { assetState: 'failed', deliveryState: 'failed', failureCode });
  }

  delivered(job: MediaJob): Promise<MediaJob> {
    if (job.assetState !== 'ready') throw new ConflictException('Persist media assets before delivery');
    return this.mutate(job, { deliveryState: 'delivered' });
  }

  async confirmDelivered(ownerId: string, environment: string, jobId: string): Promise<MediaJob> {
    const delivered = await this.jobs.findOneAndUpdate({
      ownerId,
      environment,
      jobId,
      providerState: 'succeeded',
      assetState: 'ready',
      billingState: { $ne: 'settled' },
      deliveryState: { $in: ['pending', 'delivered'] },
      $or: [{ deliveryDeadlineAt: { $exists: false } }, { deliveryDeadlineAt: { $gt: new Date() } }],
    }, {
      $set: { deliveryState: 'delivered', nextAttemptAt: new Date() },
      $inc: { revision: 1 },
    }, { returnDocument: 'after' }).lean();
    if (delivered) return delivered;
    const current = await this.get(ownerId, environment, jobId);
    if (current.deliveryState === 'delivered') return current;
    throw new ConflictException('Media delivery can no longer be confirmed');
  }

  deliveryFailed(job: MediaJob): Promise<MediaJob> {
    if (job.providerState !== 'succeeded' || job.assetState !== 'ready') {
      throw new ConflictException('Only persisted media can fail delivery');
    }
    return this.mutate(job, { deliveryState: 'failed' });
  }

  async waitForDelivery(job: MediaJob): Promise<MediaJob> {
    const next = await this.jobs.findOneAndUpdate(this.fence(job), {
      $set: { nextAttemptAt: new Date(Date.now() + 60_000) },
      $unset: { leaseToken: 1, leaseUntil: 1 },
      $inc: { revision: 1, attempts: -1 },
    }, { returnDocument: 'after' }).lean();
    if (!next) throw new ConflictException('Media job lease or revision changed');
    return next;
  }

  /** Called only after the existing ledger has accepted its idempotent settlement key. */
  settled(job: MediaJob, settlementId: string): Promise<MediaJob> {
    if (!['succeeded', 'failed', 'cancelled'].includes(job.providerState)
      || job.providerCostMicros === null || job.providerCostMicros === undefined
      || !settlementId || settlementId.length > 200) throw new ConflictException('Cannot settle an unmeasured media job');
    if (job.settlementId) {
      if (job.settlementId !== settlementId) throw new ConflictException('Settlement identity changed');
      return Promise.resolve(job);
    }
    return this.mutate(job, { billingState: 'settled', settlementId });
  }
}
