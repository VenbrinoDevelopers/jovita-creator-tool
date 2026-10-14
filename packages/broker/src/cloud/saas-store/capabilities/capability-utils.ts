import { BadGatewayException, BadRequestException } from '@nestjs/common';
import type { Dispatcher } from 'undici';
import { ProviderOutcomeUnknownError } from './capability-operation.types.js';

const DEFAULT_MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const MAX_PROVIDER_TIMEOUT_MS = 600_000;
const SAFE_RETRY_ATTEMPTS = 2;
const PRE_DISPATCH_TRANSPORT_CODES = new Set([
    'ENOTFOUND',
    'EAI_AGAIN',
    'ECONNREFUSED',
    'UND_ERR_CONNECT_TIMEOUT',
    'CERT_HAS_EXPIRED',
    'DEPTH_ZERO_SELF_SIGNED_CERT',
    'ERR_TLS_CERT_ALTNAME_INVALID',
    'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
]);

type FetchProviderOptions = {
    maxResponseBytes?: number;
    timeoutMs?: number;
    retryResponseStatuses?: readonly number[];
    clientErrorMode?: 'provider_unavailable' | 'bad_request';
    clientErrorFactory?: (details: ProviderClientErrorDetails) => Error;
    acceptedResponseStatuses?: readonly number[];
    dispatcher?: Dispatcher;
};

export type ProviderClientErrorDetails = {
    providerStatus: number;
    providerMessage?: string;
    providerCode?: string;
    providerReason?: string;
};

type ProviderRequestInit = RequestInit & { dispatcher?: Dispatcher };

export async function fetchJson(
    url: string,
    init: RequestInit,
    options: FetchProviderOptions = {},
): Promise<{
    body: Record<string, unknown>;
    requestId?: string;
    headers: Record<string, string>;
    status: number;
}> {
    const response = await fetchProviderResponse(url, init, options);
    const body = await parseProviderJsonResponse(
        response,
        options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES,
        options.clientErrorMode,
        options.clientErrorFactory,
        options.acceptedResponseStatuses,
    );
    return { body, requestId: providerRequestId(response), headers: Object.fromEntries(response.headers.entries()), status: response.status };
}

export async function fetchJsonEventStream(
    url: string,
    init: RequestInit,
    options: FetchProviderOptions = {},
): Promise<{
    events: Record<string, unknown>[];
    requestId?: string;
}> {
    const response = await fetchProviderResponse(url, init, options);
    const maxResponseBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
    if (!response.ok) {
        await parseProviderJsonResponse(
            response,
            maxResponseBytes,
            options.clientErrorMode,
            options.clientErrorFactory,
        );
        throw new BadGatewayException('Provider stream did not produce a successful response');
    }
    let raw: string;
    try {
        raw = await readBounded(response, maxResponseBytes);
    } catch (error) {
        const diagnostics = transportDiagnostics(error);
        throw new ProviderOutcomeUnknownError(
            'Provider stream ended before its result could be captured safely',
            error,
            {
                ...diagnostics,
                code: diagnostics.code ?? 'PROVIDER_STREAM_CAPTURE_FAILED',
                phase: 'response_stream',
                maxResponseBytes: String(maxResponseBytes),
            },
        );
    }
    try {
        const events = parseJsonEventStream(raw);
        if (events.length === 0) {
            throw new Error('Provider stream contained no JSON events');
        }
        return { events, requestId: providerRequestId(response) };
    } catch (error) {
        throw new ProviderOutcomeUnknownError('Provider stream succeeded, but returned an unreadable result', error, {
            code: 'PROVIDER_STREAM_INVALID',
        });
    }
}

