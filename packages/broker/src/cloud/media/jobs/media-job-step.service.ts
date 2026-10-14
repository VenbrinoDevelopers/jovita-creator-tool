import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import { createHash, randomUUID } from 'node:crypto';
import { SecretCryptoService } from '../../core/security/secret-crypto.service.js';
import { MediaJobStep, type MediaJobStepDocument, type MediaJobStepState } from './media-job-step.schema.js';
import { mediaRequestHash } from './media-job.state.js';

export interface CreateMediaJobStep {
  jobId: string;
  stepId: string;
  ownerId: string;
  type: string;
  provider: string;
  operation: string;
  routeId: string;
  request: Record<string, unknown>;
}

@Injectable()
export class MediaJobStepService {
  constructor(
    @InjectModel(MediaJobStep.name) private readonly steps: Model<MediaJobStepDocument>,
    private readonly crypto: SecretCryptoService,
  ) {}

  async ensure(input: CreateMediaJobStep): Promise<MediaJobStep> {
    for (const key of ['jobId', 'stepId', 'ownerId', 'type', 'provider', 'operation', 'routeId'] as const) {
      const value = input[key];
      if (!value.trim() || value.length > 240) throw new ConflictException(`Invalid media step ${key}`);
    }
    const requestHash = mediaRequestHash(input.request);
    const idempotencyKey = createHash('sha256').update(`${input.jobId}\0${input.stepId}`).digest('hex');
    const existing = await this.steps.findOne({ jobId: input.jobId, stepId: input.stepId }).lean();
    if (existing) return this.replay(existing, input, requestHash);
    try {
      return (await this.steps.create({
        ...input,
        requestHash,
        idempotencyKey,
        requestEncrypted: this.crypto.encrypt(JSON.stringify(input.request)),
      })).toObject();
    } catch (error) {
      if ((error as { code?: number }).code !== 11000) throw error;
      const winner = await this.steps.findOne({ jobId: input.jobId, stepId: input.stepId }).lean();
      if (!winner) throw error;
      return this.replay(winner, input, requestHash);
    }
  }

  async get(jobId: string, stepId: string): Promise<MediaJobStep> {
    const step = await this.steps.findOne({ jobId, stepId }).lean();
    if (!step) throw new NotFoundException('Media job step not found');
    return step;
  }

  async list(jobId: string): Promise<MediaJobStep[]> {
    return this.steps.find({ jobId }).sort({ stepId: 1 }).lean();
  }

  async readRequest(step: MediaJobStep): Promise<Record<string, unknown>> {
    const row = await this.steps.findOne({ jobId: step.jobId, stepId: step.stepId }).select('+requestEncrypted').lean();
    if (!row) throw new NotFoundException('Media job step not found');
    return JSON.parse(this.crypto.decrypt(row.requestEncrypted)) as Record<string, unknown>;
  }

  async beginDispatch(step: MediaJobStep): Promise<MediaJobStep> {
    if (step.state !== 'queued') return step;
    return this.mutate(step, { state: 'dispatching', leaseToken: randomUUID(), leaseUntil: new Date(Date.now() + 90_000) }, { attempts: 1 });
  }

