import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SecretCryptoService } from '../../core/security/secret-crypto.service.js';
import { UploadsService } from '../uploads/uploads.service.js';
import { MediaProcessingService } from '../jobs/media-processing.service.js';
import { MediaSourceService } from '../jobs/media-source.service.js';
import { VoiceProfile, type VoiceProfileDocument } from './voice-profile.schema.js';

@Injectable()
export class VoiceLibraryService {
  constructor(
    @InjectModel(VoiceProfile.name) private readonly voices: Model<VoiceProfileDocument>,
    private readonly crypto: SecretCryptoService,
    private readonly uploads: UploadsService,
    private readonly sources: MediaSourceService,
    private readonly processing: MediaProcessingService,
  ) {}

  async save(ownerId: string, input: {
    name: string;
    referenceAssetIds: string[];
    referenceTranscript?: string;
    consentType: 'self' | 'authorized';
    consentConfirmed: boolean;
    consentText: string;
  }) {
    if (input.consentConfirmed !== true || !input.consentText.trim()) throw new BadRequestException('Voice consent attestation is required');
    if (!['self', 'authorized'].includes(input.consentType)) throw new BadRequestException('Voice consent type is required');
    const name = this.name(input.name);
    if (!Array.isArray(input.referenceAssetIds) || input.referenceAssetIds.length !== 1) throw new BadRequestException('One private voice reference is required');
    const source = await this.sources.resolve(ownerId, this.id(input.referenceAssetIds[0], 'referenceAssetId'), 'audio');
    const transcript = String(input.referenceTranscript ?? '').trim();
    if (Buffer.byteLength(transcript, 'utf8') > 10_000) throw new BadRequestException('Voice reference transcript is too long');
    const voiceId = `voice_${randomUUID()}`;
    const directory = await mkdtemp(join(tmpdir(), 'jovita-voice-library-'));
    try {
      const sourcePath = join(directory, 'reference-source');
      await this.sources.downloadTo(source, sourcePath);
      const probe = await this.processing.probe(sourcePath, 'audio');
      if (probe.durationMs < 10_000 || probe.durationMs > 30_000) {
        throw new BadRequestException('Voice reference must be between 10 and 30 seconds');
      }
      const prepared = await this.processing.prepare({ path: sourcePath, kind: 'audio', directory,
        expectedDurationSeconds: probe.durationMs / 1000 });
      if (!prepared.playback) throw new BadRequestException('Voice reference normalization failed');
      const normalized = await this.uploads.storeWorkerOutput(ownerId, {
        ...prepared.playback,
        sourceKey: `${voiceId}:reference`,
      });
      const voice = await this.voices.create({
        voiceId,
        ownerId,
        name,
        specificationEncrypted: this.crypto.encrypt(JSON.stringify({
          cloneMode: 'openrouter_stateless',
          routeVersion: 'fish-audio/s2.1-pro@openrouter-v1',
          referenceTranscript: transcript || undefined,
        })),
        consentAttestationEncrypted: this.crypto.encrypt(input.consentText.trim().slice(0, 2000)),
        referenceAssetIds: [String(normalized.attachmentId)],
        cloneMode: 'openrouter_stateless',
        routeVersion: 'fish-audio/s2.1-pro@openrouter-v1',
        referenceSha256: normalized.sha256,
        consentType: input.consentType,
      });
      await this.uploads.markAttached(ownerId, [String(normalized.attachmentId)], `voice-library:${voiceId}`);
      return this.view(voice);
    } catch (error) { if ((error as { code?: number }).code === 11000) throw new ConflictException('A saved voice already uses this name'); throw error; }
    finally { await rm(directory, { recursive: true, force: true }); }
  }

  async list(ownerId: string) { return (await this.voices.find({ ownerId, status: 'active' }).sort({ createdAt: -1 }).lean()).map(row => this.view(row)); }
  async show(ownerId: string, voiceId: string) { const row = await this.voices.findOne({ ownerId, voiceId: this.id(voiceId, 'voiceId'), status: 'active' }).lean(); if (!row) throw new NotFoundException('Saved voice not found'); return this.view(row); }
  async resolveForSynthesis(ownerId: string, voiceId: string) {
    const row = await this.voices.findOne({ ownerId, voiceId: this.id(voiceId, 'voiceId'), status: 'active' })
      .select('+specificationEncrypted').lean();
    if (!row || row.referenceAssetIds.length !== 1) throw new NotFoundException('Saved voice not found');
    const source = await this.uploads.resolveRuntimeAttachment(ownerId, row.referenceAssetIds[0]);
    if (!source?.url || source.kind !== 'audio' || source.sha256 !== row.referenceSha256) {
      throw new BadRequestException('Saved voice reference failed integrity validation');
    }
    let specification: { providerVoiceId?: string; referenceTranscript?: string; cloneMode?: string; routeVersion?: string };
    try { specification = JSON.parse(this.crypto.decrypt(row.specificationEncrypted)) as typeof specification; }
    catch { throw new BadRequestException('Saved voice specification is unavailable'); }
    if ((row.cloneMode ?? specification.cloneMode) !== 'openrouter_stateless') {
      throw new BadRequestException('This legacy saved voice cannot be used by the stateless route');
    }
    return {
      voiceId: row.voiceId,
      name: row.name,
      reference: source,
      referenceTranscript: specification.referenceTranscript,
      cloneMode: 'openrouter_stateless' as const,
      routeVersion: row.routeVersion ?? specification.routeVersion ?? 'fish-audio/s2.1-pro@openrouter-v1',
      consentType: row.consentType,
    };
  }
  async rename(ownerId: string, voiceId: string, name: string) { try { const row = await this.voices.findOneAndUpdate({ ownerId, voiceId: this.id(voiceId, 'voiceId'), status: 'active' }, { $set: { name: this.name(name) }, $inc: { revision: 1 } }, { returnDocument: 'after' }).lean(); if (!row) throw new NotFoundException('Saved voice not found'); return this.view(row); } catch (error) { if ((error as { code?: number }).code === 11000) throw new ConflictException('A saved voice already uses this name'); throw error; } }
  async delete(ownerId: string, voiceId: string, confirm: string) { const id = this.id(voiceId, 'voiceId'); if (confirm !== id) throw new BadRequestException('Voice deletion confirmation does not match'); const row = await this.voices.findOneAndUpdate({ ownerId, voiceId: id, status: 'active' }, { $set: { status: 'deleting' }, $inc: { revision: 1 } }, { returnDocument: 'after' }).lean(); if (!row) throw new NotFoundException('Saved voice not found'); await this.uploads.deleteLibraryAttachments(ownerId, row.referenceAssetIds, `voice-library:${id}`); await this.voices.deleteOne({ ownerId, voiceId: id, status: 'deleting' }); return { status: 'deleted', voice_id: id }; }
  private view(row: Pick<VoiceProfile, 'voiceId' | 'name' | 'status' | 'revision'> & { createdAt?: Date; updatedAt?: Date }) { return { voice_id: row.voiceId, name: row.name, status: row.status, revision: row.revision, created_at: row.createdAt, updated_at: row.updatedAt }; }
  private name(value: string) { const name = String(value ?? '').trim(); if (!name || name.length > 80) throw new BadRequestException('Voice name is required'); return name; }
  private id(value: string, label: string) { const id = String(value ?? '').trim(); if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,199}$/.test(id)) throw new BadRequestException(`${label} is invalid`); return id; }
}
