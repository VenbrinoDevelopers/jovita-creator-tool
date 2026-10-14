import { BadRequestException, Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { open, unlink } from 'node:fs/promises';
import { UploadsService } from '../uploads/uploads.service.js';

export type MediaSourceKind = 'image' | 'audio' | 'video';

export interface ResolvedMediaSource {
  attachmentId: string;
  kind: MediaSourceKind;
  url: string;
  fileName: string;
  mimeType: string;
  size: number;
  sha256: string;
  durationMs?: number;
  width?: number;
  height?: number;
}

const MIME: Record<MediaSourceKind, ReadonlySet<string>> = {
  image: new Set(['image/png', 'image/jpeg', 'image/webp']),
  audio: new Set(['audio/mpeg', 'audio/wav', 'audio/ogg', 'audio/mp4', 'audio/aac', 'audio/flac', 'audio/opus']),
  video: new Set(['video/mp4', 'video/quicktime', 'video/webm', 'video/x-matroska']),
};
const LIMIT: Record<MediaSourceKind, number> = {
  image: 20 * 1024 * 1024,
  audio: 100 * 1024 * 1024,
  video: 250 * 1024 * 1024,
};

/** Resolves only private owner-scoped attachments. Provider URLs never enter public request JSON. */
@Injectable()
export class MediaSourceService {
  constructor(private readonly uploads: UploadsService) {}

  async resolve(ownerId: string, attachmentId: string, expected: MediaSourceKind): Promise<ResolvedMediaSource> {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,199}$/.test(attachmentId)) throw new BadRequestException('Invalid media source');
    const source = await this.uploads.resolveRuntimeAttachment(ownerId, attachmentId);
    if (!source?.url || source.kind !== expected || !MIME[expected].has(String(source.mimeType))
      || !Number.isSafeInteger(Number(source.size)) || Number(source.size) < 1 || Number(source.size) > LIMIT[expected]
      || typeof source.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(source.sha256)) {
      throw new BadRequestException('Private media source is unavailable or unsupported');
    }
    if (expected === 'video' && source.durationMs !== undefined && source.durationMs > 10 * 60_000) {
      throw new BadRequestException('Video source exceeds ten minutes');
    }
    if (expected === 'audio' && source.durationMs !== undefined && source.durationMs > 30 * 60_000) {
      throw new BadRequestException('Audio source exceeds thirty minutes');
    }
    return {
      attachmentId,
      kind: expected,
      url: source.url,
      fileName: source.fileName,
      mimeType: source.mimeType,
      size: Number(source.size),
      sha256: source.sha256,
      ...(source.durationMs !== undefined ? { durationMs: source.durationMs } : {}),
      ...(source.width !== undefined ? { width: source.width } : {}),
      ...(source.height !== undefined ? { height: source.height } : {}),
    };
  }

  async downloadTo(source: ResolvedMediaSource, destination: string, signal?: AbortSignal): Promise<void> {
    const response = await fetch(source.url, {
      redirect: 'error',
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(60_000)]) : AbortSignal.timeout(60_000),
    });
    if (!response.ok || !response.body) throw new BadRequestException('Private media source could not be read');
    const declared = response.headers.get('content-length');
    if (declared !== null && Number(declared) !== source.size) {
      await response.body.cancel();
      throw new BadRequestException('Private media source size changed');
    }
    const file = await open(destination, 'wx', 0o600);
    const reader = response.body.getReader();
    const digest = createHash('sha256');
    let size = 0;
    let signature = Buffer.alloc(0);
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > source.size) throw new BadRequestException('Private media source exceeded its declared size');
        if (signature.length < 16) signature = Buffer.concat([signature, Buffer.from(chunk.value)]).subarray(0, 16);
        digest.update(chunk.value);
        await file.writeFile(chunk.value);
      }
      await file.sync();
      await file.close();
      if (size !== source.size || digest.digest('hex') !== source.sha256) {
        throw new BadRequestException('Private media source failed checksum validation');
      }
      if (!validMediaSourceSignature(source.mimeType, signature)) {
        throw new BadRequestException('Private media source signature does not match its media type');
      }
    } catch (error) {
      await file.close().catch(() => {});
      await unlink(destination).catch(() => {});
      throw error;
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  }
}

export function validMediaSourceSignature(mimeType: string, bytes: Buffer): boolean {
  const ascii = (start: number, end: number) => bytes.subarray(start, end).toString('ascii');
  if (mimeType === 'image/png') return bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  if (mimeType === 'image/jpeg') return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (mimeType === 'image/webp') return ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP';
  if (mimeType === 'audio/wav') return ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WAVE';
  if (mimeType === 'audio/flac') return ascii(0, 4) === 'fLaC';
  if (mimeType === 'audio/ogg' || mimeType === 'audio/opus') return ascii(0, 4) === 'OggS';
  if (mimeType === 'audio/mpeg') return ascii(0, 3) === 'ID3' || (bytes[0] === 0xff && (Number(bytes[1]) & 0xe0) === 0xe0);
  if (mimeType === 'audio/aac') return bytes[0] === 0xff && (Number(bytes[1]) & 0xf0) === 0xf0;
  if (mimeType === 'audio/mp4' || mimeType === 'video/mp4' || mimeType === 'video/quicktime') return ascii(4, 8) === 'ftyp';
  if (mimeType === 'video/webm' || mimeType === 'video/x-matroska') return bytes.length >= 4 && bytes.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]));
  return false;
}