  async accepted(step: MediaJobStep, providerRequestId?: string): Promise<MediaJobStep> {
    if (step.state !== 'dispatching') throw new ConflictException('Media step is not dispatching');
    if (providerRequestId && (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,239}$/.test(providerRequestId)
      || (step.providerRequestId && step.providerRequestId !== providerRequestId))) {
      throw new ConflictException('Provider step identity changed');
    }
    return this.mutate(step, { state: 'pending_provider', ...(providerRequestId ? { providerRequestId } : {}) });
  }

  unknown(step: MediaJobStep): Promise<MediaJobStep> {
    if (step.state !== 'dispatching') throw new ConflictException('Only a dispatching media step can become unknown');
    return this.mutate(step, { state: 'unknown', failureCode: 'DISPATCH_OUTCOME_UNKNOWN' });
  }

  async providerSucceeded(step: MediaJobStep, result: Record<string, unknown>): Promise<MediaJobStep> {
    if (!['pending_provider', 'provider_succeeded'].includes(step.state)) {
      throw new ConflictException('Media step has not been accepted by the provider');
    }
    return this.terminal(step, 'provider_succeeded', result);
  }

  async persisted(step: MediaJobStep, assetIds: string[], result: Record<string, unknown> = {}): Promise<MediaJobStep> {
    if (!['provider_succeeded', 'persisted'].includes(step.state) || !assetIds.length || assetIds.length > 20) {
      throw new ConflictException('Invalid persisted media step');
    }
    if (step.state === 'persisted') {
      if (JSON.stringify(step.assetIds) !== JSON.stringify(assetIds)) throw new ConflictException('Media step assets changed');
      return step;
    }
    return this.terminal(step, 'persisted', { ...result, assetIds }, { assetIds });
  }

  failed(step: MediaJobStep, result: Record<string, unknown>, cancelled = false): Promise<MediaJobStep> {
    if (!['queued', 'pending_provider', 'provider_succeeded', 'failed', 'cancelled'].includes(step.state)) {
      throw new ConflictException('Media step cannot become failed from its current state');
    }
    return this.terminal(step, cancelled ? 'cancelled' : 'failed', result);
  }

  async recordCost(step: MediaJobStep, input: {
    providerCostMicros: number;
    costSource: string;
    tariffVersion?: string;
    billableQuantity?: number;
    billableUnit?: string;
  }): Promise<MediaJobStep> {
    if (!Number.isSafeInteger(input.providerCostMicros) || input.providerCostMicros < 0 || !input.costSource.trim()) {
      throw new ConflictException('Invalid media step cost');
    }
    if (step.providerCostMicros !== null && step.providerCostMicros !== undefined) {
      if (step.providerCostMicros !== input.providerCostMicros || step.costSource !== input.costSource
        || step.tariffVersion !== input.tariffVersion
        || Number(step.billableQuantity ?? 0) !== Number(input.billableQuantity ?? 0)
        || (step.billableUnit ?? '') !== (input.billableUnit ?? '')) throw new ConflictException('Conflicting media step cost');
      return step;
    }
    return this.mutate(step, input);
  }

  async aggregate(jobId: string): Promise<{ complete: boolean; providerCostMicros: number; billableQuantity: number; assetIds: string[] }> {
    const rows = await this.steps.find({ jobId }).sort({ stepId: 1 }).lean();
    if (!rows.length) return { complete: false, providerCostMicros: 0, billableQuantity: 0, assetIds: [] };
    const terminal = new Set<MediaJobStepState>(['persisted', 'failed', 'cancelled']);
    const complete = rows.every(row => terminal.has(row.state) && row.providerCostMicros !== null && row.providerCostMicros !== undefined);
    return {
      complete,
      providerCostMicros: rows.reduce((sum, row) => sum + Number(row.providerCostMicros ?? 0), 0),
      billableQuantity: rows.reduce((sum, row) => sum + Number(row.billableQuantity ?? 0), 0),
      assetIds: rows.flatMap(row => row.assetIds ?? []),
    };
  }

  private replay(step: MediaJobStep, input: CreateMediaJobStep, requestHash: string): MediaJobStep {
    if (step.ownerId !== input.ownerId || step.provider !== input.provider || step.operation !== input.operation
      || step.routeId !== input.routeId || step.requestHash !== requestHash) {
      throw new ConflictException('Media step identity already belongs to different work');
    }
    return step;
  }

  private async terminal(
    step: MediaJobStep,
    state: Extract<MediaJobStepState, 'provider_succeeded' | 'persisted' | 'failed' | 'cancelled'>,
    result: Record<string, unknown>,
    extra: Record<string, unknown> = {},
  ): Promise<MediaJobStep> {
    const terminalEvidenceHash = mediaRequestHash(result);
    if (step.terminalEvidenceHash && step.state === state) {
      if (step.terminalEvidenceHash !== terminalEvidenceHash) throw new ConflictException('Conflicting media step evidence');
      return step;
    }
    return this.mutate(step, {
      state,
      terminalEvidenceHash,
      resultEncrypted: this.crypto.encrypt(JSON.stringify(result)),
      ...extra,
    });
  }

  private async mutate(step: MediaJobStep, set: Record<string, unknown>, inc: Record<string, number> = {}): Promise<MediaJobStep> {
    const next = await this.steps.findOneAndUpdate(
      { jobId: step.jobId, stepId: step.stepId, revision: step.revision },
      { $set: set, $inc: { revision: 1, ...inc } },
      { returnDocument: 'after' },
    ).lean();
    if (!next) throw new ConflictException('Media step revision changed');
    return next;
  }
}
