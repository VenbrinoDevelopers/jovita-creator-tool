import { BadGatewayException, BadRequestException } from '@nestjs/common';
import { isIP } from 'node:net';
import { Ajv } from 'ajv';
import type { BrokerOperation } from './broker-catalog.schema.js';

const ajv = new Ajv({ allErrors: true, strict: true, removeAdditional: false });
export const SAFE_ID = /^[a-z][a-z0-9_-]{1,63}$/;
export const SAFE_PATH = /^\/(?:[a-zA-Z0-9._~:-]+|\{[a-z][a-z0-9_]{0,63}\})(?:\/(?:[a-zA-Z0-9._~:-]+|\{[a-z][a-z0-9_]{0,63}\}))*\/?$/;

/** Pure contract and manifest validation shared by the catalog authoring flow. */
export class BrokerCatalogRules {
  pollDefinition(value: unknown, method: string): BrokerOperation['poll'] {
    if (method !== 'POST' || !value || typeof value !== 'object' || Array.isArray(value)) {
      throw new BadRequestException('Async operations require POST and poll settings');
    }
    const row = this.objectWithKeys(value, ['path', 'jobIdField', 'statusField', 'resultField',
      'successValue', 'failureValue', 'failureValues', 'providerStatusField', 'noResultStatuses',
      'intervalMs', 'maxAttempts'], 'poll');
    const path = String(row.path ?? '');
    if (!SAFE_PATH.test(path) || path.split('{job_id}').length !== 2 || path.includes('..')) {
      throw new BadRequestException('Poll path must contain {job_id} on the same provider host');
    }
    const jobIdField = this.fieldPath(row.jobIdField);
    const statusField = this.fieldPath(row.statusField);
    const resultField = row.resultField === undefined ? undefined : this.fieldPath(row.resultField);
    const successValue = this.text(row.successValue, 64);
    const failureValue = this.text(row.failureValue, 64);
    const failureValues = row.failureValues === undefined ? undefined : row.failureValues;
    const providerStatusField = row.providerStatusField === undefined ? undefined : this.fieldPath(row.providerStatusField);
    const noResultStatuses = row.noResultStatuses;
    if (noResultStatuses !== undefined && (!providerStatusField || !Array.isArray(noResultStatuses)
      || noResultStatuses.length > 8 || !noResultStatuses.every(status => Number.isSafeInteger(status)
        && status >= 400 && status <= 499) || new Set(noResultStatuses).size !== noResultStatuses.length)) {
      throw new BadRequestException('Invalid no-result provider statuses');
    }
    if (failureValues !== undefined && (!Array.isArray(failureValues) || failureValues.length > 8
      || !failureValues.every(item => typeof item === 'string' && /^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(item))
      || new Set(failureValues.map(item => item.toUpperCase())).size !== failureValues.length
      || failureValues.some(item => item.toUpperCase() === successValue.toUpperCase()))) {
      throw new BadRequestException('Invalid failure states');
    }
    const intervalMs = Number(row.intervalMs);
    const maxAttempts = Number(row.maxAttempts);
    if (successValue.toUpperCase() === failureValue.toUpperCase()
      || !Number.isSafeInteger(intervalMs) || intervalMs < 250
      || intervalMs > 10_000 || !Number.isSafeInteger(maxAttempts) || maxAttempts < 1
      || maxAttempts > 60 || intervalMs * maxAttempts > 120_000) {
      throw new BadRequestException('Invalid poll timing or terminal states');
    }
    return { path, jobIdField, statusField, resultField, successValue, failureValue,
      failureValues: failureValues as string[] | undefined, providerStatusField,
      noResultStatuses: noResultStatuses as number[] | undefined, intervalMs, maxAttempts };
  }

