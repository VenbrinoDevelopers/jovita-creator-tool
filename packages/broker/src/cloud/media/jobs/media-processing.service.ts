import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

interface ProbeStream {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  duration?: string | number;
}

interface ProbeDocument {
  format?: { format_name?: string; duration?: string | number };
  streams?: ProbeStream[];
}

export interface ProbedMedia {
  durationMs: number;
  container: string;
  width?: number;
  height?: number;
  videoCodec?: string;
  audioCodec?: string;
  hasAudio: boolean;
  hasVideo: boolean;
}

export interface ProcessedMediaFile {
  path: string;
  fileName: string;
  mimeType: string;
  kind: 'audio' | 'video' | 'image';
  size: number;
  sha256: string;
}

export interface PreparedMedia {
  metadata: ProbedMedia;
  playback?: ProcessedMediaFile;
  poster?: ProcessedMediaFile;
  originalIsPlayback: boolean;
}

@Injectable()
export class MediaProcessingService {
  /** Deterministic instrumental excerpt; the input is never overwritten. */
  async instrumentalExcerpt(path: string, directory: string, seconds: number): Promise<ProcessedMediaFile> {
    const source = await this.probe(path, 'audio');
    if (!Number.isFinite(seconds) || seconds < 1 || seconds > 1800 || source.durationMs < seconds * 1000) {
      throw new Error('Invalid instrumental excerpt duration');
    }
    const output = join(directory, 'intro.mp3');
    const fade = Math.min(1, seconds / 4);
    await this.run(this.ffmpeg(), ['-nostdin', '-n', '-i', path, '-map', '0:a:0', '-vn',
      '-af', `atrim=start=0:end=${seconds},asetpts=PTS-STARTPTS,afade=t=in:d=0.05,afade=t=out:st=${seconds - fade}:d=${fade}`,
      '-c:a', 'libmp3lame', '-b:a', '192k', output], 300_000);
    const result = await this.probe(output, 'audio', seconds);
    if (Math.abs(result.durationMs - seconds * 1000) > 150) throw new Error('Instrumental excerpt duration verification failed');
    await this.run(this.ffmpeg(), ['-nostdin', '-v', 'error', '-xerror', '-i', output, '-f', 'null', '-'], 300_000);
    return this.receipt(output, 'intro.mp3', 'audio/mpeg', 'audio');
  }

  /** Deterministically repeat a sufficiently long instrumental with crossfades. The source is never overwritten. */
  async loopInstrumentalToDuration(path: string, directory: string, seconds: number): Promise<ProcessedMediaFile> {
    const source = await this.probe(path, 'audio');
    const sourceSeconds = source.durationMs / 1000;
    if (!Number.isFinite(seconds) || seconds < 3 || seconds > 600 || sourceSeconds < 5 || sourceSeconds >= seconds) {
      throw new Error('Invalid instrumental loop duration');
    }
    const crossfade = Math.min(2, sourceSeconds / 10);
    const repeats = Math.ceil((seconds - crossfade) / (sourceSeconds - crossfade));
    if (!Number.isSafeInteger(repeats) || repeats < 2 || repeats > 20) {
      throw new Error('Instrumental source is too short for a bounded loop');
    }
    const inputs = Array.from({ length: repeats }, () => ['-i', path]).flat();
    const normalized = Array.from({ length: repeats }, (_, index) =>
      `[${index}:a:0]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo[a${index}]`);
    const joins: string[] = [];
    let previous = 'a0';
    for (let index = 1; index < repeats; index += 1) {
      const next = index === repeats - 1 ? 'joined' : `x${index}`;
      joins.push(`[${previous}][a${index}]acrossfade=d=${crossfade}:c1=tri:c2=tri[${next}]`);
      previous = next;
    }
    const fade = Math.min(2, seconds / 8);
    const filters = [...normalized, ...joins,
      `[joined]atrim=start=0:end=${seconds},asetpts=PTS-STARTPTS,afade=t=in:d=0.05,afade=t=out:st=${seconds - fade}:d=${fade}[out]`].join(';');
    const output = join(directory, 'ambient-loop.mp3');
    await this.run(this.ffmpeg(), ['-nostdin', '-n', ...inputs, '-filter_complex', filters, '-map', '[out]',
      '-c:a', 'libmp3lame', '-b:a', '192k', output], 300_000);
    const result = await this.probe(output, 'audio', seconds);
    if (Math.abs(result.durationMs - seconds * 1000) > 150) throw new Error('Instrumental loop duration verification failed');
    await this.run(this.ffmpeg(), ['-nostdin', '-v', 'error', '-xerror', '-i', output, '-f', 'null', '-'], 300_000);
    return this.receipt(output, 'ambient-loop.mp3', 'audio/mpeg', 'audio');
  }

