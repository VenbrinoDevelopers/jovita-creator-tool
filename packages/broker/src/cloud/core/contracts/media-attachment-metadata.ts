import type { MediaAttachment } from './types.js';

export type MediaAttachmentMetadata = Pick<
  MediaAttachment,
  | 'durationMs'
  | 'width'
  | 'height'
  | 'container'
  | 'videoCodec'
  | 'audioCodec'
  | 'hasAudio'
  | 'posterAttachmentId'
  | 'playbackAttachmentId'
  | 'originalAttachmentId'
  | 'waveformPeaks'
  | 'processingStatus'
  | 'processingFailureCode'
>;

const identifier = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,199}$/;
const descriptor = /^[a-zA-Z0-9][a-zA-Z0-9._+-]{0,63}$/;

function boundedInteger(value: unknown, minimum: number, maximum: number): number | undefined {
  return Number.isSafeInteger(value) && Number(value) >= minimum && Number(value) <= maximum
    ? Number(value)
    : undefined;
}

function boundedString(value: unknown, pattern: RegExp): string | undefined {
  const normalized = typeof value === 'string' ? value.trim() : '';
  return normalized && pattern.test(normalized) ? normalized : undefined;
}

/**
 * Normalizes untrusted attachment metadata at every persistence/transport boundary.
 * Originals remain playable when status is absent; newly processed media must set it.
 */
export function normalizeMediaAttachmentMetadata(value: unknown): Partial<MediaAttachmentMetadata> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const input = value as Record<string, unknown>;
  const status = ['pending', 'processing', 'ready', 'failed'].includes(String(input.processingStatus))
    ? input.processingStatus as MediaAttachmentMetadata['processingStatus']
    : undefined;
  const peaks = Array.isArray(input.waveformPeaks)
    ? input.waveformPeaks
        .filter((peak): peak is number => typeof peak === 'number' && Number.isFinite(peak))
        .slice(0, 256)
        .map(peak => Math.max(0, Math.min(1, peak)))
    : undefined;
  const failureCode = typeof input.processingFailureCode === 'string'
    && /^[A-Z0-9][A-Z0-9_:-]{0,127}$/.test(input.processingFailureCode.trim())
    ? input.processingFailureCode.trim()
    : undefined;

  return {
    durationMs: boundedInteger(input.durationMs, 0, 86_400_000),
    width: boundedInteger(input.width, 1, 16_384),
    height: boundedInteger(input.height, 1, 16_384),
    container: boundedString(input.container, descriptor),
    videoCodec: boundedString(input.videoCodec, descriptor),
    audioCodec: boundedString(input.audioCodec, descriptor),
    hasAudio: typeof input.hasAudio === 'boolean' ? input.hasAudio : undefined,
    posterAttachmentId: boundedString(input.posterAttachmentId, identifier),
    playbackAttachmentId: boundedString(input.playbackAttachmentId, identifier),
    originalAttachmentId: boundedString(input.originalAttachmentId, identifier),
    waveformPeaks: peaks,
    processingStatus: status,
    processingFailureCode: failureCode,
  };
}
