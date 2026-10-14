import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import type { HydratedDocument } from 'mongoose';
import type { AssetState, CostSource, DeliveryState, ProviderState } from './media-job.state.js';

export type MediaJobDocument = HydratedDocument<MediaJob>;

@Schema({ collection: 'media_jobs', timestamps: true })
export class MediaJob {
  @Prop({ type: String, required: true }) jobId!: string;
  @Prop({ type: String, required: true }) ownerId!: string;
  @Prop({ type: String, required: true }) environment!: string;
  @Prop({ type: String, required: true }) conversationId!: string;
  @Prop({ type: String, required: true }) packId!: string;
  @Prop({ type: String, required: true }) invocationId!: string;
  @Prop({ type: String, required: true }) callId!: string;
  @Prop({ type: String, required: true }) operationId!: string;
  @Prop({ type: String, required: true }) submissionId!: string;
  @Prop({ type: String, required: true }) requestHash!: string;
  @Prop({ type: String, required: true, select: false }) requestEncrypted!: string;
  @Prop({ type: String, required: true }) provider!: string;
  @Prop({ type: String, required: true }) model!: string;
  @Prop({ type: Object, required: true }) pricingSnapshot!: Record<string, unknown>;
  @Prop({ type: String, default: 'queued', required: true }) providerState!: ProviderState;
  @Prop({ type: String }) providerRequestId?: string;
  @Prop({ type: String, select: false }) resultEncrypted?: string;
  @Prop({ type: String }) terminalEvidenceHash?: string;
  @Prop({ type: String, default: 'pending', required: true }) assetState!: AssetState;
  @Prop({ type: [String], default: [] }) assetIds!: string[];
  @Prop({ type: String, default: 'pending', required: true }) deliveryState!: DeliveryState;
  @Prop({ type: Date }) deliveryDeadlineAt?: Date;
  @Prop({ type: String, required: true }) deliveryKey!: string;
  @Prop({ type: String, default: 'pending', required: true }) billingState!: 'pending' | 'measured' | 'settled';
  @Prop({ type: Number, default: null }) providerCostMicros!: number | null;
  @Prop({ type: String }) costSource?: CostSource;
  @Prop({ type: String }) tariffVersion?: string;
  @Prop({ type: Number }) billableQuantity?: number;
  @Prop({ type: String, enum: ['second'] }) billableUnit?: 'second';
  @Prop({ type: String }) settlementId?: string;
  @Prop({ type: Number, default: 0 }) pollSequence!: number;
  @Prop({ type: String }) pendingPollId?: string;
  @Prop({ type: Date, default: () => new Date() }) nextAttemptAt!: Date;
  @Prop({ type: String }) leaseToken?: string;
  @Prop({ type: Date }) leaseUntil?: Date;
  @Prop({ type: Number, default: 0 }) attempts!: number;
  @Prop({ type: Boolean, default: false }) cancellationRequested!: boolean;
  @Prop({ type: String }) failureCode?: string;
  @Prop({ type: Date, index: true }) deadLetteredAt?: Date;
  @Prop({ type: Number, default: 0 }) revision!: number;
}

export const MediaJobSchema = SchemaFactory.createForClass(MediaJob);
MediaJobSchema.index({ jobId: 1 }, { unique: true });
MediaJobSchema.index({ environment: 1, invocationId: 1, submissionId: 1 }, { unique: true });
MediaJobSchema.index({ environment: 1, provider: 1, providerRequestId: 1 }, {
  unique: true, partialFilterExpression: { providerRequestId: { $type: 'string' } },
});
MediaJobSchema.index({ ownerId: 1, conversationId: 1, createdAt: -1 });
MediaJobSchema.index({ nextAttemptAt: 1, leaseUntil: 1, providerState: 1 });
// No TTL: unresolved jobs and their minimal settlement evidence must survive reconciliation.
