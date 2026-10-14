import { BadGatewayException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { UploadsService, MediaProcessingService } from '../contracts/platform-ports.js';
import { ProviderMediaValidationError } from './provider-media.js';
import type { BrokerConnection, BrokerProviderProfile } from '../catalog/broker-catalog.schema.js';
import type { RuntimeOperationPlan } from './broker-operation-plan.js';
import { BrokerHttpTransport } from './broker-http-transport.js';

/** Provider-independent fetch, validation, ownership and expiry for completed media jobs. */
export class BrokerArtifactService {
  constructor(private readonly transport: BrokerHttpTransport,
    private readonly uploads: UploadsService,
    private readonly processing: MediaProcessingService) {}

  async fetchAndStore(profile: BrokerProviderProfile, connection: BrokerConnection,
    operation: RuntimeOperationPlan, jobId: string, ownerId: string, executionKey: string) {
    const artifact = operation.artifact;
    if (!artifact) throw new BadGatewayException('Operation has no downloadable result');
    if (!ownerId) throw new BadGatewayException('Media result has no owner');
    const directory = await mkdtemp(join(tmpdir(), 'jovita-broker-media-'));
    try {
      const path = join(directory, 'provider-result');
      let staged: Awaited<ReturnType<BrokerHttpTransport['downloadMedia']>>;
      try {
        staged = await this.transport.downloadMedia(profile, connection, artifact.path,
          jobId, artifact.kind, artifact.maxBytes, path, artifact.timeoutMs ?? profile.timeoutMs);
      } catch (error) {
        if (error instanceof ProviderMediaValidationError) {
          throw new BadGatewayException({ code: 'PROVIDER_INVALID_MEDIA',
            message: 'Provider result is not valid media within the declared limit' });
        }
        throw error;
      }
      // A valid file signature alone does not prove playable media.
      await this.processing.probe(path, artifact.kind);
      const extension = staged.mimeType === 'video/mp4' ? 'mp4'
        : staged.mimeType === 'video/webm' ? 'webm'
          : staged.mimeType === 'audio/mpeg' ? 'mp3' : 'wav';
      const fileName = `result.${extension}`;
      const sourceKey = `broker:${createHash('sha256').update(executionKey).digest('hex')}`;
      const stored = await this.uploads.storeWorkerOutput(ownerId, { ...staged,
        fileName, kind: artifact.kind, sourceKey,
        expiresAt: new Date(Date.now() + artifact.retentionSeconds * 1000) });
      return { result: { attachment_id: stored.attachmentId, kind: stored.kind,
        mime_type: stored.mimeType, size: stored.size, sha256: stored.sha256 },
        expiresAt: stored.expiresAt };
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
}
