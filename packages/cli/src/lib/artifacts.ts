import { createHash } from 'node:crypto';
import type { EphemeralArtifactReference, RemoteImageContent, ToolExecutionResult } from '../types.js';

export interface ArtifactValidationPolicy {
  artifactHostname: string;
  authorize: (artifactId: string) => boolean | Promise<boolean>;
  now?: number;
  minimumValidityMs?: number;
  maximumBytes?: number;
  maximumDimension?: number;
  maximumPixels?: number;
  fetch?: typeof globalThis.fetch;
}

export interface SafeArtifactProvenance {
  id: string;
  kind: 'image';
  purpose: EphemeralArtifactReference['purpose'];
  label?: string;
  group_id?: string;
  sequence?: number;
  mime_type: string;
  size: number;
  sha256: string;
  width: number;
  height: number;
  expires_at: string;
  metadata?: EphemeralArtifactReference['metadata'];
  persistence: 'transient';
}

export async function validateArtifactForModel(artifact: EphemeralArtifactReference, policy: ArtifactValidationPolicy): Promise<RemoteImageContent> {
  const fail = (code: string): never => { throw Object.assign(new Error(code), { code }); };
  const configuredHostname = policy.artifactHostname.trim().toLowerCase();
  if (!configuredHostname) fail('VISUAL_ARTIFACT_INVALID');
  if (!artifact || artifact.kind !== 'image' || artifact.transport !== 'signed_url' || artifact.persistence !== 'transient') fail('VISUAL_ARTIFACT_INVALID');
  if (!await policy.authorize(artifact.id)) fail('VISUAL_ARTIFACT_INVALID');
  const url = (() => { try { return new URL(artifact.url); } catch { return fail('VISUAL_ARTIFACT_INVALID'); } })();
  if (url.protocol !== 'https:' || url.hostname.toLowerCase() !== configuredHostname || !url.search) fail('VISUAL_ARTIFACT_INVALID');
  const now = policy.now ?? Date.now();
  if (Date.parse(artifact.expires_at) - now < (policy.minimumValidityMs ?? 120_000)) fail('VISUAL_ARTIFACT_INVALID');
  const maximumBytes = policy.maximumBytes ?? 8 * 1024 * 1024;
  const maximumDimension = policy.maximumDimension ?? 16_384;
  const maximumPixels = policy.maximumPixels ?? 100_000_000;
  if (!/^image\/(?:png|jpeg|webp)$/i.test(artifact.mime_type) || artifact.size <= 0 || artifact.size > maximumBytes) fail('VISUAL_ARTIFACT_INVALID');
  if (!Number.isInteger(artifact.width) || !Number.isInteger(artifact.height) || artifact.width <= 0 || artifact.height <= 0 || artifact.width > maximumDimension || artifact.height > maximumDimension || artifact.width * artifact.height > maximumPixels) fail('VISUAL_ARTIFACT_INVALID');
  if (!/^[a-f0-9]{64}$/i.test(artifact.sha256)) fail('VISUAL_ARTIFACT_INVALID');

  const fetcher = policy.fetch ?? globalThis.fetch;
  const response = await fetcher(url, { redirect: 'manual', headers: { accept: artifact.mime_type } }).catch(() => fail('VISUAL_ARTIFACT_FETCH_FAILED'));
  if (response.status >= 300 && response.status < 400) fail('VISUAL_ARTIFACT_INVALID');
  if (!response.ok || response.url && new URL(response.url).origin !== url.origin) fail('VISUAL_ARTIFACT_FETCH_FAILED');
  const contentType = response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
  if (contentType !== artifact.mime_type.toLowerCase()) fail('VISUAL_ARTIFACT_INVALID');
  const declaredLength = response.headers.get('content-length');
  if (declaredLength && (!/^\d+$/.test(declaredLength) || Number(declaredLength) !== artifact.size || Number(declaredLength) > maximumBytes)) fail('VISUAL_ARTIFACT_INVALID');
  const bytes = await readBoundedBody(response, Math.min(maximumBytes, artifact.size), fail);
  if (bytes.byteLength !== artifact.size || bytes.byteLength > maximumBytes) fail('VISUAL_ARTIFACT_INVALID');
  if (createHash('sha256').update(bytes).digest('hex') !== artifact.sha256.toLowerCase()) fail('VISUAL_ARTIFACT_INVALID');
  return { type: 'remote_image', url: url.toString(), mimeType: artifact.mime_type, detail: 'high' };
}

