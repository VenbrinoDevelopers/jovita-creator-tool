import { BadRequestException, HttpException, HttpStatus, Injectable, Logger, NotFoundException } from '@nestjs/common';
import {
    DeleteObjectCommand,
    AbortMultipartUploadCommand,
    CompleteMultipartUploadCommand,
    CreateMultipartUploadCommand,
    GetObjectCommand,
    HeadObjectCommand,
    ListPartsCommand,
    PutObjectCommand,
    UploadPartCommand,
    S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { createHash, randomUUID } from 'node:crypto';
import { extname } from 'node:path';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import type { Readable } from 'node:stream';
import { InjectModel } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import type { ClientSession } from 'mongoose';
import { Interval } from '@nestjs/schedule';
import type { MediaAttachment } from '../../core/contracts/types.js';
import {
    normalizeMediaAttachmentMetadata,
    type MediaAttachmentMetadata,
} from '../../core/contracts/media-attachment-metadata.js';
import {
    MAX_FILE_SIZE_BYTES,
    MAX_FILES,
    MAX_ACTIVE_RUNTIME_UPLOADS,
    MAX_RUNTIME_UPLOAD_FILES,
    MAX_RUNTIME_UPLOADS_PER_MINUTE,
    MAX_OUTBOUND_TOTAL_BYTES,
    PRIVATE_ATTACHMENT_READ_URL_TTL_SECONDS,
    ALLOWED_UPLOAD_EXTENSIONS,
    ALLOWED_UPLOAD_MIME_TYPES,
    type AttachmentKind,
    type PresignFileInput,
    type PresignUploadItem,
} from './uploads.types.js';
import {
    AttachmentUpload,
    type AttachmentUploadDocument,
    AttachmentUsage,
    type AttachmentUsageDocument,
} from './attachment-upload.schema.js';

export const RUNTIME_UPLOAD_UNHOISTABLE_HEADERS = new Set(['x-amz-checksum-sha256', 'x-amz-meta-uploadid']);
export const MEDIA_MULTIPART_PART_BYTES = 8 * 1024 * 1024;

export type AttachmentReservationFailureCode =
    | 'attachment_storage_quota_exceeded'
    | 'attachment_concurrency_exceeded'
    | 'attachment_rate_limit_exceeded';

export class AttachmentReservationException extends HttpException {
    constructor(
        public readonly code: AttachmentReservationFailureCode,
        message: string,
        status: number,
        public readonly retryAfterMs?: number,
    ) {
        super({ statusCode: status, code, message, ...(retryAfterMs !== undefined ? { retryAfterMs } : {}) }, status);
    }
}

@Injectable()
export class UploadsService {
    private readonly logger = new Logger(UploadsService.name);
    constructor(
        @InjectModel(AttachmentUpload.name) private readonly uploadModel: Model<AttachmentUploadDocument>,
        @InjectModel(AttachmentUsage.name) private readonly usageModel: Model<AttachmentUsageDocument>,
    ) {}

    @Interval(15 * 60_000)
    async cleanupExpiredRuntimeUploads(): Promise<void> {
        if (process.env.JOVITA_BROKER_PLATFORM_WORKERS === 'false') return;
        const records = await this.uploadModel
            .find({
                $or: [
                    { status: { $in: ['initiated', 'completing', 'uploaded', 'deleting'] } },
                    { status: 'attached', sourceKey: /^broker:/ },
                ],
                expiresAt: { $lte: new Date() },
            })
            .limit(200);
        if (!records.length) return;
        const s3 = this.createS3Client();
        const bucket = this.env('R2_BUCKET');
        const deleted: AttachmentUploadDocument[] = [];
        for (const record of records) {
            const claimed =
                record.status === 'deleting'
                    ? record
                    : await this.uploadModel.findOneAndUpdate(
                          { _id: record._id, $or: [
                              { status: { $in: ['initiated', 'completing', 'uploaded'] } },
                              { status: 'attached', sourceKey: /^broker:/ },
                          ] },
                          { $set: { status: 'deleting' } },
                          { returnDocument: 'before' },
                      );
            if (!claimed) continue;
            try {
                if (record.multipartUploadId && ['initiated', 'completing'].includes(record.status)) {
                    try {
                        await s3.send(
                            new AbortMultipartUploadCommand({
                                Bucket: bucket,
                                Key: record.objectKey,
                                UploadId: record.multipartUploadId,
                            }),
                        );
                    } catch (error) {
                        // A completing upload may already have committed in R2,
                        // in which case its multipart ID no longer exists. Only
                        // that precise outcome is safe to convert into an object
                        // deletion; transient abort failures remain retryable.
                        if (!this.isNoSuchUpload(error)) throw error;
                    }
                    await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: record.objectKey }));
                } else {
                    await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: record.objectKey }));
                }
                deleted.push(claimed);
            } catch (error) {
                await this.uploadModel.updateOne(
                    { _id: record._id, status: 'deleting' },
                    { $set: { status: record.status } },
                );
                this.logger.warn(`Attachment cleanup failed attachmentId=${record.attachmentId}: ${String(error)}`);
            }
        }
        if (!deleted.length) return;
        await this.finalizeDeletedRecords(deleted);
    }

    async initiateRuntimeUploads(
        ownerId: string,
        files: Array<{ fileName: string; size: number; mimeType: string; kind: AttachmentKind; sha256: string }>,
    ): Promise<Record<string, unknown>> {
        if (!files.length || files.length > MAX_RUNTIME_UPLOAD_FILES)
            throw new BadRequestException(`Files must contain 1-${MAX_RUNTIME_UPLOAD_FILES} items`);
        if (files.reduce((sum, file) => sum + Number(file.size || 0), 0) > MAX_OUTBOUND_TOTAL_BYTES)
            throw new BadRequestException('Outbound attachment total exceeds 1GiB');
        const requested = files.reduce((sum, file) => sum + file.size, 0);
        files.forEach((file) => this.assertRuntimeFile(file));
        try {
            await this.reserveUsage(ownerId, requested, files.length);
        } catch (error) {
            this.logger.warn(
                `Attachment upload reservation failed owner=${this.redactId(ownerId)} files=${files.length} bytes=${requested}: ${this.errorMessage(error)}`,
            );
            throw error;
        }

        const batchId = randomUUID();
        const bucket = this.env('R2_BUCKET');
        const s3 = this.createS3Client();
        const expiresAt = new Date(Date.now() + 10 * 60_000);
        const results: Record<string, unknown>[] = [];
        try {
            for (const file of files) {
                const uploadId = randomUUID();
                const attachmentId = randomUUID();
                const objectKey = this.buildObjectKey(`attachments/${ownerId}`, file.fileName);
                const checksum = Buffer.from(file.sha256, 'hex').toString('base64');
                const put = new PutObjectCommand({
                    Bucket: bucket,
                    Key: objectKey,
                    ContentType: file.mimeType,
                    ChecksumSHA256: checksum,
                    Metadata: { uploadid: uploadId },
                });
                let uploadUrl: string;
                try {
                    uploadUrl = await getSignedUrl(s3, put, {
                        expiresIn: 600,
                        unhoistableHeaders: new Set(RUNTIME_UPLOAD_UNHOISTABLE_HEADERS),
                        signableHeaders: new Set(['content-type']),
                    });
                } catch (error) {
                    this.logger.warn(
                        `Attachment R2 signing failed owner=${this.redactId(ownerId)} file=${file.fileName} mime=${file.mimeType} size=${file.size}: ${this.errorMessage(error)}`,
                    );
                    throw error;
                }
                await this.uploadModel.create({
                    ownerId,
                    batchId,
                    uploadId,
                    attachmentId,
                    objectKey,
                    ...file,
                    direction: 'outbound',
                    activeSlotHeld: true,
                    status: 'initiated',
                    expiresAt,
                });
                results.push({
                    uploadId,
                    uploadUrl,
                    method: 'PUT',
                    headers: runtimePresignedPutHeaders(file.mimeType, uploadId, checksum),
                });
            }
            return files.length === 1
                ? { batchId, ...results[0] }
                : { batchId, uploads: results, expiresAt: expiresAt.toISOString() };
        } catch (error) {
            await this.rollbackInitiatedBatch(ownerId, batchId, requested, files.length);
            throw error;
        }
    }

    async initiateMultipartUpload(
        ownerId: string,
        file: {
            fileName: string;
            size: number;
            mimeType: string;
            kind: 'audio' | 'video';
            sha256: string;
        },
    ): Promise<Record<string, unknown>> {
        this.assertRuntimeFile(file);
        const limit = file.kind === 'video' ? 250 * 1024 * 1024 : 100 * 1024 * 1024;
        if (file.size > limit || file.size < MEDIA_MULTIPART_PART_BYTES)
            throw new BadRequestException('Multipart media size is outside supported bounds');
        await this.reserveUsage(ownerId, file.size, 1);
        const uploadId = randomUUID();
        const batchId = randomUUID();
        const attachmentId = randomUUID();
        const objectKey = this.buildObjectKey(`inbound/${ownerId.replace(/[^a-zA-Z0-9_-]/g, '_')}`, file.fileName);
        const expiresAt = new Date(Date.now() + 24 * 60 * 60_000);
        try {
            const created = await this.createS3Client().send(
                new CreateMultipartUploadCommand({
                    Bucket: this.env('R2_BUCKET'),
                    Key: objectKey,
                    ContentType: file.mimeType,
                    Metadata: { uploadid: uploadId },
                }),
            );
            if (!created.UploadId) throw new Error('R2 did not return a multipart upload ID');
            const partCount = Math.ceil(file.size / MEDIA_MULTIPART_PART_BYTES);
            await this.uploadModel.create({
                ownerId,
                batchId,
                uploadId,
                attachmentId,
                objectKey,
                multipartUploadId: created.UploadId,
                multipartPartSize: MEDIA_MULTIPART_PART_BYTES,
                multipartPartCount: partCount,
                ...file,
                direction: 'inbound',
                activeSlotHeld: true,
                status: 'initiated',
                expiresAt,
            });
            return {
                batchId,
                uploadId,
                attachmentId,
                partSize: MEDIA_MULTIPART_PART_BYTES,
                partCount,
                expiresAt: expiresAt.toISOString(),
            };
        } catch (error) {
            await this.decrementUsage(ownerId, file.size, 1, true);
            throw error;
        }
    }

    async signMultipartPart(
        ownerId: string,
        uploadId: string,
        partNumber: number,
    ): Promise<{ uploadUrl: string; method: 'PUT'; partNumber: number; size: number }> {
        const record = await this.multipartRecord(ownerId, uploadId);
        if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > Number(record.multipartPartCount))
            throw new BadRequestException('Invalid multipart part number');
        const offset = (partNumber - 1) * Number(record.multipartPartSize);
        const size = Math.min(Number(record.multipartPartSize), record.size - offset);
        const uploadUrl = await getSignedUrl(
            this.createS3Client(),
            new UploadPartCommand({
                Bucket: this.env('R2_BUCKET'),
                Key: record.objectKey,
                UploadId: record.multipartUploadId,
                PartNumber: partNumber,
                ContentLength: size,
            }),
            { expiresIn: 900 },
        );
        return { uploadUrl, method: 'PUT', partNumber, size };
    }

    async inspectMultipartUpload(ownerId: string, uploadId: string): Promise<Record<string, unknown>> {
        const record = await this.uploadModel.findOne({
            ownerId,
            uploadId,
            multipartUploadId: { $type: 'string' },
            status: { $in: ['initiated', 'completing', 'uploaded'] },
        });
        if (!record || record.expiresAt.getTime() <= Date.now()) {
            throw new BadRequestException('Multipart upload is unavailable or expired');
        }
        if (record.status === 'uploaded') {
            return {
                status: record.status,
                uploadId,
                attachmentId: record.attachmentId,
                partSize: record.multipartPartSize,
                partCount: record.multipartPartCount,
                parts: [],
                attachment: this.multipartAttachment(record),
            };
        }
        if (record.status === 'completing') {
            const leaseExpired = !record.multipartCompletionLeaseUntil || record.multipartCompletionLeaseUntil.getTime() <= Date.now();
            if (leaseExpired && record.multipartCompletionParts?.length === record.multipartPartCount) {
                const recovered = await this.completeMultipartUpload(
                    ownerId,
                    uploadId,
                    record.multipartCompletionParts,
                    record.sha256,
                );
                return {
                    status: 'uploaded', uploadId, attachmentId: record.attachmentId,
                    partSize: record.multipartPartSize, partCount: record.multipartPartCount,
                    parts: [], attachment: recovered.attachment,
                };
            }
            return {
                status: record.status,
                uploadId,
                attachmentId: record.attachmentId,
                partSize: record.multipartPartSize,
                partCount: record.multipartPartCount,
                parts: [],
            };
        }
        const listed = await this.createS3Client().send(
            new ListPartsCommand({
                Bucket: this.env('R2_BUCKET'),
                Key: record.objectKey,
                UploadId: record.multipartUploadId,
            }),
        );
        return {
            status: record.status,
            uploadId,
            attachmentId: record.attachmentId,
            partSize: record.multipartPartSize,
            partCount: record.multipartPartCount,
            parts: (listed.Parts ?? []).map((part) => ({
                partNumber: part.PartNumber,
                size: part.Size,
                etag: part.ETag,
            })),
        };
    }

    async completeMultipartUpload(
        ownerId: string,
        uploadId: string,
        parts: Array<{ partNumber: number; etag: string }>,
        sha256: string,
    ): Promise<{ attachment: MediaAttachment }> {
        const metadata = await this.uploadModel.findOne({ ownerId, uploadId, multipartUploadId: { $type: 'string' } });
        if (metadata?.status === 'uploaded') return { attachment: this.multipartAttachment(metadata) };
        if (
            !metadata ||
            !['initiated', 'completing'].includes(metadata.status) ||
            metadata.expiresAt.getTime() <= Date.now()
        ) {
            throw new BadRequestException('Multipart upload is unavailable or expired');
        }
        if (
            sha256.toLowerCase() !== metadata.sha256 ||
            parts.length !== metadata.multipartPartCount ||
            parts.some(
                (part, index) => part.partNumber !== index + 1 || typeof part.etag !== 'string' || !part.etag.trim(),
            )
        ) {
            throw new BadRequestException('Multipart completion manifest is invalid');
        }
        const completionToken = randomUUID();
        const now = new Date();
        let record = await this.uploadModel.findOneAndUpdate(
            {
            ownerId,
            uploadId,
            multipartUploadId: { $type: 'string' },
            expiresAt: { $gt: now },
                $or: [{ status: 'initiated' }, { status: 'completing', multipartCompletionLeaseUntil: { $lte: now } }],
            },
            {
            $set: {
                status: 'completing',
                multipartCompletionToken: completionToken,
                multipartCompletionLeaseUntil: new Date(Date.now() + 10 * 60_000),
                multipartCompletionParts: parts,
            },
            },
            { returnDocument: 'after' },
        );
        if (!record) {
            const existing = await this.uploadModel.findOne({
                ownerId,
                uploadId,
                multipartUploadId: { $type: 'string' },
            });
            if (existing?.status === 'uploaded') return { attachment: this.multipartAttachment(existing) };
            if (existing?.status === 'completing') {
                throw new HttpException(
                    {
                        statusCode: HttpStatus.CONFLICT,
                        code: 'multipart_completion_in_progress',
                        message: 'Video is still finalizing. Try again shortly.',
                    },
                    HttpStatus.CONFLICT,
                );
            }
            throw new BadRequestException('Multipart upload is unavailable or expired');
        }
        const client = this.createS3Client();
        try {
            await client.send(
                new CompleteMultipartUploadCommand({
                    Bucket: this.env('R2_BUCKET'),
                    Key: record.objectKey,
                    UploadId: record.multipartUploadId,
                    MultipartUpload: { Parts: parts.map((part) => ({ PartNumber: part.partNumber, ETag: part.etag })) },
                }),
            );
        } catch (error) {
            // R2 may have committed before the process lost its response. A
            // separately retrievable object is safe to verify; otherwise keep
            // the completion lease so a later retry can take over.
            await client
                .send(new HeadObjectCommand({ Bucket: this.env('R2_BUCKET'), Key: record.objectKey }))
                .catch(() => {
                    throw error;
                });
        }
        const object = await client.send(
            new GetObjectCommand({ Bucket: this.env('R2_BUCKET'), Key: record.objectKey }),
        );
        if (!object.Body) throw new BadRequestException('Completed multipart object is unavailable');
        const digest = createHash('sha256');
        let size = 0;
        for await (const chunk of object.Body as AsyncIterable<Uint8Array>) {
            size += chunk.byteLength;
            if (size > record.size) break;
            digest.update(chunk);
        }
        if (size !== record.size || digest.digest('hex') !== record.sha256) {
            await client
                .send(new DeleteObjectCommand({ Bucket: this.env('R2_BUCKET'), Key: record.objectKey }))
                .catch(() => undefined);
            await this.uploadModel.updateOne(
                { _id: record._id, multipartCompletionToken: completionToken },
                { $set: { status: 'deleting' } },
            );
            await this.finalizeDeletedRecords([record]);
            throw new BadRequestException('Completed multipart object checksum mismatch');
        }
        const committed = await this.uploadModel.findOneAndUpdate(
            { _id: record._id, status: 'completing', multipartCompletionToken: completionToken },
            { $set: { status: 'uploaded' }, $unset: { multipartCompletionToken: 1, multipartCompletionLeaseUntil: 1, multipartCompletionParts: 1 } },
            { returnDocument: 'after' },
        );
        if (!committed) {
            const winner = await this.uploadModel.findOne({ _id: record._id, status: 'uploaded' });
            if (!winner) throw new HttpException('Multipart completion lease changed', HttpStatus.CONFLICT);
            record = winner;
        } else record = committed;
        return { attachment: this.multipartAttachment(record) };
    }

    async abortMultipartUpload(ownerId: string, uploadId: string): Promise<void> {
        const record = await this.uploadModel.findOne({
            ownerId,
            uploadId,
            multipartUploadId: { $type: 'string' },
            status: { $in: ['initiated', 'uploaded'] },
        });
        if (!record) return;
        if (record.status === 'initiated')
            await this.createS3Client()
                .send(
                    new AbortMultipartUploadCommand({
                        Bucket: this.env('R2_BUCKET'),
                        Key: record.objectKey,
                        UploadId: record.multipartUploadId,
                    }),
                )
                .catch(() => undefined);
        else
            await this.createS3Client()
                .send(new DeleteObjectCommand({ Bucket: this.env('R2_BUCKET'), Key: record.objectKey }))
                .catch(() => undefined);
        await this.uploadModel.updateOne({ _id: record._id }, { $set: { status: 'deleting' } });
        await this.finalizeDeletedRecords([record]);
    }

    private async multipartRecord(ownerId: string, uploadId: string): Promise<AttachmentUploadDocument> {
        const record = await this.uploadModel.findOne({
            ownerId,
            uploadId,
            multipartUploadId: { $type: 'string' },
            status: 'initiated',
        });
        if (!record || record.expiresAt.getTime() <= Date.now())
            throw new BadRequestException('Multipart upload is unavailable or expired');
        return record;
    }

    private multipartAttachment(record: AttachmentUploadDocument): MediaAttachment {
        return {
            attachmentId: record.attachmentId,
            kind: record.kind as AttachmentKind,
            fileName: record.fileName,
            mimeType: record.mimeType,
            size: record.size,
            sha256: record.sha256,
            role: 'original',
        };
    }

    /** Persist a worker-validated media file without loading it into server memory. */
    async storeWorkerOutput(
        ownerId: string,
        input: {
        path: string;
        fileName: string;
        mimeType: string;
        kind: 'audio' | 'video' | 'image' | 'document';
        size: number;
        sha256: string;
        sourceKey?: string;
        expiresAt?: Date;
        },
    ): Promise<MediaAttachment & { expiresAt: Date }> {
        if (input.sourceKey) {
            if (!/^[a-zA-Z0-9][a-zA-Z0-9:_-]{0,199}$/.test(input.sourceKey))
                throw new BadRequestException('Invalid worker media source key');
            const replay = await this.uploadModel.findOne({
                ownerId,
                sourceKey: input.sourceKey,
                status: { $in: ['uploaded', 'attached'] },
            });
            if (replay) {
                if (input.sourceKey.startsWith('broker:') && replay.expiresAt.getTime() <= Date.now())
                    throw new BadRequestException('Worker media result expired');
                return { ...this.multipartAttachment(replay), expiresAt: replay.expiresAt };
            }
        }
        const file = await stat(input.path);
        if (!file.isFile() || file.size !== input.size || input.size < 1)
            throw new BadRequestException('Worker media file changed');
        const limit =
            input.kind === 'video' ? 250 * 1024 * 1024 : input.kind === 'audio' ? 100 * 1024 * 1024 : 20 * 1024 * 1024;
        if (input.size > limit || !/^[a-f0-9]{64}$/.test(input.sha256))
            throw new BadRequestException('Worker media exceeds limits');
        const allowed =
            input.kind === 'video'
            ? new Set(['video/mp4', 'video/webm'])
            : input.kind === 'audio'
                ? new Set(['audio/mpeg', 'audio/wav', 'audio/x-wav', 'audio/mp4', 'audio/x-m4a'])
                : input.kind === 'image'
                    ? new Set(['image/webp', 'image/jpeg'])
                    : new Set(['text/plain', 'text/vtt', 'application/json', 'application/x-subrip']);
        if (!allowed.has(input.mimeType)) throw new BadRequestException('Worker media type is unsupported');
        this.assertAllowedFileName(input.fileName);
        // Worker outputs are already bounded by the media job and owner storage
        // quota. They are not unfinished client uploads, so they must not consume
        // the active-upload or per-minute client-transfer counters. This is
        // especially important for derivatives and checkpointed dialogue parts.
        await this.reserveUsage(ownerId, input.size, 0);
        const attachmentId = randomUUID();
        const uploadId = randomUUID();
        const batchId = randomUUID();
        const objectKey = this.buildObjectKey(
            `media-results/${ownerId.replace(/[^a-zA-Z0-9_-]/g, '_')}`,
            input.fileName,
        );
        try {
            await this.createS3Client().send(
                new PutObjectCommand({
                    Bucket: this.env('R2_BUCKET'),
                    Key: objectKey,
                    Body: createReadStream(input.path),
                    ContentLength: input.size,
                    ContentType: input.mimeType,
                ChecksumSHA256: Buffer.from(input.sha256, 'hex').toString('base64'),
                Metadata: { uploadid: uploadId },
                }),
            );
            const expiresAt = input.expiresAt ?? new Date(Date.now() + 24 * 60 * 60_000);
            await this.uploadModel.create({
                ownerId,
                batchId,
                uploadId,
                attachmentId,
                objectKey,
                sourceKey: input.sourceKey,
                fileName: input.fileName,
                mimeType: input.mimeType,
                kind: input.kind,
                size: input.size,
                sha256: input.sha256,
                direction: 'outbound',
                activeSlotHeld: false,
                status: 'uploaded',
                expiresAt,
            });
            return {
                attachmentId,
                kind: input.kind,
                fileName: input.fileName,
                mimeType: input.mimeType,
                size: input.size,
                sha256: input.sha256,
                role: 'original',
                expiresAt,
            };
        } catch (error) {
            await this.createS3Client()
                .send(new DeleteObjectCommand({ Bucket: this.env('R2_BUCKET'), Key: objectKey }))
                .catch(() => undefined);
            await this.decrementUsage(ownerId, input.size, 0, true);
            if ((error as { code?: number }).code === 11000 && input.sourceKey) {
                const winner = await this.uploadModel.findOne({
                    ownerId,
                    sourceKey: input.sourceKey,
                    status: { $in: ['uploaded', 'attached'] },
                });
                if (winner) {
                    if (input.sourceKey.startsWith('broker:') && winner.expiresAt.getTime() <= Date.now())
                        throw new BadRequestException('Worker media result expired');
                    return { ...this.multipartAttachment(winner), expiresAt: winner.expiresAt };
                }
            }
            throw error;
        }
    }

    async completeRuntimeUploads(
        ownerId: string,
        batchId: string,
        uploadIds: string[],
    ): Promise<{ attachments: MediaAttachment[] }> {
        const records = await this.uploadModel.find({ ownerId, batchId, uploadId: { $in: uploadIds } });
        if (records.length !== uploadIds.length)
            throw new BadRequestException('Upload batch is incomplete or not owned by runtime');
        const s3 = this.createS3Client();
        const bucket = this.env('R2_BUCKET');
        const attachments: MediaAttachment[] = [];
        for (const record of records) {
            if (record.status === 'deleted' || record.expiresAt.getTime() <= Date.now())
                throw new BadRequestException(`Upload expired: ${record.fileName}`);
            if (record.status === 'initiated') {
                const head = await s3.send(
                    new HeadObjectCommand({ Bucket: bucket, Key: record.objectKey, ChecksumMode: 'ENABLED' }),
                );
                const expectedChecksum = Buffer.from(record.sha256, 'hex').toString('base64');
                if (
                    Number(head.ContentLength) !== record.size ||
                    head.ContentType !== record.mimeType ||
                    head.Metadata?.uploadid !== record.uploadId ||
                    head.ChecksumSHA256 !== expectedChecksum
                ) {
                    throw new BadRequestException(`Uploaded object metadata mismatch: ${record.fileName}`);
                }
                record.status = 'uploaded';
                await record.save();
            }
            attachments.push({
                attachmentId: record.attachmentId,
                kind: record.kind as AttachmentKind,
                fileName: record.fileName,
                mimeType: record.mimeType,
                size: record.size,
                sha256: record.sha256,
            });
        }
        return { attachments };
    }

    async proxyRuntimeUpload(
        ownerId: string,
        batchId: string,
        uploadId: string,
        body: Readable,
        headers: { contentLength?: number; mimeType?: string; sha256?: string },
    ): Promise<void> {
        const record = await this.uploadModel.findOne({ ownerId, batchId, uploadId, status: 'initiated' });
        if (!record || record.expiresAt.getTime() <= Date.now())
            throw new BadRequestException('Upload is unavailable, expired, or not owned by runtime');
        if (
            headers.contentLength !== record.size ||
            headers.mimeType?.trim().toLowerCase() !== record.mimeType.trim().toLowerCase() ||
            headers.sha256?.trim().toLowerCase() !== record.sha256.trim().toLowerCase()
        ) {
            throw new BadRequestException('Proxy upload metadata does not match the reserved attachment');
        }
        const checksum = Buffer.from(record.sha256, 'hex').toString('base64');
        await this.createS3Client().send(
            new PutObjectCommand({
                Bucket: this.env('R2_BUCKET'),
                Key: record.objectKey,
                Body: body,
                ContentLength: record.size,
                ContentType: record.mimeType,
                ChecksumSHA256: checksum,
                Metadata: { uploadid: record.uploadId },
            }),
        );
    }

    async abortRuntimeUploads(ownerId: string, batchId: string): Promise<void> {
        const records = await this.uploadModel.find({ ownerId, batchId, status: { $in: ['initiated', 'uploaded'] } });
        const s3 = this.createS3Client();
        const bucket = this.env('R2_BUCKET');
        const deleted: AttachmentUploadDocument[] = [];
        for (const record of records) {
            const claimed = await this.uploadModel.findOneAndUpdate(
                { _id: record._id, status: { $in: ['initiated', 'uploaded'] } },
                { $set: { status: 'deleting' } },
                { returnDocument: 'before' },
            );
            if (!claimed) continue;
            try {
                if (record.multipartUploadId && record.status === 'initiated') {
                    await s3.send(
                        new AbortMultipartUploadCommand({
                            Bucket: bucket,
                            Key: record.objectKey,
                            UploadId: record.multipartUploadId,
                        }),
                    );
                } else {
                    await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: record.objectKey }));
                }
                deleted.push(claimed);
            } catch (error) {
                await this.uploadModel.updateOne(
                    { _id: record._id, status: 'deleting' },
                    { $set: { status: record.status } },
                );
                this.logger.warn(
                    `Attachment abort cleanup failed attachmentId=${record.attachmentId}: ${String(error)}`,
                );
            }
        }
        if (deleted.length) {
            await this.finalizeDeletedRecords(deleted);
        }
    }

    async deleteInboundAttachmentsForMessages(ownerId: string, messageIds: string[]): Promise<void> {
        if (!messageIds.length) return;
        const records = await this.uploadModel.find({
            ownerId,
            direction: 'inbound',
            messageId: { $in: messageIds },
            status: 'attached',
        });
        const deleted: AttachmentUploadDocument[] = [];
        for (const record of records) {
            const claimed = await this.uploadModel.findOneAndUpdate(
                { _id: record._id, status: 'attached' },
                { $set: { status: 'deleting', activeSlotHeld: false } },
                { returnDocument: 'after' },
            );
            if (!claimed) continue;
            try {
                await this.createS3Client().send(
                    new DeleteObjectCommand({ Bucket: this.env('R2_BUCKET'), Key: record.objectKey }),
                );
                deleted.push(claimed);
            } catch (error) {
                await this.uploadModel.updateOne(
                    { _id: record._id, status: 'deleting' },
                    { $set: { status: 'attached', activeSlotHeld: false } },
                );
                this.logger.warn(
                    `Inbound attachment deletion failed attachmentId=${record.attachmentId}: ${this.errorMessage(error)}`,
                );
            }
        }
        await this.finalizeDeletedRecords(deleted);
    }

    async deleteLibraryAttachments(ownerId: string, attachmentIds: string[], messageId: string): Promise<void> {
        const ids = [...new Set(attachmentIds)];
        if (!ids.length) return;
        const records = await this.uploadModel.find({
            ownerId,
            attachmentId: { $in: ids },
            messageId,
            status: 'attached',
        });
        if (records.length !== ids.length) throw new BadRequestException('One or more library assets are unavailable');
        const deleted: AttachmentUploadDocument[] = [];
        for (const record of records) {
            const claimed = await this.uploadModel.findOneAndUpdate(
                { _id: record._id, ownerId, messageId, status: 'attached' },
                { $set: { status: 'deleting' } },
                { returnDocument: 'before' },
            );
            if (!claimed) continue;
            await this.createS3Client().send(
                new DeleteObjectCommand({ Bucket: this.env('R2_BUCKET'), Key: claimed.objectKey }),
            );
            deleted.push(claimed);
        }
        await this.finalizeDeletedRecords(deleted);
    }

    async resolveRuntimeAttachment(ownerId: string, attachmentId: string): Promise<MediaAttachment | undefined> {
        const record = await this.uploadModel.findOne({
            ownerId,
            attachmentId,
            status: { $in: ['uploaded', 'attached'] },
        });
        if (!record) return undefined;
        const url = await getSignedUrl(
            this.createS3Client(),
            new GetObjectCommand({ Bucket: this.env('R2_BUCKET'), Key: record.objectKey }),
            { expiresIn: PRIVATE_ATTACHMENT_READ_URL_TTL_SECONDS },
        );
        return {
            attachmentId,
            url,
            ...normalizeMediaAttachmentMetadata(record.mediaMetadata),
            kind: record.kind as AttachmentKind,
            fileName: record.fileName,
            mimeType: record.mimeType,
            size: record.size,
            sha256: record.sha256,
        };
    }

    /**
     * Publishes worker-probed metadata on the owner-scoped original. Ready
     * metadata is immutable and may only reference existing owner assets.
     */
    async publishWorkerMediaMetadata(
        ownerId: string,
        attachmentId: string,
        input: Partial<MediaAttachmentMetadata>,
    ): Promise<void> {
        const original = await this.uploadModel.findOne({
            ownerId,
            attachmentId,
            status: { $in: ['uploaded', 'attached'] },
        });
        if (!original || !['audio', 'video'].includes(original.kind)) {
            throw new BadRequestException('Media original is unavailable');
        }
        const metadata = normalizeMediaAttachmentMetadata({
            ...input,
            originalAttachmentId: attachmentId,
        });
        if (!metadata.processingStatus) {
            throw new BadRequestException('Worker media status is required');
        }
        const current = normalizeMediaAttachmentMetadata(original.mediaMetadata);
        if (current.processingStatus === 'ready') {
            if (JSON.stringify(current) !== JSON.stringify(metadata)) {
                throw new BadRequestException('Published media metadata is immutable');
            }
            return;
        }
        if (metadata.processingStatus === 'ready') {
            await this.assertReadyMediaDerivatives(ownerId, original.kind, metadata);
        }
        original.mediaMetadata = metadata;
        await original.save();
    }

    private async assertReadyMediaDerivatives(
        ownerId: string,
        kind: string,
        metadata: Partial<MediaAttachmentMetadata>,
    ): Promise<void> {
        const playbackId = metadata.playbackAttachmentId;
        if (!playbackId) throw new BadRequestException('Ready media requires a playback derivative');
        const ids = [playbackId, metadata.posterAttachmentId].filter((value): value is string => Boolean(value));
        const derivatives = await this.uploadModel
            .find({
            ownerId,
            attachmentId: { $in: ids },
            status: { $in: ['uploaded', 'attached'] },
            })
            .lean();
        if (derivatives.length !== new Set(ids).size) {
            throw new BadRequestException('One or more media derivatives are unavailable');
        }
        const playback = derivatives.find((item) => item.attachmentId === playbackId);
        const canonicalVideo =
            kind === 'video' &&
            metadata.container === 'mp4' &&
            ['h264', 'avc1'].includes(String(metadata.videoCodec)) &&
            (metadata.hasAudio !== true || metadata.audioCodec === 'aac') &&
            playback?.mimeType === 'video/mp4';
        const canonicalAudio =
            kind === 'audio' &&
            ['m4a', 'mp4'].includes(String(metadata.container)) &&
            metadata.audioCodec === 'aac' &&
            ['audio/mp4', 'audio/x-m4a'].includes(String(playback?.mimeType));
        if (!canonicalVideo && !canonicalAudio) {
            throw new BadRequestException('Playback derivative is not in the canonical mobile format');
        }
        if (metadata.posterAttachmentId) {
            const poster = derivatives.find((item) => item.attachmentId === metadata.posterAttachmentId);
            if (!['image/webp', 'image/jpeg'].includes(String(poster?.mimeType))) {
                throw new BadRequestException('Media poster must be WebP or JPEG');
            }
        }
    }

    async resolveInboundAttachment(
        ownerId: string,
        attachmentId: string,
        includeSignedUrl = true,
    ): Promise<MediaAttachment | undefined> {
        const record = await this.uploadModel.findOne({
            ownerId,
            attachmentId,
            direction: 'inbound',
            status: { $in: ['initiated', 'uploaded', 'attached'] },
        });
        if (!record || (record.status !== 'attached' && record.expiresAt.getTime() <= Date.now())) return undefined;
        if (record.status === 'initiated') {
            const head = await this.createS3Client().send(
                new HeadObjectCommand({
                    Bucket: this.env('R2_BUCKET'),
                    Key: record.objectKey,
                    ChecksumMode: 'ENABLED',
                }),
            );
            const checksum = record.sha256 ? Buffer.from(record.sha256, 'hex').toString('base64') : undefined;
            if (
                Number(head.ContentLength) !== record.size ||
                head.ContentType !== record.mimeType ||
                head.Metadata?.uploadid !== record.uploadId ||
                (checksum && head.ChecksumSHA256 !== checksum)
            ) {
                throw new BadRequestException(`Uploaded object metadata mismatch: ${record.fileName}`);
            }
            record.status = 'uploaded';
            await record.save();
        }
        const url = includeSignedUrl
            ? await getSignedUrl(
                  this.createS3Client(),
                  new GetObjectCommand({ Bucket: this.env('R2_BUCKET'), Key: record.objectKey }),
                  { expiresIn: 300 },
              )
            : undefined;
        return {
            attachmentId,
            url,
            kind: record.kind as AttachmentKind,
            fileName: record.fileName,
            mimeType: record.mimeType,
            size: record.size,
            sha256: record.sha256 || undefined,
            ...normalizeMediaAttachmentMetadata(record.mediaMetadata),
            role: 'original',
        };
    }

    async storeInboundAttachment(
        ownerId: string,
        input: { bytes: Uint8Array; fileName: string; mimeType: string },
    ): Promise<MediaAttachment> {
        const size = input.bytes.byteLength;
        if (!ownerId || size <= 0 || size > MAX_FILE_SIZE_BYTES)
            throw new BadRequestException('Invalid inbound attachment');
        this.assertAllowedFileName(input.fileName);
        this.assertAllowedMimeType(input.fileName, input.mimeType);
        await this.reserveUsage(ownerId, size, 1);
        const attachmentId = randomUUID();
        const uploadId = randomUUID();
        const batchId = randomUUID();
        const sha256 = createHash('sha256').update(input.bytes).digest('hex');
        const objectKey = this.buildObjectKey(`inbound/${ownerId.replace(/[^a-zA-Z0-9_-]/g, '_')}`, input.fileName);
        try {
            await this.createS3Client().send(
                new PutObjectCommand({
                    Bucket: this.env('R2_BUCKET'),
                    Key: objectKey,
                    Body: Buffer.from(input.bytes),
                    ContentType: input.mimeType,
                    Metadata: { uploadid: uploadId },
                    ChecksumSHA256: Buffer.from(sha256, 'hex').toString('base64'),
                }),
            );
            await this.uploadModel.create({
                ownerId,
                batchId,
                uploadId,
                attachmentId,
                objectKey,
                fileName: input.fileName,
                mimeType: input.mimeType,
                kind: this.kindFromMime(input.mimeType),
                size,
                sha256,
                direction: 'inbound',
                activeSlotHeld: true,
                status: 'uploaded',
                expiresAt: new Date(Date.now() + 15 * 60_000),
            });
            return {
                attachmentId,
                kind: this.kindFromMime(input.mimeType),
                fileName: input.fileName,
                mimeType: input.mimeType,
                size,
                sha256,
                role: 'original',
            };
        } catch (error) {
            await this.createS3Client()
                .send(new DeleteObjectCommand({ Bucket: this.env('R2_BUCKET'), Key: objectKey }))
                .catch(() => undefined);
            await this.decrementUsage(ownerId, size, 1, true);
            throw error;
        }
    }

    async createPrivateReadUrl(ownerId: string, attachmentId: string): Promise<string> {
        return (await this.createPrivateReadAccessForRecord(ownerId, attachmentId)).url;
    }

    async createPrivateReadAccess(ownerId: string, attachmentId: string): Promise<{ url: string; expiresIn: number }> {
        return this.createPrivateReadAccessForRecord(ownerId, attachmentId);
    }

    async createInboundPrivateReadUrl(ownerId: string, attachmentId: string): Promise<string> {
        return (await this.createPrivateReadAccessForRecord(ownerId, attachmentId, 'inbound')).url;
    }

    private async createPrivateReadAccessForRecord(
        ownerId: string,
        attachmentId: string,
        direction?: 'inbound',
    ): Promise<{ url: string; expiresIn: number }> {
        const record = await this.uploadModel.findOne({
            ownerId,
            attachmentId,
            ...(direction ? { direction } : {}),
            status: { $in: ['uploaded', 'attached'] },
        });
        if (!record) throw new BadRequestException('Attachment not found');
        if (record.sourceKey?.startsWith('broker:') && record.expiresAt.getTime() <= Date.now())
            throw new BadRequestException('Attachment expired');
        const expiresIn = record.sourceKey?.startsWith('broker:')
            ? Math.max(1, Math.min(PRIVATE_ATTACHMENT_READ_URL_TTL_SECONDS,
                Math.floor((record.expiresAt.getTime() - Date.now()) / 1000)))
            : PRIVATE_ATTACHMENT_READ_URL_TTL_SECONDS;
        const url = await getSignedUrl(
            this.createS3Client(),
            new GetObjectCommand({
                Bucket: this.env('R2_BUCKET'),
                Key: record.objectKey,
                ResponseContentDisposition: `attachment; filename="${record.fileName.replace(/["\\]/g, '_')}"`,
                ResponseContentType: record.mimeType,
            }),
            { expiresIn },
        );
        return { url, expiresIn };
    }

    async markAttached(
        ownerId: string,
        attachmentIds: string[],
        messageId: string,
        session?: ClientSession,
    ): Promise<void> {
        if (!attachmentIds.length) return;
        const roots = await this.uploadModel
            .find({ ownerId, attachmentId: { $in: attachmentIds }, status: { $in: ['uploaded', 'attached'] } })
            .session(session ?? null);
        const dependencies = roots.flatMap((record) => {
            const metadata = normalizeMediaAttachmentMetadata(record.mediaMetadata);
            return [metadata.playbackAttachmentId, metadata.posterAttachmentId].filter((value): value is string =>
                Boolean(value),
            );
        });
        attachmentIds = [...new Set([...attachmentIds, ...dependencies])];
        const existing = await this.uploadModel
            .countDocuments({
                ownerId,
                attachmentId: { $in: attachmentIds },
                $or: [{ status: 'uploaded' }, { status: 'attached', messageId }],
            })
            .session(session ?? null);
        if (existing !== attachmentIds.length)
            throw new BadRequestException('One or more attachments are unavailable or not owned by this message');
        // Claim slot-holding client uploads first. Worker-owned output records
        // already have activeSlotHeld=false and must not decrement a slot that a
        // different in-flight upload owns.
        const held = await this.uploadModel.updateMany(
            { ownerId, attachmentId: { $in: attachmentIds }, status: 'uploaded', activeSlotHeld: { $ne: false } },
            { $set: { status: 'attached', messageId, activeSlotHeld: false } },
            { session },
        );
        if (held.modifiedCount > 0) await this.decrementUsage(ownerId, 0, held.modifiedCount, false, session);
        await this.uploadModel.updateMany(
            { ownerId, attachmentId: { $in: attachmentIds }, status: 'uploaded', activeSlotHeld: false },
            { $set: { status: 'attached', messageId } },
            { session },
        );
        const remainingUploaded = await this.uploadModel
            .countDocuments({
                ownerId,
                attachmentId: { $in: attachmentIds },
                status: 'uploaded',
            })
            .session(session ?? null);
        if (remainingUploaded > 0) {
            this.logger.warn(
                `Outbound attachment(s) remained uploaded after markAttached owner=${this.redactId(ownerId)} messageId=${messageId} remaining=${remainingUploaded}`,
            );
        }
    }

    /**
     * Additive repair for worker outputs created before they stopped consuming
     * client upload slots. The attachment rows and aggregate counter move in one
     * transaction, so a crash cannot permanently skew the quota record.
     */
    async releaseLegacyWorkerOutputSlots(limit = 200): Promise<number> {
        const candidates = await this.uploadModel
            .find({
                direction: 'outbound',
                sourceKey: { $type: 'string' },
                activeSlotHeld: true,
                status: { $in: ['uploaded', 'attached'] },
            })
            .limit(Math.max(1, Math.min(1_000, limit)));
        if (!candidates.length) return 0;
        const session = await this.uploadModel.db.startSession();
        let released = 0;
        try {
            await session.withTransaction(async () => {
                const byOwner = new Map<string, string[]>();
                for (const record of candidates) {
                    const ids = byOwner.get(record.ownerId) ?? [];
                    ids.push(record.attachmentId);
                    byOwner.set(record.ownerId, ids);
                }
                for (const [ownerId, attachmentIdsForOwner] of byOwner) {
                    const result = await this.uploadModel.updateMany(
                        {
                            ownerId,
                            attachmentId: { $in: attachmentIdsForOwner },
                            direction: 'outbound',
                            sourceKey: { $type: 'string' },
                            activeSlotHeld: true,
                            status: { $in: ['uploaded', 'attached'] },
                        },
                        { $set: { activeSlotHeld: false } },
                        { session },
                    );
                    if (result.modifiedCount > 0) {
                        await this.decrementUsage(ownerId, 0, result.modifiedCount, false, session);
                        released += result.modifiedCount;
                    }
                }
            });
            return released;
        } finally {
            await session.endSession();
        }
    }

    private async reserveUsage(ownerId: string, bytes: number, files: number): Promise<void> {
        const quota = Number(process.env.JOVITA_ATTACHMENT_STORAGE_QUOTA_BYTES ?? 5 * 1024 * 1024 * 1024);
        const now = new Date();
        const cutoff = new Date(now.getTime() - 60_000);
        try {
            await this.usageModel.updateOne(
                { ownerId },
                { $setOnInsert: { ownerId, storageBytes: 0, activeUploads: 0, rateWindowStart: now, rateUploads: 0 } },
                { upsert: true },
            );
        } catch (error) {
            if ((error as { code?: number }).code !== 11000) throw error;
        }
        const storageExceeded = { $gt: [{ $add: ['$storageBytes', bytes] }, quota] };
        const concurrencyExceeded = { $gt: [{ $add: ['$activeUploads', files] }, MAX_ACTIVE_RUNTIME_UPLOADS] };
        const rateWindowExpired = { $lte: ['$rateWindowStart', cutoff] };
        const rateExceeded = {
            $and: [
                { $gt: ['$rateWindowStart', cutoff] },
                { $gt: [{ $add: ['$rateUploads', files] }, MAX_RUNTIME_UPLOADS_PER_MINUTE] },
            ],
        };
        const allowed = { $not: [{ $or: [storageExceeded, concurrencyExceeded, rateExceeded] }] };
        const reserved = await this.usageModel.findOneAndUpdate(
            { ownerId },
            [
                {
                    $set: {
                        storageBytes: { $cond: [allowed, { $add: ['$storageBytes', bytes] }, '$storageBytes'] },
                        activeUploads: { $cond: [allowed, { $add: ['$activeUploads', files] }, '$activeUploads'] },
                        rateUploads: {
                            $cond: [
                                allowed,
                                { $cond: [rateWindowExpired, files, { $add: ['$rateUploads', files] }] },
                                '$rateUploads',
                            ],
                        },
                        rateWindowStart: {
                            $cond: [{ $and: [allowed, rateWindowExpired] }, now, '$rateWindowStart'],
                        },
                        lastReservationFailure: {
                            $switch: {
                                branches: [
                                    { case: storageExceeded, then: 'attachment_storage_quota_exceeded' },
                                    { case: concurrencyExceeded, then: 'attachment_concurrency_exceeded' },
                                    { case: rateExceeded, then: 'attachment_rate_limit_exceeded' },
                                ],
                                default: null,
                            },
                        },
                        lastReservationRetryAfterMs: {
                            $cond: [
                                rateExceeded,
                                { $max: [1_000, { $subtract: [60_000, { $subtract: [now, '$rateWindowStart'] }] }] },
                                null,
                            ],
                        },
                    },
                },
            ],
            { returnDocument: 'after', updatePipeline: true },
        );
        if (!reserved) throw new Error('Attachment usage record disappeared during reservation');
        const failureCode = reserved.lastReservationFailure as AttachmentReservationFailureCode | undefined;
        if (!failureCode) return;

        const storageBytes = Math.max(0, Number(reserved.storageBytes ?? 0));
        const activeUploads = Math.max(0, Number(reserved.activeUploads ?? 0));
        const rateUploads = Math.max(0, Number(reserved.rateUploads ?? 0));
        const rateWindowStart = reserved.rateWindowStart instanceof Date ? reserved.rateWindowStart : now;
        const retryAfterMs = Math.max(1_000, Number(reserved.lastReservationRetryAfterMs ?? 1_000));
        this.logger.warn(
            `Attachment reservation rejected owner=${this.redactId(ownerId)} requestedFiles=${files} requestedBytes=${bytes} ` +
                `activeUploads=${activeUploads} activeLimit=${MAX_ACTIVE_RUNTIME_UPLOADS} storageBytes=${storageBytes} ` +
                `storageQuota=${quota} rateUploads=${rateUploads} rateLimit=${MAX_RUNTIME_UPLOADS_PER_MINUTE} ` +
                `rateWindowStart=${rateWindowStart.toISOString()}`,
        );

        if (failureCode === 'attachment_storage_quota_exceeded') {
            throw new AttachmentReservationException(
                'attachment_storage_quota_exceeded',
                'Attachment storage quota exceeded',
                HttpStatus.PAYLOAD_TOO_LARGE,
            );
        }
        if (failureCode === 'attachment_concurrency_exceeded') {
            throw new AttachmentReservationException(
                'attachment_concurrency_exceeded',
                `Too many unclaimed attachments (max ${MAX_ACTIVE_RUNTIME_UPLOADS})`,
                HttpStatus.CONFLICT,
            );
        }
        throw new AttachmentReservationException(
            'attachment_rate_limit_exceeded',
            `Attachment upload rate limit exceeded (max ${MAX_RUNTIME_UPLOADS_PER_MINUTE} per minute)`,
            HttpStatus.TOO_MANY_REQUESTS,
            retryAfterMs,
        );
    }

    private async releaseUsage(
        records: AttachmentUploadDocument[],
        includeStorage: boolean,
        session?: ClientSession,
    ): Promise<void> {
        const byOwner = new Map<string, { bytes: number; files: number }>();
        for (const record of records) {
            const value = byOwner.get(record.ownerId) ?? { bytes: 0, files: 0 };
            value.bytes += record.size;
            if (record.activeSlotHeld !== false) value.files += 1;
            byOwner.set(record.ownerId, value);
        }
        await Promise.all(
            [...byOwner].map(([ownerId, value]) =>
                this.decrementUsage(ownerId, value.bytes, value.files, includeStorage, session),
            ),
        );
    }

    private async rollbackInitiatedBatch(
        ownerId: string,
        batchId: string,
        bytes: number,
        files: number,
    ): Promise<void> {
        const session = await this.uploadModel.db.startSession();
        try {
            await session.withTransaction(async () => {
                await this.uploadModel.updateMany(
                    { ownerId, batchId, status: 'initiated' },
                    { $set: { status: 'deleted' } },
                    { session },
                );
                await this.decrementUsage(ownerId, bytes, files, true, session);
            });
        } finally {
            await session.endSession();
        }
    }

    private async finalizeDeletedRecords(records: AttachmentUploadDocument[]): Promise<void> {
        if (!records.length) return;
        const session = await this.uploadModel.db.startSession();
        try {
            await session.withTransaction(async () => {
                const pending = await this.uploadModel
                    .find({ _id: { $in: records.map((record) => record._id) }, status: 'deleting' })
                    .session(session);
                if (!pending.length) return;
                await this.uploadModel.updateMany(
                    { _id: { $in: pending.map((record) => record._id) }, status: 'deleting' },
                    { $set: { status: 'deleted' } },
                    { session },
                );
                await this.releaseUsage(pending, true, session);
            });
        } finally {
            await session.endSession();
        }
    }

    private async decrementUsage(
        ownerId: string,
        bytes: number,
        files: number,
        includeStorage: boolean,
        session?: ClientSession,
    ): Promise<void> {
        await this.usageModel.updateOne(
            { ownerId },
            [
                {
                    $set: {
                        ...(includeStorage
                            ? { storageBytes: { $max: [0, { $subtract: ['$storageBytes', bytes] }] } }
                            : {}),
                        activeUploads: { $max: [0, { $subtract: ['$activeUploads', files] }] },
                    },
                },
            ],
            { updatePipeline: true, ...(session ? { session } : {}) },
        );
    }

    private assertRuntimeFile(file: {
        fileName: string;
        size: number;
        mimeType: string;
        kind: AttachmentKind;
        sha256: string;
    }): void {
        if (!file.fileName?.trim() || !/^[a-f0-9]{64}$/i.test(file.sha256))
            throw new BadRequestException('Invalid attachment metadata');
        const limits: Record<AttachmentKind, number> = {
            image: 10 * 1024 * 1024,
            document: file.mimeType?.trim().toLowerCase() === 'application/zip' ? 100 * 1024 * 1024 : 25 * 1024 * 1024,
            audio: 100 * 1024 * 1024,
            video: 250 * 1024 * 1024,
        };
        if (!Number.isFinite(file.size) || file.size <= 0 || file.size > limits[file.kind])
            throw new BadRequestException(`File exceeds ${file.kind} limit: ${file.fileName}`);
        const mime = file.mimeType?.trim().toLowerCase();
        const allowed: Record<AttachmentKind, Set<string>> = {
            image: new Set([
                'image/png',
                'image/jpeg',
                'image/gif',
                'image/webp',
                'image/heic',
                'image/heif',
                'image/svg+xml',
            ]),
            document: new Set([
                'application/pdf',
                'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
                'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
                'text/csv',
                'text/plain',
                'text/markdown',
                'application/json',
                'application/yaml',
                'application/zip',
            ]),
            audio: new Set([
                'audio/mpeg',
                'audio/wav',
                'audio/ogg',
                'audio/mp4',
                'audio/aac',
                'audio/flac',
                'audio/opus',
            ]),
            video: new Set(['video/mp4', 'video/quicktime', 'video/webm', 'video/x-matroska']),
        };
        if (!allowed[file.kind].has(mime)) throw new BadRequestException(`Unsupported ${file.kind} MIME type`);
    }
    async createPresignedUploads(ownerId: string, files: PresignFileInput[]): Promise<PresignUploadItem[]> {
        if (files.length === 0) {
            throw new BadRequestException('No files provided');
        }
        if (files.length > MAX_FILES) {
            throw new BadRequestException(`Too many files (max ${MAX_FILES})`);
        }

        for (const file of files) {
            if (!file.fileName?.trim()) {
                throw new BadRequestException('fileName is required');
            }
            this.assertAllowedFileName(file.fileName);
            if (!Number.isFinite(file.size) || file.size <= 0) {
                throw new BadRequestException(`Invalid file size for ${file.fileName}`);
            }
            if (file.size > MAX_FILE_SIZE_BYTES) {
                throw new BadRequestException(`File too large (max 250MB): ${file.fileName}`);
            }
            const mimeType = (file.mimeType?.trim() || 'application/octet-stream').toLowerCase();
            this.assertAllowedMimeType(file.fileName, mimeType);
            if (!/^[a-f0-9]{64}$/i.test(String(file.sha256 ?? '').trim())) {
                throw new BadRequestException(`SHA-256 is required for ${file.fileName}`);
            }
        }
        const s3 = this.createS3Client();
        const bucket = this.env('R2_BUCKET');
        const requestedBytes = files.reduce((sum, file) => sum + Number(file.size || 0), 0);
        await this.reserveUsage(ownerId, requestedBytes, files.length);
        const batchId = randomUUID();
        const uploads: PresignUploadItem[] = [];
        try {
            for (const file of files) {
                const mimeType = (file.mimeType?.trim() || 'application/octet-stream').toLowerCase();
                const kind = file.kind ?? this.kindFromMime(mimeType);
                const key = this.buildObjectKey(`inbound/${ownerId.replace(/[^a-zA-Z0-9_-]/g, '_')}`, file.fileName);
                const attachmentId = randomUUID();
                const uploadId = randomUUID();
                const sha256 = String(file.sha256 ?? '')
                    .trim()
                    .toLowerCase();
                const checksum = Buffer.from(sha256, 'hex').toString('base64');

                const put = new PutObjectCommand({
                    Bucket: bucket,
                    Key: key,
                    ContentType: mimeType,
                    Metadata: { uploadid: uploadId },
                    ChecksumSHA256: checksum,
                });
                const uploadUrl = await getSignedUrl(s3, put, {
                    expiresIn: 600,
                    unhoistableHeaders: RUNTIME_UPLOAD_UNHOISTABLE_HEADERS,
                    signableHeaders: new Set(['content-type']),
                });
                await this.uploadModel.create({
                    ownerId,
                    batchId,
                    uploadId,
                    attachmentId,
                    objectKey: key,
                    fileName: file.fileName,
                    mimeType,
                    kind,
                    size: file.size,
                    sha256,
                    direction: 'inbound',
                    activeSlotHeld: true,
                    status: 'initiated',
                    expiresAt: new Date(Date.now() + 15 * 60_000),
                });

                uploads.push({
                    uploadUrl,
                    method: 'PUT',
                    headers: {
                        'content-type': mimeType,
                        'x-amz-meta-uploadid': uploadId,
                        'x-amz-checksum-sha256': checksum,
                    },
                    attachment: {
                        attachmentId,
                        kind,
                        mimeType,
                        fileName: file.fileName,
                        size: file.size,
                    },
                });
            }
            return uploads;
        } catch (error) {
            await this.rollbackInitiatedBatch(ownerId, batchId, requestedBytes, files.length);
            throw error;
        }
    }

    async uploadAttachmentBytes(input: {
        bytes: Uint8Array;
        fileName: string;
        mimeType: string;
        kind?: AttachmentKind;
        keyPrefix?: string;
        publicProxyBaseUrl?: string;
    }): Promise<MediaAttachment> {
        const bytes = input.bytes;
        if (bytes.byteLength <= 0) {
            throw new BadRequestException('Cannot upload empty attachment');
        }
        if (bytes.byteLength > MAX_FILE_SIZE_BYTES) {
            throw new BadRequestException(`File too large (max 10MB): ${input.fileName}`);
        }

        const s3 = this.createS3Client();
        const bucket = this.env('R2_BUCKET');
        const keyPrefix = input.keyPrefix?.trim() || process.env.R2_KEY_PREFIX?.trim() || 'uploads';
        const key = this.buildObjectKey(keyPrefix, input.fileName);
        const mimeType = (input.mimeType?.trim() || 'application/octet-stream').toLowerCase();
        const kind = input.kind ?? this.kindFromMime(mimeType);

        const put = new PutObjectCommand({
            Bucket: bucket,
            Key: key,
            ContentType: mimeType,
            Body: Buffer.from(bytes),
        });
        await s3.send(put);

        const readUrl = input.publicProxyBaseUrl
            ? `${input.publicProxyBaseUrl.replace(/\/$/, '')}/creator-public/media/showcase/${key.split('/').pop()}`
            : await this.buildReadUrl(s3, bucket, key);
        return {
            kind,
            url: readUrl,
            mimeType,
            fileName: input.fileName,
            size: bytes.byteLength,
        };
    }

    async uploadServiceLogoBytes(input: {
        bytes: Uint8Array;
        fileName: string;
        mimeType: string;
    }): Promise<MediaAttachment> {
        return this.uploadAttachmentBytes({
            bytes: input.bytes,
            fileName: input.fileName,
            mimeType: input.mimeType,
            kind: 'image',
            keyPrefix: 'service-logo',
        });
    }

    async uploadCreatorProfileBytes(input: {
        bytes: Uint8Array;
        fileName: string;
        mimeType: string;
    }): Promise<MediaAttachment> {
        return this.uploadAttachmentBytes({
            bytes: input.bytes,
            fileName: input.fileName,
            mimeType: input.mimeType,
            kind: 'image',
            keyPrefix: 'creator-profile',
        });
    }

    async uploadCreatorShowcaseBytes(input: { bytes: Uint8Array; fileName: string; mimeType: string; kind: AttachmentKind }): Promise<MediaAttachment> {
        const apiBase = process.env.JOVITA_SERVER_PUBLIC_BASE_URL?.trim();
        if (!process.env.R2_PUBLIC_BASE_URL?.trim() && !apiBase?.startsWith('https://')) {
            throw new BadRequestException('Configure a public HTTPS URL for showcase media');
        }
        return this.uploadAttachmentBytes({ ...input, keyPrefix: 'creator-showcase',
            publicProxyBaseUrl: process.env.R2_PUBLIC_BASE_URL?.trim() ? undefined : apiBase });
    }

    async readCreatorShowcase(file: string, range?: string): Promise<{ bytes: Uint8Array; mimeType: string; contentRange?: string }> {
        if (!/^[0-9]+-[0-9a-f-]+\.(jpg|png|webp|mp4|webm)$/i.test(file)) throw new BadRequestException('Invalid showcase media path');
        if (range && !/^bytes=\d+-\d*$/.test(range)) throw new BadRequestException('Invalid media range');
        const mimeTypes: Record<string, string> = { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp', mp4: 'video/mp4', webm: 'video/webm' };
        const s3 = this.createS3Client();
        try {
            const object = await s3.send(new GetObjectCommand({ Bucket: this.env('R2_BUCKET'), Key: `creator-showcase/${file}`, ...(range ? { Range: range } : {}) }));
            if (!object.Body || Number(object.ContentLength) > MAX_FILE_SIZE_BYTES) throw new BadRequestException('Showcase media is unavailable');
            return { bytes: await object.Body.transformToByteArray(), mimeType: mimeTypes[file.split('.').pop()!.toLowerCase()],
                contentRange: object.ContentRange };
        } catch (error) {
            if ((error as { name?: string }).name === 'NoSuchKey') throw new NotFoundException('Showcase media not found');
            throw error;
        } finally { s3.destroy(); }
    }

    private createS3Client(): S3Client {
        return new S3Client({
            region: process.env.R2_REGION || 'auto',
            endpoint: this.env('R2_S3_ENDPOINT'),
            credentials: {
                accessKeyId: this.env('R2_ACCESS_KEY_ID'),
                secretAccessKey: this.env('R2_SECRET_ACCESS_KEY'),
            },
            forcePathStyle: true,
        });
    }

    private buildObjectKey(prefix: string, fileName: string): string {
        const safePrefix = prefix.replace(/^\/+|\/+$/g, '');
        const ext = extname(fileName) || '';
        return `${safePrefix}/${Date.now()}-${randomUUID()}${ext}`;
    }

    private assertAllowedFileName(fileName: string): void {
        const ext = extname(fileName).replace(/^\./, '').trim().toLowerCase();
        if (ALLOWED_UPLOAD_EXTENSIONS.includes(ext as (typeof ALLOWED_UPLOAD_EXTENSIONS)[number])) {
            return;
        }
        throw new BadRequestException(
            `Unsupported file type: ${fileName}. Allowed: ${ALLOWED_UPLOAD_EXTENSIONS.join(', ')}`,
        );
    }

    private assertAllowedMimeType(fileName: string, mimeType: string): void {
        if (!ALLOWED_UPLOAD_MIME_TYPES.includes(mimeType as (typeof ALLOWED_UPLOAD_MIME_TYPES)[number])) {
            throw new BadRequestException(`Unsupported MIME type: ${mimeType}`);
        }
        const ext = extname(fileName).replace(/^\./, '').trim().toLowerCase();
        const allowedForExtension: Record<string, readonly string[]> = {
            png: ['image/png'],
            jpg: ['image/jpeg'],
            jpeg: ['image/jpeg'],
            jfif: ['image/jpeg'],
            webp: ['image/webp'],
            gif: ['image/gif'],
            heic: ['image/heic'],
            heif: ['image/heif'],
            svg: ['image/svg+xml'],
            pdf: ['application/pdf'],
            docx: ['application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
            xlsx: ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
            txt: ['text/plain'],
            md: ['text/markdown', 'text/plain'],
            csv: ['text/csv'],
            json: ['application/json'],
            yaml: ['application/yaml', 'text/yaml', 'text/x-yaml'],
            yml: ['application/yaml', 'text/yaml', 'text/x-yaml'],
            mp3: ['audio/mpeg'],
            wav: ['audio/wav'],
            m4a: ['audio/mp4'],
            aac: ['audio/aac'],
            flac: ['audio/flac'],
            ogg: ['audio/ogg'],
            opus: ['audio/opus'],
            mp4: ['video/mp4'],
            mov: ['video/quicktime'],
            webm: ['video/webm'],
            mkv: ['video/x-matroska'],
        };
        if ((allowedForExtension[ext] ?? []).includes(mimeType)) {
            return;
        }
        throw new BadRequestException(`MIME type ${mimeType} does not match file type: ${fileName}`);
    }

    private async buildReadUrl(s3: S3Client, bucket: string, key: string): Promise<string> {
        const publicBaseUrl = process.env.R2_PUBLIC_BASE_URL?.trim() ?? '';
        if (publicBaseUrl) {
            return `${publicBaseUrl.replace(/\/$/, '')}/${key}`;
        }
        const get = new GetObjectCommand({
            Bucket: bucket,
            Key: key,
        });
        return getSignedUrl(s3, get, { expiresIn: 60 * 60 * 24 });
    }

    private env(key: string): string {
        const value = process.env[key]?.trim();
        if (!value) {
            throw new BadRequestException(`Missing required env var: ${key}`);
        }
        return value;
    }

    private redactId(value: string): string {
        const normalized = String(value ?? '').trim();
        if (normalized.length <= 10) return normalized || '<empty>';
        return `${normalized.slice(0, 4)}…${normalized.slice(-4)}`;
    }

    private errorMessage(error: unknown): string {
        return error instanceof Error ? error.message : String(error);
    }

    private isNoSuchUpload(error: unknown): boolean {
        if (!error || typeof error !== 'object') return false;
        const value = error as {
            name?: unknown;
            Code?: unknown;
            code?: unknown;
            $metadata?: { httpStatusCode?: unknown };
        };
        return (
            ['NoSuchUpload', '10024'].includes(String(value.name ?? value.Code ?? value.code ?? '')) ||
            Number(value.$metadata?.httpStatusCode) === 404
        );
    }

    private kindFromMime(mime: string): AttachmentKind {
        if (mime.startsWith('image/')) return 'image';
        if (mime.startsWith('audio/')) return 'audio';
        if (mime.startsWith('video/')) return 'video';
        return 'document';
    }
}

export function runtimePresignedPutHeaders(
    mimeType: string,
    uploadId: string,
    checksum: string,
): Record<string, string> {
    return {
        'content-type': mimeType,
        'x-amz-meta-uploadid': uploadId,
        'x-amz-checksum-sha256': checksum,
    };
}
