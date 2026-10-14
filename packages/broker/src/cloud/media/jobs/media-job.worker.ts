import { Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { MediaJobService } from './media-job.service.js';
import { MediaProviderRejection, OpenRouterMediaClient, openRouterMediaCost, stageProviderMedia, normalizeLyriaAudio } from './openrouter-media.client.js';
import { ElevenLabsMediaClient } from './elevenlabs-media.client.js';
import { MiniappProviderCredentialService } from '../../saas-store/miniapp-provider-credential.service.js';
import { MiniappInvocationService } from '../../saas-store/miniapp-invocation.service.js';
import { AttachmentReservationException, UploadsService } from '../uploads/uploads.service.js';
import type { MediaJob } from './media-job.schema.js';
import { ProviderOutcomeUnknownError } from '../../saas-store/capabilities/capability-operation.types.js';
import { MediaProcessingService, type PreparedMedia, type ProcessedMediaFile } from './media-processing.service.js';
import { MediaSourceService, type ResolvedMediaSource } from './media-source.service.js';
import { VoiceLibraryService } from '../voice-library/voice-library.service.js';
import { MediaJobStepService } from './media-job-step.service.js';
import { MediaArchiveService } from './media-archive.service.js';
import { MEDIA_JOB_HEARTBEAT_MS } from './media-job-timing.js';
import { readElevenLabsTariff } from './media-provider-tariffs.js';

export class MediaRouteCompatibilityError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'MediaRouteCompatibilityError';
  }
}

export class MediaOutputValidationError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'MediaOutputValidationError';
  }
}

@Injectable()
export class MediaJobWorker implements OnApplicationBootstrap {
  private readonly logger = new Logger(MediaJobWorker.name);
  private busy = false;
  private reconciling = false;
  constructor(
    private readonly jobs: MediaJobService,
    private readonly credentials: MiniappProviderCredentialService,
    private readonly uploads: UploadsService,
    private readonly invocations: MiniappInvocationService,
    private readonly processing: MediaProcessingService,
    private readonly sources: MediaSourceService,
    private readonly voices: VoiceLibraryService,
    private readonly steps: MediaJobStepService,
    private readonly archives: MediaArchiveService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (process.env.JOVITA_BROKER_PLATFORM_WORKERS === 'false') return;
    await this.reconcileLegacyOutputSlots();
  }

  @Interval(60_000)
  async reconcileLegacyOutputSlots(): Promise<void> {
    if (process.env.JOVITA_BROKER_PLATFORM_WORKERS === 'false') return;
    if (this.reconciling) return;
    this.reconciling = true;
    try {
      const released = await this.uploads.releaseLegacyWorkerOutputSlots();
      const recoverable = await this.jobs.listRecoverableAssetDeadLetters();
      let requeued = 0;
      for (const job of recoverable) {
        await this.jobs.requeueForReconciliation(job.ownerId, job.environment, job.jobId);
        requeued += 1;
      }
      const preDispatch = await this.jobs.listTerminalizablePreDispatchDeadLetters();
      let finalized = 0;
      for (const candidate of preDispatch) {
        const job = await this.jobs.finalizePreDispatchDeadLetter(candidate.ownerId, candidate.environment, candidate.jobId);
        if (!job) continue;
        await this.settle(job);
        finalized += 1;
      }
      if (released || requeued || finalized) {
        this.logger.log(`media_output_reconciliation releasedSlots=${released} requeuedJobs=${requeued} finalizedPreDispatchJobs=${finalized}`);
      }
    } catch (error) {
      this.logger.warn(`media_output_reconciliation_failed reason=${error instanceof Error ? error.message : String(error)}`);
    } finally {
      this.reconciling = false;
    }
  }

  @Interval(2_000)
  async tick(): Promise<void> {
    if (process.env.JOVITA_BROKER_PLATFORM_WORKERS === 'false') return;
    // Accepted jobs must be processed without an additional deployment switch.
    // Mongo leases fence replicas; this guard prevents overlapping local ticks.
    if (this.busy) return;
    this.busy = true;
    try { const job = await this.jobs.lease(); if (job) await this.process(job); }
    catch (error) { this.logger.error(`media_worker_failed reason=${error instanceof Error ? error.message : String(error)}`); }
    finally { this.busy = false; }
  }

  async process(input: MediaJob): Promise<void> {
    let job = input;
    const heartbeat = setInterval(() => {
      void this.jobs.heartbeat(job).catch(error => {
        this.logger.warn(`media_job_heartbeat_lost jobId=${job.jobId} reason=${error instanceof Error ? error.message : String(error)}`);
      });
    }, MEDIA_JOB_HEARTBEAT_MS);
    heartbeat.unref();
    try {
      const work = await this.jobs.readWork(job);
      if (this.isRecoverableSynchronousAudio(job)
        && ['dispatching', 'running', 'unknown'].includes(job.providerState)) {
        const saved = await this.jobs.readAudioResult(job);
        if (!saved) throw new ProviderOutcomeUnknownError('Synchronous audio response is not recoverable; generation was not repeated');
        if (job.providerState === 'dispatching') {
          const resultId = this.savedAudioResultId(saved.evidence);
          job = await this.jobs.transition(job, 'running', resultId);
        }
        job = await this.jobs.terminal(job, 'succeeded', saved.evidence);
      }
      if (this.isDialogue(work.request)) {
        job = await this.processDialogue(job, work.request);
        if (['succeeded', 'failed', 'cancelled'].includes(job.providerState)) await this.settle(job);
        else await this.jobs.release(job);
        return;
      }
      if (this.isElevenCompound(job, work.request)) {
        job = await this.processElevenCompound(job, work.request);
        if (['succeeded', 'failed', 'cancelled'].includes(job.providerState)) await this.settle(job);
        else await this.jobs.release(job);
        return;
      }
      if (job.providerState === 'queued') job = await this.dispatch(job, work.request);
      if (work.request.kind === 'video' && (job.providerState === 'running' || (job.providerState === 'unknown' && job.providerRequestId))) job = await this.poll(job);
      if (job.providerState === 'succeeded' && job.assetState !== 'failed') {
        job = work.request.kind === 'video'
          ? await this.persist(await this.measureCompletedVideo(job, work.result), work.request)
          : await this.recoverSynchronousPersistence(job, work.request);
      }
      if (['succeeded', 'failed', 'cancelled'].includes(job.providerState)) await this.settle(job);
      else await this.jobs.release(job);
    } catch (error) {
      // dispatch() can commit several fenced transitions before a later local
      // finalization step throws. Recover the authoritative revision/state so
      // error handling never acts on the stale pre-dispatch object.
      try { job = await this.jobs.get(job.ownerId, job.environment, job.jobId); } catch { /* retain the last fenced state */ }
      if (error instanceof ProviderOutcomeUnknownError) {
        if (job.providerState === 'dispatching' && this.isRecoverableSynchronousAudio(job)) {
          // A synchronous response may have been journaled immediately before a
          // local state write failed. Promote that durable evidence instead of
          // quarantining a result we can prove and recover.
          const saved = await this.jobs.readAudioResult(job).catch(() => null);
          if (saved) {
            job = await this.jobs.transition(job, 'running', this.savedAudioResultId(saved.evidence));
            job = await this.jobs.terminal(job, 'succeeded', saved.evidence);
            await this.jobs.release(job, 1_000).catch(() => undefined);
            return;
          }
          await this.jobs.quarantineUnknownDispatch(job);
        } else if (job.providerState === 'dispatching') await this.jobs.quarantineUnknownDispatch(job);
        else if (job.providerState === 'running') {
          const unknown = await this.jobs.transition(job, 'unknown').catch(() => undefined);
          if (unknown) await this.jobs.release(unknown, 60_000).catch(() => undefined);
        } else await this.jobs.release(job, 60_000).catch(() => undefined);
        return;
      }
      if (error instanceof MediaProviderRejection && job.providerState === 'dispatching') {
        job = await this.jobs.terminal(job, 'failed', {
          status: error.status, rejected: true,
          ...(error.providerCode ? { provider_code: error.providerCode } : {}),
          ...(error.providerMessage ? { provider_message: error.providerMessage } : {}),
        }, 'PROVIDER_REJECTED');
        job = await this.jobs.measure(job, 0, 'openrouter_usage');
        await this.settle(job);
        return;
      }
      if (error instanceof MediaRouteCompatibilityError && job.providerState === 'queued') {
        job = await this.jobs.terminal(job, 'failed', { code: error.code, rejected: true, reason: error.message }, error.code);
        job = await this.jobs.measure(job, 0, 'openrouter_usage');
        await this.settle(job);
        return;
      }
      if (error instanceof MediaOutputValidationError && job.providerState === 'succeeded' && job.assetState !== 'ready') {
        job = await this.jobs.assetFailed(job, error.code);
        await this.settle(job);
        return;
      }
      if (error instanceof AttachmentReservationException && job.providerState === 'succeeded' && job.assetState !== 'ready') {
        if (error.code === 'attachment_storage_quota_exceeded') {
          job = await this.jobs.assetFailed(job, 'ATTACHMENT_STORAGE_QUOTA_EXCEEDED');
          await this.settle(job);
        } else {
          await this.jobs.release(job, error.retryAfterMs ?? 60_000).catch(() => undefined);
        }
        return;
      }
      if (job.providerState === 'dispatching') {
        job = await this.jobs.terminal(job, 'failed', { rejected: true, reason: error instanceof Error ? error.message : 'provider rejection' }, 'PROVIDER_REJECTED');
        const voiceTariff = job.pricingSnapshot.voiceTariff as Record<string, unknown> | undefined;
        job = await this.jobs.measure(job, 0, job.provider === 'openrouter' ? 'openrouter_usage' : 'account_tariff',
          job.packId === 'voice-studio' && job.provider === 'elevenlabs'
            ? String(voiceTariff?.version ?? '')
            : job.provider === 'elevenlabs' ? this.tariffVersion(job, this.operation(job.operationId)) : undefined);
        await this.settle(job);
        return;
      }
      this.logger.warn(`media_job_retry jobId=${job.jobId} state=${job.providerState} reason=${error instanceof Error ? error.message : String(error)}`);
      await this.jobs.release(job, 10_000).catch(() => undefined);
    } finally {
      clearInterval(heartbeat);
    }
  }

