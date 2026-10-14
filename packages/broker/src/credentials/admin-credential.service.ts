import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { createHash } from 'node:crypto';
import type { Model } from 'mongoose';
import { SecretCryptoService } from '../security/secret-crypto.service.js';
import {
  MiniappProviderCredential,
  type MiniappProviderCredentialDocument,
} from './admin-credential.schema.js';

@Injectable()
export class MiniappProviderCredentialService {
  private static readonly ENVIRONMENT_PACK_ID = '__environment__';
  constructor(
    @InjectModel(MiniappProviderCredential.name)
    private readonly model: Model<MiniappProviderCredentialDocument>,
    private readonly crypto: SecretCryptoService,
  ) {}

  async put(input: {
    environment: string;
    packId: string;
    providerId: string;
    config: Record<string, unknown>;
    updatedBy: string;
    scope?: 'pack' | 'environment';
  }): Promise<Record<string, unknown>> {
    this.assertEnvironment(input.environment);
    const serialized = JSON.stringify(input.config ?? {});
    if (Buffer.byteLength(serialized) > 32_000) {
      throw new BadRequestException('Provider credential is too large');
    }
    const fingerprint = createHash('sha256').update(serialized).digest('hex').slice(0, 16);
    const row = await this.model.findOneAndUpdate(
      {
        environment: this.required(input.environment, 'environment'),
        packId: input.scope === 'environment'
          ? MiniappProviderCredentialService.ENVIRONMENT_PACK_ID
          : this.required(input.packId, 'packId'),
        providerId: this.required(input.providerId, 'providerId'),
      },
      {
        $set: {
          encryptedConfig: this.crypto.encrypt(serialized),
          configFingerprint: fingerprint,
          status: 'active',
          scope: input.scope ?? 'pack',
          updatedBy: this.required(input.updatedBy, 'updatedBy'),
        },
        $unset: {
          lastTestStatus: 1,
          lastTestedAt: 1,
          sourcePackId: 1,
        },
      },
      { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true },
    ).lean().exec();
    return this.safeView(row!);
  }

  async putEnvironment(input: {
    environment: string;
    providerId: string;
    config: Record<string, unknown>;
    updatedBy: string;
  }): Promise<Record<string, unknown>> {
    return this.put({ ...input, packId: MiniappProviderCredentialService.ENVIRONMENT_PACK_ID, scope: 'environment' });
  }

  async putCreator(input: { environment: string; creatorId: string; providerId: string;
    config: Record<string, unknown>; updatedBy: string }) {
    return this.put({ ...input, packId: this.creatorPackId(input.creatorId), scope: 'pack' });
  }

  async listCreator(creatorId: string): Promise<Record<string, unknown>[]> {
    const rows = await this.model.find({ environment: this.currentEnvironment(),
      packId: this.creatorPackId(creatorId), status: 'active' }).lean().exec();
    return rows.map((row) => this.safeView(row));
  }

  async listCreatorBindings(creatorId: string): Promise<Record<string, unknown>[]> {
    const sourcePackId = this.creatorPackId(creatorId);
    const rows = await this.model.find({ environment: this.currentEnvironment(), sourcePackId,
      status: 'active' }).lean().exec();
    return rows.map((row) => this.safeView(row));
  }

  resolveCreatorForTest(environment: string, creatorId: string, providerId: string) {
    return this.resolveForTest(environment, this.creatorPackId(creatorId), providerId);
  }

  recordCreatorTest(environment: string, creatorId: string, providerId: string,
    status: 'ok' | 'failed', expectedFingerprint?: string) {
    return this.recordTest(environment, this.creatorPackId(creatorId), providerId, status, expectedFingerprint);
  }

  async bindCreator(input: { environment: string; creatorId: string; packId: string; providerId: string }) {
    this.assertEnvironment(input.environment);
    const sourcePackId = this.creatorPackId(input.creatorId);
    const source = await this.model.findOne({ environment: input.environment, packId: sourcePackId,
      providerId: input.providerId, status: 'active', lastTestStatus: 'ok' }).lean().exec();
    if (!source) throw new BadRequestException('Test this creator connection before granting it');
    const packId = this.required(input.packId, 'packId');
    if (packId.startsWith('__')) throw new BadRequestException('Invalid tool ID');
    const row = await this.model.findOneAndUpdate({ environment: input.environment, packId,
      providerId: input.providerId }, { $set: {
      encryptedConfig: this.crypto.encrypt('{}'), sourcePackId, configFingerprint: source.configFingerprint,
      status: 'active', scope: 'pack', updatedBy: `creator:${input.creatorId}`,
    }, $unset: { lastTestStatus: 1, lastTestedAt: 1 } },
    { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true }).lean().exec();
    return this.safeView(row!);
  }

