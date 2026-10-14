import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import type { HydratedDocument } from 'mongoose';

export type MiniappInvocationDocument = HydratedDocument<MiniappInvocation>;

@Schema({ _id: false })
export class MiniappInvocationCall {
    @Prop({ type: String, required: true })
    callId!: string;

    @Prop({ type: String, required: true })
    requestHash!: string;

    @Prop({ type: String, required: true })
    capability!: string;

    @Prop({ type: Number, required: true, min: 1, default: 1 })
    attempt!: number;

    @Prop({ type: String, required: true, enum: ['started', 'deferred', 'succeeded', 'failed', 'unknown'] })
    status!: 'started' | 'deferred' | 'succeeded' | 'failed' | 'unknown';

    @Prop({ type: String, required: true, enum: ['pending', 'succeeded', 'failed', 'unknown'], default: 'pending' })
    providerOutcome!: 'pending' | 'succeeded' | 'failed' | 'unknown';

    @Prop({
        type: String,
        required: true,
        enum: ['pending', 'acknowledged', 'failed', 'not_required'],
        default: 'pending',
    })
    deliveryStatus!: 'pending' | 'acknowledged' | 'failed' | 'not_required';

    @Prop({ type: Date })
    deliveredAt?: Date;

    @Prop({ type: String })
    providerRequestId?: string;

    @Prop({ type: String })
    deferredJobId?: string;

    @Prop({ type: Date })
    providerEvidenceAt?: Date;

    @Prop({ type: Number, min: 0, default: 0 })
    providerCostMicros!: number;

    @Prop({ type: Number, min: 0, default: 0 })
    quantity!: number;

    @Prop({ type: Number, min: 0, default: 0 })
    estimatedQuantity!: number;

    @Prop({ type: String, enum: ['provider_usage', 'account_tariff'] })
    costSource?: 'provider_usage' | 'account_tariff';

    @Prop({ type: String })
    tariffVersion?: string;

    @Prop({ type: Number, min: 0 })
    billableQuantity?: number;

    @Prop({ type: String, enum: ['second'] })
    billableUnit?: 'second';

    @Prop({ type: String, select: false })
    encryptedResult?: string;

    @Prop({ type: Date })
    resultExpiresAt?: Date;

    @Prop({ type: Object })
    error?: Record<string, unknown>;

    @Prop({ type: String })
    providerReason?: string;
}

const MiniappInvocationCallSchema = SchemaFactory.createForClass(MiniappInvocationCall);

@Schema({ collection: 'miniapp_invocations', timestamps: true })
export class MiniappInvocation {
    @Prop({ type: String, required: true, trim: true, unique: true })
    invocationId!: string;

    @Prop({ type: String, required: true, trim: true, index: true })
    ownerId!: string;

    @Prop({ type: String, required: true, trim: true, index: true })
    runtimeId!: string;

    @Prop({ type: Number, required: true, min: 1 })
    runtimeGeneration!: number;

    @Prop({ type: String, required: true, trim: true })
    environment!: string;

    @Prop({ type: String, required: true, trim: true, index: true })
    packId!: string;

    @Prop({ type: String, required: true, trim: true })
    packVersion!: string;

    @Prop({ type: String, required: true, trim: true })
    artifactDigest!: string;

    @Prop({ type: String, required: true, trim: true })
    publisherId!: string;

    @Prop({ type: String, required: true, trim: true })
    operationId!: string;

    @Prop({ type: String, required: true })
    requestHash!: string;

    @Prop({
        type: String,
        required: true,
        enum: ['authorized', 'running', 'pending_provider', 'reconciling', 'succeeded', 'partial', 'failed', 'cancelled', 'unknown'],
        index: true,
    })
    status!: 'authorized' | 'running' | 'pending_provider' | 'reconciling' | 'succeeded' | 'partial' | 'failed' | 'cancelled' | 'unknown';

    @Prop({ type: String, enum: ['succeeded', 'partial', 'failed', 'cancelled', 'unknown'] })
    executionOutcome?: 'succeeded' | 'partial' | 'failed' | 'cancelled' | 'unknown';

    @Prop({ type: String, enum: ['succeeded', 'partial', 'failed', 'cancelled'] })
    requestedExecutionOutcome?: 'succeeded' | 'partial' | 'failed' | 'cancelled';

    @Prop({
        type: String,
        required: true,
        enum: ['reserved', 'settling', 'settled', 'released', 'review'],
        default: 'reserved',
        index: true,
    })
    settlementStatus!: 'reserved' | 'settling' | 'settled' | 'released' | 'review';

    @Prop({ type: Object, required: true })
    pricingSnapshot!: Record<string, unknown>;

    @Prop({ type: String, required: true, trim: true })
    reservationId!: string;

    @Prop({ type: Number, min: 0, default: 0 })
    providerCostMicros!: number;

    @Prop({ type: Number, min: 0, default: 0 })
    settledCredits!: number;

    @Prop({ type: [MiniappInvocationCallSchema], default: [] })
    calls!: MiniappInvocationCall[];

    @Prop({ type: Number, required: true, min: 0, default: 0 })
    callCount!: number;

    @Prop({ type: Number, required: true, min: 1, default: 1 })
    maxCalls!: number;

    @Prop({ type: Number, required: true, min: 0, default: 0 })
    meteringReservedQuantity!: number;

    @Prop({ type: Date, required: true, index: true })
    expiresAt!: Date;

    @Prop({ type: Date })
    completedAt?: Date;

    @Prop({ type: Date })
    unknownNotifiedAt?: Date;

    @Prop({ type: Date })
    reconciliationDeadline?: Date;

    @Prop({ type: Boolean, default: false })
    platformIncident?: boolean;

    @Prop({ type: Number }) accountingVersion?: number;
    @Prop({ type: Number }) settledQuantity?: number;
    @Prop({ type: Date }) nextReconcileAt?: Date;
    @Prop({ type: String }) reconcileOwner?: string;
    @Prop({ type: Number, default: 0 }) reconcileFence!: number;
    @Prop({ type: Date }) reconcileLeaseUntil?: Date;
    @Prop({ type: String }) quarantineCode?: string;
    @Prop({ type: Date }) quarantinedAt?: Date;
}

export const MiniappInvocationSchema = SchemaFactory.createForClass(MiniappInvocation);
MiniappInvocationSchema.index({ ownerId: 1, createdAt: -1 });
MiniappInvocationSchema.index({ status: 1, expiresAt: 1 });
MiniappInvocationSchema.index({ ownerId: 1, packId: 1, status: 1 });
MiniappInvocationSchema.index({ nextReconcileAt: 1, reconcileLeaseUntil: 1, _id: 1 });
