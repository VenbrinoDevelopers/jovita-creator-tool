import { BadRequestException, BadGatewayException } from '@nestjs/common';
import { builtinProviderBaseUrl } from '../catalog/builtin-provider-catalog.js';

type CredentialTestDefinition = Readonly<{
  providerId: string;
  method: 'GET' | 'HEAD';
  path: string;
  auth: 'bearer' | 'xi-api-key';
  maxKeyLength: number;
  accountStatus?: { path: string; balanceField: string; currencyField: string;
    balanceScale: number; maxBalance: number };
}>;

/** Fixed, reviewed probes. A creator's test never supplies a URL or auth header. */
const DEFINITIONS: Readonly<Record<string, CredentialTestDefinition>> = {
  elevenlabs: { providerId: 'elevenlabs', method: 'GET', path: '/v1/user',
    auth: 'xi-api-key', maxKeyLength: 500 },
  recraft: { providerId: 'recraft', method: 'GET', path: '/users/me',
    auth: 'bearer', maxKeyLength: 500 },
};

export const credentialFields = [{ key: 'apiKey', label: 'API key', type: 'secret' as const, required: true }];

export function hasCredentialTest(providerId: string): boolean { return providerId in DEFINITIONS; }
export function hasAccountStatusDefinition(providerId: string): boolean {
  return Boolean(DEFINITIONS[providerId]?.accountStatus);
}

export function validateCredentialDefinition(providerId: string, config: Record<string, unknown>): void {
  const definition = DEFINITIONS[providerId];
  if (!definition) throw new BadRequestException(`Provider credential test is not registered: ${providerId}`);
  const apiKey = config.apiKey;
  if (typeof apiKey !== 'string' || !apiKey.trim() || apiKey.length > definition.maxKeyLength || /[\r\n]/.test(apiKey)) {
    throw new BadRequestException(`${providerId} apiKey is required`);
  }
}

export async function runCredentialTest(providerId: string, config: Record<string, unknown>, signal?: AbortSignal): Promise<void> {
  validateCredentialDefinition(providerId, config);
  const definition = DEFINITIONS[providerId]!;
  const url = `${builtinProviderBaseUrl(providerId)}${definition.path}`;
  const headers = definition.auth === 'bearer'
    ? { authorization: `Bearer ${String(config.apiKey)}` }
    : { 'xi-api-key': String(config.apiKey) };
  const response = await fetch(url, { method: definition.method, headers, redirect: 'error',
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000) });
  await response.body?.cancel();
  if (!response.ok) throw new BadGatewayException({ code: 'PROVIDER_CREDENTIAL_TEST_FAILED',
    message: `${providerId} credential test returned HTTP ${response.status}` });
}

export async function readProviderAccountStatus(providerId: string, config: Record<string, unknown>, signal?: AbortSignal) {
  validateCredentialDefinition(providerId, config);
  const definition = DEFINITIONS[providerId];
  const status = definition?.accountStatus;
  if (!status) throw new BadRequestException(`Provider account status is not registered: ${providerId}`);
  const response = await fetch(`${builtinProviderBaseUrl(providerId)}${status.path}`, {
    method: 'GET', headers: { authorization: `Bearer ${String(config.apiKey)}` }, redirect: 'error',
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000),
  });
  if (!response.ok) { await response.body?.cancel(); throw new BadGatewayException('Provider account status failed'); }
  const parts: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of response.body ?? []) {
    size += chunk.length;
    if (size > 32_768) { await response.body?.cancel(); throw new BadGatewayException('Provider account response is too large'); }
    parts.push(chunk);
  }
  let body: unknown;
  try { body = JSON.parse(Buffer.concat(parts).toString('utf8')); }
  catch { throw new BadGatewayException('Provider returned invalid account status'); }
  const field = (path: string) => path.split('.').reduce<unknown>((value, key) => value
    && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)[key] : undefined, body);
  const balance = Number(field(status.balanceField));
  if (!Number.isFinite(balance) || balance < 0 || balance > status.maxBalance) {
    throw new BadGatewayException('Provider returned an invalid account balance');
  }
  return { providerId, balanceMicros: Math.ceil(balance * status.balanceScale),
    currency: String(field(status.currencyField) ?? 'USD') };
}