async function fetchProviderResponse(url: string, init: RequestInit, options: FetchProviderOptions): Promise<Response> {
    const timeoutMs = Math.max(1_000, Math.min(MAX_PROVIDER_TIMEOUT_MS, options.timeoutMs ?? 60_000));
    const timeout = AbortSignal.timeout(timeoutMs);
    const signal = init.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
    let response: Response | undefined;
    for (let attempt = 1; attempt <= SAFE_RETRY_ATTEMPTS; attempt += 1) {
        const attemptStartedAt = Date.now();
        try {
            const request = {
                ...init,
                signal,
                ...(options.dispatcher ? { dispatcher: options.dispatcher } : {}),
            } satisfies ProviderRequestInit;
            response = await fetch(url, request);
            if (
                options.retryResponseStatuses?.includes(response.status) &&
                attempt < SAFE_RETRY_ATTEMPTS &&
                !signal.aborted
            ) {
                const retryAfterMs = retryDelayMs(response.headers.get('retry-after'));
                await response.body?.cancel().catch(() => undefined);
                await new Promise((resolveRetry) => setTimeout(resolveRetry, retryAfterMs));
                response = undefined;
                continue;
            }
            break;
        } catch (error) {
            const diagnostics: Record<string, string> = {
                ...transportDiagnostics(error),
                phase: 'awaiting_response',
                attempt: String(attempt),
                elapsedMs: String(Math.max(0, Date.now() - attemptStartedAt)),
            };
            const preDispatch = diagnostics.code ? PRE_DISPATCH_TRANSPORT_CODES.has(diagnostics.code) : false;
            if (preDispatch && attempt < SAFE_RETRY_ATTEMPTS && !signal.aborted) continue;
            if (preDispatch) {
                throw new BadGatewayException({
                    code: 'PROVIDER_UNAVAILABLE',
                    message: 'Provider could not be reached before the request was sent',
                    transport: diagnostics,
                });
            }
            throw new ProviderOutcomeUnknownError(
                'Provider request ended without a provable outcome',
                error,
                diagnostics,
            );
        }
    }
    if (!response) throw new BadGatewayException('Provider request did not produce a response');
    return response;
}

async function parseProviderJsonResponse(
    response: Response,
    maxResponseBytes: number,
    clientErrorMode: FetchProviderOptions['clientErrorMode'] = 'provider_unavailable',
    clientErrorFactory?: FetchProviderOptions['clientErrorFactory'],
    acceptedResponseStatuses: readonly number[] = [],
): Promise<Record<string, unknown>> {
    let raw: string;
    try {
        raw = await readBounded(response, maxResponseBytes);
    } catch (error) {
        if (response.ok || response.status >= 500) {
            throw new ProviderOutcomeUnknownError(
                'Provider responded, but its result could not be captured safely',
                error,
                {
                    code: 'PROVIDER_RESPONSE_CAPTURE_FAILED',
                    phase: 'response_body',
                    maxResponseBytes: String(maxResponseBytes),
                    ...(providerRequestId(response) ? { providerRequestId: providerRequestId(response)! } : {}),
                },
            );
        }
        if (clientErrorFactory) {
            throw clientErrorFactory({ providerStatus: response.status });
        }
        throw error;
    }
    let body: Record<string, unknown>;
    try {
        body = JSON.parse(raw) as Record<string, unknown>;
    } catch {
        if (response.ok) {
            throw new ProviderOutcomeUnknownError('Provider succeeded, but returned an unreadable result');
        }
        if (response.status < 500 && clientErrorFactory) {
            throw clientErrorFactory({ providerStatus: response.status });
        }
        throw new BadGatewayException('Provider returned invalid JSON');
    }
    if (!response.ok && !acceptedResponseStatuses.includes(response.status)) {
        if (response.status >= 500) {
            throw new ProviderOutcomeUnknownError(
                `Provider returned ${response.status}; the provider outcome cannot be proven`,
            );
        }
        const providerError = record(body.error);
        const providerMetadata = record(providerError.metadata);
        const providerMessage = boundedProviderText(providerError.message ?? body.message ?? body.filter_error);
        const providerCode = boundedProviderText(providerError.code ?? body.code ?? body.error_code);
        const providerReason = boundedProviderReason(
            providerMetadata.reason,
            providerMetadata.code,
            providerMetadata.raw,
            providerError.reason,
            body.reason,
            providerCode,
            providerMessage,
        );
        const providerDetails: ProviderClientErrorDetails = {
            providerStatus: response.status,
            ...(providerMessage ? { providerMessage } : {}),
            ...(providerCode ? { providerCode } : {}),
            ...(providerReason ? { providerReason } : {}),
        };
        if (clientErrorFactory) throw clientErrorFactory(providerDetails);
        const details = {
            code: clientErrorMode === 'bad_request' ? 'PROVIDER_REQUEST_REJECTED' : 'PROVIDER_UNAVAILABLE',
            message: `Provider request failed with status ${response.status}`,
            ...providerDetails,
        };
        if (clientErrorMode === 'bad_request') throw new BadRequestException(details);
        throw new BadGatewayException(details);
    }
    return body;
}

