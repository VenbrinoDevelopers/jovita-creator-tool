import { mediaReservationCredits } from './media-job.state.js';

export type MediaProfile = 'fast' | 'auto' | 'pro' | 'hd' | 'ultra';
export class MediaRouteContractError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'MediaRouteContractError';
  }
}
export const MEDIA_ROUTE_POLICY_VERSION = '2026-09-28.1';
export const VIDEO_ROUTE_MODELS = {
  fast: 'bytedance/seedance-2.0-mini', auto: 'bytedance/seedance-2.0', pro: 'bytedance/seedance-2.5',
  hd: 'bytedance/seedance-2.0', ultra: 'minimax/hailuo-3',
} as const;
export const ADVANCED_VIDEO_MODELS = {
  remix: 'runway/aleph-2',
  extend: 'bytedance/seedance-2.5',
  lipSync: 'heygen/avatar-iv',
} as const;
const VIDEO_ROUTE_DURATIONS: Readonly<Record<string, readonly number[]>> = {
  'bytedance/seedance-2.0-mini': [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
  'bytedance/seedance-2.0': [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
  // The public Studio contract remains capped at 15 seconds even though the
  // live endpoint currently advertises longer clips.
  'bytedance/seedance-2.5': [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
  'minimax/hailuo-3': [5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
  'minimax/hailuo-3-max': [5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
};
export const SPEECH_ROUTE_MODELS = {
  fast: 'microsoft/mai-voice-2-flash', auto: 'microsoft/mai-voice-2', pro: 'minimax/speech-2.8-hd',
} as const;
export const MEDIA_MODELS = {
  dialogueAuto: 'fish-audio/s2.1-pro',
  customVoice: 'fish-audio/s2.1-pro',
  transcription: 'deepgram/nova-3',
  musicFast: 'google/lyria-3-clip-preview',
  musicAuto: 'google/lyria-3-pro-preview',
  musicPro: 'music_v2',
} as const;
export const PRESET_VOICES = {
  harper: { providerId: 'en-US-Harper:MAI-Voice-2', profiles: ['fast', 'auto'], language: 'en-US', accent: 'American English' },
  valeria: { providerId: 'es-MX-Valeria:MAI-Voice-2', profiles: ['fast', 'auto'], language: 'es-MX', accent: 'Mexican Spanish' },
  soleil: { providerId: 'fr-FR-Soleil:MAI-Voice-2', profiles: ['fast', 'auto'], language: 'fr-FR', accent: 'French' },
  klaus: { providerId: 'de-DE-Klaus:MAI-Voice-2', profiles: ['fast', 'auto'], language: 'de-DE', accent: 'German' },
  narrator: { providerId: 'English_expressive_narrator', profiles: ['pro'], language: 'en', accent: 'English, region unspecified' },
  calm: { providerId: 'English_CalmWoman', profiles: ['pro'], language: 'en', accent: 'English, region unspecified' },
  storyteller: { providerId: 'English_CaptivatingStoryteller', profiles: ['pro'], language: 'en', accent: 'English, region unspecified' },
} as const;

export function curatedVoices() {
  return Object.entries(PRESET_VOICES).map(([id, voice]) => ({
    id, languages: [voice.language], locale: voice.language, accent: voice.accent,
    profiles: voice.profiles, provider: 'openrouter',
    preview: { available: false, reason: 'A verified preview has not been published' },
    qualified: true,
  }));
}

export interface QualifiedTariff {
  routeId: string;
  version: string;
  /** Maximum input AND output cost in microdollars; account-configured, not supplied by the mini-app. */
  providerCeilingMicros: number;
  qualified: boolean;
}

function profile(value: string): asserts value is MediaProfile {
  if (!['fast', 'auto', 'pro', 'hd', 'ultra'].includes(value)) throw new Error('Invalid media profile');
}
function videoRoute(selectedProfile: MediaProfile, resolution: string, characterRoute = false) {
  if (characterRoute) {
    if ((selectedProfile !== 'fast' || resolution !== '480p')
      && (selectedProfile !== 'auto' || resolution !== '768p')) {
      throw new MediaRouteContractError('VIDEO_RESOLUTION_UNSUPPORTED',
        'Character shots support Fast 480p or Standard 768p');
    }
    return 'minimax/hailuo-3-max';
  }
  const allowed: Record<MediaProfile, readonly string[]> = {
    fast: ['480p'], auto: ['720p'], pro: ['480p', '720p'],
    hd: ['1080p'], ultra: ['2K', '4K'],
  };
  if (!allowed[selectedProfile].includes(resolution)) throw new MediaRouteContractError(
    'VIDEO_RESOLUTION_UNSUPPORTED', `Selected video profile supports ${allowed[selectedProfile].join(' or ')}`,
  );
  return selectedProfile === 'ultra' && resolution === '4K' ? 'bytedance/seedance-2.0' : VIDEO_ROUTE_MODELS[selectedProfile];
}
function integer(value: unknown, minimum: number, maximum: number, name: string): number {
  if (!Number.isInteger(value) || Number(value) < minimum || Number(value) > maximum) throw new Error(`Invalid ${name}`);
  return Number(value);
}
function only(request: Record<string, unknown>, keys: string[]) {
  if (request.schema_version !== '1') throw new Error('Unsupported media schema version');
  for (const key of Object.keys(request)) if (!keys.includes(key)) throw new Error(`Unsupported media field: ${key}`);
}
function text(value: unknown, name: string, maximum: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum) throw new Error(`Invalid ${name}`);
  return value.trim();
}
function supported(catalog: Record<string, unknown>, field: string, value: unknown) {
  const values = catalog[field];
  if (!Array.isArray(values) || !values.includes(value)) throw new Error(`Selected route does not support ${field}: ${value}`);
}
function assertPinnedVideoDuration(model: string, duration: number): void {
  const supportedDurations = VIDEO_ROUTE_DURATIONS[model];
  if (!supportedDurations?.includes(duration)) {
    throw new MediaRouteContractError(
      'VIDEO_DURATION_UNSUPPORTED',
      `Selected video profile supports durations: ${supportedDurations?.join(', ') ?? 'none'}`,
    );
  }
}

/** Compiles only the qualified API subset. Extension/remix/lip-sync need dedicated contracts, never an imitation. */
export function compileVideoRequest(operation: string, selectedProfile: string, request: Record<string, unknown>, catalog: Record<string, unknown>[]) {
  profile(selectedProfile);
  if (!['generate', 'animate', 'transition'].includes(operation)) throw new Error('Operation requires its dedicated provider route');
  only(request, ['schema_version', 'prompt', 'duration', 'resolution', 'aspect_ratio', 'count', 'generate_audio', 'frame_images', 'input_references', 'dialogue']);
  const prompt = text(request.prompt, 'prompt', 10000);
  const count = integer(request.count ?? 1, 1, 4, 'count');
  const duration = integer(request.duration ?? 6, 4, 15, 'duration');
  const resolution = request.resolution ?? (selectedProfile === 'fast' ? '480p' : selectedProfile === 'hd' ? '1080p' : selectedProfile === 'ultra' ? '2K' : '720p');
  const aspect_ratio = request.aspect_ratio ?? '16:9';
  if (request.dialogue !== undefined && typeof request.dialogue !== 'boolean') throw new Error('Invalid dialogue mode');
  if (request.generate_audio !== undefined && typeof request.generate_audio !== 'boolean') throw new Error('Invalid audio mode');
  // Pro retains the legacy Seedance 2.5 route; Ultra 2K and 4K use different models.
  const model = videoRoute(selectedProfile, String(resolution));
  assertPinnedVideoDuration(model, duration);
  const endpoint = catalog.find(item => item.id === model);
  if (!endpoint) throw new Error('Selected media model is unavailable; choose another profile');
  supported(endpoint, 'supported_durations', duration);
  supported(endpoint, 'supported_resolutions', resolution);
  supported(endpoint, 'supported_aspect_ratios', aspect_ratio);
  const frames = request.frame_images ?? [];
  const references = request.input_references ?? [];
  if (!Array.isArray(frames) || !Array.isArray(references) || frames.length > 2 || references.length > 4) throw new Error('Invalid video reference count');
  if (frames.length && references.length) throw new Error('Frame control and style references cannot be combined without dropping references');
  if (operation === 'animate' && frames.length !== 1) throw new Error('Animation requires one first frame');
  if (operation === 'transition' && frames.length !== 2) throw new Error('Transition requires first and last frames');
  if (operation === 'generate' && frames.length) throw new Error('Use animate or transition for frame control');
  const frameTypes = new Set<string>();
  const validatedFrames = frames.map(frame => {
    if (!frame || typeof frame !== 'object' || !['first_frame', 'last_frame'].includes(frame.frame_type)) throw new Error('Invalid frame reference');
    if (operation === 'animate' && frame.frame_type !== 'first_frame') throw new Error('Animation needs the first frame');
    if (frameTypes.has(frame.frame_type)) throw new Error('Duplicate frame type');
    frameTypes.add(frame.frame_type);
    supported(endpoint, 'supported_frame_images', frame.frame_type);
    return { frame_type: frame.frame_type, attachment_id: text(frame.attachment_id, 'frame attachment', 200) };
  });
  // Model list does not prove endpoint reference limits. Until qualified, fail closed for reference-to-video.
  if (references.length) throw new Error('Reference-to-video requires qualified endpoint reference limits');
  const generate_audio = request.generate_audio ?? true;
  if (generate_audio && endpoint.generate_audio !== true) throw new Error('Selected route does not support generated audio');
  return { routeId: `video-studio:${operation}:${selectedProfile}:${resolution}:${model}`, model, count,
    request: { model, prompt, duration, resolution, aspect_ratio, generate_audio }, frames: validatedFrames };
}

/** Conservative per-second ceilings; reviewed against OpenRouter's live catalog before a release. */
export function videoRequestReservation(input: { operation: string; profile: string; request: Record<string, unknown> },
  pricing: { creditsPerUsd: number; marginBasisPoints: number; fixedFeeCredits: number }) {
  const compiled = compileMediaJob({ studio: 'video-studio', ...input });
  if (!['generate', 'animate', 'transition'].includes(input.operation)) throw new Error('No dynamic reservation for this operation');
  const resolution = String(compiled.request.resolution);
  const microsPerSecond: Record<string, number> = {
    'bytedance/seedance-2.0-mini:480p': 75_000,
    'bytedance/seedance-2.0:720p': 325_000,
    'bytedance/seedance-2.0:1080p': 800_000,
    'bytedance/seedance-2.0:4K': 1_600_000,
    'bytedance/seedance-2.5:480p': 225_000,
    'bytedance/seedance-2.5:720p': 500_000,
    'minimax/hailuo-3:2K': 300_000,
    'minimax/hailuo-3-max:480p': 50_000,
    'minimax/hailuo-3-max:768p': 80_000,
  };
  const rate = microsPerSecond[`${compiled.model}:${resolution}`];
  if (!rate) throw new Error('Video route has no reservation ceiling');
  const count = integer(input.request.count ?? 1, 1, 4, 'count');
  const providerCeilingMicros = rate * Number(compiled.request.duration) * count;
  const numerator = BigInt(providerCeilingMicros) * BigInt(pricing.creditsPerUsd) * BigInt(10_000 + pricing.marginBasisPoints);
  const maxCredits = Number((numerator + 10_000_000_000n - 1n) / 10_000_000_000n) + pricing.fixedFeeCredits;
  if (!Number.isSafeInteger(maxCredits) || maxCredits <= 0) throw new Error('Invalid video reservation');
  return { maxCredits, count, model: compiled.model, duration: compiled.request.duration,
    resolution, aspectRatio: compiled.request.aspect_ratio, audio: compiled.request.generate_audio };
}

export function compileSpeechRequest(selectedProfile: string, request: Record<string, unknown>, catalog: Record<string, unknown>[]) {
  profile(selectedProfile);
  if (selectedProfile === 'hd' || selectedProfile === 'ultra') throw new Error('Invalid speech profile');
  only(request, ['schema_version', 'text', 'voice', 'locale', 'speed', 'style']);
  const input = text(request.text, 'speech text', 5000);
  const model = SPEECH_ROUTE_MODELS[selectedProfile];
  const voiceId = request.voice ?? (selectedProfile === 'pro' ? 'narrator' : 'harper');
  const voice = PRESET_VOICES[String(voiceId) as keyof typeof PRESET_VOICES];
  if (!voice || !(voice.profiles as readonly string[]).includes(selectedProfile)) throw new Error('Chosen voice is unavailable in this profile; select a supported voice explicitly');
  if (request.locale !== undefined && (typeof request.voice !== 'string' || voice.language.toLowerCase() !== String(request.locale).toLowerCase())) {
    throw new MediaRouteContractError('VOICE_LOCALE_MISMATCH', 'No selected voice is qualified for the requested locale');
  }
  const endpoint = catalog.find(item => item.id === model);
  if (!endpoint) throw new Error('Selected speech model is unavailable');
  supported(endpoint, 'supported_voices', voice.providerId);
  const speed = request.speed ?? 1;
  if (typeof speed !== 'number' || !Number.isFinite(speed) || speed < 0.5 || speed > 2) throw new Error('Invalid speaking speed');
  if (selectedProfile === 'pro' && (speed !== 1 || request.style !== undefined)) throw new Error('Speech style/speed is not yet qualified for this route');
  if (request.style !== undefined && !['cheerful', 'sad', 'angry', 'excited'].includes(String(request.style))) throw new Error('Unsupported speaking style');
  return { routeId: `voice-studio:speak:${selectedProfile}:${model}`, model, voiceId,
    request: { model, input, voice: voice.providerId, response_format: 'mp3',
      ...(selectedProfile !== 'pro' ? { speed } : {}),
      ...(request.style !== undefined ? { provider: { options: { azure: { style: request.style } } } } : {}) } };
}

/** Route presence is not activation. Credentials, signed policy and live qualification remain required. */
export function authorizeMediaTariff(routeId: string, tariffs: readonly QualifiedTariff[], creditsPerUsd: number) {
  const tariff = tariffs.find(item => item.routeId === routeId);
  if (!tariff?.qualified || !tariff.version?.trim()) throw new Error('Media route is not qualified and priced');
  return { ...tariff, maxCredits: mediaReservationCredits(tariff.providerCeilingMicros, creditsPerUsd),
    creditsPerUsd, marginBasisPoints: 5000, fixedFeeCredits: 0, policyVersion: MEDIA_ROUTE_POLICY_VERSION };
}

/**
 * Compile the server-owned route from the signed operation context. This is
 * intentionally independent of user payload fields named provider/model.
 */
export function compileMediaJob(input: {
  studio: string; operation: string; profile: string; request: Record<string, unknown>;
}): { provider: 'openrouter' | 'elevenlabs'; model: string; routeId: string; kind: 'video' | 'audio' | 'transcript'; request: Record<string, unknown> } {
  profile(input.profile);
  if (input.studio !== 'video-studio' && (input.profile === 'hd' || input.profile === 'ultra')) throw new Error('Invalid media profile');
  if (input.studio === 'video-studio') {
    const allowed = ['generate', 'animate', 'transition', 'extend', 'remix', 'lip-sync'];
    if (!allowed.includes(input.operation)) throw new Error('This exact video operation is not qualified');
    only(input.request, ['schema_version', 'prompt', 'duration', 'resolution', 'aspect_ratio', 'count', 'audio', 'dialogue', 'first_frame', 'last_frame', 'image_references', 'video_reference', 'source_video', 'source_image', 'source_audio', 'keyframes', 'additional_duration', 'audio_mode', 'output_format', 'real_person_consent', 'pricing_preview', 'reference_appearance', 'character_route', 'seedance_risk_acknowledged']);
    const promptText = text(input.request.prompt, 'prompt', 10000);
    const count = integer(input.request.count ?? 1, 1, 4, 'count');
    if (input.request.output_format !== undefined && input.request.output_format !== 'mp4') throw new Error('Video Studio currently delivers MP4');
    if (['extend', 'remix', 'lip-sync'].includes(input.operation)) {
      if (input.request.reference_appearance !== undefined || input.request.character_route !== undefined
        || input.request.seedance_risk_acknowledged !== undefined) {
        throw new Error('Character reference routing is not valid for this editing operation');
      }
      if (input.profile !== 'auto') throw new Error('This advanced video operation supports only Auto');
      if (count !== 1) throw new Error('Advanced video operations produce one output');
      if (input.request.first_frame !== undefined || input.request.last_frame !== undefined
        || (input.request.image_references !== undefined
          && (!Array.isArray(input.request.image_references) || input.request.image_references.length > 0))
        || input.request.video_reference !== undefined) {
        throw new Error('Frame and guide references are not supported for this editing operation');
      }
      if (input.operation === 'lip-sync') {
        if (input.request.source_video !== undefined || input.request.keyframes !== undefined
          || input.request.additional_duration !== undefined || input.request.audio_mode !== undefined) {
          throw new Error('Video source and editing controls are not valid for lip-sync');
        }
      } else if (input.request.source_image !== undefined || input.request.source_audio !== undefined
        || (input.operation !== 'remix' && input.request.keyframes !== undefined)
        || (input.operation !== 'extend' && (input.request.additional_duration !== undefined || input.request.audio_mode !== undefined))) {
        throw new Error('Unsupported fields for this video editing operation');
      }
      const outputFormat = String(input.request.output_format ?? 'mp4');
      if (outputFormat !== 'mp4') throw new Error('Advanced video operations currently deliver MP4');
      if (input.operation === 'remix') {
        const keyframes = input.request.keyframes ?? [];
        if (!Array.isArray(keyframes) || keyframes.length > 5) throw new Error('Video remix supports at most five keyframes');
        const normalizedKeyframes = keyframes.map(value => {
          if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid video keyframe');
          const row = value as Record<string, unknown>;
          if (Object.keys(row).some(key => !['image', 'at'].includes(key))) throw new Error('Invalid video keyframe field');
          const at = Number(row.at);
          if (!Number.isFinite(at) || at < 0 || at > 1) throw new Error('Video keyframe position must be between 0 and 1');
          return { attachment_id: text(row.image, 'keyframe image', 200), at };
        });
        const model = ADVANCED_VIDEO_MODELS.remix;
        return { provider: 'openrouter', model, kind: 'video', routeId: `video-studio:remix:auto:${model}`, request: {
          schema_version: '1', model, prompt: promptText, count: 1, output_format: 'mp4',
          source_video_attachment_id: text(input.request.source_video, 'source video', 200),
          ...(normalizedKeyframes.length ? { keyframe_attachment_ids: normalizedKeyframes } : {}),
          ...(input.request.real_person_consent === true ? { real_person_consent: true } : {}),
        } };
      }
      if (input.operation === 'extend') {
        const additionalDuration = integer(input.request.additional_duration ?? 6, 4, 15, 'additional duration');
        const audioMode = String(input.request.audio_mode ?? 'preserve');
        if (!['preserve', 'generate', 'silent'].includes(audioMode)) throw new Error('Invalid extension audio mode');
        const model = ADVANCED_VIDEO_MODELS.extend;
        return { provider: 'openrouter', model, kind: 'video', routeId: `video-studio:extend:auto:720p:${model}`, request: {
          schema_version: '1', model, prompt: promptText, duration: additionalDuration, resolution: '720p', count: 1,
          source_video_attachment_id: text(input.request.source_video, 'source video', 200),
          audio_mode: audioMode, generate_audio: audioMode === 'generate', output_format: 'mp4',
        } };
      }
      if (input.request.real_person_consent !== true) throw new Error('Real-person consent is required for lip-sync');
      const model = ADVANCED_VIDEO_MODELS.lipSync;
      return { provider: 'openrouter', model, kind: 'video', routeId: `video-studio:lip-sync:auto:${model}`, request: {
        schema_version: '1', model, prompt: promptText, count: 1, output_format: 'mp4', real_person_consent: true,
        source_image_attachment_id: text(input.request.source_image, 'source portrait', 200),
        source_audio_attachment_id: text(input.request.source_audio, 'source audio', 200),
      } };
    }
    if (input.request.source_video !== undefined || input.request.source_image !== undefined
      || input.request.source_audio !== undefined || input.request.keyframes !== undefined
      || input.request.additional_duration !== undefined || input.request.audio_mode !== undefined
      || input.request.real_person_consent !== undefined) {
      throw new Error('Source editing fields are not valid for this video operation');
    }
    const appearance = input.request.reference_appearance;
    if (appearance !== undefined && !['non_character', 'stylized', 'realistic', 'uncertain'].includes(String(appearance))) {
      throw new Error('Invalid reference appearance assessment');
    }
    const override = input.request.character_route;
    if (override !== undefined && !['seedance', 'h3-max'].includes(String(override))) throw new Error('Invalid character route choice');
    if (input.request.seedance_risk_acknowledged !== undefined && typeof input.request.seedance_risk_acknowledged !== 'boolean') {
      throw new Error('Invalid Seedance risk acknowledgement');
    }
    const hasImage = input.request.first_frame !== undefined || input.request.last_frame !== undefined
      || (Array.isArray(input.request.image_references) && input.request.image_references.length > 0);
    if (appearance !== undefined && !hasImage) throw new Error('Character assessment requires an image reference');
    if (override !== undefined && appearance === undefined) throw new Error('Character route requires an appearance assessment');
    if (override !== undefined && appearance === 'non_character') throw new Error('Character route is not valid for a non-character image');
    if (appearance === 'realistic' && override === 'seedance') throw new Error('Realistic face references cannot use the Seedance route');
    if (appearance === 'uncertain' && override === 'seedance' && input.request.seedance_risk_acknowledged !== true) {
      throw new Error('Confirm Seedance rejection risk before choosing it for uncertain art');
    }
    if (input.request.seedance_risk_acknowledged === true && !(appearance === 'uncertain' && override === 'seedance')) {
      throw new Error('Seedance risk acknowledgement is not applicable');
    }
    const characterRoute = appearance !== undefined && appearance !== 'non_character' && (override === 'h3-max'
      || (override !== 'seedance' && appearance !== 'stylized'));
    if (characterRoute && input.operation !== 'animate') {
      throw new Error('H3 Max character shots require one selected starting image; use animate');
    }
    const duration = integer(input.request.duration ?? 6, 4, 15, 'duration');
    const resolution = String(input.request.resolution ?? (input.profile === 'fast' ? '480p' : characterRoute ? '768p' : input.profile === 'hd' ? '1080p' : input.profile === 'ultra' ? '2K' : '720p'));
    const aspectRatio = String(input.request.aspect_ratio ?? '16:9');
    if (!['16:9', '9:16', '1:1'].includes(aspectRatio)) throw new Error('Invalid video aspect ratio');
    const model = videoRoute(input.profile, resolution, characterRoute);
    assertPinnedVideoDuration(model, duration);
    if (input.operation === 'animate' && typeof input.request.first_frame !== 'string') throw new Error('Animation requires a first frame');
    if (input.operation === 'animate' && input.request.last_frame !== undefined) throw new Error('Animation accepts only a first frame');
    if (input.operation === 'transition' && (typeof input.request.first_frame !== 'string' || typeof input.request.last_frame !== 'string')) throw new Error('Transition requires first and last frames');
    if (characterRoute && (input.request.last_frame !== undefined || input.request.image_references !== undefined || input.request.video_reference !== undefined)) {
      throw new Error('H3 Max character shots accept one starting image only');
    }
    const refs = input.request.image_references ?? [];
    if (!Array.isArray(refs) || refs.length > 4) throw new Error('Invalid image reference count');
    const videoReference = input.request.video_reference;
    if (videoReference !== undefined && typeof videoReference !== 'string') throw new Error('Invalid video reference');
    if ((refs.length || videoReference !== undefined) && input.operation !== 'generate') {
      throw new Error('Guidance references are supported for generation only');
    }
    if ((refs.length || videoReference !== undefined) && (input.request.first_frame !== undefined || input.request.last_frame !== undefined)) {
      throw new Error('Frame control and guidance references cannot be combined');
    }
    if (refs.length + Number(videoReference !== undefined) > 4) throw new Error('Use at most four guide references');
    const referenceAttachmentIds = refs.map(value => ({ kind: 'image', attachment_id: text(value, 'image reference', 200) }));
    if (videoReference !== undefined) referenceAttachmentIds.push({ kind: 'video', attachment_id: text(videoReference, 'video reference', 200) });
    if (referenceAttachmentIds.length && !['bytedance/seedance-2.0', 'bytedance/seedance-2.5'].includes(model)) {
      throw new Error('Selected profile does not support guide references');
    }
    if (appearance !== undefined && appearance !== 'non_character' && referenceAttachmentIds.some(reference => reference.kind === 'video')) {
      throw new Error('Character appearance assessment applies to image references only');
    }
    const routeId = `video-studio:${input.operation}:${input.profile}:${resolution}:${model}`;
    return { provider: 'openrouter', model, routeId, kind: 'video', request: {
      model, prompt: promptText, duration, resolution, aspect_ratio: aspectRatio,
      count, generate_audio: input.request.audio !== false,
      ...(input.request.first_frame ? { first_frame_attachment_id: input.request.first_frame } : {}),
      ...(input.request.last_frame ? { last_frame_attachment_id: input.request.last_frame } : {}),
      ...(referenceAttachmentIds.length ? { reference_attachment_ids: referenceAttachmentIds } : {}),
    } };
  }
  if (input.studio === 'voice-studio' || input.studio === 'product-demo') {
    if (input.studio === 'product-demo' && (input.operation !== 'speak' || input.profile !== 'auto')) throw new Error('Product Demo supports Auto narration only');
    if (input.operation === 'speak') {
      only(input.request, ['schema_version', 'text', 'voice', 'locale', 'speed', 'style', 'count', 'output_format']);
      if (input.studio === 'voice-studio' && !input.request.voice) throw new MediaRouteContractError('VOICE_MATCH_REQUIRED', 'Voice Studio requires a qualified voice selection');
      const voiceId = String(input.request.voice ?? (input.profile === 'pro' ? 'narrator' : 'harper'));
      const savedVoice = /^voice_[a-f0-9-]{36}$/i.test(voiceId);
      const elevenVoice = input.studio === 'voice-studio' && /^eleven:[a-zA-Z0-9]{20}$/.test(voiceId);
      if (savedVoice && input.profile !== 'auto') throw new Error('Saved voices currently use the Auto profile');
      if (elevenVoice && input.profile !== 'auto') throw new Error('Selected voice currently supports Auto only');
      const model = elevenVoice ? 'eleven_multilingual_v2' : savedVoice ? MEDIA_MODELS.customVoice : SPEECH_ROUTE_MODELS[input.profile];
      const voice = PRESET_VOICES[voiceId as keyof typeof PRESET_VOICES];
      if (!savedVoice && !elevenVoice && (!voice || !(voice.profiles as readonly string[]).includes(input.profile))) throw new Error('Voice is unavailable in this profile');
      if (input.request.locale !== undefined) {
        const locale = text(input.request.locale, 'locale', 16);
        if (!input.request.voice || savedVoice || (!elevenVoice && voice?.language.toLowerCase() !== locale.toLowerCase())) {
          throw new MediaRouteContractError('VOICE_LOCALE_MISMATCH', `Selected voice is not qualified for ${locale}`);
        }
      }
      const speed = Number(input.request.speed ?? 1);
      if (!Number.isFinite(speed) || speed < 0.5 || speed > 2) throw new Error('Invalid speaking speed');
      const style = input.request.style;
      if (style !== undefined && !['cheerful', 'sad', 'angry', 'excited'].includes(String(style))) throw new Error('Unsupported speaking style');
      if (input.profile === 'pro' && (speed !== 1 || style !== undefined)) throw new Error('Speech style and speed are unavailable in Pro');
      if (elevenVoice && style !== undefined) throw new Error('Selected voice route does not support this style');
      integer(input.request.count ?? 1, 1, 4, 'count');
      if (String(input.request.output_format ?? 'mp3') !== 'mp3') throw new Error('Qualified preset speech output is MP3');
      const provider = elevenVoice ? 'elevenlabs' : 'openrouter';
      return { provider, model, kind: 'audio', routeId: `${input.studio}:speak:${input.profile}:${model}`, request: {
        model, input: text(input.request.text, 'speech text', 5000),
        ...(savedVoice ? { saved_voice_id: voiceId }
          : elevenVoice ? { voice: voiceId.slice(7), ...(input.request.locale ? { locale: input.request.locale } : {}) }
            : { voice: voice!.providerId }),
        response_format: 'mp3', speed,
        ...(style ? { provider: { options: { azure: { style } } } } : {}),
      } };
    }
    if (input.operation === 'dialogue') {
      if (input.profile !== 'auto') throw new Error('Multi-speaker dialogue currently supports only Auto');
      only(input.request, ['schema_version', 'speakers', 'segments', 'output_format']);
      if (!Array.isArray(input.request.speakers) || input.request.speakers.length < 2 || input.request.speakers.length > 4) throw new Error('Dialogue requires two to four speakers');
      const speakers = input.request.speakers.map(value => {
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid dialogue speaker');
        const speaker = value as Record<string, unknown>;
        for (const key of Object.keys(speaker)) if (!['id', 'voice'].includes(key)) throw new Error(`Unsupported speaker field: ${key}`);
        const voice = text(speaker.voice, 'speaker voice', 200);
        if (!/^voice_[a-f0-9-]{36}$/i.test(voice)) {
          throw new Error('Dialogue currently requires saved Voice Studio voices');
        }
        return { id: text(speaker.id, 'speaker id', 80), voice };
      });
      if (new Set(speakers.map(speaker => speaker.id)).size !== speakers.length) throw new Error('Dialogue speaker IDs must be unique');
      const speakerIds = new Set(speakers.map(speaker => speaker.id));
      if (!Array.isArray(input.request.segments) || input.request.segments.length < 2 || input.request.segments.length > 40) throw new Error('Dialogue requires 2-40 segments');
      const segments = input.request.segments.map((value, index) => {
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid dialogue segment');
        const segment = value as Record<string, unknown>;
        for (const key of Object.keys(segment)) if (!['index', 'speaker_id', 'text'].includes(key)) throw new Error(`Unsupported dialogue field: ${key}`);
        const speakerId = text(segment.speaker_id, 'speaker id', 80);
        if (!speakerIds.has(speakerId)) throw new Error('Dialogue segment references an unknown speaker');
        return { index, speaker_id: speakerId, text: text(segment.text, 'dialogue text', 2000) };
      });
      if (segments.reduce((sum, segment) => sum + Buffer.byteLength(segment.text), 0) > 20_000) throw new Error('Dialogue exceeds 20,000 UTF-8 bytes');
      if (String(input.request.output_format ?? 'mp3') !== 'mp3') throw new Error('Qualified dialogue output is MP3');
      const model = MEDIA_MODELS.dialogueAuto;
      return { provider: 'openrouter', model, kind: 'audio', routeId: `voice-studio:dialogue:auto:${model}`, request: { schema_version: '1', speakers, segments, count: 1, output_format: 'mp3', model } };
    }
    if (input.operation === 'transcribe') {
      only(input.request, ['schema_version', 'source_audio', 'source_video', 'language', 'diarize', 'timestamps', 'output_format']);
      const sourceAudio = input.request.source_audio === undefined ? undefined : text(input.request.source_audio, 'source audio', 200);
      const sourceVideo = input.request.source_video === undefined ? undefined : text(input.request.source_video, 'source video', 200);
      if (Number(Boolean(sourceAudio)) + Number(Boolean(sourceVideo)) !== 1) throw new Error('Provide exactly one transcription source');
      const language = input.request.language === undefined || input.request.language === 'auto' ? undefined : text(input.request.language, 'language', 16);
      if (input.request.diarize !== undefined && typeof input.request.diarize !== 'boolean') throw new Error('Invalid diarization option');
      const timestamps = String(input.request.timestamps ?? 'segment');
      if (!['none', 'segment', 'word'].includes(timestamps)) throw new Error('Invalid timestamps mode');
      const outputFormat = String(input.request.output_format ?? 'txt');
      if (!['txt', 'json', 'srt', 'vtt'].includes(outputFormat)) throw new Error('Invalid transcript output format');
      return { provider: 'openrouter', model: MEDIA_MODELS.transcription, kind: 'transcript', routeId: `voice-studio:transcribe:auto:${MEDIA_MODELS.transcription}`, request: {
        schema_version: '1', ...(sourceAudio ? { source_audio_attachment_id: sourceAudio } : { source_video_attachment_id: sourceVideo }), diarize: input.request.diarize ?? false,
        timestamps, output_format: outputFormat,
        ...(language ? { language } : {}), model: MEDIA_MODELS.transcription,
      } };
    }
    if (input.operation === 'create-voice') {
      throw new Error('Custom voice creation is a free Voice Library operation');
    }
    throw new Error('Unsupported voice operation');
  }
  if (input.studio === 'music-studio') {
    if (!['generate', 'extend', 'remix', 'separate-stems', 'score-video', 'replace-section', 'insert-section'].includes(input.operation)) throw new Error('Unsupported music operation');
    only(input.request, ['schema_version', 'prompt', 'duration', 'additional_duration', 'target_duration', 'preserve', 'cues', 'instrumental', 'loop_to_duration', 'lyrics', 'sections', 'start_ms', 'end_ms', 'section_name', 'insert_at_ms', 'source_audio', 'source_video', 'stem_count', 'count', 'output_format', 'consent_confirmed']);
    const count = integer(input.request.count ?? 1, 1, 4, 'count');
    const duration = input.operation === 'extend'
      ? integer(input.request.additional_duration ?? 30, 3, 120, 'additional duration')
      : input.operation === 'remix'
        ? integer(input.request.target_duration ?? 60, 3, 600, 'target duration')
        : integer(input.request.duration ?? (input.operation === 'generate' ? 60 : 30), 3, 600, 'duration');
    const outputFormat = String(input.request.output_format ?? 'mp3');
    if (!['mp3', 'wav'].includes(outputFormat)) throw new Error('Invalid music output format');
    const promptText = ['generate', 'extend', 'remix', 'score-video', 'replace-section', 'insert-section'].includes(input.operation)
      ? text(input.request.prompt, 'prompt', 10000) : undefined;
    const lyrics = input.request.lyrics === undefined ? undefined : text(input.request.lyrics, 'lyrics', 20000);
    const sections = input.request.sections === undefined ? [] : input.request.sections;
    if (!Array.isArray(sections) || sections.length > 30 || sections.some(part => !part || typeof part !== 'object' || Array.isArray(part)
      || typeof part.name !== 'string' || !part.name.trim() || part.name.length > 100
      || !Number.isInteger(part.duration_ms) || part.duration_ms < 3000 || part.duration_ms > 120000
      || (part.lyrics !== undefined && (typeof part.lyrics !== 'string' || part.lyrics.length > 20000)))) throw new Error('Invalid song sections');
    if (sections.length && (input.operation !== 'generate' || sections.reduce((sum, part) => sum + part.duration_ms, 0) !== duration * 1000 || lyrics !== undefined)) throw new Error('Invalid song section duration or lyrics');
    if (sections.length && input.profile !== 'pro') throw new Error('Timed song sections require Pro');
    if (input.request.instrumental === true && sections.some(part => typeof part.lyrics === 'string' && part.lyrics.trim())) throw new Error('Instrumental sections cannot contain lyrics');
    const instrumental = input.request.instrumental ?? (lyrics === undefined && !sections.some(part => typeof part.lyrics === 'string' && part.lyrics.trim()));
    if (typeof instrumental !== 'boolean') throw new Error('Invalid instrumental option');
    const loopToDuration = input.request.loop_to_duration ?? false;
    if (typeof loopToDuration !== 'boolean') throw new Error('Invalid loop-to-duration option');
    if (loopToDuration && (input.operation !== 'generate' || !instrumental || lyrics !== undefined)) {
      throw new Error('Loop-to-duration supports only generated instrumental audio');
    }
    const sourceAudio = ['extend', 'remix', 'separate-stems', 'replace-section', 'insert-section'].includes(input.operation)
      ? text(input.request.source_audio, 'source audio', 200) : undefined;
    const startMs = input.operation === 'replace-section' ? integer(input.request.start_ms, 0, 600000, 'section start') : undefined;
    const endMs = input.operation === 'replace-section' ? integer(input.request.end_ms, 3000, 600000, 'section end') : undefined;
    const sectionName = input.operation === 'replace-section' ? text(input.request.section_name, 'section name', 100) : undefined;
    if (input.operation === 'replace-section' && (endMs! - startMs! !== duration * 1000 || duration > 120)) throw new Error('Invalid replacement range');
    const insertAtMs = input.operation === 'insert-section' ? integer(input.request.insert_at_ms, 0, 600000, 'insertion point') : undefined;
    const insertName = input.operation === 'insert-section' ? text(input.request.section_name, 'section name', 100) : undefined;
    if (input.operation === 'insert-section' && duration > 120) throw new Error('Insertion exceeds two minutes');
    const sourceVideo = input.operation === 'score-video'
      ? text(input.request.source_video, 'source video', 200) : undefined;
    const stemCount = input.operation === 'separate-stems'
      ? integer(input.request.stem_count ?? 2, 2, 6, 'stem count') : undefined;
    if (stemCount !== undefined && ![2, 6].includes(stemCount)) throw new Error('Stem count must be 2 or 6');
    const preserve = input.request.preserve ?? [];
    if (!Array.isArray(preserve) || preserve.length > 5 || preserve.some(value => !['vocals', 'lyrics', 'melody', 'rhythm', 'instrumentation'].includes(String(value)))) {
      throw new Error('Invalid music preserve list');
    }
    const cues = input.request.cues ?? [];
    if (!Array.isArray(cues) || cues.length > 20 || cues.some(cue => !cue || typeof cue !== 'object' || Array.isArray(cue))) {
      throw new Error('Invalid video score cues');
    }
    const normalized = { schema_version: '1', ...(promptText ? { prompt: promptText } : {}), duration,
      ...(input.operation === 'extend' ? { additional_duration: duration } : {}),
      ...(input.operation === 'remix' ? { target_duration: duration } : {}),
      instrumental, ...(loopToDuration ? { loop_to_duration: true } : {}), ...(lyrics ? { lyrics } : {}),
      ...(sections.length ? { sections } : {}),
      ...(startMs !== undefined ? { start_ms: startMs, end_ms: endMs, section_name: sectionName } : {}),
      ...(insertAtMs !== undefined ? { insert_at_ms: insertAtMs, section_name: insertName } : {}),
      ...(sourceAudio ? { source_audio_attachment_id: sourceAudio } : {}),
      ...(sourceVideo ? { source_video_attachment_id: sourceVideo } : {}),
      ...(stemCount ? { stem_count: stemCount } : {}),
      ...(preserve.length ? { preserve } : {}), ...(cues.length ? { cues } : {}), count, output_format: outputFormat };
    if (input.operation !== 'generate') {
      if (input.profile !== 'auto') throw new Error('Advanced music operations currently support only Auto');
      const routeId = `music-studio:${input.operation}:auto:elevenlabs:${MEDIA_MODELS.musicPro}`;
      return { provider: 'elevenlabs', model: MEDIA_MODELS.musicPro, kind: 'audio', routeId, request: { ...normalized, model: MEDIA_MODELS.musicPro } };
    }
    const provider = input.profile === 'pro' ? 'elevenlabs' : 'openrouter';
    const model = input.profile === 'fast' ? MEDIA_MODELS.musicFast : input.profile === 'auto' ? MEDIA_MODELS.musicAuto : MEDIA_MODELS.musicPro;
    if (input.profile === 'fast' && duration !== 30) throw new Error('Fast music drafts are exactly 30 seconds');
    return { provider, model, kind: 'audio', routeId: `music-studio:generate:${input.profile}:${provider}:${model}`, request: { ...normalized, model } };
  }
  throw new Error('Unsupported media studio');
}
