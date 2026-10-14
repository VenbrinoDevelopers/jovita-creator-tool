import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { open, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import JSZip from 'jszip';
import type { ProcessedMediaFile } from './media-processing.service.js';

interface ZipEntry { name: string; compressed: number; uncompressed: number; method: number; flags: number; external: number; }

@Injectable()
export class MediaArchiveService {
  async extractStemZip(response: Response, directory: string, expected: 2 | 6): Promise<ProcessedMediaFile[]> {
    const mime = (response.headers.get('content-type') ?? '').split(';')[0]!.trim();
    if (!response.ok || !response.body || !['application/zip', 'application/x-zip-compressed', 'application/octet-stream'].includes(mime)) {
      await response.body?.cancel(); throw new Error('Invalid stem archive response');
    }
    const archive = join(directory, 'stems.zip');
    await this.stage(response, archive, 250 * 1024 * 1024);
    const bytes = await readFile(archive);
    const entries = this.directory(bytes);
    if (entries.length !== expected) throw new Error('Stem archive contains an unexpected number of files');
    const zip = await JSZip.loadAsync(bytes, { checkCRC32: true, createFolders: false });
    const files: ProcessedMediaFile[] = [];
    for (const [index, metadata] of entries.entries()) {
      const entry = zip.file(metadata.name);
      if (!entry || entry.dir) throw new Error('Stem archive entry is unavailable');
      const contents = await entry.async('uint8array');
      if (contents.byteLength !== metadata.uncompressed || contents.byteLength > 100 * 1024 * 1024) throw new Error('Stem archive entry size mismatch');
      const safe = basename(metadata.name).replace(/[^a-zA-Z0-9._-]/g, '_');
      const name = `${String(index + 1).padStart(2, '0')}-${safe}`;
      const path = join(directory, name);
      await writeFile(path, contents, { flag: 'wx', mode: 0o600 });
      files.push({ path, fileName: name, mimeType: 'audio/mpeg', kind: 'audio', size: contents.byteLength,
        sha256: createHash('sha256').update(contents).digest('hex') });
    }
    return files;
  }

  private directory(bytes: Buffer): ZipEntry[] {
    const eocd = bytes.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
    if (eocd < 0 || eocd + 22 > bytes.length) throw new Error('Stem archive directory is missing');
    const count = bytes.readUInt16LE(eocd + 10);
    const directorySize = bytes.readUInt32LE(eocd + 12);
    const offset = bytes.readUInt32LE(eocd + 16);
    if (count < 1 || count > 10 || offset + directorySize > eocd) throw new Error('Stem archive directory is invalid');
    const result: ZipEntry[] = [];
    const seen = new Set<string>();
    let cursor = offset;
    let total = 0;
    for (let index = 0; index < count; index += 1) {
      if (cursor + 46 > bytes.length || bytes.readUInt32LE(cursor) !== 0x02014b50) throw new Error('Stem archive entry is malformed');
      const flags = bytes.readUInt16LE(cursor + 8);
      const method = bytes.readUInt16LE(cursor + 10);
      const compressed = bytes.readUInt32LE(cursor + 20);
      const uncompressed = bytes.readUInt32LE(cursor + 24);
      const nameLength = bytes.readUInt16LE(cursor + 28);
      const extraLength = bytes.readUInt16LE(cursor + 30);
      const commentLength = bytes.readUInt16LE(cursor + 32);
      const external = bytes.readUInt32LE(cursor + 38);
      const name = bytes.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8');
      const normalized = name.replace(/\\/g, '/');
      const key = normalized.toLowerCase();
      if (!name || name.includes('\0') || normalized.startsWith('/') || normalized.split('/').includes('..')
        || normalized.endsWith('/') || !/\.mp3$/i.test(normalized) || seen.has(key)
        || (flags & 1) !== 0 || ![0, 8].includes(method) || compressed === 0xffffffff || uncompressed === 0xffffffff
        || uncompressed < 1 || uncompressed > 100 * 1024 * 1024 || ((external >>> 16) & 0o170000) === 0o120000) {
        throw new Error('Unsafe stem archive entry');
      }
      seen.add(key); total += uncompressed;
      if (total > 600 * 1024 * 1024) throw new Error('Stem archive expands beyond the allowed size');
      result.push({ name, compressed, uncompressed, method, flags, external });
      cursor += 46 + nameLength + extraLength + commentLength;
    }
    if (cursor !== offset + directorySize) throw new Error('Stem archive directory length mismatch');
    return result;
  }

  private async stage(response: Response, destination: string, limit: number) {
    const file = await open(destination, 'wx', 0o600);
    const reader = response.body!.getReader();
    let size = 0;
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > limit) throw new Error('Stem archive exceeds limit');
        await file.writeFile(chunk.value);
      }
      await file.sync(); await file.close();
      const details = await stat(destination);
      if (details.size !== size || size < 22) throw new Error('Stem archive is truncated');
    } catch (error) {
      await file.close().catch(() => {}); await unlink(destination).catch(() => {}); throw error;
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  }
}
