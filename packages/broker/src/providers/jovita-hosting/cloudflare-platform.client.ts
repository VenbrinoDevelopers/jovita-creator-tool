import { BadGatewayException } from '@nestjs/common';
import { fetchJson } from '../../cloud/saas-store/capabilities/capability-utils.js';
import type { HostingControlPlaneConfig, JsonObject, JsonValue } from './jovita-hosting.types.js';
import { objectValue, optionalString, stringValue } from './jovita-hosting.types.js';

export class CloudflarePlatformApi {
  constructor(private readonly config: HostingControlPlaneConfig) {}

  async testAccess(signal?: AbortSignal): Promise<void> {
    await this.api(`/zones/${encodeURIComponent(this.config.cloudflareZoneId)}`, {}, signal);
  }

  async createCustomHostname(
    hostname: string,
    signal?: AbortSignal,
    validationMethod: 'http' | 'txt' = 'txt',
  ): Promise<JsonObject> {
    return this.api(`/zones/${encodeURIComponent(this.config.cloudflareZoneId)}/custom_hostnames`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        hostname,
        custom_origin_server: this.config.fallbackHostname,
        ssl: { method: validationMethod, type: 'dv', settings: { min_tls_version: '1.2' } },
      }),
    }, signal);
  }

  async ensureCustomHostname(
    hostname: string,
    signal?: AbortSignal,
    validationMethod: 'http' | 'txt' = 'txt',
  ): Promise<JsonObject> {
    const existing = await this.findCustomHostname(hostname, signal);
    return existing ?? this.createCustomHostname(hostname, signal, validationMethod);
  }

  async getCustomHostname(id: string, signal?: AbortSignal): Promise<JsonObject> {
    return this.api(
      `/zones/${encodeURIComponent(this.config.cloudflareZoneId)}/custom_hostnames/${encodeURIComponent(id)}`,
      {},
      signal,
    );
  }

  async deleteCustomHostname(id: string, signal?: AbortSignal): Promise<void> {
    await this.api(
      `/zones/${encodeURIComponent(this.config.cloudflareZoneId)}/custom_hostnames/${encodeURIComponent(id)}`,
      { method: 'DELETE' },
      signal,
    );
  }

  async routingStatus(hostname: string, signal?: AbortSignal): Promise<'active' | 'pending'> {
    const target = normalizeDns(this.config.fallbackHostname);
    const cnames = await this.dnsAnswers(hostname, 'CNAME', signal);
    if (cnames.some((answer) => normalizeDns(answer) === target)) return 'active';

    const [hostA, fallbackA, hostAaaa, fallbackAaaa] = await Promise.all([
      this.dnsAnswers(hostname, 'A', signal),
      this.dnsAnswers(target, 'A', signal),
      this.dnsAnswers(hostname, 'AAAA', signal),
      this.dnsAnswers(target, 'AAAA', signal),
    ]);
    const fallbackAddresses = new Set([...fallbackA, ...fallbackAaaa].map(normalizeDns));
    return [...hostA, ...hostAaaa].some((address) => fallbackAddresses.has(normalizeDns(address)))
      ? 'active'
      : 'pending';
  }

  domainState(result: JsonObject, routingStatus: 'active' | 'pending'): JsonObject {
    const ssl = result.ssl && typeof result.ssl === 'object' && !Array.isArray(result.ssl)
      ? result.ssl as JsonObject
      : {};
    const hostnameStatus = optionalString(result.status) ?? 'pending';
    const sslStatus = optionalString(ssl.status) ?? 'pending';
    const validationRecords: JsonValue[] = [];
    if (result.ownership_verification && typeof result.ownership_verification === 'object') {
      validationRecords.push(normalizeJson(result.ownership_verification));
    }
    if (Array.isArray(ssl.validation_records)) {
      validationRecords.push(...ssl.validation_records.map(normalizeJson));
    }
    const hostname = stringValue(result.hostname, 'custom hostname');
    return {
      cloudflare_hostname_id: stringValue(result.id, 'custom hostname id'),
      hostname,
      ownership_status: hostnameStatus === 'active' ? 'active' : hostnameStatus === 'blocked' ? 'failed' : 'pending',
      ssl_status: sslStatus === 'active' ? 'active' : sslStatus === 'failed' ? 'failed' : 'pending',
      routing_status: routingStatus,
      validation_records: validationRecords,
      dns_records: [{
        type: 'CNAME',
        name: hostname,
        value: this.config.fallbackHostname,
        status: routingStatus === 'active' ? 'verified_dns' : 'pending_dns',
      }],
    };
  }

  private async api(path: string, init: RequestInit = {}, signal?: AbortSignal): Promise<JsonObject> {
    const response = await this.safeApiFetch(`https://api.cloudflare.com/client/v4${path}`, {
      ...init,
      headers: this.headers(init.headers),
      signal,
    }, signal);
    const envelope = objectValue(response.body, 'Cloudflare API response');
    if (envelope.success !== true) {
      throw new BadGatewayException('Cloudflare API rejected the request');
    }
    return envelope.result == null ? {} : objectValue(envelope.result, 'Cloudflare API result');
  }

  private async findCustomHostname(hostname: string, signal?: AbortSignal): Promise<JsonObject | undefined> {
    const query = new URLSearchParams({ hostname });
    const response = await this.safeApiFetch(
      `https://api.cloudflare.com/client/v4/zones/${encodeURIComponent(this.config.cloudflareZoneId)}/custom_hostnames?${query}`,
      { headers: this.headers(), signal },
      signal,
    );
    const envelope = objectValue(response.body, 'Cloudflare API response');
    if (envelope.success !== true || !Array.isArray(envelope.result)) {
      throw new BadGatewayException('Cloudflare API returned an invalid custom-hostname list');
    }
    const found = envelope.result.find((entry) => entry
      && typeof entry === 'object'
      && !Array.isArray(entry)
      && optionalString((entry as JsonObject).hostname)?.toLowerCase() === hostname.toLowerCase());
    return found ? objectValue(found, 'Cloudflare custom hostname') : undefined;
  }

  private async safeApiFetch(url: string, init: RequestInit, signal?: AbortSignal) {
    const method = String(init.method ?? 'GET').toUpperCase();
    const attempts = method === 'GET' || method === 'HEAD' ? 3 : 1;
    let lastError: unknown;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        return await fetchJson(url, init);
      } catch (error) {
        lastError = error;
        if (signal?.aborted || attempt === attempts - 1) throw error;
        await new Promise((resolve) => setTimeout(resolve, 150 * (attempt + 1)));
      }
    }
    throw lastError;
  }

  private async dnsAnswers(hostname: string, type: 'A' | 'AAAA' | 'CNAME', signal?: AbortSignal): Promise<string[]> {
    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const response = await fetchJson(
          `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(hostname)}&type=${type}`,
          { headers: { Accept: 'application/dns-json' }, signal },
        );
        const answers = response.body.Answer;
        if (!Array.isArray(answers)) return [];
        return answers.flatMap((answer) => {
          if (!answer || typeof answer !== 'object' || Array.isArray(answer)) return [];
          const data = optionalString((answer as JsonObject).data);
          return data ? [data] : [];
        });
      } catch (error) {
        lastError = error;
        if (signal?.aborted || attempt === 2) throw error;
        await new Promise((resolve) => setTimeout(resolve, 100 * (attempt + 1)));
      }
    }
    throw lastError;
  }

  private headers(extra?: HeadersInit): Headers {
    const headers = new Headers(extra);
    headers.set('Authorization', `Bearer ${this.config.cloudflareApiToken}`);
    headers.set('Accept', 'application/json');
    return headers;
  }
}

function normalizeDns(value: string): string {
  return value.trim().toLowerCase().replace(/\.$/, '');
}

function normalizeJson(value: unknown): JsonValue {
  if (value === undefined) return null;
  if (value === null) return null;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.map(normalizeJson);
  if (typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, normalizeJson(item)]));
  }
  return String(value);
}
