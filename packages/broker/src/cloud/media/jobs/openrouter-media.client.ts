import { createHash } from 'node:crypto';
import { open, link, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ProviderOutcomeUnknownError } from '../../saas-store/capabilities/capability-operation.types.js';
import { MEDIA_PROVIDER_REQUEST_TIMEOUT_MS } from './media-job-timing.js';

const BASE = 'https://openrouter.ai/api/v1';
const VIDEO_MODELS = new Set([
  'bytedance/seedance-2.0-mini', 'bytedance/seedance-2.0',
  'google/veo-3.1-fast', 'google/veo-3.1',
  'runway/aleph-2', 'bytedance/seedance-2.5', 'heygen/avatar-iv',
  'minimax/hailuo-3',
  'minimax/hailuo-3-max',
]);
const SPEECH_MODELS = new Set([
  'microsoft/mai-voice-2-flash', 'microsoft/mai-voice-2', 'minimax/speech-2.8-hd',
  'fish-audio/s2.1-pro',
]);
const MUSIC_MODELS = new Set(['google/lyria-3-clip-preview', 'google/lyria-3-pro-preview']);
const TRANSCRIPTION_MODEL = 'deepgram/nova-3';

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function id(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,199}$/.test(value)) throw new Error('Invalid provider generation ID');
  return value;
}
function amount(value: unknown): number | null {
  if ((typeof value !== 'number' && typeof value !== 'string') || (typeof value === 'string' && !value.trim())) return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/** Absent usage is pending, including terminal errors. A reported zero remains a real zero. */
export function openRouterMediaCost(body: Record<string, unknown>): number | null {
  const usage = object(body.usage ?? body.data);
  const billed = amount(usage.cost ?? usage.total_cost);
  if (billed === null) return null;
  const upstream = amount(object(usage.cost_details).upstream_inference_cost ?? usage.upstream_inference_cost);
  const byok = usage.is_byok === true || body.is_byok === true || object(body.openrouter_metadata).is_byok === true
    || (billed === 0 && upstream !== null && upstream > 0);
  if (byok && upstream === null) return null;
  const micros = Math.round((billed + (byok ? upstream! : 0)) * 1_000_000);
  return Number.isSafeInteger(micros) ? micros : null;
}

export class MediaProviderRejection extends Error {
  constructor(readonly status: number, readonly providerCode?: string, readonly providerMessage?: string) {
    super(`Media provider rejected the request (${status})`);
  }
}

function safeProviderErrorText(value: unknown, maximum: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/https?:\/\/[^\s"'<>]+/gi, '[URL]')
    .replace(/data:[^\s"'<>]+/gi, '[MEDIA]')
    .replace(/\bBearer\s+\S+/gi, '[CREDENTIAL]')
    .replace(/\bsk-[A-Za-z0-9_-]+/gi, '[CREDENTIAL]')
    .replace(/[A-Za-z0-9+/]{100,}={0,2}/g, '[DATA]')
    .trim();
  return cleaned ? cleaned.slice(0, maximum) : undefined;
}

async function providerRejection(response: Response): Promise<MediaProviderRejection> {
  const chunks: Buffer[] = [];
  let size = 0;
  const reader = response.body?.getReader();
  if (reader) {
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > 16 * 1024) break;
        chunks.push(Buffer.from(chunk.value));
      }
    } catch { size = 16 * 1024 + 1; }
    finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  }
  let body: Record<string, unknown> = {};
  if (size <= 16 * 1024) {
    try { body = object(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
    catch { /* An unstructured body is not retained. */ }
  }
  const outer = object(body.error);
  const metadata = object(outer.metadata);
  let upstream: Record<string, unknown> = {};
  let upstreamText: string | undefined;
  if (typeof metadata.raw === 'string') {
    try { upstream = object(JSON.parse(metadata.raw)); }
    catch { upstreamText = metadata.raw; }
  } else upstream = object(metadata.raw);
  const nested = object(upstream.error);
  const detail = Object.keys(nested).length ? nested : upstream;
  const candidateCode = detail.code ?? outer.code ?? body.code;
  const providerCode = typeof candidateCode === 'string' && /^[A-Za-z][A-Za-z0-9_.:-]{0,79}$/.test(candidateCode)
    ? candidateCode : undefined;
  const providerMessage = safeProviderErrorText(detail.message ?? upstreamText
    ?? outer.message ?? body.message ?? (typeof body.error === 'string' ? body.error : undefined), 500);
  return new MediaProviderRejection(response.status, providerCode, providerMessage);
}

/** Worker-only HTTP client. Never retries a paid POST. No arbitrary provider URL or credentials in results. */
export class OpenRouterMediaClient {
  constructor(private readonly apiKey: string, private readonly fetcher: typeof fetch = fetch) {
    if (!apiKey.trim()) throw new Error('OpenRouter credential required');
  }

  private async request(path: string, payload?: Record<string, unknown>, signal?: AbortSignal): Promise<Response> {
    let response: Response;
    try {
      response = await this.fetcher(`${BASE}/${path}`, {
        method: payload ? 'POST' : 'GET', redirect: 'error',
        headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json',
          'X-OpenRouter-Metadata': 'enabled', 'User-Agent': 'jovita-media-worker/1.0' },
        ...(payload ? { body: JSON.stringify(payload) } : {}),
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(MEDIA_PROVIDER_REQUEST_TIMEOUT_MS)]) : AbortSignal.timeout(MEDIA_PROVIDER_REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      if (payload) throw new ProviderOutcomeUnknownError('Media submission response was lost; do not resubmit', error);
      throw error;
    }
    if (!response.ok) {
      if (payload && (response.status >= 500 || response.status === 408)) {
        await response.body?.cancel();
        throw new ProviderOutcomeUnknownError('Media provider did not prove the submission outcome');
      }
      throw await providerRejection(response);
    }
    return response;
  }

  private async json(response: Response): Promise<Record<string, unknown>> {
    if (!response.body) throw new Error('Provider response body missing');
    const reader = response.body.getReader();
    let size = 0;
    const parts: Uint8Array[] = [];
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > 2 * 1024 * 1024) throw new Error('Provider JSON exceeds limit');
        parts.push(chunk.value);
      }
      const value = JSON.parse(Buffer.concat(parts).toString('utf8'));
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Malformed provider JSON');
      return value;
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  }

  async discover(kind: 'video' | 'speech' | 'audio' | 'transcription', signal?: AbortSignal): Promise<Record<string, unknown>[]> {
    const path = kind === 'video' ? 'videos/models'
      : kind === 'speech' ? 'models?output_modalities=speech'
        : kind === 'transcription' ? 'models?output_modalities=transcription'
          : 'models?output_modalities=audio';
    const body = await this.json(await this.request(path, undefined, signal));
    const allowed = kind === 'video' ? VIDEO_MODELS : SPEECH_MODELS;
    return (Array.isArray(body.data) ? body.data : []).map(object).filter(model =>
      kind === 'audio' ? MUSIC_MODELS.has(String(model.id))
        : kind === 'transcription' ? String(model.id) === TRANSCRIPTION_MODEL
          : allowed.has(String(model.id)));
  }

  async modelEndpoints(model: string, signal?: AbortSignal): Promise<Record<string, unknown>[]> {
    if (!SPEECH_MODELS.has(model) && !MUSIC_MODELS.has(model)) throw new Error('Unsupported media model');
    const [author, slug] = model.split('/');
    if (!author || !slug) throw new Error('Invalid media model');
    const body = await this.json(await this.request(`models/${encodeURIComponent(author)}/${encodeURIComponent(slug)}/endpoints`, undefined, signal));
    const data = object(body.data);
    if (data.id !== model) throw new Error('Model endpoint discovery identity mismatch');
    return (Array.isArray(data.endpoints) ? data.endpoints : []).map(object);
  }

  async submitVideo(payload: Record<string, unknown>, signal?: AbortSignal): Promise<Record<string, unknown>> {
    if (!VIDEO_MODELS.has(String(payload.model)) || typeof payload.prompt !== 'string' || !payload.prompt.trim()
      || payload.prompt.length > 10000 || payload.callback_url !== undefined) throw new Error('Invalid video request');
    // The route policy validates exact operation/reference/resolution support before this boundary.
    try {
      const body = await this.json(await this.request('videos', payload, signal));
      id(body.id);
      if (!['pending', 'in_progress', 'completed'].includes(String(body.status))) throw new Error('Unexpected submission status');
      return body;
    } catch (error) {
      if (error instanceof MediaProviderRejection || error instanceof ProviderOutcomeUnknownError) throw error;
      throw new ProviderOutcomeUnknownError('Media submission receipt was invalid; do not resubmit', error);
    }
  }

  async videoStatus(jobId: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
    const body = await this.json(await this.request(`videos/${id(jobId)}`, undefined, signal));
    if (body.id !== jobId || !['pending', 'in_progress', 'completed', 'failed', 'cancelled', 'expired'].includes(String(body.status))) {
      throw new Error('Malformed video status response');
    }
    return body;
  }

  async generationCost(generationId: string, signal?: AbortSignal): Promise<number | null> {
    const body = await this.json(await this.request(`generation?id=${encodeURIComponent(id(generationId))}`, undefined, signal));
    const data = object(body.data);
    if (data.id !== generationId) throw new Error('Generation cost identity mismatch');
    return openRouterMediaCost(body);
  }

  async videoContent(jobId: string, signal?: AbortSignal): Promise<Response> {
    // Construct the URL ourselves; never forward the account key to unsigned_urls from response JSON.
    return this.request(`videos/${id(jobId)}/content?index=0`, undefined, signal);
  }

  async speech(payload: Record<string, unknown>, signal?: AbortSignal): Promise<{ response: Response; generationId: string | null }> {
    if (!SPEECH_MODELS.has(String(payload.model)) || typeof payload.input !== 'string' || !payload.input.trim()
      || payload.input.length > 5000 || payload.response_format !== 'mp3') throw new Error('Invalid speech request');
    const references = payload.input_references;
    if (payload.model === 'fish-audio/s2.1-pro') {
      if (payload.voice !== undefined || !Array.isArray(references) || references.length < 1 || references.length > 2) {
        throw new Error('Fish speech requires one private stateless voice reference');
      }
      const audio = object(references[0]);
      const inputAudio = object(audio.input_audio);
      if (audio.type !== 'input_audio' || typeof inputAudio.data !== 'string'
        || !/^data:audio\/(?:mpeg|mp3|wav|x-wav|ogg|mp4|aac|flac|opus);base64,[A-Za-z0-9+/=]+$/.test(inputAudio.data)
        || inputAudio.data.length > 32 * 1024 * 1024) throw new Error('Invalid stateless voice audio');
      if (references.length === 2) {
        const transcript = object(references[1]);
        if (transcript.type !== 'text' || typeof transcript.text !== 'string' || !transcript.text.trim() || transcript.text.length > 10_000) {
          throw new Error('Invalid stateless voice transcript');
        }
      }
    } else if (typeof payload.voice !== 'string' || !payload.voice || references !== undefined) {
      throw new Error('Invalid preset speech request');
    }
    const response = await this.request('audio/speech', payload, signal);
    const generationId = response.headers.get('x-generation-id');
    // Retain audio even when its measurement ID is missing; billing then remains pending.
    return { response, generationId: generationId && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,199}$/.test(generationId) ? generationId : null };
  }

  async transcribe(payload: Record<string, unknown>, signal?: AbortSignal): Promise<{ body: Record<string, unknown>; generationId: string | null }> {
    const audio = object(payload.input_audio);
    if (payload.model !== TRANSCRIPTION_MODEL || typeof audio.data !== 'string' || !audio.data
      || audio.data.length > 48 * 1024 * 1024 || !['wav', 'mp3', 'flac', 'm4a', 'ogg', 'webm', 'aac'].includes(String(audio.format))) {
      throw new Error('Invalid transcription request');
    }
    const response = await this.request('audio/transcriptions', payload, signal);
    const generationId = response.headers.get('x-generation-id');
    return {
      body: await this.json(response),
      generationId: generationId && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,199}$/.test(generationId) ? generationId : null,
    };
  }

  /** Lyria audio is streamed as base64 deltas through chat completions. */
  async music(payload: Record<string, unknown>, signal?: AbortSignal): Promise<{ bytes: Buffer; body: Record<string, unknown>; generationId: string | null }> {
    if (!MUSIC_MODELS.has(String(payload.model)) || !Array.isArray(payload.messages)
      || payload.messages.length !== 1 || payload.stream !== true) throw new Error('Invalid Lyria request');
    const response = await this.request('chat/completions', payload, signal);
    const generationId = response.headers.get('x-generation-id');
    if (!response.body) throw new Error('Lyria response body missing');
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let base64 = '';
    const audioChunks: Buffer[] = [];
    let audioSize = 0;
    const flushAudio = () => {
      if (!base64 || base64.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(base64)) throw new Error('Malformed Lyria base64');
      const decoded = Buffer.from(base64, 'base64');
      if (decoded.toString('base64') !== base64) throw new Error('Malformed Lyria base64');
      audioSize += decoded.length;
      if (audioSize > 100 * 1024 * 1024) throw new Error('Lyria audio exceeds limit');
      audioChunks.push(decoded); base64 = '';
    };
    let final: Record<string, unknown> = {};
    let encodedBytes = 0;
    let completed = false;
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        encodedBytes += chunk.value.byteLength;
        if (encodedBytes > 140 * 1024 * 1024) throw new Error('Lyria response exceeds limit');
        buffer += decoder.decode(chunk.value, { stream: true });
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          if (!line.startsWith('data:')) continue;
          const data = line.slice(5).trim();
          if (data === '[DONE]') { completed = true; continue; }
          if (!data) continue;
          if (completed) throw new Error('Lyria data after completion');
          const event = object(JSON.parse(data));
          const choice = object((Array.isArray(event.choices) ? event.choices : [])[0]);
          const delta = object(choice.delta);
          const message = object(choice.message);
          const audio = object(delta.audio ?? message.audio);
          if (event.error) throw new ProviderOutcomeUnknownError('Lyria stream reported an error');
          if (typeof audio.data === 'string') {
            base64 += audio.data;
            // Preserve all independently padded blocks, as well as base64 split across SSE frames.
            if (base64.endsWith('=') && base64.length % 4 === 0) flushAudio();
          }
          if (event.usage !== undefined) final = { ...final, usage: event.usage };
          if (typeof event.id === 'string') final = { ...final, id: event.id };
          if (event.model !== undefined) final = { ...final, model: event.model };
        }
      }
      if (buffer.trim() || !completed) throw new ProviderOutcomeUnknownError('Incomplete Lyria stream');
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
    if (base64) flushAudio();
    const bytes = Buffer.concat(audioChunks);
    if (!bytes.length || bytes.length > 100 * 1024 * 1024) throw new Error('Lyria audio exceeds limit');
    return {
      bytes,
      body: final,
      generationId: generationId && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,199}$/.test(generationId) ? generationId : null,
    };
  }
}

