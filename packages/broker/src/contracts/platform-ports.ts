export const ADMIN_CREDENTIALS = Symbol('ADMIN_CREDENTIALS');
export const ARTIFACT_UPLOADS = Symbol('ARTIFACT_UPLOADS');
export const MEDIA_PROCESSING = Symbol('MEDIA_PROCESSING');

export interface MiniappProviderCredentialService {
  resolve(environment: string, packId: string, providerId: string): Promise<Record<string, unknown>>;
  resolveEnvironment(environment: string, providerId: string): Promise<Record<string, unknown>>;
}

export interface UploadsService {
  storeWorkerOutput(ownerId: string, staged: { path: string; size: number; sha256: string;
    mimeType: string; fileName: string; kind: 'video' | 'audio'; sourceKey: string;
    expiresAt: Date }): Promise<{ attachmentId: string; kind: 'video' | 'audio'; mimeType: string;
      size: number; sha256: string; expiresAt: Date }>;
}

export interface MediaProcessingService {
  probe(path: string, kind: 'video' | 'audio'): Promise<unknown>;
}