  private async dispatch(job: MediaJob, request: Record<string, unknown>): Promise<MediaJob> {
    if (job.provider === 'elevenlabs' && request.kind === 'audio' && request.model === 'eleven_multilingual_v2') {
      const config = await this.credentials.resolve(job.environment, job.packId, 'elevenlabs');
      const client = new ElevenLabsMediaClient(this.key(config));
      job = await this.jobs.transition(job, 'dispatching');
      return this.dispatchQualifiedSpeech(job, request, () => client.speech(String(request.input), String(request.voice), Number(request.speed)));
    }
    if (job.provider === 'openrouter') {
      const config = await this.credentials.resolve(job.environment, job.packId, 'openrouter');
      const client = new OpenRouterMediaClient(this.key(config));
      if (request.kind === 'video') this.assertLiveVideoRoute(request, await client.discover('video'));
      if (request.kind === 'audio' && this.isSpeechModel(String(request.model))) {
        this.assertLiveSpeechRoute(request, await client.discover('speech'));
        if (request.model === 'fish-audio/s2.1-pro'
          && !(await client.modelEndpoints(String(request.model))).some(endpoint => endpoint.supports_voice_cloning === true)) {
          throw new Error('Selected speech route no longer supports stateless voice cloning');
        }
      }
      if (request.kind === 'transcript' && !(await client.discover('transcription')).some(model => model.id === request.model)) {
        throw new Error('Selected transcription route is currently unavailable');
      }
      if (request.kind === 'audio' && String(request.model).startsWith('google/lyria-3-')
        && !(await client.discover('audio')).some(model => model.id === request.model)) {
        throw new Error('Selected music route is currently unavailable');
      }
      const providerRequest = request.kind === 'video'
        ? await this.materializeVideoRequest(job, request)
        : request.kind === 'audio' && this.isSpeechModel(String(request.model))
          ? await this.materializeSpeechRequest(job, request)
          : request.kind === 'transcript'
            ? await this.materializeTranscriptionRequest(job, request)
            : request;
      job = await this.jobs.transition(job, 'dispatching');
      if (providerRequest.kind === 'video') {
        const payload = this.withoutInternal(providerRequest);
        // OpenRouter does not advertise a generate_audio switch for H3 Max. Its
        // native soundtrack is qualified separately and checked on the result.
        if (providerRequest.model === 'minimax/hailuo-3-max') delete payload.generate_audio;
        const receipt = await client.submitVideo(payload);
        const id = String(receipt.id);
        job = await this.jobs.transition(job, receipt.status === 'completed' ? 'running' : 'running', id);
        if (receipt.status === 'completed') job = await this.jobs.terminal(job, 'succeeded', receipt);
        return job;
      }
      if (providerRequest.kind === 'audio' && this.isSpeechModel(String(providerRequest.model))) {
        const generated = await client.speech(this.withoutInternal(providerRequest));
        try {
          const directory = await mkdtemp(join(tmpdir(), 'jovita-media-'));
          try {
            const staged = await stageProviderMedia(generated.response, join(directory, 'voice.mp3'), 'audio');
            const bytes = await readFile(staged.path);
            const evidence = {
              generation_id: generated.generationId,
              audio_format: 'mp3',
              sha256: staged.sha256,
              size: staged.size,
              mime_type: staged.mimeType,
            };
            // The provider response is synchronous and cannot be downloaded again.
            // Journal the validated bytes before recording provider success so a
            // lease loss or process restart can resume persistence without a new POST.
            await this.jobs.saveAudioResult(job, bytes, evidence);
            job = await this.jobs.transition(job, 'running', generated.generationId ?? undefined);
            job = await this.jobs.terminal(job, 'succeeded', evidence);
            const micros = generated.generationId ? await client.generationCost(generated.generationId) : null;
            if (micros !== null) job = await this.jobs.measure(job, micros, 'openrouter_usage');
            return this.persistSpeechAudio(job, bytes);
          } finally { await rm(directory, { recursive: true, force: true }); }
        } catch (error) {
          // A response was already received from the paid synchronous POST.
          // Any later storage/state error is not a provider rejection and must
          // never cause the POST to be repeated. Journal evidence, when present,
          // is recovered by the next lease.
          throw new ProviderOutcomeUnknownError('Speech completed but durable finalization was interrupted', error);
        }
      }
      if (providerRequest.kind === 'transcript') return this.dispatchTranscription(job, providerRequest, client);
      if (providerRequest.kind === 'audio' && String(providerRequest.model).startsWith('google/lyria-3-')) {
        return this.dispatchLyria(job, providerRequest, client);
      }
      throw new Error('OpenRouter media route has no qualified worker implementation');
    }
    if (job.provider === 'elevenlabs') {
      const config = await this.credentials.resolve(job.environment, job.packId, 'elevenlabs');
      const client = new ElevenLabsMediaClient(this.key(config));
      const operation = this.operation(job.operationId);
      const directory = await mkdtemp(join(tmpdir(), 'jovita-media-'));
      try {
        let source: ResolvedMediaSource | undefined;
        let sourcePath: string | undefined;
        if (operation === 'separate-stems' || operation === 'score-video') {
          const kind = operation === 'score-video' ? 'video' : 'audio';
          const attachmentId = request[operation === 'score-video' ? 'source_video_attachment_id' : 'source_audio_attachment_id'];
          if (typeof attachmentId !== 'string') throw new Error('ElevenLabs source is required');
          source = await this.sources.resolve(job.ownerId, attachmentId, kind);
          sourcePath = join(directory, `source-${kind}`);
          await this.sources.downloadTo(source, sourcePath);
          await this.processing.probe(sourcePath, kind);
        }
        job = await this.jobs.transition(job, 'dispatching');
        const response = operation === 'generate'
          ? await client.compose(request)
          : operation === 'separate-stems'
            ? await client.stemSeparation(sourcePath!, source!.mimeType, Number(request.stem_count) as 2 | 6)
            : operation === 'score-video'
              ? await client.videoToMusic(sourcePath!, source!.mimeType, String(request.prompt))
              : (() => { throw new Error('ElevenLabs route has no qualified worker implementation'); })();
        if (operation === 'separate-stems') {
          job = await this.jobs.transition(job, 'running', response.headers.get('request-id') ?? undefined);
          const count = Number(request.stem_count) as 2 | 6;
          const files = await this.archives.extractStemZip(response, directory, count);
          const sourceProbe = await this.processing.probe(sourcePath!, 'audio');
          job = await this.jobs.terminal(job, 'succeeded', { stem_count: files.length, source_sha256: source!.sha256 });
          const verifiedSeconds = Math.max(1, Math.ceil(sourceProbe.durationMs / 1000));
          job = await this.jobs.measure(job, this.elevenLabsTariffMicros(job, verifiedSeconds, 'separate-stems'), 'account_tariff', this.tariffVersion(job, 'separate-stems'), verifiedSeconds);
          const assets: string[] = [];
          for (let index = 0; index < files.length; index += 1) {
            await this.processing.probe(files[index]!.path, 'audio', sourceProbe.durationMs / 1000);
            const prepared = await this.processing.prepare({ path: files[index]!.path, kind: 'audio', directory,
              expectedDurationSeconds: sourceProbe.durationMs / 1000 });
            const asset = await this.persistPrepared(job, { ...files[index]!, kind: 'audio' }, prepared, `stem-${index + 1}`);
            assets.push(String(asset.attachmentId));
          }
          return await this.jobs.assetsReady(job, assets);
        }
        try {
          const staged = await stageProviderMedia(response, join(directory, 'music.mp3'), 'audio');
          const bytes = await readFile(staged.path);
          const providerRequestId = response.headers.get('request-id') ?? response.headers.get('song-id') ?? undefined;
          const evidence = {
            provider_request_id: providerRequestId,
            audio_format: 'mp3',
            sha256: staged.sha256,
            size: staged.size,
            mime_type: staged.mimeType,
          };
          // Direct ElevenLabs audio is synchronous and cannot be fetched later.
          // Commit the bytes before terminal success; never persist a temp path as
          // the sole evidence for a paid result.
          await this.jobs.saveAudioResult(job, bytes, evidence);
          job = await this.jobs.transition(job, 'running', providerRequestId);
          job = await this.jobs.terminal(job, 'succeeded', evidence);
          return this.persistElevenLabsAudio(job, request, bytes, operation, sourcePath);
        } catch (error) {
          throw new ProviderOutcomeUnknownError('ElevenLabs audio completed but durable finalization was interrupted', error);
        }
      } finally { await rm(directory, { recursive: true, force: true }); }
    }
    throw new Error('Unsupported media provider');
  }

