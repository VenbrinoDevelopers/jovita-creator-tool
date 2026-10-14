import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import ipaddr from 'ipaddr.js';
import { Agent, fetch } from 'undici';
import type { MediaConfig } from '../core/config/types/index.js';

export type FetchUrlFailureReason = 'invalid_url' | 'blocked_url' | 'redirect_failed' | 'fetch_failed' | 'http_error' | 'too_large' | 'empty';
export type FetchUrlBytesResult = { bytes: Uint8Array } | { reason: FetchUrlFailureReason };
export type FetchUrlResourceResult =
  | { bytes: Uint8Array; finalUrl: string; contentType: string }
  | { reason: FetchUrlFailureReason };

export async function fetchUrlBytesResult(url: string, maxBytes: number, media: MediaConfig): Promise<FetchUrlBytesResult> {
  const result = await fetchUrlResourceResult(url, maxBytes, media);
  return 'bytes' in result ? { bytes: result.bytes } : result;
}

export async function fetchUrlResourceResult(
  url: string,
  maxBytes: number,
  media: MediaConfig,
): Promise<FetchUrlResourceResult> {
  let current = url;
  const visited = new Set<string>();
  const signal = AbortSignal.timeout(media.timeoutMs);

  for (let redirects = 0; redirects <= media.maxRedirects; redirects += 1) {
    const uri = parseHttpUrl(current);
    if (!uri) return { reason: 'invalid_url' };
    const addresses = await resolvePublicAddresses(uri.hostname, signal);
    if (addresses.length === 0) return { reason: 'blocked_url' };
    let cursor = 0;
    const dispatcher = new Agent({
      connectTimeout: media.timeoutMs,
      headersTimeout: media.timeoutMs,
      bodyTimeout: media.timeoutMs,
      maxResponseSize: maxBytes,
      connect: {
        lookup: (_host, options, callback) => {
          const ordered = addresses.slice(cursor).concat(addresses.slice(0, cursor));
          cursor = (cursor + 1) % addresses.length;
          if (options.all) callback(null, ordered as never);
          else callback(null, ordered[0]!.address, ordered[0]!.family);
        },
      },
    });

    try {
      const response = await fetch(uri, {
        method: 'GET', redirect: 'manual', signal, dispatcher,
        headers: { 'user-agent': 'jovita-server/1.0', accept: '*/*' },
      });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get('location');
        await response.body?.cancel();
        if (!location || redirects === media.maxRedirects) return { reason: 'redirect_failed' };
        const next = new URL(location, uri).toString();
        if (visited.has(next)) return { reason: 'redirect_failed' };
        visited.add(next);
        current = next;
        continue;
      }
      if (!response.ok) {
        await response.body?.cancel();
        return { reason: 'http_error' };
      }
      const contentLength = Number(response.headers.get('content-length') ?? 0);
      if (contentLength > maxBytes) {
        await response.body?.cancel();
        return { reason: 'too_large' };
      }
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.byteLength === 0) return { reason: 'empty' };
      if (bytes.byteLength > maxBytes) return { reason: 'too_large' };
      return {
        bytes,
        finalUrl: uri.toString(),
        contentType: String(response.headers.get('content-type') ?? '').trim().toLowerCase(),
      };
    } catch {
      return { reason: 'fetch_failed' };
    } finally {
      await dispatcher.close().catch(() => undefined);
    }
  }
  return { reason: 'redirect_failed' };
}

export async function fetchUrlBytes(url: string, maxBytes: number, media: MediaConfig): Promise<Uint8Array | undefined> {
  const result = await fetchUrlBytesResult(url, maxBytes, media);
  return 'bytes' in result ? result.bytes : undefined;
}

function parseHttpUrl(value: string): URL | undefined {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url : undefined;
  } catch {
    return undefined;
  }
}

async function resolvePublicAddresses(hostname: string, signal: AbortSignal): Promise<Array<{ address: string; family: 4 | 6 }>> {
  const host = hostname.trim().toLowerCase().replace(/\.$/, '');
  if (!host || host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal')) return [];
  if (isIP(host)) return isPrivateIp(host) ? [] : [{ address: host, family: isIP(host) as 4 | 6 }];
  try {
    const records = await raceWithAbort(lookup(host, { all: true, verbatim: true }), signal);
    if (records.length === 0 || records.some((record) => isPrivateIp(record.address))) return [];
    return records.map((record) => ({ address: record.address, family: record.family as 4 | 6 }));
  } catch {
    return [];
  }
}

async function raceWithAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw new Error('dns_timeout');
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new Error('dns_timeout'));
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

function isPrivateIp(ip: string): boolean {
  try {
    return ipaddr.parse(ip).range() !== 'unicast';
  } catch {
    return true;
  }
}