/** Lyria's pinned PCM16 route is 48 kHz stereo. Never guess PCM for a WAV request. */
export function normalizeLyriaAudio(bytes: Buffer, requestedFormat: string): { bytes: Buffer; mimeType: string; fileName: string } {
  if (providerMediaSignatureMatches('audio/wav', bytes)) return { bytes, mimeType: 'audio/wav', fileName: 'music.wav' };
  if (providerMediaSignatureMatches('audio/mpeg', bytes)) return { bytes, mimeType: 'audio/mpeg', fileName: 'music.mp3' };
  if (requestedFormat !== 'pcm16' || !bytes.length || bytes.length % 4 !== 0 || bytes.length > 100 * 1024 * 1024 - 44) {
    throw new Error('Unsupported Lyria audio encoding; original preserved for diagnosis');
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0); header.writeUInt32LE(bytes.length + 36, 4); header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(2, 22);
  header.writeUInt32LE(48000, 24); header.writeUInt32LE(192000, 28);
  header.writeUInt16LE(4, 32); header.writeUInt16LE(16, 34);
  header.write('data', 36); header.writeUInt32LE(bytes.length, 40);
  return { bytes: Buffer.concat([header, bytes]), mimeType: 'audio/wav', fileName: 'music.wav' };
}

/** Stages a bounded stream for probing/private storage. Caller supplies an isolated worker directory. */
export class ProviderMediaValidationError extends Error {
  constructor(message: string) { super(message); this.name = 'ProviderMediaValidationError'; }
}