  private async dispatchQualifiedSpeech(job: MediaJob, request: Record<string, unknown>, generate: () => Promise<Response>): Promise<MediaJob> {
    const response = await generate();
    try {
      const directory = await mkdtemp(join(tmpdir(), 'jovita-qualified-speech-'));
      try {
        const staged = await stageProviderMedia(response, join(directory, 'voice.mp3'), 'audio');
        const bytes = await readFile(staged.path);
        const evidence = { audio_format: 'mp3', sha256: staged.sha256, size: staged.size, mime_type: staged.mimeType };
        await this.jobs.saveAudioResult(job, bytes, evidence);
        job = await this.jobs.transition(job, 'running');
        job = await this.jobs.terminal(job, 'succeeded', evidence);
        const cost = this.qualifiedSpeechCost(job, request);
        job = await this.jobs.measure(job, cost.micros, 'account_tariff', cost.version);
        return this.persistSpeechAudio(job, bytes);
      } finally { await rm(directory, { recursive: true, force: true }); }
    } catch (error) { throw new ProviderOutcomeUnknownError('Speech completed but durable finalization was interrupted', error); }
  }

  private qualifiedSpeechCost(job: MediaJob, request: Record<string, unknown>): { micros: number; version: string } {
    const tariff = job.pricingSnapshot.voiceTariff as Record<string, unknown> | undefined;
    const rate = Number(tariff?.usdMicrosPerCharacter);
    const version = String(tariff?.version ?? '');
    if (tariff?.provider !== job.provider || !Number.isSafeInteger(rate) || rate < 1 || !version || typeof request.input !== 'string') throw new Error('Qualified speech tariff is missing');
    const micros = Array.from(request.input).length * rate;
    if (!Number.isSafeInteger(micros)) throw new Error('Qualified speech tariff overflow');
    return { micros, version };
  }

  private async poll(job: MediaJob): Promise<MediaJob> {
    if (job.provider !== 'openrouter' || !job.providerRequestId) return job;
    const config = await this.credentials.resolve(job.environment, job.packId, 'openrouter');
    const client = new OpenRouterMediaClient(this.key(config));
    const begun = await this.jobs.beginPoll(job); job = begun.job;
    const status = await client.videoStatus(job.providerRequestId);
    if (status.status === 'completed') {
      job = await this.jobs.terminal(job, 'succeeded', status);
      return this.measureCompletedVideo(job, status, client);
    }
    if (['failed', 'cancelled', 'expired'].includes(String(status.status))) {
      const state = status.status === 'cancelled' ? 'cancelled' : 'failed';
      job = await this.jobs.terminal(job, state, status);
      const micros = openRouterMediaCost(status);
      if (micros !== null) job = await this.jobs.measure(job, micros, 'openrouter_usage');
      return job;
    }
    return this.jobs.finishPoll(job);
  }

  private async persist(job: MediaJob, request: Record<string, unknown>): Promise<MediaJob> {
    if (job.assetState === 'ready') return job;
    if (job.provider !== 'openrouter' || !job.providerRequestId) throw new Error('Completed provider result is not downloadable');
    const config = await this.credentials.resolve(job.environment, job.packId, 'openrouter');
    const client = new OpenRouterMediaClient(this.key(config));
    const directory = await mkdtemp(join(tmpdir(), 'jovita-media-'));
    try {
      const staged = await stageProviderMedia(await client.videoContent(job.providerRequestId), join(directory, 'video.mp4'), 'video');
      if (request.model === 'bytedance/seedance-2.5' && typeof request.source_video_attachment_id === 'string') {
        const source = await this.sources.resolve(job.ownerId, request.source_video_attachment_id, 'video');
        const sourcePath = join(directory, 'source-video');
        await this.sources.downloadTo(source, sourcePath);
        const continuationPrepared = await this.processing.prepare({ path: staged.path, kind: 'video', directory,
          expectedDurationSeconds: Number(request.duration) });
        const continuationPath = continuationPrepared.originalIsPlayback ? staged.path : continuationPrepared.playback!.path;
        await this.uploads.storeWorkerOutput(job.ownerId, {
          ...(continuationPrepared.originalIsPlayback ? { ...staged, fileName: 'continuation.mp4', kind: 'video' as const } : continuationPrepared.playback!),
          sourceKey: `${job.jobId}:continuation`,
        });
        const joined = await this.processing.appendVideos(sourcePath, continuationPath, directory);
        const prepared = await this.processing.prepare({ path: joined.file.path, kind: 'video', directory,
          expectedDurationSeconds: (joined.originalDurationMs + joined.continuationDurationMs) / 1000 });
        const asset = await this.persistPrepared(job, { ...joined.file, kind: 'video' }, prepared);
        return this.jobs.assetsReady(job, [String(asset.attachmentId)]);
      }
      let expectedDuration: number | undefined;
      let expectedDimensions: { width?: number; height?: number } | undefined;
      if (request.model === 'runway/aleph-2' && typeof request.source_video_attachment_id === 'string') {
        const source = await this.sources.resolve(job.ownerId, request.source_video_attachment_id, 'video');
        const sourcePath = join(directory, 'remix-source-video');
        await this.sources.downloadTo(source, sourcePath);
        const sourceProbe = await this.processing.probe(sourcePath, 'video');
        expectedDuration = sourceProbe.durationMs / 1000;
        expectedDimensions = { width: sourceProbe.width, height: sourceProbe.height };
      } else if (request.model === 'heygen/avatar-iv' && typeof request.source_audio_attachment_id === 'string') {
        const source = await this.sources.resolve(job.ownerId, request.source_audio_attachment_id, 'audio');
        const sourcePath = join(directory, 'lip-sync-source-audio');
        await this.sources.downloadTo(source, sourcePath);
        expectedDuration = (await this.processing.probe(sourcePath, 'audio')).durationMs / 1000;
      } else if (request.duration !== undefined) {
        expectedDuration = Number(request.duration);
      }
      const output = request.model === 'minimax/hailuo-3-max' && request.generate_audio === false
        ? await this.processing.stripVideoAudio(staged.path, directory) : staged;
      const prepared = await this.processing.prepare({ path: output.path, kind: 'video', directory,
        ...(expectedDuration !== undefined ? { expectedDurationSeconds: expectedDuration } : {}) });
      if (request.model === 'minimax/hailuo-3-max' && request.generate_audio === true && !prepared.metadata.hasAudio) {
        throw new MediaOutputValidationError('H3_AUDIO_MISSING', 'H3 Max returned a video without the requested audio track');
      }
      if (expectedDimensions && (prepared.metadata.width !== expectedDimensions.width
        || prepared.metadata.height !== expectedDimensions.height)) {
        throw new Error('Video remix changed the source canvas unexpectedly');
      }
      const asset = await this.persistPrepared(job, { ...output,
        fileName: output.mimeType === 'video/webm' ? 'video.webm' : 'video.mp4', kind: 'video' }, prepared);
      return this.jobs.assetsReady(job, [String(asset.attachmentId)]);
    } finally { await rm(directory, { recursive: true, force: true }); }
  }

  private async measureCompletedVideo(
    job: MediaJob,
    evidence: Record<string, unknown> | undefined,
    existingClient?: OpenRouterMediaClient,
  ): Promise<MediaJob> {
    if (job.providerCostMicros !== null && job.providerCostMicros !== undefined) return job;
    const terminal = evidence ?? {};
    let micros = openRouterMediaCost(terminal);
    if (micros === null) {
      const generationId = typeof terminal.generation_id === 'string' ? terminal.generation_id.trim() : '';
      if (!generationId) throw new Error('Completed video response has no cost or generation identity');
      let client = existingClient;
      if (!client) {
        const config = await this.credentials.resolve(job.environment, job.packId, 'openrouter');
        client = new OpenRouterMediaClient(this.key(config));
      }
      micros = await client.generationCost(generationId);
    }
    if (micros === null) throw new Error('Completed video cost is not available yet');
    return this.jobs.measure(job, micros, 'openrouter_usage');
  }

