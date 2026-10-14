import { BadGatewayException, BadRequestException, ForbiddenException } from '@nestjs/common';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import ipaddr from 'ipaddr.js';
import { Agent, FormData, fetch as providerFetch } from 'undici';
import { SecretCryptoService } from '../security/secret-crypto.service.js';
import { ProviderOutcomeUnknownError } from '../contracts/capability.js';
import { BrokerConnection, BrokerProviderProfile } from '../catalog/broker-catalog.schema.js';
import type { RuntimeOperationPlan } from './broker-operation-plan.js';
import { extractMediaResult, prepareMediaRequest } from './media-presets.js';
import { stageProviderMedia } from './provider-media.js';

/** Bounded, DNS-checked transport for all declared external HTTP operations. */
export class BrokerHttpTransport {
  constructor(private readonly crypto: SecretCryptoService) {}

  async downloadMedia(profile: BrokerProviderProfile, connection: BrokerConnection,
    path: string, jobId: string, kind: 'video' | 'audio', maxBytes: number, destination: string,
    timeoutMs = profile.timeoutMs) {
    const base = new URL(profile.baseUrl);
    await this.assertPublicHost(base.hostname);
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(jobId)) throw new BadRequestException('Invalid provider job ID');
    const url = new URL(path.replace('{job_id}', encodeURIComponent(jobId)).slice(1), base);
    if (url.origin !== base.origin) throw new ForbiddenException('Download host changed');
    const key = this.crypto.decrypt(connection.encryptedApiKey);
    const headers = profile.authMethod === 'bearer'
      ? { authorization: `Bearer ${key}` } : { [profile.authHeader!]: key };
    const dispatcher = new Agent({ connect: { lookup: (hostname, options, callback) => {
      void lookup(hostname, { all: true, family: typeof options === 'object' ? options.family : 0 })
        .then(addresses => {
          if (!addresses.length || addresses.some(address => !this.publicAddress(address.address))) {
            callback(new Error('Provider address is not public'), '', 0);
          } else if (typeof options === 'object' && options.all) {
            callback(null, addresses);
          } else callback(null, addresses[0]!.address, addresses[0]!.family);
        }).catch(error => callback(error, '', 0));
    } } });
    try {
      const response = await providerFetch(url, { method: 'GET', headers, redirect: 'error',
        signal: AbortSignal.timeout(timeoutMs), dispatcher });
      if (!response.ok) {
        await response.body?.cancel();
        throw new BadGatewayException({ code: 'PROVIDER_DOWNLOAD_FAILED',
          message: `Provider returned HTTP ${response.status}` });
      }
      return await stageProviderMedia(response as Response, destination, kind, maxBytes);
    } finally { await dispatcher.close(); }
  }

  async providerRequest(profile: BrokerProviderProfile, connection: BrokerConnection,
    operation: RuntimeOperationPlan, payload: Record<string, unknown>, maxRequestMs?: number,
    acceptedStatuses?: readonly number[]) {
    const base = new URL(profile.baseUrl);
    await this.assertPublicHost(base.hostname);
    const { url, body: mappedBody } = this.mapRequest(base, operation, payload);
    const body = operation.mediaPreset ? await prepareMediaRequest(operation.mediaPreset, payload)
      : operation.requestMapping ? this.mappedBody(operation.requestMapping, payload)
        : operation.executionKind === 'named-run'
          ? { provider: operation.providerName, endpoint: operation.endpoint, input: payload } : mappedBody;
    if (url.origin !== base.origin) throw new ForbiddenException('Operation host changed');
    const key = this.crypto.decrypt(connection.encryptedApiKey);
    const headers: Record<string, string> = { accept: operation.executionKind === 'http-sse'
      ? 'text/event-stream' : operation.executionKind === 'http-binary' ? '*/*' : 'application/json' };
    if (profile.authMethod === 'bearer') headers.authorization = `Bearer ${key}`;
    else headers[profile.authHeader!] = key;
    let requestBody: string | Buffer | FormData | undefined;
    if (operation.method !== 'GET') {
      if (operation.executionKind === 'http-multipart') requestBody = this.multipartBody(body, operation.maxRequestBytes);
      else if (operation.executionKind === 'http-binary') {
        if (Object.keys(body).some(field => !['dataBase64', 'contentType'].includes(field))
          || typeof body.dataBase64 !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(body.dataBase64)) {
          throw new BadRequestException('Binary input requires base64 data and an optional content type');
        }
        headers['content-type'] = this.contentType(body.contentType, 'application/octet-stream');
        requestBody = Buffer.from(body.dataBase64, 'base64');
      } else {
        headers['content-type'] = 'application/json';
        requestBody = JSON.stringify(body);
      }
      this.assertOutgoingRequestSize(requestBody, operation.maxRequestBytes);
    }
    const dispatcher = new Agent({ connect: { lookup: (hostname, options, callback) => {
        void lookup(hostname, { all: true, family: typeof options === 'object' ? options.family : 0 })
          .then(addresses => {
            if (!addresses.length || addresses.some(address => !this.publicAddress(address.address))) {
              callback(new Error('Provider address is not public'), '', 0);
            } else if (typeof options === 'object' && options.all) {
              callback(null, addresses);
            } else callback(null, addresses[0]!.address, addresses[0]!.family);
          }).catch(error => callback(error, '', 0));
      } } });
    try {
      const response = await providerFetch(url, { method: operation.method, headers,
        body: requestBody,
        redirect: 'error', signal: AbortSignal.timeout(Math.min(profile.timeoutMs, maxRequestMs ?? profile.timeoutMs)), dispatcher });
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of response.body ?? []) {
        const bytes = Buffer.from(chunk);
        size += bytes.length;
        if (size > operation.maxResponseBytes) throw new BadGatewayException('Provider response exceeded its limit');
        chunks.push(bytes);
      }
      if (!response.ok && !acceptedStatuses?.includes(response.status)) {
        if (operation.method !== 'GET' && (response.status >= 500 || response.status === 408)) {
          throw new ProviderOutcomeUnknownError('Provider may have accepted the request before returning an error');
        }
        throw new BadGatewayException({ code: 'PROVIDER_REJECTED', message: `Provider returned HTTP ${response.status}` });
      }
      if (!size) {
        if (operation.executionKind === 'http-poll' || operation.executionKind === 'named-run') throw new ProviderOutcomeUnknownError('Provider accepted a job without a readable run ID');
        if (operation.emptyResultIsNoResult) return {};
        throw new BadGatewayException({ code: 'PROVIDER_EMPTY_RESPONSE', message: 'Provider returned no result' });
      }
      const bytes = Buffer.concat(chunks, size);
      if (operation.executionKind === 'http-binary') {
        return { dataBase64: bytes.toString('base64'),
          contentType: this.contentType(response.headers.get('content-type')?.split(';', 1)[0], 'application/octet-stream') };
      }
      if (operation.executionKind === 'http-sse') return this.streamEvents(bytes.toString('utf8'));
      let parsed: unknown;
      try { parsed = JSON.parse(bytes.toString('utf8')); }
      catch {
        if (operation.method !== 'GET') throw new ProviderOutcomeUnknownError('Provider accepted a request but returned unreadable JSON');
        throw new BadGatewayException('Provider returned invalid JSON');
      }
      if (operation.mediaPreset) {
        const row = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
          ? parsed as Record<string, unknown> : {};
        const image = row.image && typeof row.image === 'object' && !Array.isArray(row.image)
          ? row.image as Record<string, unknown> : {};
        const requestId = String(image.id ?? response.headers.get('x-request-id') ?? '').trim();
        return { __brokerResult: await extractMediaResult(operation.mediaPreset, parsed),
          __brokerRequestId: requestId || undefined };
      }
      return acceptedStatuses?.includes(response.status) && parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? { ...parsed, __httpStatus: response.status } : parsed;
    } finally { await dispatcher.close(); }
  }

  private multipartBody(fields: Record<string, unknown>, maxBytes: number): FormData {
    const form = new FormData();
    let estimatedBytes = 0;
    for (const [name, value] of Object.entries(fields)) {
      if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(name)) throw new BadRequestException('Invalid multipart field');
      if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
        const textValue = String(value);
        estimatedBytes += Buffer.byteLength(name) + Buffer.byteLength(textValue) + 1_024;
        if (estimatedBytes > maxBytes) throw new BadRequestException('Multipart operation request is too large');
        form.append(name, textValue);
        continue;
      }
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new BadRequestException('Invalid multipart value');
      const file = value as Record<string, unknown>;
      if (Object.keys(file).some(key => !['dataBase64', 'filename', 'contentType'].includes(key))
        || typeof file.dataBase64 !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(file.dataBase64)
        || typeof file.filename !== 'string' || !/^[A-Za-z0-9._-]{1,128}$/.test(file.filename)) {
        throw new BadRequestException('Invalid multipart file');
      }
      const bytes = Buffer.from(file.dataBase64, 'base64');
      estimatedBytes += Buffer.byteLength(name) + Buffer.byteLength(file.filename) + bytes.length + 1_024;
      if (estimatedBytes > maxBytes) throw new BadRequestException('Multipart operation request is too large');
      form.append(name, new Blob([bytes],
        { type: this.contentType(file.contentType, 'application/octet-stream') }), file.filename);
    }
    return form;
  }

  private assertOutgoingRequestSize(body: string | Buffer | FormData | undefined, maxBytes: number): void {
    // Multipart is bounded while its fields are assembled above. Mapping may
    // duplicate input values, so the incoming JSON size alone is insufficient.
    if ((typeof body === 'string' || Buffer.isBuffer(body)) && Buffer.byteLength(body) > maxBytes) {
      throw new BadRequestException('Mapped operation request is too large');
    }
  }

  private streamEvents(body: string): { events: unknown[] } {
    const events: unknown[] = [];
    for (const block of body.split(/\r?\n\r?\n/)) {
      const data = block.split(/\r?\n/).filter(line => line.startsWith('data:'))
        .map(line => line.slice(5).trimStart()).join('\n');
      if (!data || data === '[DONE]') continue;
      try { events.push(JSON.parse(data)); } catch { events.push(data); }
    }
    if (!events.length) throw new BadGatewayException('Provider stream contained no result');
    return { events };
  }

  private contentType(value: unknown, fallback: string): string {
    if (value == null || value === '') return fallback;
    if (typeof value !== 'string' || !/^[A-Za-z0-9.+-]+\/[A-Za-z0-9.+-]+(?:;\s*charset=[A-Za-z0-9_-]+)?$/.test(value)) {
      throw new BadRequestException('Invalid content type');
    }
    return value;
  }

  private mapRequest(base: URL, operation: RuntimeOperationPlan, payload: Record<string, unknown>) {
    const pathFields = new Set<string>();
    const path = operation.path.replace(/\{([a-z][a-z0-9_]{0,63})\}/g, (_match, field: string) => {
      const value = payload[field];
      if ((typeof value !== 'string' && typeof value !== 'number') || !String(value).trim()
        || value === '.' || value === '..' || String(value).length > 128) {
        throw new BadRequestException(`Invalid path field: ${field}`);
      }
      pathFields.add(field);
      return encodeURIComponent(String(value));
    });
    const url = new URL(path.slice(1), base);
    const queryFields = new Set(operation.queryFields ?? []);
    const body: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(payload)) {
      if (pathFields.has(key)) continue;
      if (operation.method === 'GET' || queryFields.has(key)) {
        if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
          throw new BadRequestException(`Query field must be a string, number or boolean: ${key}`);
        }
        url.searchParams.set(key, String(value));
      } else body[key] = value;
    }
    return { url, body };
  }

  private mappedBody(mapping: NonNullable<RuntimeOperationPlan['requestMapping']>,
    payload: Record<string, unknown>): Record<string, unknown> {
    const body: Record<string, unknown> = {};
    for (const [field, spec] of Object.entries(mapping.body)) {
      const value = 'const' in spec ? spec.const : spec.from === '$' ? payload : this.readField(payload, spec.from);
      if (value === undefined) throw new BadRequestException(`Mapped input is missing: ${field}`);
      body[field] = value;
    }
    return body;
  }

  readField(value: unknown, path: string): unknown {
    return path.split('.').reduce<unknown>((current, field) => current && typeof current === 'object'
      && !Array.isArray(current) ? (current as Record<string, unknown>)[field] : undefined, value);
  }

  async assertPublicHost(host: string) {
    if (!host || host === 'localhost' || isIP(host) || !host.includes('.')) throw new BadRequestException('Provider must use a public DNS host');
    const addresses = await lookup(host, { all: true });
    if (!addresses.length || addresses.some(item => !this.publicAddress(item.address))) throw new BadRequestException('Provider host resolves to a restricted address');
  }
  publicAddress(address: string) {
    try {
      const parsed = ipaddr.parse(address);
      return parsed.range() === 'unicast';
    } catch { return false; }
  }
}