  async promotePackToCreator(input: { environment: string; creatorId: string; packId: string; providerId: string }) {
    this.assertEnvironment(input.environment);
    const creatorPackId = this.creatorPackId(input.creatorId);
    if (await this.model.exists({ environment: input.environment, packId: creatorPackId,
      providerId: input.providerId, status: 'active' })) {
      throw new ConflictException('A shared key already exists for this API; grant it to the tool instead');
    }
    const original = await this.model.findOne({ environment: input.environment, packId: input.packId,
      providerId: input.providerId, status: 'active', sourcePackId: { $exists: false } })
      .select('+encryptedConfig').lean().exec();
    if (!original) throw new NotFoundException('This tool has no individual key to move');
    let config: Record<string, unknown>;
    try { config = JSON.parse(this.crypto.decrypt(original.encryptedConfig)) as Record<string, unknown>; }
    catch { throw new BadRequestException('Stored provider credential is invalid'); }
    const saved = await this.putCreator({ ...input, config, updatedBy: `creator:${input.creatorId}` });
    if (original.lastTestStatus === 'ok') {
      await this.recordCreatorTest(input.environment, input.creatorId, input.providerId, 'ok',
        String(saved.configFingerprint));
      return this.bindCreator(input);
    }
    return saved;
  }

  async resolve(environment: string, packId: string, providerId: string): Promise<Record<string, unknown>> {
    return (await this.resolveForTest(environment, packId, providerId)).config;
  }

  async resolveEnvironment(environment: string, providerId: string): Promise<Record<string, unknown>> {
    return (await this.resolveForTest(
      environment,
      MiniappProviderCredentialService.ENVIRONMENT_PACK_ID,
      providerId,
    )).config;
  }

  async resolveEnvironmentForTest(
    environment: string,
    providerId: string,
  ): Promise<{ config: Record<string, unknown>; configFingerprint: string }> {
    return this.resolveForTest(environment, MiniappProviderCredentialService.ENVIRONMENT_PACK_ID, providerId);
  }

  async resolveForTest(
    environment: string,
    packId: string,
    providerId: string,
  ): Promise<{ config: Record<string, unknown>; configFingerprint: string }> {
    this.assertEnvironment(environment);
    const row = await this.model
      .findOne({ environment, packId, providerId, status: 'active' })
      .select('+encryptedConfig')
      .lean()
      .exec();
    if (!row) {
      throw new NotFoundException({
        code: 'PROVIDER_NOT_CONFIGURED',
        message: `${providerId} is not configured for ${packId}`,
      });
    }
    try {
      if (row.sourcePackId) {
        const source = await this.model.findOne({ environment, packId: row.sourcePackId,
          providerId, status: 'active', lastTestStatus: 'ok', sourcePackId: { $exists: false } })
          .select('+encryptedConfig').lean().exec();
        if (!source) throw new NotFoundException('Shared provider connection needs a successful test');
        return { config: JSON.parse(this.crypto.decrypt(source.encryptedConfig)) as Record<string, unknown>,
          configFingerprint: source.configFingerprint };
      }
      return {
        config: JSON.parse(this.crypto.decrypt(row.encryptedConfig)) as Record<string, unknown>,
        configFingerprint: row.configFingerprint,
      };
    } catch (error) {
      if (error instanceof NotFoundException) throw error;
      throw new BadRequestException('Stored provider credential is invalid');
    }
  }

  async isReady(environment: string, packId: string, providerId: string): Promise<boolean> {
    this.assertEnvironment(environment);
    const row = await this.model.findOne({
      environment,
      packId,
      providerId,
      status: 'active',
    }).select('sourcePackId lastTestStatus').lean().exec();
    if (!row) return false;
    if (!row.sourcePackId) return row.lastTestStatus === 'ok';
    return Boolean(await this.model.exists({ environment, packId: row.sourcePackId, providerId,
      status: 'active', lastTestStatus: 'ok', sourcePackId: { $exists: false } }));
  }

  async isEnvironmentReady(environment: string, providerId: string): Promise<boolean> {
    return this.isReady(environment, MiniappProviderCredentialService.ENVIRONMENT_PACK_ID, providerId);
  }

