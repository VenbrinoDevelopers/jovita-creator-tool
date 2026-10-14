import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import type { HydratedDocument } from 'mongoose';

export type MediaJobStepDocument = HydratedDocument<MediaJobStep>;
export type MediaJobStepState =
  | 'queued'
  | 'dispatching'
  | 'pending_provider'
  | 'provider_succeeded'
  | 'persisted'
  | 'failed'
  | 'unknown'
  | 'cancelled';

@Schema({ collection: 'media_job_steps', timestamps: true })
export class MediaJobStep {
  @Prop({ type: String, required: true, index: true }) jobId!: string;
  @Prop({ type: String, required: true }) stepId!: string;
  @Prop({ type: String, required: true }) ownerId!: string;
  @Prop({ type: String, required: true }) type!: string;
  @Prop({ type: String, required: true }) provider!: string;
  @Prop({ type: String, required: true }) operation!: string;
  @Prop({ type: String, required: true }) routeId!: string;
  @Prop({ type: String, required: true }) idempotencyKey!: string;
  @Prop({ type: String, required: true }) requestHash!: string;
  @Prop({ type: String, required: true, select: false }) requestEncrypted!: string;
  @Prop({ type: String, required: true, default: 'queued', index: true }) state!: MediaJobStepState;
  @Prop({ type: String }) providerRequestId?: string;
  @Prop({ type: String }) terminalEvidenceHash?: string;
  @Prop({ type: String, select: false }) resultEncrypted?: string;
  @Prop({ type: Number, default: null }) providerCostMicros!: number | null;
  @Prop({ type: String }) costSource?: string;
  @Prop({ type: String }) tariffVersion?: string;
  @Prop({ type: Number }) billableQuantity?: number;
  @Prop({ type: String }) billableUnit?: string;
  @Prop({ type: [String], default: [] }) assetIds!: string[];
  @Prop({ type: Number, required: true, default: 0 }) attempts!: number;
  @Prop({ type: String }) leaseToken?: string;
  @Prop({ type: Date }) leaseUntil?: Date;
  @Prop({ type: String }) failureCode?: string;
  @Prop({ type: Number, required: true, default: 0 }) revision!: number;
}

export const MediaJobStepSchema = SchemaFactory.createForClass(MediaJobStep);
MediaJobStepSchema.index({ jobId: 1, stepId: 1 }, { unique: true });
MediaJobStepSchema.index({ idempotencyKey: 1 }, { unique: true });
MediaJobStepSchema.index({ provider: 1, providerRequestId: 1 }, {
  unique: true,
  partialFilterExpression: { providerRequestId: { $type: 'string' } },
});
MediaJobStepSchema.index({ state: 1, leaseUntil: 1 });