export async function stageProviderMedia(response: Response, destination: string, kind: 'audio' | 'video', maxBytes?: number) {
  const ceiling = (kind === 'video' ? 250 : 100) * 1024 * 1024;
  const limit = maxBytes === undefined ? ceiling : Math.min(ceiling, maxBytes);
  const mimeType = (response.headers.get('content-type') ?? '').split(';')[0]!.trim();
  const allowed = kind === 'video' ? ['video/mp4', 'video/webm'] : ['audio/mpeg', 'audio/wav', 'audio/x-wav'];
  const lengthHeader = response.headers.get('content-length');
  const declared = lengthHeader === null ? null : Number(lengthHeader);
  if (!response.ok || !response.body || !allowed.includes(mimeType)
    || (declared !== null && (!Number.isSafeInteger(declared) || declared <= 0 || declared > limit))) {
    await response.body?.cancel(); throw new ProviderMediaValidationError('Invalid provider media response');
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
      if (signature.length < 16) {
        signature = Buffer.concat([signature, Buffer.from(chunk.value).subarray(0, 16 - signature.length)]);
      }
      // writeFile on the open handle consumes the complete chunk, including partial OS writes.
      await file.writeFile(chunk.value);
    }
    if (!size || (declared !== null && declared !== size)) throw new ProviderMediaValidationError('Truncated provider media');
    if (!providerMediaSignatureMatches(mimeType, signature)) throw new ProviderMediaValidationError('Provider media signature mismatch');
    await file.sync(); await file.close();
    // This is only a staging receipt, not a ready attachment; the worker must probe actual streams next.
    await link(stage, destination);
    await unlink(stage);
    return { path: destination, size, sha256: hash.digest('hex'), mimeType };
  } catch (error) {
    await file.close().catch(() => {}); await unlink(stage).catch(() => {}); throw error;
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

export function providerMediaSignatureMatches(mimeType: string, bytes: Uint8Array): boolean {
  const head = Buffer.from(bytes);
  if (mimeType === 'video/mp4') return head.length >= 12 && head.subarray(4, 8).toString('ascii') === 'ftyp';
  if (mimeType === 'video/webm') return head.length >= 4 && head.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]));
  if (mimeType === 'audio/wav' || mimeType === 'audio/x-wav') {
    return head.length >= 12 && head.subarray(0, 4).toString('ascii') === 'RIFF'
      && head.subarray(8, 12).toString('ascii') === 'WAVE';
  }
  if (mimeType === 'audio/mpeg') {
    return head.length >= 3 && head.subarray(0, 3).toString('ascii') === 'ID3'
      || head.length >= 2 && head[0] === 0xff && (head[1]! & 0xe0) === 0xe0;
  }
  return false;
}
