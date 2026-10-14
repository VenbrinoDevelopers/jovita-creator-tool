import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import type { HydratedDocument } from 'mongoose';

@Schema({ collection: 'broker_provider_profiles', timestamps: true })
export class BrokerProviderProfile {
  @Prop({ type: String, required: true, unique: true }) profileId!: string;
  @Prop({ type: String, required: true, index: true }) creatorId!: string;
  @Prop({ type: String, required: true }) name!: string;
  @Prop({ type: String, required: true }) summary!: string;
  @Prop({ type: String, required: true }) docsUrl!: string;
  @Prop({ type: String, required: true }) category!: string;
  @Prop({ type: String, required: true }) baseUrl!: string;
  @Prop({ type: String, required: true, enum: ['bearer', 'header'] }) authMethod!: 'bearer' | 'header';
  @Prop({ type: String }) authHeader?: string;
  @Prop({ type: Number, required: true, min: 1000, max: 120000 }) timeoutMs!: number;
  @Prop({ type: String, required: true, enum: ['draft', 'approved', 'rejected'], index: true }) status!: 'draft' | 'approved' | 'rejected';
  @Prop({ type: String }) approvedBy?: string;
  @Prop({ type: Date }) approvedAt?: Date;
}
export type BrokerProviderProfileDocument = HydratedDocument<BrokerProviderProfile>;
export const BrokerProviderProfileSchema = SchemaFactory.createForClass(BrokerProviderProfile);

@Schema({ collection: 'broker_operations', timestamps: true })
export class BrokerOperation {
  @Prop({ type: String, required: true, unique: true }) capabilityId!: string;
  @Prop({ type: [String], default: [] }) manifestAliases!: string[];
  @Prop({ type: String, required: true, index: true }) profileId!: string;
  @Prop({ type: String, required: true }) creatorId!: string;
  @Prop({ type: String, required: true }) operationId!: string;
  @Prop({ type: Number, required: true, min: 1 }) version!: number;
  @Prop({ type: String, required: true }) name!: string;
  @Prop({ type: String, required: true }) purpose!: string;
  @Prop({ type: String, required: true, enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] }) method!: string;
  @Prop({ type: String, required: true }) path!: string;
  @Prop({ type: String, required: true, enum: ['http-json', 'http-multipart', 'http-binary', 'http-sse', 'http-poll', 'named-run'], default: 'http-json' })
  executionKind!: 'http-json' | 'http-multipart' | 'http-binary' | 'http-sse' | 'http-poll' | 'named-run';
  @Prop({ type: String, enum: ['transparent-png-v1'] }) mediaPreset?: 'transparent-png-v1';
  @Prop({ type: Object }) requestMapping?: { body: Record<string, { from: string } | { const: string | number | boolean }> };
  @Prop({ type: String }) responseField?: string;
  @Prop({ type: Object }) poll?: { path: string; jobIdField: string; statusField: string;
    resultField?: string; successValue: string; failureValue: string; failureValues?: string[];
    providerStatusField?: string; noResultStatuses?: number[];
    intervalMs: number; maxAttempts: number };
  @Prop({ type: Object }) artifact?: { path: string; kind: 'video' | 'audio';
    maxBytes: number; retentionSeconds: number; timeoutMs?: number };
  @Prop({ type: String }) providerName?: string;
  @Prop({ type: String }) endpoint?: string;
  @Prop({ type: [String], default: [] }) queryFields!: string[];
  @Prop({ type: Object, required: true }) inputSchema!: Record<string, unknown>;
  @Prop({ type: Object, required: true }) outputSchema!: Record<string, unknown>;
  @Prop({ type: Number, required: true, min: 1, max: 8000000 }) maxRequestBytes!: number;
  @Prop({ type: Number, required: true, min: 1, max: 10485760 }) maxResponseBytes!: number;
  @Prop({ type: Number, required: true, min: 1 }) buyerCredits!: number;
  @Prop({ type: Boolean, default: false }) emptyResultIsNoResult!: boolean;
  @Prop({ type: String, required: true }) providerCostNote!: string;
}
export type BrokerOperationDocument = HydratedDocument<BrokerOperation>;
export const BrokerOperationSchema = SchemaFactory.createForClass(BrokerOperation);
BrokerOperationSchema.index({ profileId: 1, operationId: 1, version: 1 }, { unique: true });
BrokerOperationSchema.index({ manifestAliases: 1 }, { unique: true, sparse: true });

