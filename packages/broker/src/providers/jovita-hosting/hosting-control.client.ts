import { BadGatewayException } from '@nestjs/common';
import { fetchJson } from '../../cloud/saas-store/capabilities/capability-utils.js';
import type { CapabilityPayload, JsonObject } from './jovita-hosting.types.js';

export class HostingControlClient {
  constructor(
    private readonly baseUrl: URL,
    private readonly secret: string,
  ) {}

  async ping(signal?: AbortSignal): Promise<JsonObject> {
    return this.request('/ping', 'credential-test', 'GET', undefined, signal);
  }

  async request(
    path: string,
    tenantId: string,
    method = 'GET',
    payload?: CapabilityPayload,
    signal?: AbortSignal,
  ): Promise<JsonObject> {
    const url = new URL(`/__jovita/control${path}`, this.baseUrl);
    const response = await fetchJson(url.toString(), {
      method,
      headers: {
        Authorization: `Bearer ${this.secret}`,
        'X-Jovita-Tenant-Id': tenantId,
        Accept: 'application/json',
        ...(payload ? { 'Content-Type': 'application/json' } : {}),
      },
      body: payload ? JSON.stringify(payload) : undefined,
      signal,
    }, { clientErrorMode: 'bad_request' });
    if (!response.body || typeof response.body !== 'object' || Array.isArray(response.body)) {
      throw new BadGatewayException('Hosting control returned an invalid response');
    }
    return response.body as JsonObject;
  }

  async uploadSigned(urlValue: string, bytes: Buffer, contentType: string, signal?: AbortSignal): Promise<JsonObject> {
    let url: URL;
    try { url = new URL(urlValue); } catch { throw new BadGatewayException('Hosting control returned an invalid upload URL'); }
    if (url.protocol !== 'https:' || url.origin !== this.baseUrl.origin
      || !/^\/__jovita\/control\/visual-artifacts\/[0-9a-f-]+\/upload$/i.test(url.pathname)) {
      throw new BadGatewayException('Hosting control returned an untrusted upload URL');
    }
    const response = await fetchJson(url.toString(), {
      method: 'PUT',
      headers: { 'Content-Type': contentType, 'Content-Length': String(bytes.byteLength) },
      body: new Uint8Array(bytes).buffer,
      signal,
    }, { maxResponseBytes: 256 * 1024, timeoutMs: 30_000 });
    if (!response.body || typeof response.body !== 'object' || Array.isArray(response.body)) {
      throw new BadGatewayException('Hosting control returned an invalid upload response');
    }
    return response.body as JsonObject;
  }
}