  async appendVideos(originalPath: string, continuationPath: string, directory: string): Promise<{
    file: ProcessedMediaFile;
    originalDurationMs: number;
    continuationDurationMs: number;
  }> {
    let leftPath = originalPath;
    let rightPath = continuationPath;
    let original = await this.probe(leftPath, 'video');
    let continuation = await this.probe(rightPath, 'video');
    if (original.hasAudio !== continuation.hasAudio) {
      const silentTarget = original.hasAudio ? rightPath : leftPath;
      const silentDuration = original.hasAudio ? continuation.durationMs : original.durationMs;
      const output = join(directory, original.hasAudio ? 'continuation-with-silence.mp4' : 'original-with-silence.mp4');
      await this.run(this.ffmpeg(), [
        '-nostdin', '-y', '-i', silentTarget, '-f', 'lavfi', '-t', String(silentDuration / 1000), '-i', 'anullsrc=r=48000:cl=stereo',
        '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'copy', '-c:a', 'aac', '-shortest', '-movflags', '+faststart', output,
      ], 300_000);
      if (original.hasAudio) rightPath = output; else leftPath = output;
      original = await this.probe(leftPath, 'video');
      continuation = await this.probe(rightPath, 'video');
    }
    if (original.width !== continuation.width || original.height !== continuation.height
      || original.videoCodec !== continuation.videoCodec || original.hasAudio !== continuation.hasAudio
      || (original.hasAudio && original.audioCodec !== continuation.audioCodec)) {
      throw new Error('Video extension streams are incompatible at the join');
    }
    const quote = (value: string) => value.replace(/'/g, "'\\''");
    const listPath = join(directory, 'extension-concat.txt');
    await writeFile(listPath, `file '${quote(leftPath)}'\nfile '${quote(rightPath)}'\n`, { flag: 'wx', mode: 0o600 });
    const output = join(directory, 'extended-video.mp4');
    await this.run(this.ffmpeg(), ['-nostdin', '-y', '-f', 'concat', '-safe', '0', '-i', listPath, '-c', 'copy', '-movflags', '+faststart', output], 300_000);
    await this.probe(output, 'video', (original.durationMs + continuation.durationMs) / 1000);
    return {
      file: await this.receipt(output, 'extended-video.mp4', 'video/mp4', 'video'),
      originalDurationMs: original.durationMs,
      continuationDurationMs: continuation.durationMs,
    };
  }

  async transcriptionInput(inputPath: string, outputPath: string): Promise<ProcessedMediaFile> {
    await this.run(this.ffmpeg(), [
      '-nostdin', '-y', '-i', inputPath, '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'flac', outputPath,
    ], 300_000);
    await this.probe(outputPath, 'audio');
    return this.receipt(outputPath, 'transcription.flac', 'audio/flac', 'audio');
  }

  async assembleDialogue(segmentPaths: string[], directory: string, pauseMs = 250): Promise<ProcessedMediaFile> {
    if (segmentPaths.length < 2 || segmentPaths.length > 40 || !Number.isInteger(pauseMs) || pauseMs < 0 || pauseMs > 2_000) {
      throw new Error('Invalid dialogue assembly plan');
    }
    const inputs = segmentPaths.flatMap(path => ['-i', path]);
    const normalized = segmentPaths.map((_, index) => `[${index}:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,loudnorm=I=-16:TP=-1.5:LRA=11[a${index}]`);
    const silence = segmentPaths.slice(0, -1).map((_, index) => `anullsrc=r=48000:cl=stereo:d=${pauseMs / 1000}[s${index}]`);
    const order = segmentPaths.flatMap((_, index) => index < segmentPaths.length - 1 ? [`[a${index}]`, `[s${index}]`] : [`[a${index}]`]).join('');
    const filters = [...normalized, ...silence, `${order}concat=n=${segmentPaths.length * 2 - 1}:v=0:a=1[out]`].join(';');
    const output = join(directory, 'dialogue.mp3');
    await this.run(this.ffmpeg(), ['-nostdin', '-y', ...inputs, '-filter_complex', filters, '-map', '[out]', '-c:a', 'libmp3lame', '-b:a', '192k', output], 300_000);
    await this.probe(output, 'audio');
    return this.receipt(output, 'dialogue.mp3', 'audio/mpeg', 'audio');
  }

  async prepare(input: {
    path: string;
    kind: 'audio' | 'video';
    directory: string;
    expectedDurationSeconds?: number;
  }): Promise<PreparedMedia> {
    const original = await this.probe(input.path, input.kind, input.expectedDurationSeconds);
    if (input.kind === 'audio') {
      const output = join(input.directory, 'playback.m4a');
      await this.run(this.ffmpeg(), ['-nostdin', '-y', '-i', input.path, '-vn', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', output], 300_000);
      const metadata = await this.probe(output, 'audio', input.expectedDurationSeconds);
      return {
        metadata,
        playback: await this.receipt(output, 'playback.m4a', 'audio/mp4', 'audio'),
        originalIsPlayback: false,
      };
    }

    let playback: ProcessedMediaFile | undefined;
    let playbackPath = input.path;
    const originalIsPlayback = original.container === 'mp4' && original.videoCodec === 'h264'
      && (!original.hasAudio || original.audioCodec === 'aac')
      && Number(original.width) % 2 === 0 && Number(original.height) % 2 === 0;
    if (!originalIsPlayback) {
      playbackPath = join(input.directory, 'playback.mp4');
      await this.run(this.ffmpeg(), [
        '-nostdin', '-y', '-i', input.path,
        '-map', '0:v:0', '-map', '0:a:0?',
        '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2',
        '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k',
        '-movflags', '+faststart', playbackPath,
      ], 300_000);
      playback = await this.receipt(playbackPath, 'playback.mp4', 'video/mp4', 'video');
    }
    const metadata = await this.probe(playbackPath, 'video', input.expectedDurationSeconds);
    // MJPEG is available in the minimal FFmpeg builds used by workers, while
    // WebP encoding is optional in FFmpeg. A bounded JPEG poster keeps the
    // derivative path portable across both release architectures.
    const posterPath = join(input.directory, 'poster.jpg');
    await this.run(this.ffmpeg(), [
      '-nostdin', '-y', '-ss', String(Math.min(1, metadata.durationMs / 2000)), '-i', playbackPath,
      '-frames:v', '1', '-vf', 'scale=720:-2:force_original_aspect_ratio=decrease', '-c:v', 'mjpeg', '-q:v', '3', posterPath,
    ], 120_000);
    return {
      metadata,
      playback,
      poster: await this.receipt(posterPath, 'poster.jpg', 'image/jpeg', 'image'),
      originalIsPlayback,
    };
  }

  async stripVideoAudio(path: string, directory: string): Promise<ProcessedMediaFile> {
    const output = join(directory, 'silent-video.mp4');
    await this.run(this.ffmpeg(), ['-nostdin', '-y', '-i', path, '-map', '0:v:0', '-c:v', 'copy', '-an', '-movflags', '+faststart', output], 300_000);
    const metadata = await this.probe(output, 'video');
    if (metadata.hasAudio) throw new Error('Silent video still contains an audio track');
    return this.receipt(output, 'silent-video.mp4', 'video/mp4', 'video');
  }

  async probe(path: string, kind: 'audio' | 'video', expectedDurationSeconds?: number): Promise<ProbedMedia> {
    const raw = await this.run(this.ffprobe(), ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', path], 60_000);
    return parseProbeDocument(JSON.parse(raw), kind, expectedDurationSeconds);
  }

  private async receipt(path: string, fileName: string, mimeType: string, kind: 'audio' | 'video' | 'image'): Promise<ProcessedMediaFile> {
    const details = await stat(path);
    if (!details.isFile() || details.size < 1) throw new Error('Media processor produced an empty file');
    const digest = createHash('sha256');
    for await (const chunk of createReadStream(path)) digest.update(chunk);
    return { path, fileName, mimeType, kind, size: details.size, sha256: digest.digest('hex') };
  }

  private run(command: string, args: string[], timeoutMs: number): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let settled = false;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) reject(error);
        else resolve(Buffer.concat(stdout).toString('utf8'));
      };
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        finish(new Error('Media processor timed out'));
      }, timeoutMs);
      timer.unref();
      child.stdout.on('data', (chunk: Buffer) => {
        stdoutBytes += chunk.length;
        if (stdoutBytes > 1024 * 1024) {
          child.kill('SIGKILL');
          finish(new Error('Media processor output exceeded limit'));
        } else stdout.push(chunk);
      });
      child.stderr.on('data', (chunk: Buffer) => {
        if (stderrBytes >= 256 * 1024) return;
        stderrBytes += chunk.length;
        stderr.push(chunk.subarray(0, Math.max(0, 256 * 1024 - (stderrBytes - chunk.length))));
      });
      child.once('error', error => finish(error));
      child.once('close', code => {
        if (settled) return;
        if (code !== 0) finish(new Error(`Media processor failed (${code}): ${Buffer.concat(stderr).toString('utf8').slice(-1000)}`));
        else finish();
      });
    });
  }

  private ffmpeg(): string { return String(process.env.JOVITA_FFMPEG_PATH ?? 'ffmpeg').trim(); }
  private ffprobe(): string { return String(process.env.JOVITA_FFPROBE_PATH ?? 'ffprobe').trim(); }
}

