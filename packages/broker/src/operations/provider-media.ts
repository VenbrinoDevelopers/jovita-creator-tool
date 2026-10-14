import { createHash, randomUUID } from 'node:crypto';
import { open, link, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export class ProviderMediaValidationError extends Error {}

/** Stage only verified, bounded media. The platform storage port owns persistence. */
export async function stageProviderMedia(response: Response, destination: string,
  kind: 'audio' | 'video', maxBytes: number) {
  const ceiling = (kind === 'video' ? 250 : 100) * 1024 * 1024;
  const limit = Math.min(ceiling, maxBytes);
  const mimeType = (response.headers.get('content-type') ?? '').split(';')[0]!.trim();
  const allowed = kind === 'video' ? ['video/mp4', 'video/webm'] : ['audio/mpeg', 'audio/wav', 'audio/x-wav'];
  const header = response.headers.get('content-length');
  const declared = header === null ? null : Number(header);
  if (!response.ok || !response.body || !allowed.includes(mimeType)
    || (declared !== null && (!Number.isSafeInteger(declared) || declared < 1 || declared > limit))) {
    await response.body?.cancel();
    throw new ProviderMediaValidationError('Invalid provider media response');
  }
  const stage = join(dirname(destination), `.media-${randomUUID()}.part`);
  const file = await open(stage, 'wx', 0o600);
  const reader = response.body.getReader();
  const hash = createHash('sha256');
  let signature = Buffer.alloc(0);
  let size = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > limit) throw new ProviderMediaValidationError('Provider media exceeds limit');
      hash.update(chunk.value);
      if (signature.length < 16) signature = Buffer.concat([signature,
        Buffer.from(chunk.value).subarray(0, 16 - signature.length)]);
      await file.writeFile(chunk.value);
    }
    if (!size || (declared !== null && declared !== size) || !signatureMatches(mimeType, signature)) {
      throw new ProviderMediaValidationError('Provider media is truncated or has the wrong signature');
    }
    await file.sync();
    await file.close();
    await link(stage, destination);
    await unlink(stage);
    return { path: destination, size, sha256: hash.digest('hex'), mimeType };
  } catch (error) {
    await file.close().catch(() => {});
    await unlink(stage).catch(() => {});
    throw error;
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

function signatureMatches(mime: string, bytes: Buffer): boolean {
  if (mime === 'video/mp4') return bytes.length >= 12 && bytes.subarray(4, 8).toString('ascii') === 'ftyp';
  if (mime === 'video/webm') return bytes.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]));
  if (mime === 'audio/wav' || mime === 'audio/x-wav') return bytes.length >= 12
    && bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WAVE';
  if (mime === 'audio/mpeg') return bytes.length >= 3 && bytes.subarray(0, 3).toString('ascii') === 'ID3'
    || bytes.length >= 2 && bytes[0] === 0xff && (bytes[1]! & 0xe0) === 0xe0;
  return false;
}