@Schema({ collection: 'broker_connections', timestamps: true })
export class BrokerConnection {
  @Prop({ type: String, required: true, unique: true }) connectionId!: string;
  @Prop({ type: String, required: true, index: true }) creatorId!: string;
  @Prop({ type: String, required: true, index: true }) profileId!: string;
  @Prop({ type: String, required: true }) name!: string;
  @Prop({ type: String, required: true, select: false }) encryptedApiKey!: string;
  @Prop({ type: String, required: true }) keyFingerprint!: string;
  @Prop({ type: String, required: true, enum: ['untested', 'ok', 'failed'] }) testStatus!: 'untested' | 'ok' | 'failed';
  @Prop({ type: Date }) testedAt?: Date;
}
export type BrokerConnectionDocument = HydratedDocument<BrokerConnection>;
export const BrokerConnectionSchema = SchemaFactory.createForClass(BrokerConnection);

@Schema({ collection: 'broker_route_grants', timestamps: true })
export class BrokerRouteGrant {
  @Prop({ type: String, required: true, unique: true }) grantId!: string;
  @Prop({ type: String, required: true, index: true }) creatorId!: string;
  @Prop({ type: String, required: true, index: true }) packId!: string;
  @Prop({ type: String, required: true }) connectionId!: string;
  @Prop({ type: String, required: true }) capabilityId!: string;
  @Prop({ type: String, required: true, enum: ['active', 'revoked'] }) status!: 'active' | 'revoked';
}
export type BrokerRouteGrantDocument = HydratedDocument<BrokerRouteGrant>;
export const BrokerRouteGrantSchema = SchemaFactory.createForClass(BrokerRouteGrant);
BrokerRouteGrantSchema.index({ creatorId: 1, packId: 1, capabilityId: 1 }, { unique: true });

@Schema({ collection: 'broker_execution_evidence', timestamps: true })
export class BrokerExecution {
  @Prop({ type: String, required: true, unique: true }) executionKey!: string;
  @Prop({ type: String, required: true }) capabilityId!: string;
  @Prop({ type: String, required: true }) packId!: string;
  @Prop({ type: String, required: true }) environment!: string;
  @Prop({ type: String }) ownerId?: string;
  @Prop({ type: String, required: true }) requestHash!: string;
  @Prop({ type: String, required: true, enum: ['started', 'succeeded', 'failed'] }) status!: 'started' | 'succeeded' | 'failed';
  @Prop({ type: String, select: false }) encryptedResult?: string;
  @Prop({ type: Date, index: true }) resultExpiresAt?: Date;
  @Prop({ type: Number }) providerCostMicros?: number;
  @Prop({ type: Number }) quantity?: number;
  @Prop({ type: String }) providerRequestId?: string;
  // Saved immediately after an asynchronous submit. A retry may poll this run,
  // but must never submit another paid upstream request for the same call ID.
  @Prop({ type: String }) upstreamRunId?: string;
  @Prop({ type: String, select: false }) encryptedCredential?: string;
  @Prop({ type: String }) artifactLeaseToken?: string;
  @Prop({ type: Date }) artifactLeaseUntil?: Date;
  @Prop({ type: String }) errorCode?: string;
  // Execution keys are permanent idempotency evidence. A TTL here could erase a
  // pending upstream run ID and permit the same paid call to be submitted again.
  @Prop({ type: Date }) expiresAt?: Date;
}
export type BrokerExecutionDocument = HydratedDocument<BrokerExecution>;
export const BrokerExecutionSchema = SchemaFactory.createForClass(BrokerExecution);
