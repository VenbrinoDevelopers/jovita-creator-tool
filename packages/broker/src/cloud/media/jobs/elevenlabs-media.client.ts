import { randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { basename } from 'node:path';
import { Readable } from 'node:stream';
import { ProviderOutcomeUnknownError } from '../../saas-store/capabilities/capability-operation.types.js';
import { MEDIA_PROVIDER_REQUEST_TIMEOUT_MS } from './media-job-timing.js';

const BASE = 'https://api.elevenlabs.io/v1';

export class ElevenLabsMediaClient {
  constructor(private readonly apiKey: string, private readonly fetcher: typeof fetch = fetch) {
    if (!apiKey.trim()) throw new Error('ElevenLabs credential required');
  }

  speech(text: string, voiceId: string, speed: number, signal?: AbortSignal): Promise<Response> {
    if (!text.trim() || text.length > 5000 || !/^[a-zA-Z0-9]{20}$/.test(voiceId)
      || !Number.isFinite(speed) || speed < 0.5 || speed > 2) throw new Error('Invalid ElevenLabs speech request');
    return this.postJson(`text-to-speech/${voiceId}?output_format=mp3_44100_128`, {
      text, model_id: 'eleven_multilingual_v2', voice_settings: { speed },
    }, 'audio/mpeg', signal);
  }

  async compose(payload: Record<string, unknown>, signal?: AbortSignal): Promise<Response> {
    const duration = Number(payload.duration ?? 60);
    if (!Number.isInteger(duration) || duration < 3 || duration > 600 || typeof payload.prompt !== 'string' || !payload.prompt.trim()) throw new Error('Invalid ElevenLabs composition request');
    const body = (typeof payload.lyrics === 'string' && payload.lyrics.trim()) || (Array.isArray(payload.sections) && payload.sections.length)
      ? { composition_plan: this.songPlan(payload, duration), model_id: 'music_v2' }
      : { prompt: payload.prompt, music_length_ms: duration * 1000, model_id: 'music_v2' };
    return this.postJson('music', body, 'audio/mpeg', signal);
  }

  async uploadMusic(path: string, mimeType: string, signal?: AbortSignal): Promise<{ songId: string; body: Record<string, unknown> }> {
    const response = await this.postMultipart('music/upload', path, mimeType, 'file', {
      extract_composition_plan: 'music_v2', with_timestamps: 'false', with_waveform_visual: 'false',
    }, 'application/json', signal);
    const body = await this.json(response, 2 * 1024 * 1024);
    const songId = String(body.song_id ?? '');
    if (!/^[a-zA-Z0-9_-]{8,200}$/.test(songId)) throw new ProviderOutcomeUnknownError('ElevenLabs upload receipt was invalid; do not repeat the upload');
    return { songId, body };
  }

  async inpaint(songId: string, payload: Record<string, unknown>, signal?: AbortSignal): Promise<Response> {
    if (!/^[a-zA-Z0-9_-]{8,200}$/.test(songId)) throw new Error('Invalid ElevenLabs song ID');
    const duration = Number(payload.duration);
    if (!Number.isInteger(duration) || duration < 3 || duration > 600) throw new Error('Invalid music edit duration');
    return this.postJson('music', { composition_plan: this.editPlan(songId, payload, duration), model_id: 'music_v2' }, 'audio/mpeg', signal);
  }

  stemSeparation(path: string, mimeType: string, count: 2 | 6, signal?: AbortSignal): Promise<Response> {
    return this.postMultipart('music/stem-separation?output_format=mp3_44100_192', path, mimeType, 'file', {
      stem_variation_id: count === 2 ? 'two_stems_v1' : 'six_stems_v1', sign_with_c2pa: 'false',
    }, 'application/zip', signal);
  }

  videoToMusic(path: string, mimeType: string, description: string, signal?: AbortSignal): Promise<Response> {
    if (!description.trim() || description.length > 1_000) throw new Error('Invalid video score direction');
    return this.postMultipart('music/video-to-music?output_format=mp3_44100_192', path, mimeType, 'videos[]', {
      description, model_id: 'music_v2', sign_with_c2pa: 'false',
    }, 'audio/mpeg', signal);
  }

  private songPlan(payload: Record<string, unknown>, duration: number) {
    if (Array.isArray(payload.sections) && payload.sections.length) return { chunks: payload.sections.map((section) => {
      const row = section as Record<string, unknown>;
      return { text: `[${String(row.name).trim()}]${typeof row.lyrics === 'string' && row.lyrics.trim() ? `\n${row.lyrics.trim()}` : ''}`,
        duration_ms: Number(row.duration_ms), positive_styles: [String(payload.prompt).trim()], negative_styles: [], context_adherence: 'high' };
    }) };
    return { chunks: [{
      text: `[Song]\n${String(payload.lyrics).trim()}`, duration_ms: duration * 1000,
      positive_styles: [String(payload.prompt).trim()].filter(Boolean), negative_styles: [], context_adherence: 'high',
    }] };
  }

  private editPlan(songId: string, payload: Record<string, unknown>, duration: number) {
    const prompt = String(payload.prompt ?? '').trim();
    const preserve = Array.isArray(payload.preserve) ? payload.preserve.map(String) : [];
    const styles = [prompt, preserve.length ? `preserve ${preserve.join(', ')}` : ''].filter(Boolean);
    const sourceDuration = Number(payload.source_duration_ms);
    if (!Number.isSafeInteger(sourceDuration) || sourceDuration < 50) throw new Error('Invalid source music duration');
    if (payload.operation === 'extend') return { chunks: [
      { song_id: songId, range: { start_ms: 0, end_ms: sourceDuration } },
      { text: `[Continuation]${typeof payload.lyrics === 'string' ? `\n${payload.lyrics}` : ''}`, duration_ms: duration * 1000, positive_styles: styles, negative_styles: [], context_adherence: 'high',
        conditioning_ref: { song_id: songId, range: { start_ms: Math.max(0, sourceDuration - 30_000), end_ms: sourceDuration } }, condition_strength: 'high' },
    ] };
    if (payload.operation === 'replace-section') {
      const start = Number(payload.start_ms);
      const end = Number(payload.end_ms);
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end > sourceDuration || end <= start || end - start !== duration * 1000) throw new Error('Invalid section range for source song');
      const chunks: Record<string, unknown>[] = [];
      if (start > 0) chunks.push({ song_id: songId, range: { start_ms: 0, end_ms: start } });
      chunks.push({ text: `[${String(payload.section_name).trim()}]${typeof payload.lyrics === 'string' ? `\n${payload.lyrics}` : ''}`,
        duration_ms: duration * 1000, positive_styles: styles, negative_styles: [], context_adherence: 'high',
        conditioning_ref: { song_id: songId, range: { start_ms: start, end_ms: Math.min(end, start + 30000) } }, condition_strength: 'high' });
      if (end < sourceDuration) chunks.push({ song_id: songId, range: { start_ms: end, end_ms: sourceDuration } });
      return { chunks };
    }
    if (payload.operation === 'insert-section') {
      const at = Number(payload.insert_at_ms);
      if (!Number.isSafeInteger(at) || at < 0 || at > sourceDuration || sourceDuration + duration * 1000 > 600000) throw new Error('Invalid insertion point or final song duration');
      const chunks: Record<string, unknown>[] = [];
      if (at > 0) chunks.push({ song_id: songId, range: { start_ms: 0, end_ms: at } });
      chunks.push({ text: `[${String(payload.section_name).trim()}]${typeof payload.lyrics === 'string' ? `\n${payload.lyrics}` : ''}`,
        duration_ms: duration * 1000, positive_styles: styles, negative_styles: [], context_adherence: 'high',
        ...(at > 0 ? { conditioning_ref: { song_id: songId, range: { start_ms: Math.max(0, at - 30000), end_ms: at } }, condition_strength: 'high' } : {}) });
      if (at < sourceDuration) chunks.push({ song_id: songId, range: { start_ms: at, end_ms: sourceDuration } });
      return { chunks };
    }
    return { chunks: [{
      text: `[Remix]${typeof payload.lyrics === 'string' ? `\n${payload.lyrics}` : ''}`,
      duration_ms: duration * 1000, positive_styles: styles, negative_styles: [], context_adherence: 'high',
      conditioning_ref: { song_id: songId, range: { start_ms: 0, end_ms: Math.min(30_000, sourceDuration) } }, condition_strength: 'high',
    }] };
  }

  private postJson(path: string, payload: Record<string, unknown>, accept: string, signal?: AbortSignal): Promise<Response> {
    return this.post(path, { method: 'POST', redirect: 'error', headers: {
      'xi-api-key': this.apiKey, 'Content-Type': 'application/json', Accept: accept,
    }, body: JSON.stringify(payload), signal: this.signal(signal) });
  }

  private async postMultipart(path: string, filePath: string, mimeType: string, fieldName: string,
    fields: Record<string, string>, accept: string, signal?: AbortSignal): Promise<Response> {
    const file = await stat(filePath);
    if (!file.isFile() || file.size < 1 || file.size > 250 * 1024 * 1024 || !/^[a-z]+\/[a-z0-9.+-]+$/i.test(mimeType)) throw new Error('Invalid ElevenLabs source media');
    const boundary = `jovita-${randomUUID()}`;
    const encodedFields = Object.entries(fields).map(([name, value]) =>
      `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`).join('');
    const safeName = basename(filePath).replace(/[^a-zA-Z0-9._-]/g, '_');
    const prefix = Buffer.from(`${encodedFields}--${boundary}\r\nContent-Disposition: form-data; name="${fieldName}"; filename="${safeName}"\r\nContent-Type: ${mimeType}\r\n\r\n`);
    const suffix = Buffer.from(`\r\n--${boundary}--\r\n`);
    const stream = Readable.from((async function* () {
      yield prefix;
      for await (const chunk of createReadStream(filePath)) yield chunk;
      yield suffix;
    })());
    return this.post(path, { method: 'POST', redirect: 'error', headers: {
      'xi-api-key': this.apiKey, Accept: accept, 'Content-Type': `multipart/form-data; boundary=${boundary}`,
      'Content-Length': String(prefix.length + file.size + suffix.length),
    }, body: stream as unknown as BodyInit, signal: this.signal(signal), duplex: 'half' } as RequestInit & { duplex: 'half' });
  }

  private async post(path: string, init: RequestInit): Promise<Response> {
    let response: Response;
    try { response = await this.fetcher(`${BASE}/${path}`, init); }
    catch (error) { throw new ProviderOutcomeUnknownError('ElevenLabs submission response was lost; do not resubmit', error); }
    if (!response.ok) {
      await response.body?.cancel();
      // Some ElevenLabs music rejections (notably copyright screening during
      // upload) are still chargeable. Without request-level cost evidence the
      // worker must preserve the reservation instead of inventing a zero-cost
      // failure, regardless of the HTTP status class.
      throw new ProviderOutcomeUnknownError(`ElevenLabs did not provide authoritative billing evidence (${response.status})`);
    }
    return response;
  }

  private async json(response: Response, limit: number): Promise<Record<string, unknown>> {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (!bytes.length || bytes.length > limit) throw new Error('ElevenLabs JSON response is invalid');
    const value = JSON.parse(Buffer.from(bytes).toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('ElevenLabs JSON response is malformed');
    return value as Record<string, unknown>;
  }

  private signal(signal?: AbortSignal) { return signal ? AbortSignal.any([signal, AbortSignal.timeout(MEDIA_PROVIDER_REQUEST_TIMEOUT_MS)]) : AbortSignal.timeout(MEDIA_PROVIDER_REQUEST_TIMEOUT_MS); }
}