  async recordTest(
    environment: string,
    packId: string,
    providerId: string,
    status: 'ok' | 'failed',
    expectedFingerprint?: string,
  ): Promise<Record<string, unknown>> {
    this.assertEnvironment(environment);
    const row = await this.model.findOneAndUpdate(
      {
        environment,
        packId,
        providerId,
        status: 'active',
        ...(expectedFingerprint ? { configFingerprint: expectedFingerprint } : {}),
      },
      { $set: { lastTestStatus: status, lastTestedAt: new Date() } },
      { returnDocument: 'after' },
    ).lean().exec();
    if (!row) {
      if (expectedFingerprint && await this.model.exists({
        environment,
        packId,
        providerId,
        status: 'active',
      })) {
        throw new BadRequestException('Provider credential changed while its connection test was running');
      }
      throw new NotFoundException('Provider credential is not configured');
    }
    return this.safeView(row);
  }

  async recordEnvironmentTest(
    environment: string,
    providerId: string,
    status: 'ok' | 'failed',
    expectedFingerprint?: string,
  ): Promise<Record<string, unknown>> {
    return this.recordTest(
      environment,
      MiniappProviderCredentialService.ENVIRONMENT_PACK_ID,
      providerId,
      status,
      expectedFingerprint,
    );
  }

  async list(packId?: string): Promise<Record<string, unknown>[]> {
    const rows = await this.model.find({
      environment: this.currentEnvironment(),
      // Pack readiness must also see credentials shared by the environment.
      // The safe view never exposes
      // encrypted configuration, and consumers already match by providerId,
      // so returning the environment-scoped status lets the admin console
      // report the same readiness that runtime resolution enforces.
      ...(packId ? {
        $or: [
          { packId },
          { packId: MiniappProviderCredentialService.ENVIRONMENT_PACK_ID, scope: 'environment' },
        ],
      } : {}),
    }).lean().exec();
    const sourcePackIds = [...new Set(rows.map((row) => row.sourcePackId).filter((id): id is string => Boolean(id)))];
    const sources = sourcePackIds.length ? await this.model.find({ environment: this.currentEnvironment(),
      packId: { $in: sourcePackIds }, status: 'active' }).lean().exec() : [];
    const bySource = new Map(sources.map((row) => [`${row.packId}:${row.providerId}`, row]));
    return rows.map((row) => {
      const view = this.safeView(row);
      if (row.sourcePackId) {
        const source = bySource.get(`${row.sourcePackId}:${row.providerId}`);
        view.lastTestStatus = source?.lastTestStatus ?? 'untested';
        view.lastTestedAt = source?.lastTestedAt;
        view.configFingerprint = source?.configFingerprint ?? row.configFingerprint;
      }
      return view;
    });
  }

  async remove(environment: string, packId: string, providerId: string): Promise<Record<string, unknown>> {
    this.assertEnvironment(environment);
    const row = await this.model.findOneAndDelete({
      environment,
      packId: this.required(packId, 'packId'),
      providerId: this.required(providerId, 'providerId'),
    }).lean().exec();
    if (!row) throw new NotFoundException('Provider credential is not configured');
    return this.safeView(row);
  }

  async removeEnvironment(environment: string, providerId: string): Promise<Record<string, unknown>> {
    return this.remove(environment, MiniappProviderCredentialService.ENVIRONMENT_PACK_ID, providerId);
  }

  private safeView(row: MiniappProviderCredential): Record<string, unknown> {
    return {
      id: String((row as MiniappProviderCredential & { _id?: unknown })._id ?? ''),
      environment: row.environment,
      packId: row.packId,
      scope: row.scope ?? 'pack',
      providerId: row.providerId,
      status: row.status,
      configFingerprint: row.configFingerprint,
      shared: Boolean(row.sourcePackId),
      lastTestedAt: row.lastTestedAt,
      lastTestStatus: row.lastTestStatus,
      updatedBy: row.updatedBy,
    };
  }

  private required(value: string, name: string): string {
    const normalized = String(value ?? '').trim();
    if (!normalized) throw new BadRequestException(`${name} is required`);
    return normalized;
  }

  private creatorPackId(creatorId: string): string {
    return `__creator__${this.required(creatorId, 'creatorId')}`;
  }

  private assertEnvironment(value: string): void {
    const normalized = this.required(value, 'environment').toLowerCase();
    const current = this.currentEnvironment();
    if (normalized !== current) {
      throw new BadRequestException(`Provider credential environment must be ${current}`);
    }
  }

  private currentEnvironment(): string {
    return String(process.env.JOVITA_ENVIRONMENT ?? process.env.NODE_ENV ?? 'development')
      .trim()
      .toLowerCase();
  }
}
