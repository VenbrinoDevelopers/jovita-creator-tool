import { BadRequestException } from '@nestjs/common';

export type CapabilityPayload = Record<string, unknown>;

export interface HostingCapabilityContext {
  tenantId: string;
  signal?: AbortSignal;
}

export interface HostingControlPlaneConfig {
  workerControlUrl: string;
  workerControlSecret: string;
  cloudflareApiToken: string;
  cloudflareAccountId: string;
  cloudflareZoneId: string;
  fallbackHostname: string;
  sitesBaseDomain: string;
}

export interface JsonObject { [key: string]: JsonValue }
export type JsonValue = string | number | boolean | null | JsonObject | JsonValue[];

export function objectValue(value: unknown, name = 'value'): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new BadRequestException(`${name} must be an object`);
  }
  return value as JsonObject;
}

export function stringValue(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new BadRequestException(`${name} is required`);
  }
  return value.trim();
}

export function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

export function normalizeHostname(value: unknown, name: string): string {
  const hostname = stringValue(value, name).toLowerCase().replace(/\.$/, '');
  if (!/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(hostname)) {
    throw new BadRequestException(`${name} must be a valid hostname`);
  }
  return hostname;
}