  private async recoverSynchronousPersistence(job: MediaJob, request: Record<string, unknown>): Promise<MediaJob> {
    if ((job.assetState === 'ready' && job.providerCostMicros !== null)
      || (job.assetState === 'failed' && job.failureCode !== 'PROVIDER_RESULT_PERSISTENCE_LOST')) return job;
    if (job.packId === 'voice-studio' && job.operationId === 'speak-auto' && job.provider === 'elevenlabs') {
      const saved = await this.jobs.readAudioResult(job);
      if (saved) {
        if (job.providerCostMicros === null) {
          const cost = this.qualifiedSpeechCost(job, request);
          job = await this.jobs.measure(job, cost.micros, 'account_tariff', cost.version);
        }
        if (job.assetState === 'ready') return job;
        return this.persistSpeechAudio(job, saved.bytes);
      }
      if (job.providerCostMicros === null) {
        const cost = this.qualifiedSpeechCost(job, request);
        job = await this.jobs.measure(job, cost.micros, 'account_tariff', cost.version);
      }
      return this.jobs.assetFailed(job, 'PROVIDER_RESULT_PERSISTENCE_LOST');
    }
    if (this.isRecoverableOpenRouterAudio(job)) {
      const saved = await this.jobs.readAudioResult(job);
      if (saved) {
        if (job.providerCostMicros === null) {
          let micros = openRouterMediaCost(saved.evidence);
          if (micros === null && job.providerRequestId) {
            const config = await this.credentials.resolve(job.environment, job.packId, 'openrouter');
            micros = await new OpenRouterMediaClient(this.key(config)).generationCost(job.providerRequestId);
          }
          if (micros !== null) job = await this.jobs.measure(job, micros, 'openrouter_usage');
        }
        if (job.assetState === 'ready') return job;
        return job.model.startsWith('google/lyria-3-')
          ? this.persistLyriaAudio(job, request, saved.bytes, String(saved.evidence.audio_format))
          : this.persistSpeechAudio(job, saved.bytes);
      }
    }
    if (job.provider === 'elevenlabs' && ['generate', 'score-video'].includes(this.operation(job.operationId))) {
      const saved = await this.jobs.readAudioResult(job);
      if (saved) {
        if (job.assetState === 'ready') return job;
        const operation = this.operation(job.operationId);
        if (operation === 'generate') return this.persistElevenLabsAudio(job, request, saved.bytes, operation);
        const sourceId = request.source_video_attachment_id;
        if (typeof sourceId !== 'string') throw new ProviderOutcomeUnknownError('Video score source evidence is unavailable');
        const source = await this.sources.resolve(job.ownerId, sourceId, 'video');
        const directory = await mkdtemp(join(tmpdir(), 'jovita-eleven-recovery-'));
        try {
          const sourcePath = join(directory, 'source-video');
          await this.sources.downloadTo(source, sourcePath);
          return await this.persistElevenLabsAudio(job, request, saved.bytes, operation, sourcePath);
        } finally { await rm(directory, { recursive: true, force: true }); }
      }
    }
    // Synchronous audio responses cannot be fetched a second time. If the
    // worker crashes after receiving bytes but before durable persistence,
    // preserve the known provider cost and settle cost-only; never repeat the
    // paid POST.
    if (job.provider === 'openrouter' && job.providerRequestId && job.providerCostMicros === null) {
      const config = await this.credentials.resolve(job.environment, job.packId, 'openrouter');
      const micros = await new OpenRouterMediaClient(this.key(config)).generationCost(job.providerRequestId);
      if (micros === null) return this.jobs.release(job, 30_000);
      job = await this.jobs.measure(job, micros, 'openrouter_usage');
    }
    if (job.provider === 'elevenlabs' && job.providerCostMicros === null) {
      const operation = this.operation(job.operationId);
      let duration = Number(request.duration);
      if (operation === 'separate-stems' || operation === 'score-video') {
        const sourceId = request[operation === 'score-video' ? 'source_video_attachment_id' : 'source_audio_attachment_id'];
        if (typeof sourceId !== 'string') throw new ProviderOutcomeUnknownError('ElevenLabs source evidence is unavailable');
        const kind = operation === 'score-video' ? 'video' : 'audio';
        const source = await this.sources.resolve(job.ownerId, sourceId, kind);
        const directory = await mkdtemp(join(tmpdir(), 'jovita-eleven-recovery-'));
        try {
          const path = join(directory, 'source');
          await this.sources.downloadTo(source, path);
          duration = Math.max(1, Math.ceil((await this.processing.probe(path, kind)).durationMs / 1000));
        } finally { await rm(directory, { recursive: true, force: true }); }
      }
      job = await this.jobs.measure(job, this.elevenLabsTariffMicros(job, duration, operation),
        'account_tariff', this.tariffVersion(job, operation), duration);
    }
    return this.jobs.assetFailed(job, 'PROVIDER_RESULT_PERSISTENCE_LOST');
  }

  private isRecoverableOpenRouterAudio(job: MediaJob): boolean {
    return job.provider === 'openrouter'
      && (job.model.startsWith('google/lyria-3-') || this.isSpeechModel(job.model));
  }

  private isRecoverableSynchronousAudio(job: MediaJob): boolean {
    return this.isRecoverableOpenRouterAudio(job)
      || (job.provider === 'elevenlabs' && job.packId === 'voice-studio' && job.operationId === 'speak-auto')
      || (job.provider === 'elevenlabs' && ['generate', 'score-video'].includes(this.operation(job.operationId)));
  }

  private savedAudioResultId(evidence: Record<string, unknown>): string | undefined {
    const value = evidence.generation_id ?? evidence.provider_request_id ?? evidence.id;
    return typeof value === 'string' && value.trim() ? value : undefined;
  }

  private async persistSpeechAudio(job: MediaJob, bytes: Buffer): Promise<MediaJob> {
    const directory = await mkdtemp(join(tmpdir(), 'jovita-voice-'));
    try {
      const response = new Response(Uint8Array.from(bytes), {
        headers: { 'content-type': 'audio/mpeg', 'content-length': String(bytes.length) },
      });
      const staged = await stageProviderMedia(response, join(directory, 'voice.mp3'), 'audio');
      const prepared = await this.processing.prepare({ path: staged.path, kind: 'audio', directory });
      const asset = await this.persistPrepared(job, { ...staged, fileName: 'voice.mp3', kind: 'audio' }, prepared);
      return this.jobs.assetsReady(job, [String(asset.attachmentId)]);
    } finally { await rm(directory, { recursive: true, force: true }); }
  }

  private async persistElevenLabsAudio(
    job: MediaJob,
    request: Record<string, unknown>,
    bytes: Buffer,
    operation: string,
    sourcePath?: string,
  ): Promise<MediaJob> {
    const directory = await mkdtemp(join(tmpdir(), 'jovita-eleven-audio-'));
    try {
      const response = new Response(Uint8Array.from(bytes), {
        headers: { 'content-type': 'audio/mpeg', 'content-length': String(bytes.length) },
      });
      const staged = await stageProviderMedia(response, join(directory, 'music.mp3'), 'audio');
      const expectedDuration = operation === 'score-video'
        ? (sourcePath ? (await this.processing.probe(sourcePath, 'video')).durationMs / 1000 : Number(request.duration))
        : Number(request.duration);
      const prepared = await this.processing.prepare({
        path: staged.path,
        kind: 'audio',
        directory,
        expectedDurationSeconds: expectedDuration,
      });
      const verifiedSeconds = Math.max(1, Math.ceil(prepared.metadata.durationMs / 1000));
      if (job.providerCostMicros === null) {
        job = await this.jobs.measure(
          job,
          this.elevenLabsTariffMicros(job, verifiedSeconds, operation),
          'account_tariff',
          this.tariffVersion(job, operation),
          verifiedSeconds,
        );
      }
      const asset = await this.persistPrepared(job, { ...staged, fileName: 'music.mp3', kind: 'audio' }, prepared);
      return this.jobs.assetsReady(job, [String(asset.attachmentId)]);
    } finally { await rm(directory, { recursive: true, force: true }); }
  }

  private async dispatchTranscription(job: MediaJob, request: Record<string, unknown>, client: OpenRouterMediaClient): Promise<MediaJob> {
    const generated = await client.transcribe(this.withoutInternal(request));
    job = await this.jobs.transition(job, 'running', generated.generationId ?? undefined);
    job = await this.jobs.terminal(job, 'succeeded', generated.body);
    const micros = openRouterMediaCost(generated.body)
      ?? (generated.generationId ? await client.generationCost(generated.generationId) : null);
    if (micros !== null) {
      const usageSeconds = Math.max(1, Math.ceil(Number((generated.body.usage as Record<string, unknown> | undefined)?.seconds ?? generated.body.duration ?? 1)));
      job = await this.jobs.measure(job, micros, 'openrouter_usage', undefined, usageSeconds);
    }
    const outputFormat = String(request.transcript_output_format ?? 'txt');
    const directory = await mkdtemp(join(tmpdir(), 'jovita-transcript-'));
    try {
      const rendered = this.renderTranscript(generated.body, outputFormat);
      const extension = outputFormat;
      const path = join(directory, `transcript.${extension}`);
      await writeFile(path, rendered, { flag: 'wx', mode: 0o600 });
      const details = await stat(path);
      const sha256 = createHash('sha256').update(rendered).digest('hex');
      const mimeType = outputFormat === 'json' ? 'application/json'
        : outputFormat === 'vtt' ? 'text/vtt'
          : outputFormat === 'srt' ? 'application/x-subrip' : 'text/plain';
      const asset = await this.uploads.storeWorkerOutput(job.ownerId, {
        path, fileName: `transcript.${extension}`, mimeType, kind: 'document', size: details.size, sha256,
        sourceKey: `${job.jobId}:transcript`,
      });
      return this.jobs.assetsReady(job, [String(asset.attachmentId)]);
    } finally { await rm(directory, { recursive: true, force: true }); }
  }

  private async dispatchLyria(job: MediaJob, request: Record<string, unknown>, client: OpenRouterMediaClient): Promise<MediaJob> {
    const prompt = this.musicPrompt(request);
    const generated = await client.music({
      model: request.model,
      messages: [{ role: 'user', content: prompt }],
      modalities: ['text', 'audio'],
      audio: { format: 'pcm16' },
      stream: true,
      stream_options: { include_usage: true },
    });
    const resultId = generated.generationId ?? (typeof generated.body.id === 'string' ? generated.body.id : undefined);
    // Commit raw bytes BEFORE terminal state, validation, transcoding or attachment storage.
    const evidence = { ...generated.body, ...(resultId ? { id: resultId } : {}), audio_format: 'pcm16' };
    await this.jobs.saveAudioResult(job, generated.bytes, evidence);
    job = await this.jobs.transition(job, 'running', resultId);
    job = await this.jobs.terminal(job, 'succeeded', evidence);
    const micros = openRouterMediaCost(generated.body)
      ?? (resultId ? await client.generationCost(resultId) : null);
    if (micros !== null) job = await this.jobs.measure(job, micros, 'openrouter_usage');
    return this.persistLyriaAudio(job, request, generated.bytes, 'pcm16');
  }