export function parseProbeDocument(value: unknown, kind: 'audio' | 'video', expectedDurationSeconds?: number): ProbedMedia {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Malformed media probe result');
  const document = value as ProbeDocument;
  const streams = Array.isArray(document.streams) ? document.streams : [];
  const video = streams.find(stream => stream.codec_type === 'video');
  const audio = streams.find(stream => stream.codec_type === 'audio');
  if (kind === 'video' && (!video || !Number.isInteger(video.width) || !Number.isInteger(video.height)
    || Number(video.width) < 2 || Number(video.height) < 2 || Number(video.width) > 8192 || Number(video.height) > 8192)) {
    throw new Error('Video stream is missing or invalid');
  }
  if (kind === 'audio' && !audio) throw new Error('Audio stream is missing');
  const durationSeconds = Number(document.format?.duration ?? video?.duration ?? audio?.duration);
  const maximum = kind === 'video' ? 10 * 60 : 30 * 60;
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0 || durationSeconds > maximum) throw new Error('Media duration is invalid');
  if (expectedDurationSeconds !== undefined) {
    if (!Number.isFinite(expectedDurationSeconds) || expectedDurationSeconds <= 0) throw new Error('Expected media duration is invalid');
    const tolerance = Math.max(2, expectedDurationSeconds * 0.1);
    if (Math.abs(durationSeconds - expectedDurationSeconds) > tolerance) throw new Error('Media duration is outside the accepted tolerance');
  }
  const formats = String(document.format?.format_name ?? '').split(',');
  const container = formats.some(name => name === 'mp4') ? (kind === 'audio' ? 'm4a' : 'mp4')
    : formats.find(Boolean) ?? '';
  if (!container || !/^[a-zA-Z0-9._+-]{1,64}$/.test(container)) throw new Error('Media container is invalid');
  return {
    durationMs: Math.round(durationSeconds * 1000),
    container,
    ...(video ? { width: Number(video.width), height: Number(video.height), videoCodec: String(video.codec_name ?? '') } : {}),
    ...(audio ? { audioCodec: String(audio.codec_name ?? '') } : {}),
    hasAudio: Boolean(audio),
    hasVideo: Boolean(video),
  };
}