async function readBoundedBody(response: Response, maximumBytes: number, fail: (code: string) => never): Promise<Uint8Array> {
  if (!response.body) return fail('VISUAL_ARTIFACT_FETCH_FAILED');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      total += part.value.byteLength;
      if (total > maximumBytes) {
        await reader.cancel().catch(() => undefined);
        return fail('VISUAL_ARTIFACT_INVALID');
      }
      chunks.push(part.value);
    }
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && String((error as { code?: unknown }).code).startsWith('VISUAL_ARTIFACT_')) throw error;
    return fail('VISUAL_ARTIFACT_FETCH_FAILED');
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export async function prepareToolResultForModel(input: {
  result: ToolExecutionResult;
  policy: ArtifactValidationPolicy;
  supportsImages: boolean;
}): Promise<{ text: string; details?: Record<string, unknown>; images: RemoteImageContent[]; provenance: SafeArtifactProvenance[] }> {
  const artifacts = input.result.artifacts ?? [];
  if (artifacts.length && !input.supportsImages) throw Object.assign(new Error('AGENT_REMOTE_IMAGE_UNSUPPORTED'), { code: 'AGENT_REMOTE_IMAGE_UNSUPPORTED' });
  const images: RemoteImageContent[] = [];
  const provenance: SafeArtifactProvenance[] = [];
  for (const artifact of artifacts) {
    images.push(await validateArtifactForModel(artifact, input.policy));
    provenance.push(safeArtifactProvenance(artifact));
  }
  return { text: input.result.text, details: sanitizeArtifactDetails(input.result.details, input.policy.artifactHostname), images, provenance };
}

export function clearRemoteImageUrls(images: RemoteImageContent[]): void {
  for (const image of images) image.url = '';
}

export function safeArtifactProvenance(artifact: EphemeralArtifactReference): SafeArtifactProvenance {
  return {
    id: artifact.id,
    kind: artifact.kind,
    purpose: artifact.purpose,
    label: artifact.label,
    group_id: artifact.group_id,
    sequence: artifact.sequence,
    mime_type: artifact.mime_type,
    size: artifact.size,
    sha256: artifact.sha256,
    width: artifact.width,
    height: artifact.height,
    expires_at: artifact.expires_at,
    metadata: artifact.metadata,
    persistence: artifact.persistence,
  };
}

export function toOpenAIChatImage(content: RemoteImageContent): { type: 'image_url'; image_url: { url: string; detail?: 'low' | 'high' | 'auto' } } {
  return { type: 'image_url', image_url: { url: content.url, detail: content.detail } };
}

export function toOpenAIResponsesImage(content: RemoteImageContent): { type: 'input_image'; image_url: string; detail?: 'low' | 'high' | 'auto' } {
  return { type: 'input_image', image_url: content.url, detail: content.detail };
}

function sanitizeArtifactDetails(details: Record<string, unknown> | undefined, artifactHostname: string): Record<string, unknown> | undefined {
  if (!details) return undefined;
  const visit = (value: unknown): unknown => {
    if (typeof value === 'string') {
      try {
        const url = new URL(value);
        if (url.hostname.toLowerCase() === artifactHostname.toLowerCase() && url.search) return '[transient artifact URL removed]';
      } catch { /* ordinary text */ }
      return value;
    }
    if (Array.isArray(value)) return value.map(visit);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, nested]) => [key, visit(nested)]));
    return value;
  };
  return visit(details) as Record<string, unknown>;
}