  private async persistLyriaAudio(job: MediaJob, request: Record<string, unknown>, bytes: Buffer, format: string): Promise<MediaJob> {
    const audio = normalizeLyriaAudio(bytes, format);
    const directory = await mkdtemp(join(tmpdir(), 'jovita-music-'));
    try {
      const response = new Response(Uint8Array.from(audio.bytes), { headers: { 'content-type': audio.mimeType, 'content-length': String(audio.bytes.length) } });
      const staged = await stageProviderMedia(response, join(directory, audio.fileName), 'audio');
      const expected = Number(request.duration);
      const actual = await this.processing.probe(staged.path, 'audio');
      let output = { ...staged, fileName: audio.fileName, kind: 'audio' as const };
      let role = 'original';
      if (Number.isFinite(expected) && Math.abs(actual.durationMs / 1000 - expected) > Math.max(2, expected * 0.1)) {
        if (request.instrumental !== true || request.lyrics) {
          // Deterministic failure: keep the journal, settle cost-only, and do not process the same bytes forever.
          return this.jobs.assetFailed(job, 'MEDIA_DURATION_REQUIRES_EDIT');
        }
        // Keep the full provider original privately as well as in the recovery journal.
        await this.uploads.storeWorkerOutput(job.ownerId, { ...output, sourceKey: `${job.jobId}:provider-original` });
        if (actual.durationMs >= expected * 1000) {
          output = { ...await this.processing.instrumentalExcerpt(staged.path, directory, expected), kind: 'audio' };
          role = 'instrumental-excerpt-v1';
        } else if (request.loop_to_duration === true) {
          output = { ...await this.processing.loopInstrumentalToDuration(staged.path, directory, expected), kind: 'audio' };
          role = 'instrumental-loop-v1';
        } else {
          return this.jobs.assetFailed(job, 'MEDIA_DURATION_REQUIRES_EDIT');
        }
      }
      const prepared = await this.processing.prepare({ path: output.path, kind: 'audio', directory,
        expectedDurationSeconds: expected });
      const asset = await this.persistPrepared(job, output, prepared, role);
      return this.jobs.assetsReady(job, [String(asset.attachmentId)]);
    } finally { await rm(directory, { recursive: true, force: true }); }
  }

  private async materializeTranscriptionRequest(job: MediaJob, request: Record<string, unknown>): Promise<Record<string, unknown>> {
    const sourceField = request.source_audio_attachment_id !== undefined ? 'source_audio_attachment_id' : 'source_video_attachment_id';
    const expected = sourceField === 'source_audio_attachment_id' ? 'audio' : 'video';
    const sourceId = request[sourceField];
    if (typeof sourceId !== 'string') throw new Error('Invalid transcription source');
    const source = await this.sources.resolve(job.ownerId, sourceId, expected);
    const directory = await mkdtemp(join(tmpdir(), 'jovita-transcription-input-'));
    try {
      const inputPath = join(directory, expected === 'audio' ? 'source-audio' : 'source-video');
      const flacPath = join(directory, 'source.flac');
      await this.sources.downloadTo(source, inputPath);
      const normalized = await this.processing.transcriptionInput(inputPath, flacPath);
      if (normalized.size > 24 * 1024 * 1024) throw new Error('Normalized transcription input exceeds provider limits');
      const bytes = await readFile(flacPath);
      const timestamps = String(request.timestamps ?? 'segment');
      return {
        kind: 'transcript',
        route_id: request.route_id,
        model: request.model,
        input_audio: { data: bytes.toString('base64'), format: 'flac' },
        response_format: 'verbose_json',
        timestamp_granularities: timestamps === 'word' ? ['segment', 'word'] : timestamps === 'segment' ? ['segment'] : [],
        provider: { options: { deepgram: {
          diarize: request.diarize === true, smart_format: true, punctuate: true, detect_language: request.language === undefined,
        } } },
        ...(request.language ? { language: request.language } : {}),
        transcript_output_format: request.output_format,
      };
    } finally { await rm(directory, { recursive: true, force: true }); }
  }

  private async settle(job: MediaJob): Promise<void> {
    if (job.billingState === 'settled') return;
    if (job.providerCostMicros === null) { await this.jobs.release(job, 30_000); return; }
    if (job.providerState === 'succeeded' && job.assetState === 'ready' && job.deliveryState === 'pending') {
      if (!job.deliveryDeadlineAt || job.deliveryDeadlineAt.getTime() > Date.now()) {
        await this.jobs.waitForDelivery(job);
        return;
      }
      job = await this.jobs.deliveryFailed(job);
    }
    const delivered = job.providerState === 'succeeded' && job.assetState === 'ready' && job.deliveryState === 'delivered';
    await this.invocations.settleDeferredCall({ invocationId: job.invocationId, callId: job.callId, jobId: job.jobId,
      providerOutcome: job.providerState === 'succeeded' ? 'succeeded' : 'failed', deliveryStatus: delivered ? 'acknowledged' : job.providerState === 'succeeded' ? 'failed' : 'not_required',
      providerCostMicros: job.providerCostMicros, quantity: delivered ? Number(job.billableQuantity ?? 1) : 0, providerRequestId: job.providerRequestId,
      costSource: job.costSource === 'account_tariff' ? 'account_tariff' : 'provider_usage',
      tariffVersion: job.tariffVersion,
      billableQuantity: job.billableQuantity,
      billableUnit: job.billableUnit,
      executionOutcome: delivered ? 'succeeded' : job.providerState === 'cancelled' ? 'cancelled' : 'failed' });
    job = await this.jobs.settled(job, `miniapp:${job.invocationId}:media:${job.jobId}`);
    await this.jobs.release(job).catch(() => undefined);
  }

  private async processDialogue(job: MediaJob, request: Record<string, unknown>): Promise<MediaJob> {
    if (job.provider !== 'openrouter' || request.model !== 'fish-audio/s2.1-pro') throw new Error('Invalid dialogue route');
    const speakers = Array.isArray(request.speakers) ? request.speakers as Record<string, unknown>[] : [];
    const segments = Array.isArray(request.segments) ? request.segments as Record<string, unknown>[] : [];
    if (speakers.length < 2 || speakers.length > 4 || segments.length < 2 || segments.length > 40) throw new Error('Invalid dialogue plan');
    const voiceBySpeaker = new Map<string, string>();
    for (const speaker of speakers) {
      const id = String(speaker.id ?? '');
      const voice = String(speaker.voice ?? '');
      if (!id || !/^voice_[a-f0-9-]{36}$/i.test(voice) || voiceBySpeaker.has(id)) throw new Error('Invalid dialogue speaker');
      voiceBySpeaker.set(id, voice);
      // Resolve every reference before the first paid segment is dispatched.
      await this.voices.resolveForSynthesis(job.ownerId, voice);
    }
    const config = await this.credentials.resolve(job.environment, job.packId, 'openrouter');
    const client = new OpenRouterMediaClient(this.key(config));
    if (!(await client.discover('speech')).some(model => model.id === request.model)
      || !(await client.modelEndpoints(String(request.model))).some(endpoint => endpoint.supports_voice_cloning === true)) {
      throw new Error('Dialogue voice-cloning route is currently unavailable');
    }
    if (job.providerState === 'queued') {
      job = await this.jobs.transition(job, 'dispatching');
      job = await this.jobs.transition(job, 'running');
    }
    if (job.providerState !== 'running') return job;
    for (let index = 0; index < segments.length; index += 1) {
      const segment = segments[index]!;
      const speakerId = String(segment.speaker_id ?? '');
      const voiceId = voiceBySpeaker.get(speakerId);
      const input = String(segment.text ?? '').trim();
      if (!voiceId || !input || input.length > 2_000 || Number(segment.index) !== index) throw new Error('Invalid dialogue segment');
      const stepId = `segment-${String(index).padStart(2, '0')}`;
      let step = await this.steps.ensure({
        jobId: job.jobId, stepId, ownerId: job.ownerId, type: 'speech-segment', provider: 'openrouter',
        operation: 'dialogue', routeId: String(request.route_id), request: { model: request.model, input, saved_voice_id: voiceId, response_format: 'mp3' },
      });
      if (step.state === 'dispatching') {
        await this.steps.unknown(step);
        throw new ProviderOutcomeUnknownError('A dialogue segment dispatch was interrupted and will not be repeated');
      }
      if (step.state === 'unknown') throw new ProviderOutcomeUnknownError('A dialogue segment has an unknown provider outcome');
      if (step.state === 'pending_provider' || step.state === 'provider_succeeded') {
        if (!step.providerRequestId) throw new ProviderOutcomeUnknownError('A dialogue segment result was lost without a provider identity');
        if (step.providerCostMicros === null || step.providerCostMicros === undefined) {
          const cost = await client.generationCost(step.providerRequestId);
          if (cost === null) throw new ProviderOutcomeUnknownError('Dialogue segment cost evidence is pending');
          step = await this.steps.recordCost(step, { providerCostMicros: cost, costSource: 'openrouter_usage' });
        }
        step = await this.steps.failed(step, { code: 'SYNCHRONOUS_RESULT_PERSISTENCE_LOST' });
      }
      if (step.state === 'failed' || step.state === 'cancelled') {
        const partial = await this.steps.aggregate(job.jobId);
        if (!partial.complete) throw new ProviderOutcomeUnknownError('Dialogue segment cost evidence is incomplete');
        job = await this.jobs.terminal(job, 'failed', { code: 'DIALOGUE_SEGMENT_FAILED', step_id: stepId });
        return this.jobs.measure(job, partial.providerCostMicros, 'openrouter_usage');
      }
      if (step.state === 'persisted') {
        if ((step.providerCostMicros === null || step.providerCostMicros === undefined) && step.providerRequestId) {
          const cost = await client.generationCost(step.providerRequestId);
          if (cost === null) throw new ProviderOutcomeUnknownError('Dialogue segment cost evidence is pending');
          await this.steps.recordCost(step, { providerCostMicros: cost, costSource: 'openrouter_usage' });
        }
        continue;
      }
      step = await this.steps.beginDispatch(step);
      let generated: Awaited<ReturnType<OpenRouterMediaClient['speech']>>;
      try {
        const payload = await this.materializeSpeechRequest(job, { model: request.model, input, saved_voice_id: voiceId, response_format: 'mp3' });
        generated = await client.speech(payload);
      } catch (error) {
        if (step.state === 'dispatching') await this.steps.unknown(step);
        if (error instanceof ProviderOutcomeUnknownError) throw error;
        throw new ProviderOutcomeUnknownError('Dialogue provider outcome lacks replay-safe evidence', error);
      }
      step = await this.steps.accepted(step, generated.generationId ?? undefined);
      const directory = await mkdtemp(join(tmpdir(), 'jovita-dialogue-segment-'));
      try {
        const staged = await stageProviderMedia(generated.response, join(directory, `${stepId}.mp3`), 'audio');
        step = await this.steps.providerSucceeded(step, { generation_id: generated.generationId, sha256: staged.sha256, size: staged.size });
        const cost = generated.generationId ? await client.generationCost(generated.generationId) : null;
        if (cost !== null) step = await this.steps.recordCost(step, { providerCostMicros: cost, costSource: 'openrouter_usage' });
        const asset = await this.uploads.storeWorkerOutput(job.ownerId, {
          ...staged, fileName: `${stepId}.mp3`, kind: 'audio', sourceKey: `${job.jobId}:${stepId}`,
        });
        await this.steps.persisted(step, [String(asset.attachmentId)], { sha256: staged.sha256 });
      } finally { await rm(directory, { recursive: true, force: true }); }
    }
    const aggregate = await this.steps.aggregate(job.jobId);
    if (!aggregate.complete || aggregate.assetIds.length !== segments.length) throw new ProviderOutcomeUnknownError('Dialogue segment settlement evidence is incomplete');
    job = await this.jobs.terminal(job, 'succeeded', { steps: segments.length, evidence: createHash('sha256').update(aggregate.assetIds.join('\0')).digest('hex') });
    job = await this.jobs.measure(job, aggregate.providerCostMicros, 'openrouter_usage');
    const directory = await mkdtemp(join(tmpdir(), 'jovita-dialogue-'));
    try {
      const paths: string[] = [];
      for (let index = 0; index < aggregate.assetIds.length; index += 1) {
        const source = await this.sources.resolve(job.ownerId, aggregate.assetIds[index]!, 'audio');
        const path = join(directory, `segment-${String(index).padStart(2, '0')}.mp3`);
        await this.sources.downloadTo(source, path);
        paths.push(path);
      }
      const assembled = await this.processing.assembleDialogue(paths, directory);
      const prepared = await this.processing.prepare({ path: assembled.path, kind: 'audio', directory });
      const asset = await this.persistPrepared(job, { ...assembled, kind: 'audio' }, prepared);
      return this.jobs.assetsReady(job, [String(asset.attachmentId)]);
    } finally { await rm(directory, { recursive: true, force: true }); }
  }