  artifactDefinition(value: unknown, kind: BrokerOperation['executionKind']): BrokerOperation['artifact'] {
    if (kind !== 'http-poll') throw new BadRequestException('A downloadable result requires submit and poll');
    const row = this.objectWithKeys(value, ['path', 'kind', 'maxBytes', 'retentionSeconds', 'timeoutMs'], 'artifact');
    const path = String(row.path ?? '');
    if (!SAFE_PATH.test(path) || path.split('{job_id}').length !== 2 || path.includes('..')) {
      throw new BadRequestException('Download path must contain {job_id} on the same provider host');
    }
    const mediaKind = row.kind;
    if (mediaKind !== 'video' && mediaKind !== 'audio') throw new BadRequestException('Select a reviewed media kind');
    const maxBytes = Number(row.maxBytes);
    const ceiling = mediaKind === 'video' ? 250 * 1024 * 1024 : 100 * 1024 * 1024;
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > ceiling) {
      throw new BadRequestException('Invalid media download limit');
    }
    const retentionSeconds = Number(row.retentionSeconds);
    if (!Number.isSafeInteger(retentionSeconds) || retentionSeconds < 3600 || retentionSeconds > 7 * 86400) {
      throw new BadRequestException('Media retention must be 1 hour to 7 days');
    }
    const timeoutMs = row.timeoutMs === undefined ? undefined : Number(row.timeoutMs);
    if (timeoutMs !== undefined && (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 600_000)) {
      throw new BadRequestException('Invalid media download timeout');
    }
    return { path, kind: mediaKind, maxBytes, retentionSeconds, timeoutMs };
  }

  fieldPath(value: unknown): string {
    const path = String(value ?? '');
    if (!/^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*){0,3}$/.test(path)) {
      throw new BadRequestException('Invalid response field path');
    }
    return path;
  }

  requestMapping(value: unknown, inputSchema: Record<string, unknown>, method: string,
    kind: BrokerOperation['executionKind']): BrokerOperation['requestMapping'] {
    if (method === 'GET' || !['http-json', 'http-poll'].includes(kind)
      || Buffer.byteLength(JSON.stringify(value)) > 4096) {
      throw new BadRequestException('Request mapping requires a bounded JSON POST');
    }
    const mapping = this.objectWithKeys(value, ['body'], 'requestMapping');
    const body = mapping.body;
    if (!body || typeof body !== 'object' || Array.isArray(body)
      || !Object.keys(body).length || Object.keys(body).length > 20) {
      throw new BadRequestException('Request body mapping needs 1 to 20 fields');
    }
    const fields: BrokerOperation['requestMapping'] = { body: {} };
    const properties = inputSchema.properties as Record<string, unknown> | undefined;
    for (const [key, raw] of Object.entries(body)) {
      if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(key)) throw new BadRequestException('Invalid mapped body field');
      const spec = this.objectWithKeys(raw, ['from', 'const'], `requestMapping.body.${key}`);
      if (Object.keys(spec).length !== 1) throw new BadRequestException('Mapped field needs exactly one source');
      if ('from' in spec) {
        const source = String(spec.from ?? '');
        if (source !== '$') {
          this.fieldPath(source);
          if (!properties || !(source.split('.')[0]! in properties)) {
            throw new BadRequestException('Mapped input field must be declared in the input schema');
          }
        }
        fields.body[key] = { from: source };
      } else {
        if (!['string', 'number', 'boolean'].includes(typeof spec.const)
          || (typeof spec.const === 'string' && spec.const.length > 512)
          || (typeof spec.const === 'number' && !Number.isFinite(spec.const))) {
          throw new BadRequestException('Mapped constant must be a bounded scalar');
        }
        fields.body[key] = { const: spec.const as string | number | boolean };
      }
    }
    return fields;
  }

  validate(schema: Record<string, unknown>, value: unknown, label: string) {
    const validator = ajv.compile(schema);
    if (!validator(value)) {
      if (label === 'input') throw new BadRequestException('Operation input failed its schema');
      throw new BadGatewayException('Provider output failed its schema');
    }
  }
  schema(value: unknown, input: boolean) {
    if (!value || typeof value !== 'object' || Array.isArray(value) || Buffer.byteLength(JSON.stringify(value)) > 16_384) throw new BadRequestException('Invalid JSON schema');
    if (this.containsCredentialField(value)) throw new BadRequestException('Credential fields belong in saved connections');
    const schema = value as Record<string, unknown>;
    if (input && (schema.type !== 'object' || schema.additionalProperties !== false)) {
      throw new BadRequestException('Input schema must be a closed object');
    }
    try { ajv.compile(schema); } catch { throw new BadRequestException('Invalid JSON schema'); }
    return schema;
  }
  objectWithKeys(value: unknown, keys: string[], label: string): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new BadRequestException(`${label} must be an object`);
    const record = value as Record<string, unknown>;
    if (Object.keys(record).some(key => !keys.includes(key))) {
      throw new BadRequestException(`${label} contains an unsupported field; credentials belong in saved connections`);
    }
    return record;
  }
  containsCredentialField(value: unknown): boolean {
    if (Array.isArray(value)) return value.some(item => this.containsCredentialField(item));
    if (!value || typeof value !== 'object') return false;
    return Object.entries(value).some(([key, item]) => /^(?:api_?key|access_?token|refresh_?token|secret|password|authorization|credential)$/i.test(key)
      || this.containsCredentialField(item));
  }
  baseUrl(value: unknown, directory = false) {
    let url: URL;
    try { url = new URL(String(value ?? '')); } catch { throw new BadRequestException('Invalid HTTPS URL'); }
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || isIP(url.hostname)) throw new BadRequestException('Use a public HTTPS URL');
    if (directory && !url.pathname.endsWith('/')) url.pathname += '/';
    return url.toString();
  }
  id(value: unknown, label: string) {
    const id = String(value ?? '');
    if (!SAFE_ID.test(id)) throw new BadRequestException(`Invalid ${label}`);
    return id;
  }
  text(value: unknown, max: number) {
    const result = String(value ?? '').trim();
    if (!result || result.length > max) throw new BadRequestException('Invalid text field');
    return result;
  }
  limit(value: unknown, min: number, max: number, fallback: number) {
    const limit = Number(value ?? fallback);
    if (!Number.isSafeInteger(limit) || limit < min || limit > max) throw new BadRequestException('Invalid operation limit');
    return limit;
  }
  minimumBuyerCredits(): number {
    const creditsPerUsd = Number(process.env.JOVITA_CREDITS_PER_USD ?? 500);
    return Number.isSafeInteger(creditsPerUsd) && creditsPerUsd > 0
      ? Math.ceil(creditsPerUsd / 100) : 5;
  }}