function providerRequestId(response: Response): string | undefined {
    return response.headers.get('x-generation-id') ?? response.headers.get('x-request-id') ?? undefined;
}

function parseJsonEventStream(raw: string): Record<string, unknown>[] {
    const events: Record<string, unknown>[] = [];
    for (const block of raw.replace(/\r\n/g, '\n').split(/\n{2,}/)) {
        const data = block
            .split('\n')
            .filter((line) => line.startsWith('data:'))
            .map((line) => line.slice(5).trimStart())
            .join('\n')
            .trim();
        if (!data || data === '[DONE]') continue;
        const parsed = JSON.parse(data) as unknown;
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            throw new Error('Provider stream event was not a JSON object');
        }
        events.push(parsed as Record<string, unknown>);
    }
    return events;
}

function retryDelayMs(value: string | null): number {
    if (!value) return 250;
    const seconds = Number(value);
    if (Number.isFinite(seconds)) return Math.max(0, Math.min(5_000, Math.round(seconds * 1_000)));
    const date = Date.parse(value);
    return Number.isFinite(date) ? Math.max(0, Math.min(5_000, date - Date.now())) : 250;
}

function boundedProviderText(value: unknown): string | undefined {
    const normalized =
        typeof value === 'string' || typeof value === 'number'
            ? String(value)
                  .replace(/[\r\n\t]+/g, ' ')
                  .trim()
            : '';
    return normalized ? normalized.slice(0, 500) : undefined;
}

function boundedProviderReason(...values: unknown[]): string | undefined {
    for (const value of values) {
        const match = String(value ?? '').slice(0, 2_000).toUpperCase().match(/\bIMAGE_[A-Z0-9_]{1,64}\b/);
        if (match?.[0]) return match[0];
    }
    return undefined;
}

export function transportDiagnostics(error: unknown): Record<string, string> {
    const chain: unknown[] = [];
    let current: unknown = error;
    for (let depth = 0; current && depth < 4; depth += 1) {
        chain.push(current);
        current =
            current && typeof current === 'object' && 'cause' in current
                ? (current as { cause?: unknown }).cause
                : undefined;
    }
    const records = chain.filter((value): value is Record<string, unknown> =>
        Boolean(value && typeof value === 'object'),
    );
    const code = records
        .map((value) =>
            String(value.code ?? '')
                .trim()
                .toUpperCase(),
        )
        .find(Boolean);
    const name = records
        .map((value) => String(value.name ?? '').trim())
        .find((value) => value && value !== 'TypeError');
    const message = chain
        .map((value) => (value instanceof Error ? value.message : String(value ?? '')))
        .find((value) => value && value !== 'fetch failed');
    const socket = records
        .map((value) => value.socket)
        .find((value): value is Record<string, unknown> => Boolean(value && typeof value === 'object'));
    const bytesWritten = boundedTransportCounter(socket?.bytesWritten);
    const bytesRead = boundedTransportCounter(socket?.bytesRead);
    return {
        ...(code ? { code: code.slice(0, 80) } : {}),
        ...(name ? { name: name.slice(0, 80) } : {}),
        ...(message ? { message: message.slice(0, 240) } : {}),
        ...(bytesWritten !== undefined ? { bytesWritten } : {}),
        ...(bytesRead !== undefined ? { bytesRead } : {}),
    };
}