  private async processElevenCompound(job: MediaJob, request: Record<string, unknown>): Promise<MediaJob> {
    const operation = this.operation(job.operationId);
    if (job.provider !== 'elevenlabs' || !['extend', 'remix', 'replace-section', 'insert-section'].includes(operation)) throw new Error('Invalid compound music route');
    const sourceId = request.source_audio_attachment_id;
    if (typeof sourceId !== 'string') throw new Error('Music editing requires private source audio');
    const source = await this.sources.resolve(job.ownerId, sourceId, 'audio');
    const config = await this.credentials.resolve(job.environment, job.packId, 'elevenlabs');
    const client = new ElevenLabsMediaClient(this.key(config));
    const directory = await mkdtemp(join(tmpdir(), 'jovita-music-edit-'));
    try {
      const sourcePath = join(directory, 'source-audio');
      await this.sources.downloadTo(source, sourcePath);
      const sourceProbe = await this.processing.probe(sourcePath, 'audio');
      if (operation === 'replace-section' && (Number(request.end_ms) > sourceProbe.durationMs || Number(request.start_ms) >= Number(request.end_ms))) {
        throw new Error('Replacement section is outside the source song');
      }
      if (operation === 'insert-section' && (Number(request.insert_at_ms) > sourceProbe.durationMs || sourceProbe.durationMs + Number(request.duration) * 1000 > 600000)) {
        throw new Error('Insertion point or final song duration is invalid');
      }
      if (job.providerState === 'queued') {
        job = await this.jobs.transition(job, 'dispatching');
        job = await this.jobs.transition(job, 'running');
      }
      if (job.providerState !== 'running') return job;

      let upload = await this.steps.ensure({
        jobId: job.jobId, stepId: '01-upload', ownerId: job.ownerId, type: 'music-upload', provider: 'elevenlabs', operation,
        routeId: String(request.route_id), request: { source_sha256: source.sha256, source_size: source.size },
      });
      if (upload.state === 'dispatching' || upload.state === 'unknown') {
        if (upload.state === 'dispatching') await this.steps.unknown(upload);
        throw new ProviderOutcomeUnknownError('Music upload outcome is unknown and will not be repeated');
      }
      if (upload.state === 'queued') {
        upload = await this.steps.beginDispatch(upload);
        try {
          const receipt = await client.uploadMusic(sourcePath, source.mimeType);
          upload = await this.steps.accepted(upload, receipt.songId);
          upload = await this.steps.providerSucceeded(upload, { song_id: receipt.songId });
        } catch (error) {
          if (error instanceof ProviderOutcomeUnknownError) await this.steps.unknown(upload);
          throw error;
        }
      }
      if (['pending_provider', 'provider_succeeded'].includes(upload.state)) {
        if (!upload.providerRequestId) throw new ProviderOutcomeUnknownError('Stored music upload has no provider identity');
        const uploadSeconds = Math.max(1, Math.ceil(sourceProbe.durationMs / 1000));
        if (upload.providerCostMicros === null || upload.providerCostMicros === undefined) {
          upload = await this.steps.recordCost(upload, { providerCostMicros: this.elevenLabsTariffMicros(job, uploadSeconds, 'upload'), costSource: 'account_tariff', tariffVersion: this.tariffVersion(job, 'upload'), billableQuantity: uploadSeconds, billableUnit: 'second' });
        }
        upload = await this.steps.persisted(upload, [source.attachmentId], { song_id: upload.providerRequestId });
      }
      if (upload.state !== 'persisted' || !upload.providerRequestId) throw new Error('Music upload did not become reusable');

      const editRequest = { ...request, operation, source_duration_ms: sourceProbe.durationMs };
      let edit = await this.steps.ensure({
        jobId: job.jobId, stepId: '02-inpaint', ownerId: job.ownerId, type: 'music-inpainting', provider: 'elevenlabs', operation,
        routeId: String(request.route_id), request: editRequest,
      });
      if (edit.state === 'dispatching' || edit.state === 'unknown') {
        if (edit.state === 'dispatching') await this.steps.unknown(edit);
        throw new ProviderOutcomeUnknownError('Music edit outcome is unknown and will not be repeated');
      }
      if (edit.state === 'pending_provider' || edit.state === 'provider_succeeded') {
        const seconds = Math.max(1, Number(request.duration));
        if (edit.providerCostMicros === null || edit.providerCostMicros === undefined) {
          edit = await this.steps.recordCost(edit, { providerCostMicros: this.elevenLabsTariffMicros(job, seconds, operation), costSource: 'account_tariff', tariffVersion: this.tariffVersion(job, operation), billableQuantity: seconds, billableUnit: 'second' });
        }
        edit = await this.steps.failed(edit, { code: 'SYNCHRONOUS_RESULT_PERSISTENCE_LOST' });
      }
      if (edit.state === 'failed' || edit.state === 'cancelled') {
        const aggregate = await this.steps.aggregate(job.jobId);
        if (!aggregate.complete || !Number.isSafeInteger(aggregate.billableQuantity) || aggregate.billableQuantity < 1) throw new ProviderOutcomeUnknownError('Music edit settlement evidence is incomplete');
        job = await this.jobs.terminal(job, 'failed', { code: 'MUSIC_EDIT_RESULT_LOST' });
        return this.jobs.measure(job, aggregate.providerCostMicros, 'account_tariff', this.tariffVersion(job, operation), aggregate.billableQuantity);
      }
      if (edit.state === 'persisted') {
        const aggregate = await this.steps.aggregate(job.jobId);
        if (!aggregate.complete || edit.assetIds.length !== 1 || !Number.isSafeInteger(aggregate.billableQuantity) || aggregate.billableQuantity < 1) throw new ProviderOutcomeUnknownError('Music edit evidence is incomplete');
        job = await this.jobs.terminal(job, 'succeeded', { steps: 2, output: edit.assetIds[0] });
        job = await this.jobs.measure(job, aggregate.providerCostMicros, 'account_tariff', this.tariffVersion(job, operation), aggregate.billableQuantity);
        return this.jobs.assetsReady(job, edit.assetIds);
      }
      edit = await this.steps.beginDispatch(edit);
      let response: Response;
      try { response = await client.inpaint(upload.providerRequestId, editRequest); }
      catch (error) { if (error instanceof ProviderOutcomeUnknownError) await this.steps.unknown(edit); throw error; }
      edit = await this.steps.accepted(edit, response.headers.get('request-id') ?? undefined);
      const staged = await stageProviderMedia(response, join(directory, 'edited-music.mp3'), 'audio');
      edit = await this.steps.providerSucceeded(edit, { sha256: staged.sha256, size: staged.size });
      const expectedDuration = ['extend', 'insert-section'].includes(operation) ? sourceProbe.durationMs / 1000 + Number(request.duration) : operation === 'replace-section' ? sourceProbe.durationMs / 1000 : Number(request.duration);
      const prepared = await this.processing.prepare({ path: staged.path, kind: 'audio', directory, expectedDurationSeconds: expectedDuration });
      const billedSeconds = Math.max(1, Number(request.duration));
      edit = await this.steps.recordCost(edit, { providerCostMicros: this.elevenLabsTariffMicros(job, billedSeconds, operation), costSource: 'account_tariff', tariffVersion: this.tariffVersion(job, operation), billableQuantity: billedSeconds, billableUnit: 'second' });
      const asset = await this.persistPrepared(job, { ...staged, fileName: 'edited-music.mp3', kind: 'audio' }, prepared, 'edit');
      edit = await this.steps.persisted(edit, [String(asset.attachmentId)], { sha256: staged.sha256 });
      const aggregate = await this.steps.aggregate(job.jobId);
      if (!aggregate.complete || !Number.isSafeInteger(aggregate.billableQuantity) || aggregate.billableQuantity < 1) throw new ProviderOutcomeUnknownError('Music edit cost evidence is incomplete');
      job = await this.jobs.terminal(job, 'succeeded', { steps: 2, output: asset.attachmentId });
      job = await this.jobs.measure(job, aggregate.providerCostMicros, 'account_tariff', this.tariffVersion(job, operation), aggregate.billableQuantity);
      return this.jobs.assetsReady(job, [String(asset.attachmentId)]);
    } finally { await rm(directory, { recursive: true, force: true }); }
  }

