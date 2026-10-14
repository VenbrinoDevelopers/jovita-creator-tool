import { BadRequestException, ConflictException, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import { MiniappInvocation, type MiniappInvocationDocument } from '../../cloud/saas-store/schemas/miniapp-invocation.schema.js';
import { MediaJobService } from '../../cloud/media/jobs/media-job.service.js';
import { compileMediaJob, MediaRouteContractError } from '../../cloud/media/jobs/media-route-policy.js';
import { assertQualifiedVoice, qualifiedVoiceCatalog } from '../../cloud/media/jobs/voice-catalog.js';
import { MiniappProviderCredentialService } from '../../cloud/saas-store/miniapp-provider-credential.service.js';
import { UploadsService } from '../../cloud/media/uploads/uploads.service.js';
import { normalizeMediaAttachmentMetadata } from '../../cloud/core/contracts/media-attachment-metadata.js';
import type { CapabilityCallInput, CapabilityCallResult } from '../../cloud/saas-store/capabilities/capability-operation.types.js';
import { elevenLabsTariffForOperation } from '../../cloud/media/jobs/media-provider-tariffs.js';


@Injectable()
export class JovitaMediaLifecycle {
  readonly providerId = 'jovita-media';
  readonly credentialSource = 'none' as const;
  readonly credentialFields = [] as const;


  constructor(private readonly jobs: MediaJobService, private readonly uploads: UploadsService,
    @Optional() private readonly credentials?: MiniappProviderCredentialService,
    @Optional() @InjectModel(MiniappInvocation.name) private readonly invocationModel?: Model<MiniappInvocationDocument>) {}
  validateCredential(config: Record<string, unknown>): void { if (Object.keys(config).length) throw new BadRequestException('Jovita Media does not accept client credentials'); }

  activationRequirements(input: Readonly<{ capability: string; packId: string; operationId: string }>) {
    if (input.capability !== 'jovita.media.submit') return { ready: true, credentialProviderIds: [] } as const;
    const provider = input.packId === 'music-studio'
      && !['generate-fast', 'generate-auto'].includes(input.operationId)
      ? 'elevenlabs'
      : 'openrouter';
    const ready = this.implementedOperation(input.packId, input.operationId);
    return {
      ready,
      credentialProviderIds: input.packId === 'voice-studio' && input.operationId === 'speak-auto' ? [] : [provider],
      billingUnit: provider === 'elevenlabs' ? 'second' : 'request',
      ...(ready ? {} : { reason: `Media route qualification is missing for ${input.packId}/${input.operationId}` }),
    } as const;
  }

  async estimateQuantity(input: Readonly<{ capability: string; ownerId: string; packId: string;
    operationId: string; pricingMode: string; payload: Record<string, unknown> }>): Promise<number> {
    if (input.capability !== 'jovita.media.submit' || input.packId !== 'music-studio' || input.pricingMode !== 'per_unit') return 1;
    const operation = this.text(input.payload.operation);
    const profile = this.text(input.payload.profile);
    if (input.operationId !== `${operation}-${profile}`) throw new BadRequestException('Music operation does not match the signed route');
    const compiled = compileMediaJob({ studio: input.packId, operation, profile, request: this.record(input.payload.request) });
    if (compiled.provider !== 'elevenlabs') return 1;
    const duration = Number(compiled.request.duration);
    if (operation === 'generate') return this.outputDurationBudget(duration);
    const sourceKind = operation === 'score-video' ? 'video' : 'audio';
    const sourceId = compiled.request[operation === 'score-video' ? 'source_video_attachment_id' : 'source_audio_attachment_id'];
    if (typeof sourceId !== 'string') throw new BadRequestException('Music source is required');
    const source = await this.uploads.resolveRuntimeAttachment(input.ownerId, sourceId);
    if (!source || source.kind !== sourceKind || !Number.isSafeInteger(source.durationMs) || Number(source.durationMs) < 1) {
      throw new BadRequestException('Source duration must be verified before paid music editing');
    }
    const sourceSeconds = Math.ceil(Number(source.durationMs) / 1000);
    if (operation === 'separate-stems') return sourceSeconds;
    if (operation === 'score-video') return this.outputDurationBudget(sourceSeconds);
    return sourceSeconds + duration;
  }

  private outputDurationBudget(seconds: number): number {
    // The media processor accepts at most two seconds or ten percent of
    // variation. Reserve that upper bound before the provider is called.
    return Math.ceil(seconds + Math.max(2, seconds * 0.1));
  }

  async invoke(input: CapabilityCallInput): Promise<CapabilityCallResult> {
    if (!input.invocationId || !input.callId || !input.operationId || !input.pricingSnapshot) throw new ConflictException('Authenticated media invocation context is required');
    if (input.capability === 'jovita.media.voices') return this.free({ status: 'success', voices: await qualifiedVoiceCatalog(this.credentials, input.environment) });
    if (input.capability === 'jovita.media.quote') {
      const compiled = this.compile(input);
      return this.free({ status: this.qualified(compiled.routeId) ? 'available' : 'unavailable', profile: this.text(input.payload.profile), operation: this.text(input.payload.operation) });
    }
    if (input.capability === 'jovita.media.submit') {
      const compiled = this.compile(input);
      this.assertSignedOperation(input.operationId, this.text(input.payload.operation), this.text(input.payload.profile));
      const selectedVoice = String(this.record(input.payload.request).voice ?? '');
      if (input.packId === 'voice-studio' && selectedVoice && !/^voice_[a-f0-9-]{36}$/i.test(selectedVoice)) {
        try {
          await assertQualifiedVoice(this.credentials, input.environment, selectedVoice,
            typeof this.record(input.payload.request).locale === 'string' ? String(this.record(input.payload.request).locale) : undefined);
        } catch (error) {
          throw new BadRequestException({ code: 'VOICE_UNAVAILABLE', message: error instanceof Error ? error.message : 'Selected voice is unavailable' });
        }
      }
      const reserved = input.pricingSnapshot.videoReservation;
      if (reserved && input.packId === 'video-studio') {
        const row = this.record(reserved);
        if (row.model !== compiled.model || row.duration !== compiled.request.duration
          || row.resolution !== compiled.request.resolution || row.aspectRatio !== compiled.request.aspect_ratio
          || row.audio !== compiled.request.generate_audio || compiled.request.count !== 1) {
          throw new ConflictException('Video submission does not match its credit reservation');
        }
      }
      const pricingMode = String(input.pricingSnapshot.mode ?? '');
      const fixedCallPrice = input.pricingSnapshot.brokerCalls === true && pricingMode === 'fixed_success';
      if (input.packId === 'voice-studio' && compiled.provider !== 'openrouter' && pricingMode !== 'cost_plus' && !fixedCallPrice) throw new ConflictException('Selected voice route requires a fixed call price');
      if (compiled.provider === 'openrouter' && pricingMode !== 'cost_plus' && !fixedCallPrice) {
        throw new ConflictException('OpenRouter media routes require cost-plus pricing');
      }
      if (compiled.provider === 'elevenlabs' && pricingMode !== 'per_unit' && !fixedCallPrice) {
        if (!(input.packId === 'voice-studio' && pricingMode === 'cost_plus')) throw new ConflictException('ElevenLabs media routes require a qualified pricing policy');
      }
      let voiceTariff: Record<string, unknown> | undefined;
      if (input.packId === 'voice-studio' && compiled.provider === 'elevenlabs') {
        if (!this.credentials || !(await this.credentials.isReady(input.environment, input.packId, compiled.provider))) throw new ConflictException('Selected voice provider is not qualified');
        const config = await this.credentials.resolve(input.environment, input.packId, compiled.provider);
        const rate = Number(config.usdMicrosPerCharacter);
        if (!Number.isSafeInteger(rate) || rate < 1 || rate > 100_000 || typeof config.tariffVersion !== 'string' || !config.tariffVersion.trim()) throw new ConflictException('Selected voice provider has no qualified tariff');
        voiceTariff = { provider: compiled.provider, version: config.tariffVersion, usdMicrosPerCharacter: rate };
      }
      if (!this.qualified(compiled.routeId)) throw new ConflictException({ code: 'MEDIA_ROUTE_NOT_QUALIFIED', message: 'This media profile is not available yet.' });
      const job = await this.jobs.submit({
        ownerId: input.ownerId, environment: input.environment, conversationId: input.invocationId,
        packId: input.packId, invocationId: input.invocationId, callId: input.callId,
        operationId: input.operationId, submissionId: input.callId, provider: compiled.provider,
        model: compiled.model, request: { kind: compiled.kind, route_id: compiled.routeId, ...compiled.request },
        pricingSnapshot: {
          ...input.pricingSnapshot,
          ...(compiled.provider === 'elevenlabs'
            ? input.packId === 'voice-studio' ? {} : { providerTariff: elevenLabsTariffForOperation(input.operationId) }
            : {}),
          ...(voiceTariff ? { voiceTariff } : {}),
        },
      });
      return { result: { status: 'pending', job_id: job.jobId }, providerCostMicros: 0, quantity: 0, deferred: { jobId: job.jobId } };
    }
    const jobId = this.text(input.payload.job_id);
    if (input.capability === 'jovita.media.cancel') {
      const job = await this.jobs.cancel(input.ownerId, input.environment, jobId);
      return this.free(this.view(job));
    }
    const job = await this.jobs.get(input.ownerId, input.environment, jobId);
    if (input.capability === 'jovita.media.status') {
      const view: Record<string, unknown> = this.view(job);
      const rejection = await this.jobs.providerRejectionDetails(job);
      if (rejection) view.provider_rejection = rejection;
      if (job.billingState === 'settled' && this.invocationModel) {
        const settled = await this.invocationModel.findOne({ invocationId: job.invocationId,
          ownerId: input.ownerId, settlementStatus: 'settled' }).select('settledCredits').lean().exec();
        if (settled && Number.isSafeInteger(Number(settled.settledCredits))) {
          view.invocation_credits_charged = Number(settled.settledCredits);
        }
      }
      return this.free(view);
    }
    if (input.capability === 'jovita.media.persist-result') {
      if (job.providerState !== 'succeeded' || job.assetState !== 'ready') throw new ConflictException('Media result is not ready');
      const checksums = input.payload.sha256;
      if (!Array.isArray(checksums) || checksums.length !== job.assetIds.length
        || checksums.some(value => typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value))) {
        throw new BadRequestException('Delivered media checksum list is invalid');
      }
      const expected = await Promise.all(job.assetIds.map(async attachmentId => {
        const attachment = await this.uploads.resolveRuntimeAttachment(input.ownerId, attachmentId);
        if (!attachment?.sha256) throw new NotFoundException('A completed media asset is unavailable');
        return attachment.sha256;
      }));
      if (expected.some((value, index) => value !== checksums[index])) throw new ConflictException('Delivered media checksum does not match');
      return this.free(this.view(await this.jobs.confirmDelivered(input.ownerId, input.environment, jobId)));
    }
    if (input.capability === 'jovita.media.download') {
      if (job.providerState !== 'succeeded' || job.assetState !== 'ready') throw new ConflictException({ code: 'MEDIA_NOT_READY', message: 'The media job is not ready yet.' });
      const assets = await Promise.all(job.assetIds.map(async attachmentId => {
        const attachment = await this.uploads.resolveRuntimeAttachment(input.ownerId, attachmentId);
        if (!attachment?.url || !attachment.sha256 || !attachment.size) throw new NotFoundException('A completed media asset is unavailable');
        const media = normalizeMediaAttachmentMetadata(attachment);
        return {
          attachment_id: attachmentId,
          url: attachment.url,
          file_name: attachment.fileName,
          mime_type: attachment.mimeType,
          size: attachment.size,
          sha256: attachment.sha256,
          ...(Object.keys(media).length ? { media } : {}),
        };
      }));
      return this.free({ status: 'success', job_id: job.jobId, assets });
    }
    throw new BadRequestException('Unsupported Jovita Media capability');
  }

  private compile(input: CapabilityCallInput) {
    const studio = this.text(input.payload.studio); const operation = this.text(input.payload.operation); const profile = this.text(input.payload.profile);
    const request = this.record(input.payload.request);
    if (studio !== input.packId) throw new BadRequestException('Media studio identity mismatch');
    try { return compileMediaJob({ studio, operation, profile, request }); } catch (error) {
      if (error instanceof MediaRouteContractError) throw new BadRequestException({ code: error.code, message: error.message });
      throw new BadRequestException(error instanceof Error ? error.message : 'Invalid media request');
    }
  }
  private qualified(routeId: string): boolean {
    // The compiler emits only server-owned, explicitly implemented routes.
    // Credentials and an active signed pricing policy remain mandatory.
    return this.implemented(routeId);
  }
  private implementedOperation(packId: string, operationId: string): boolean {
    if (packId === 'video-studio') {
      return [
        'generate-fast', 'generate-auto', 'generate-pro',
        'generate-hd', 'generate-ultra',
        'animate-fast', 'animate-auto', 'animate-pro',
        'animate-hd', 'animate-ultra',
        'transition-fast', 'transition-auto', 'transition-pro',
        'transition-hd', 'transition-ultra',
        'remix-auto', 'extend-auto', 'lip-sync-auto',
      ].includes(operationId);
    }
    if (packId === 'voice-studio') {
      return ['transcribe', 'speak-fast', 'speak-auto', 'speak-pro', 'dialogue-auto'].includes(operationId);
    }
    if (packId === 'product-demo') return operationId === 'narrate-auto';
    if (packId === 'music-studio') {
      return [
        'generate-fast', 'generate-auto', 'generate-pro',
        'extend-auto', 'remix-auto', 'replace-section-auto', 'insert-section-auto', 'separate-stems-auto', 'score-video-auto',
      ].includes(operationId);
    }
    return false;
  }
  private implemented(routeId: string): boolean {
    return /^video-studio:(generate|animate|transition):(fast|auto|pro|hd|ultra):(480p|720p|1080p|2K|4K):/.test(routeId)
      || /^video-studio:(remix|extend|lip-sync):auto:/.test(routeId)
      || /^voice-studio:speak:(fast|auto|pro):/.test(routeId)
      || routeId === 'voice-studio:speak:auto:eleven_multilingual_v2'
      || /^product-demo:speak:auto:/.test(routeId)
      || /^voice-studio:dialogue:auto:fish-audio\/s2\.1-pro$/.test(routeId)
      || /^voice-studio:transcribe:auto:deepgram\/nova-3$/.test(routeId)
      || /^music-studio:generate:(fast|auto):openrouter:google\/lyria-3-(clip|pro)-preview$/.test(routeId)
      || routeId === 'music-studio:generate:pro:elevenlabs:music_v2'
      || /^music-studio:(extend|remix|replace-section|insert-section|separate-stems|score-video):auto:elevenlabs:music_v2$/.test(routeId);
  }
  private assertSignedOperation(operationId: string, operation: string, profile: string) { const expected = operationId === 'narrate-auto' && operation === 'speak' && profile === 'auto' ? 'narrate-auto' : operation === 'transcribe' ? operation : `${operation}-${profile}`; if (operationId !== expected) throw new ConflictException('Signed media operation does not match request profile'); }
  private view(job: { jobId: string; providerState: string; assetState: string; deliveryState: string; failureCode?: string; deadLetteredAt?: Date }) {
    const status = job.assetState === 'failed' || job.deadLetteredAt ? 'failed'
      : job.providerState === 'succeeded' && job.assetState !== 'ready' ? 'processing' : job.providerState;
    const preDispatchFailure = job.providerState === 'queued'
      || job.failureCode === 'PRE_DISPATCH_RETRY_LIMIT_EXCEEDED'
      || job.failureCode?.startsWith('VIDEO_') === true;
    const failurePhase = preDispatchFailure ? 'validation'
      : job.providerState === 'dispatching' || job.providerState === 'unknown' ? 'submission'
        : job.providerState === 'failed' ? 'generation'
          : job.assetState === 'ready' ? 'delivery' : 'asset_finalization';
    return { status, provider_status: job.providerState, job_id: job.jobId,
      asset_status: job.assetState, delivery_status: job.deliveryState,
      downloadable: job.providerState === 'succeeded' && job.assetState === 'ready',
      ...(status === 'failed' ? { failure_phase: failurePhase } : {}),
      ...(job.failureCode ? { error: { code: job.failureCode } } : {}) };
  }
  private free(result: unknown): CapabilityCallResult { return { result, providerCostMicros: 0, quantity: 1 }; }
  private text(value: unknown): string { if (typeof value !== 'string' || !value.trim() || value.length > 200) throw new BadRequestException('Invalid media identifier'); return value.trim(); }
  private record(value: unknown): Record<string, unknown> { if (!value || typeof value !== 'object' || Array.isArray(value)) throw new BadRequestException('Invalid media request'); return value as Record<string, unknown>; }
}