function boundedTransportCounter(value: unknown): string | undefined {
    const number = Number(value);
    if (!Number.isSafeInteger(number) || number < 0) return undefined;
    return String(number);
}

async function readBounded(response: Response, maxBytes: number): Promise<string> {
    if (!response.body) return '';
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > maxBytes) {
            await reader.cancel();
            throw new BadGatewayException('Provider response exceeded the configured limit');
        }
        chunks.push(value);
    }
    return Buffer.concat(chunks).toString('utf8');
}

export function assertBounded(value: unknown, maxBytes: number, name: string): void {
    if (Buffer.byteLength(JSON.stringify(value ?? null)) > maxBytes) {
        throw new BadRequestException(`${name} exceeded ${maxBytes} bytes`);
    }
}

export function record(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

export function required(value: unknown, name: string): string {
    const normalized = String(value ?? '').trim();
    if (!normalized) throw new BadRequestException(`${name} is required`);
    return normalized;
}

export function positiveInteger(value: unknown, name: string): number {
    const normalized = Number(value);
    if (!Number.isSafeInteger(normalized) || normalized < 1) {
        throw new BadRequestException(`${name} must be a positive integer`);
    }
    return normalized;
}

export function safeQuantitySum(...values: number[]): number {
    const total = values.reduce((sum, value) => sum + value, 0);
    if (!Number.isSafeInteger(total) || total < 1) {
        throw new BadRequestException('Estimated capability quantity exceeds the supported numeric range');
    }
    return total;
}

export function boundedInteger(value: unknown, minimum: number, maximum: number): number {
    const normalized = Number(value);
    if (!Number.isSafeInteger(normalized) || normalized < minimum || normalized > maximum) {
        throw new BadRequestException(`Value must be an integer between ${minimum} and ${maximum}`);
    }
    return normalized;
}

export function requiredHttpsUrl(value: unknown, name: string): URL {
    try {
        const url = new URL(required(value, name));
        if (url.protocol !== 'https:') throw new Error('not HTTPS');
        return url;
    } catch {
        throw new BadRequestException(`${name} must be a valid HTTPS URL`);
    }
}

export function assertPublicProviderUrl(url: URL, providerName: string): void {
    if (url.username || url.password) {
        throw new BadRequestException(`${providerName} baseUrl cannot contain credentials`);
    }
    const hostname = url.hostname.toLowerCase();
    if (
        hostname === 'localhost' ||
        hostname.endsWith('.localhost') ||
        hostname.endsWith('.local') ||
        hostname.endsWith('.internal') ||
        isPrivateAddress(hostname)
    ) {
        throw new BadRequestException(`${providerName} baseUrl must use a public HTTPS host`);
    }
}

function isPrivateAddress(hostname: string): boolean {
    if (hostname.includes(':')) {
        const normalized = hostname.replace(/^\[|\]$/g, '').toLowerCase();
        return (
            normalized === '::1' ||
            normalized === '::' ||
            normalized.startsWith('fc') ||
            normalized.startsWith('fd') ||
            normalized.startsWith('fe8') ||
            normalized.startsWith('fe9') ||
            normalized.startsWith('fea') ||
            normalized.startsWith('feb')
        );
    }
    const octets = hostname.split('.').map(Number);
    if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
    const [first, second] = octets as [number, number, number, number];
    return (
        first === 0 ||
        first === 10 ||
        first === 127 ||
        (first === 100 && second >= 64 && second <= 127) ||
        (first === 169 && second === 254) ||
        (first === 172 && second >= 16 && second <= 31) ||
        (first === 192 && second === 168) ||
        first >= 224
    );
}

export function boundedEnvInteger(name: string, fallback: number, min: number, max: number): number {
    const parsed = Number(process.env[name] ?? fallback);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.min(max, Math.max(min, Math.floor(parsed)));
}
