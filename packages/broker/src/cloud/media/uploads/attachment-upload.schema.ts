import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import type { HydratedDocument } from 'mongoose';

export type AttachmentUploadDocument = HydratedDocument<AttachmentUpload>;

@Schema({ collection: 'attachment_uploads', timestamps: true })
export class AttachmentUpload {
  @Prop({ type: String, required: true, index: true }) ownerId!: string;
  @Prop({ type: String, required: true, index: true }) batchId!: string;
  @Prop({ type: String, required: true, unique: true }) uploadId!: string;
  @Prop({ type: String, required: true, unique: true }) attachmentId!: string;
  @Prop({ type: String, required: true }) objectKey!: string;
  @Prop({ type: String }) sourceKey?: string;
  @Prop({ type: String }) multipartUploadId?: string;
  @Prop({ type: Number }) multipartPartSize?: number;
  @Prop({ type: Number }) multipartPartCount?: number;
  @Prop({ type: String }) multipartCompletionToken?: string;
  @Prop({ type: Date }) multipartCompletionLeaseUntil?: Date;
  @Prop({ type: [Object] }) multipartCompletionParts?: Array<{
    partNumber: number;
    etag: string;
  }>;
  @Prop({ type: String, required: true }) fileName!: string;
  @Prop({ type: String, required: true }) mimeType!: string;
  @Prop({ type: String, required: true, enum: ['image', 'document', 'audio', 'video'] }) kind!: string;
  @Prop({ type: Number, required: true }) size!: number;
  @Prop({ type: String, default: '' }) sha256!: string;
  @Prop({ type: String, required: true, enum: ['inbound', 'outbound'], default: 'outbound', index: true }) direction!: string;
  @Prop({ type: Boolean, default: true }) activeSlotHeld!: boolean;
  @Prop({ type: String, required: true, enum: ['initiated', 'completing', 'uploaded', 'attached', 'deleting', 'deleted'], index: true }) status!: string;
  @Prop({ type: Date, required: true, index: true }) expiresAt!: Date;
  @Prop({ type: String }) messageId?: string;
  /** Written only by the server's media worker after probing, never trusted from upload JSON. */
  @Prop({ type: Object }) mediaMetadata?: {
    durationMs?: number; width?: number; height?: number; container?: string;
    videoCodec?: string; audioCodec?: string; hasAudio?: boolean;
    posterAttachmentId?: string; playbackAttachmentId?: string; originalAttachmentId?: string;
    waveformPeaks?: number[]; processingStatus?: 'pending' | 'processing' | 'ready' | 'failed';
    processingFailureCode?: string;
  };
}

export const AttachmentUploadSchema = SchemaFactory.createForClass(AttachmentUpload);
AttachmentUploadSchema.index({ ownerId: 1, batchId: 1 });
AttachmentUploadSchema.index({ ownerId: 1, sourceKey: 1 }, {
  unique: true,
  partialFilterExpression: { sourceKey: { $type: 'string' } },
});

export type AttachmentUsageDocument = HydratedDocument<AttachmentUsage>;

@Schema({ collection: 'attachment_usage', timestamps: true })
export class AttachmentUsage {
  @Prop({ type: String, required: true, unique: true }) ownerId!: string;
  @Prop({ type: Number, required: true, default: 0 }) storageBytes!: number;
  @Prop({ type: Number, required: true, default: 0 }) activeUploads!: number;
  @Prop({ type: Date, required: true, default: Date.now }) rateWindowStart!: Date;
  @Prop({ type: Number, required: true, default: 0 }) rateUploads!: number;
  @Prop({ type: String, enum: ['attachment_storage_quota_exceeded', 'attachment_concurrency_exceeded', 'attachment_rate_limit_exceeded'] }) lastReservationFailure?: string;
  @Prop({ type: Number }) lastReservationRetryAfterMs?: number;
}

export const AttachmentUsageSchema = SchemaFactory.createForClass(AttachmentUsage);