  private renderTranscript(body: Record<string, unknown>, format: string): Buffer {
    const text = typeof body.text === 'string' ? body.text.trim() : '';
    if (!text || Buffer.byteLength(text) > 2 * 1024 * 1024) throw new Error('Provider transcript is empty or oversized');
    const segments = Array.isArray(body.segments) ? body.segments.map(value => value as Record<string, unknown>) : [];
    if (format === 'json') return Buffer.from(`${JSON.stringify({ text, language: body.language, duration: body.duration, segments, words: body.words }, null, 2)}\n`);
    if (format === 'txt') return Buffer.from(`${text}\n`);
    if (!segments.length) throw new Error('Timed transcript output requires segment timestamps');
    const cue = segments.map((segment, index) => {
      const start = Number(segment.start); const end = Number(segment.end); const value = String(segment.text ?? '').trim();
      if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || !value) throw new Error('Provider returned invalid transcript timestamps');
      return `${format === 'srt' ? `${index + 1}\n` : ''}${this.timestamp(start, format)} --> ${this.timestamp(end, format)}\n${value}`;
    }).join('\n\n');
    return Buffer.from(format === 'vtt' ? `WEBVTT\n\n${cue}\n` : `${cue}\n`);
  }

  private timestamp(seconds: number, format: string): string {
    const ms = Math.max(0, Math.round(seconds * 1000));
    const hours = Math.floor(ms / 3_600_000);
    const minutes = Math.floor((ms % 3_600_000) / 60_000);
    const secs = Math.floor((ms % 60_000) / 1000);
    const millis = ms % 1000;
    const separator = format === 'srt' ? ',' : '.';
    return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}${separator}${String(millis).padStart(3, '0')}`;
  }

  private musicPrompt(request: Record<string, unknown>): string {
    const prompt = String(request.prompt ?? '').trim();
    if (!prompt) throw new Error('Music prompt is required');
    const duration = Number(request.duration);
    const lyrics = typeof request.lyrics === 'string' ? request.lyrics.trim() : '';
    const mode = request.instrumental === false ? 'Include original vocals.' : 'Instrumental only; do not add vocals.';
    return `${prompt}\nTarget duration: ${duration} seconds. ${mode}${lyrics ? `\nAuthorized lyrics:\n${lyrics}` : ''}`;
  }

  private async materializeVideoRequest(job: MediaJob, request: Record<string, unknown>): Promise<Record<string, unknown>> {
    const frames: Array<Record<string, unknown>> = [];
    for (const [field, frameType] of [
      ['first_frame_attachment_id', 'first_frame'],
      ['last_frame_attachment_id', 'last_frame'],
    ] as const) {
      const attachmentId = request[field];
      if (attachmentId === undefined) continue;
      if (typeof attachmentId !== 'string') throw new Error('Invalid video frame attachment');
      const source = await this.sources.resolve(job.ownerId, attachmentId, 'image');
      await this.validateProviderSource(source, 'image', String(request.model));
      frames.push({ type: 'image_url', image_url: { url: source.url }, frame_type: frameType });
    }
    const references: Array<Record<string, unknown>> = [];
    for (const [field, kind, type, property] of [
      ['source_video_attachment_id', 'video', 'video_url', 'video_url'],
      ['source_image_attachment_id', 'image', 'image_url', 'image_url'],
      ['source_audio_attachment_id', 'audio', 'audio_url', 'audio_url'],
    ] as const) {
      const attachmentId = request[field];
      if (attachmentId === undefined) continue;
      if (typeof attachmentId !== 'string') throw new Error('Invalid video reference attachment');
      const source = await this.sources.resolve(job.ownerId, attachmentId, kind);
      await this.validateProviderSource(source, kind, String(request.model));
      references.push({ type, [property]: { url: source.url } });
    }
    const guideIds = request.reference_attachment_ids;
    if (guideIds !== undefined) {
      if (!Array.isArray(guideIds) || guideIds.length < 1 || guideIds.length > 4 || frames.length) {
        throw new Error('Invalid video guide references');
      }
      for (const entry of guideIds) {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error('Invalid video guide reference');
        const row = entry as Record<string, unknown>;
        if (row.kind !== 'image' && row.kind !== 'video') throw new Error('Invalid video guide kind');
        if (typeof row.attachment_id !== 'string') throw new Error('Invalid video guide attachment');
        const kind = row.kind;
        const source = await this.sources.resolve(job.ownerId, row.attachment_id, kind);
        await this.validateProviderSource(source, kind, String(request.model));
        const property = kind === 'image' ? 'image_url' : 'video_url';
        references.push({ type: property, [property]: { url: source.url } });
      }
    }
    const keyframeIds = request.keyframe_attachment_ids;
    let providerKeyframes: Array<{ uri: string; at: number }> = [];
    if (keyframeIds !== undefined) {
      if (!Array.isArray(keyframeIds) || keyframeIds.length > 5) throw new Error('Invalid video keyframes');
      for (let index = 0; index < keyframeIds.length; index += 1) {
        const row = keyframeIds[index];
        if (!row || typeof row !== 'object' || Array.isArray(row)) throw new Error('Invalid video keyframe');
        const attachmentId = (row as Record<string, unknown>).attachment_id;
        const at = Number((row as Record<string, unknown>).at);
        if (typeof attachmentId !== 'string' || !Number.isFinite(at) || at < 0 || at > 1) throw new Error('Invalid video keyframe');
        const source = await this.sources.resolve(job.ownerId, attachmentId, 'image');
        if (source.size > 5 * 1024 * 1024) throw new Error('A video keyframe exceeds the qualified provider limit');
        await this.validateProviderSource(source, 'image', String(request.model));
        providerKeyframes.push({ uri: source.url, at });
      }
    }
    const {
      first_frame_attachment_id: _first, last_frame_attachment_id: _last,
      source_video_attachment_id: _video, source_image_attachment_id: _image,
      source_audio_attachment_id: _audio, keyframe_attachment_ids: _keyframes,
      reference_attachment_ids: _guides,
      schema_version: _schema, output_format: _format, real_person_consent: _consent,
      audio_mode: _audioMode, ...rest
    } = request;
    return {
      ...rest,
      ...(frames.length ? { frame_images: frames } : {}),
      ...(references.length ? { input_references: references } : {}),
      ...(providerKeyframes.length ? { provider: { options: { runway: { keyframes: providerKeyframes } } } } : {}),
    };
  }

  private async validateProviderSource(source: ResolvedMediaSource, kind: 'image' | 'audio' | 'video', model: string): Promise<void> {
    const directory = await mkdtemp(join(tmpdir(), 'jovita-provider-source-'));
    try {
      const path = join(directory, 'source');
      await this.sources.downloadTo(source, path);
      if (kind === 'image') return;
      const probe = await this.processing.probe(path, kind);
      if (model === 'runway/aleph-2' && kind === 'video'
        && (source.size > 16 * 1024 * 1024 || probe.durationMs < 2_000 || probe.durationMs > 30_000)) {
        throw new Error('Aleph remix requires a 2-30 second source video within 16 MiB');
      }
      if (model === 'bytedance/seedance-2.5' && kind === 'video'
        && (probe.durationMs < 2_000 || probe.durationMs > 30_000)) {
        throw new Error('Seedance extension requires a 2-30 second source video');
      }
      if (model === 'heygen/avatar-iv' && kind === 'audio' && probe.durationMs > 600_000) {
        throw new Error('Avatar lip-sync audio cannot exceed ten minutes');
      }
    } finally { await rm(directory, { recursive: true, force: true }); }
  }

  private async materializeSpeechRequest(job: MediaJob, request: Record<string, unknown>): Promise<Record<string, unknown>> {
    const savedVoiceId = request.saved_voice_id;
    if (savedVoiceId === undefined) return request;
    if (typeof savedVoiceId !== 'string' || request.model !== 'fish-audio/s2.1-pro') throw new Error('Invalid saved voice route');
    const saved = await this.voices.resolveForSynthesis(job.ownerId, savedVoiceId);
    const source = await this.sources.resolve(job.ownerId, String(saved.reference.attachmentId), 'audio');
    if (source.size > 20 * 1024 * 1024) throw new Error('Saved voice reference exceeds the stateless route limit');
    const directory = await mkdtemp(join(tmpdir(), 'jovita-voice-ref-'));
    try {
      const path = join(directory, 'reference');
      await this.sources.downloadTo(source, path);
      const bytes = await readFile(path);
      const references: Record<string, unknown>[] = [{
        type: 'input_audio', input_audio: { data: `data:${source.mimeType};base64,${bytes.toString('base64')}` },
      }];
      if (saved.referenceTranscript) references.push({ type: 'text', text: saved.referenceTranscript });
      const { saved_voice_id: _saved, ...rest } = request;
      return { ...rest, input_references: references };
    } finally { await rm(directory, { recursive: true, force: true }); }
  }
  private async persistPrepared(
    job: MediaJob,
    original: { path: string; fileName: string; mimeType: string; kind: 'audio' | 'video'; size: number; sha256: string },
    prepared: PreparedMedia,
    sourceRole = 'original',
  ) {
    const storedOriginal = await this.uploads.storeWorkerOutput(job.ownerId, {
      ...original,
      sourceKey: `${job.jobId}:${sourceRole}`,
    });
    const playback = prepared.originalIsPlayback
      ? storedOriginal
      : await this.storeProcessed(job, prepared.playback, `${sourceRole}:playback`);
    const poster = prepared.poster ? await this.storeProcessed(job, prepared.poster, `${sourceRole}:poster`) : undefined;
    await this.uploads.publishWorkerMediaMetadata(job.ownerId, String(storedOriginal.attachmentId), {
      ...prepared.metadata,
      processingStatus: 'ready',
      playbackAttachmentId: String(playback.attachmentId),
      ...(poster ? { posterAttachmentId: String(poster.attachmentId) } : {}),
    });
    return storedOriginal;
  }
  private storeProcessed(job: MediaJob, file: ProcessedMediaFile | undefined, role: string) {
    if (!file) throw new Error(`Media processor did not create ${role}`);
    return this.uploads.storeWorkerOutput(job.ownerId, { ...file, sourceKey: `${job.jobId}:${role}` });
  }
  private assertLiveVideoRoute(request: Record<string, unknown>, catalog: Record<string, unknown>[]): void {
    const endpoint = catalog.find(item => item.id === request.model);
    if (!endpoint) throw new MediaRouteCompatibilityError('VIDEO_ROUTE_UNAVAILABLE', 'Selected video route is currently unavailable');
    const model = String(request.model);
    const resolution = String(request.resolution ?? '');
    const priceLimits: Record<string, { sku: string; maximum: number }> = {
      'bytedance/seedance-2.0-mini:480p': { sku: 'video_tokens', maximum: 0.000007 },
      'bytedance/seedance-2.0:720p': { sku: 'video_tokens', maximum: 0.000014 },
      'bytedance/seedance-2.0:1080p': { sku: 'video_tokens_1080p', maximum: 0.0000154 },
      'bytedance/seedance-2.0:4K': { sku: 'video_tokens_4k', maximum: 0.000008 },
      'bytedance/seedance-2.5:480p': { sku: 'video_tokens', maximum: 0.0000214 },
      'bytedance/seedance-2.5:720p': { sku: 'video_tokens', maximum: 0.0000214 },
      'minimax/hailuo-3:2K': { sku: 'duration_seconds', maximum: 0.30 },
      'minimax/hailuo-3-max:480p': { sku: 'duration_seconds_480p', maximum: 0.05 },
      'minimax/hailuo-3-max:768p': { sku: 'duration_seconds_768p', maximum: 0.08 },
    };
    const priceLimit = priceLimits[`${model}:${resolution}`];
    if (priceLimit) {
      const skus = endpoint.pricing_skus as Record<string, unknown> | undefined;
      const price = Number(skus?.[priceLimit.sku]);
      if (!Number.isFinite(price) || price < 0 || price > priceLimit.maximum) {
        throw new MediaRouteCompatibilityError('VIDEO_PRICE_CHANGED', 'Selected video route pricing changed; submission is paused');
      }
    }
    for (const [field, value] of [
      ['supported_durations', request.duration],
      ['supported_resolutions', request.resolution],
      ['supported_aspect_ratios', request.aspect_ratio],
    ] as const) {
      if (value !== undefined && (!Array.isArray(endpoint[field]) || !endpoint[field].includes(value))) {
        const code = field === 'supported_durations' ? 'VIDEO_DURATION_UNSUPPORTED'
          : field === 'supported_resolutions' ? 'VIDEO_RESOLUTION_UNSUPPORTED'
            : 'VIDEO_ASPECT_RATIO_UNSUPPORTED';
        throw new MediaRouteCompatibilityError(code, `Selected video route no longer supports ${field}`);
      }
    }
    // H3 Max currently advertises generate_audio=false, but its native output
    // includes a soundtrack. The exact brokered request shape has been verified;
    // persist() rejects a silent H3 result instead of delivering it as audio-on.
    if (request.generate_audio === true && endpoint.generate_audio !== true
      && model !== 'minimax/hailuo-3-max') {
      throw new MediaRouteCompatibilityError('VIDEO_AUDIO_UNSUPPORTED', 'Selected video route no longer supports generated audio');
    }
    if (request.first_frame_attachment_id !== undefined
      && (!Array.isArray(endpoint.supported_frame_images) || !endpoint.supported_frame_images.includes('first_frame'))) {
      throw new MediaRouteCompatibilityError('VIDEO_FIRST_FRAME_UNSUPPORTED', 'Selected video route no longer supports a first frame');
    }
    if (request.last_frame_attachment_id !== undefined
      && (!Array.isArray(endpoint.supported_frame_images) || !endpoint.supported_frame_images.includes('last_frame'))) {
      throw new MediaRouteCompatibilityError('VIDEO_LAST_FRAME_UNSUPPORTED', 'Selected video route no longer supports a last frame');
    }
    if (Array.isArray(request.reference_attachment_ids) && request.reference_attachment_ids.length) {
      if (!['bytedance/seedance-2.0', 'bytedance/seedance-2.5'].includes(model)) {
        throw new MediaRouteCompatibilityError('VIDEO_REFERENCE_UNSUPPORTED', 'Selected video route cannot honor guide references');
      }
      const modalities = endpoint.input_modalities;
      if (Array.isArray(modalities) && request.reference_attachment_ids.some(value => {
        const kind = value && typeof value === 'object' ? (value as Record<string, unknown>).kind : undefined;
        return typeof kind !== 'string' || !modalities.includes(kind);
      })) {
        throw new MediaRouteCompatibilityError('VIDEO_REFERENCE_UNSUPPORTED', 'Selected video route no longer supports the supplied reference type');
      }
    }
    if (model === 'runway/aleph-2' && typeof request.source_video_attachment_id !== 'string') {
      throw new Error('Aleph remix requires one source video');
    }
    if (String(request.route_id).startsWith('video-studio:extend:auto:')
      && model === 'bytedance/seedance-2.5' && typeof request.source_video_attachment_id !== 'string') {
      throw new Error('Seedance extension requires one source video');
    }
    if (model === 'heygen/avatar-iv' && (typeof request.source_image_attachment_id !== 'string'
      || typeof request.source_audio_attachment_id !== 'string')) {
      throw new Error('Avatar IV requires one portrait and one audio reference');
    }
  }
  private assertLiveSpeechRoute(request: Record<string, unknown>, catalog: Record<string, unknown>[]): void {
    const endpoint = catalog.find(item => item.id === request.model);
    if (!endpoint) throw new Error('Selected speech route is currently unavailable');
    if (Array.isArray(endpoint.supported_voices) && !endpoint.supported_voices.includes(request.voice)) {
      throw new Error('Selected speech voice is currently unavailable');
    }
  }
  private isSpeechModel(model: string) { return model.startsWith('microsoft/') || model.startsWith('minimax/') || model === 'fish-audio/s2.1-pro'; }
  private isDialogue(request: Record<string, unknown>) { return request.kind === 'audio' && request.model === 'fish-audio/s2.1-pro' && Array.isArray(request.segments); }
  private isElevenCompound(job: MediaJob, request: Record<string, unknown>) { return job.provider === 'elevenlabs' && request.kind === 'audio' && ['extend', 'remix', 'replace-section', 'insert-section'].includes(this.operation(job.operationId)); }
  private withoutInternal(request: Record<string, unknown>) {
    const { kind: _kind, route_id: _route, count: _count, transcript_output_format: _transcript, ...payload } = request;
    return payload;
  }
  private operation(operationId: string) { return operationId.split('-').slice(0, -1).join('-') || operationId; }
  private key(config: Record<string, unknown>) { if (typeof config.apiKey !== 'string' || !config.apiKey.trim()) throw new Error('Provider credential missing'); return config.apiKey; }
  private tariffVersion(job: MediaJob, operationId: string) {
    return readElevenLabsTariff(job.pricingSnapshot, operationId).version;
  }
  private elevenLabsTariffMicros(job: MediaJob, seconds: number, operationId: string) {
    if (!Number.isFinite(seconds) || seconds <= 0) throw new Error(`Invalid ElevenLabs billing quantity for ${operationId}`);
    const tariff = readElevenLabsTariff(job.pricingSnapshot, operationId);
    return Math.ceil(seconds * tariff.usdMicrosPerUnit);
  }
}
