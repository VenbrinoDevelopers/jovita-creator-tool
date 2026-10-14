import { extname } from 'node:path';
import type { MediaAttachment } from '../core/contracts/types.js';
import { FILE_EXT_TO_MIME } from './constants.js';

export function normalizeMime(mime?: string): string | undefined {
  const value = String(mime ?? '').split(';')[0]?.trim().toLowerCase();
  return value || undefined;
}

export function resolveMimeFromName(att: MediaAttachment): string | undefined {
  const source = (att.fileName ?? att.path ?? att.url ?? '').toLowerCase();
  if (!source) return undefined;
  const ext = extname(source);
  return FILE_EXT_TO_MIME[ext];
}

export function isGenericMime(mime: string): boolean {
  return mime === 'application/octet-stream' || mime === 'application/zip';
}

export async function detectMime(att: MediaAttachment, bytes: Uint8Array): Promise<string> {
  const declared = normalizeMime(att.mimeType);
  const { fileTypeFromBuffer } = await import('file-type');
  const sniffed = (await fileTypeFromBuffer(Buffer.from(bytes)))?.mime?.toLowerCase();
  const extMime = resolveMimeFromName(att);

  if (sniffed && (!isGenericMime(sniffed) || !extMime)) {
    return sniffed;
  }
  if (extMime) {
    return extMime;
  }
  if (declared && !isGenericMime(declared)) {
    return declared;
  }
  if (sniffed) {
    return sniffed;
  }
  if (declared) {
    return declared;
  }
  return 'application/octet-stream';
}
