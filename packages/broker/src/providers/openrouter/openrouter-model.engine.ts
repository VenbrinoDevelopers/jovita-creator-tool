import {
    BadGatewayException,
    BadRequestException,
    HttpException,
    Injectable,
    Optional,
    ServiceUnavailableException,
    UnprocessableEntityException,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import { Agent } from 'undici';
import { UploadsService } from '../../cloud/media/uploads/uploads.service.js';
import { MiniappProviderCredentialService } from '../../cloud/saas-store/miniapp-provider-credential.service.js';
import {
    ProviderOutcomeUnknownError,
    type CapabilityCallInput,
    type CapabilityCallResult,
    } from '../../cloud/saas-store/capabilities/capability-operation.types.js';
import {
    fetchJson,
    fetchJsonEventStream,
    record,
    required,
    type ProviderClientErrorDetails,
} from '../../cloud/saas-store/capabilities/capability-utils.js';
import { OPENROUTER_BASE_URL } from './openrouter.routes.js';
import { BuiltinOperationCatalog } from '../../catalog/builtin-operation.catalog.js';
import { mapOpenRouterRequest, mapOpenRouterResult } from './openrouter.mapper.js';

const MAX_INLINE_IMAGE_RESPONSE_BYTES = 10 * 1024 * 1024;
const STRUCTURED_GENERATION_TIMEOUT_MS = 300_000;
// Keep the authoritative provider deadline below the 330-second broker and
// 360-second mini-app deadlines so a provider response wins every race.
const IMAGE_GENERATION_TIMEOUT_MS = 300_000;
const TRANSCRIPTION_TIMEOUT_MS = 60_000;
const MAX_TRANSCRIPTION_AUDIO_BYTES = 8 * 1024 * 1024;
const OPENROUTER_TRANSCRIPTION_CAPABILITY = 'openrouter.audio.transcribe';
const VIDEO_EDITOR_TRANSCRIPTION_MODEL = 'deepgram/nova-3';
const WORKER_ONLY_MEDIA_CAPABILITIES = new Set([
    'openrouter.videos.generate',
    'openrouter.videos.status',
]);

// OpenRouter generation POSTs are paid and non-idempotent. Disabling
// pipelining also disables keep-alive reuse in Undici, so each generation is
// dispatched on a fresh connection instead of risking a stale pooled socket.
const OPENROUTER_GENERATION_DISPATCHER = new Agent({ pipelining: 0 });

@Injectable()
export class OpenRouterModelEngine {
    readonly providerId = 'openrouter';
    readonly credentialSource = 'admin' as const;
    readonly credentialFields = [{ key: 'apiKey', label: 'API key', type: 'secret', required: true }] as const;
  

    constructor(
        private readonly credentials: MiniappProviderCredentialService,
        @Optional() private readonly uploads?: UploadsService,
        private readonly catalog?: BuiltinOperationCatalog,
    ) {}

    validateCredential(config: Record<string, unknown>): void {
        required(config.apiKey, 'OpenRouter apiKey');
    }

    async testCredential(config: Record<string, unknown>, signal?: AbortSignal): Promise<void> {
        this.validateCredential(config);
        await fetchJson(`${OPENROUTER_BASE_URL}/models`, {
            method: 'GET',
            headers: { Authorization: `Bearer ${required(config.apiKey, 'OpenRouter apiKey')}` },
            signal,
        });
    }

    async invoke(input: CapabilityCallInput): Promise<CapabilityCallResult> {
        if (WORKER_ONLY_MEDIA_CAPABILITIES.has(input.capability)) {
            throw new ServiceUnavailableException({
                code: 'MEDIA_WORKER_REQUIRED',
                message: 'Video generation is unavailable until durable media processing is enabled.',
                retrySafe: false,
                charged: false,
            });
        }
        const config = await this.credentials.resolve(input.environment, input.packId, this.providerId);
        const mappedInput =
            input.capability === OPENROUTER_TRANSCRIPTION_CAPABILITY
                ? await this.prepareTranscriptionPayload(input)
                : input.payload;
        const definition = this.catalog?.find(input.capability);
        const declaredRoute = definition?.providerId === this.providerId ? definition.route : undefined;
        if (!declaredRoute && !WORKER_ONLY_MEDIA_CAPABILITIES.has(input.capability)) {
            throw new BadRequestException('OpenRouter operation has no approved route');
        }
        const { route, payload } = mapOpenRouterRequest(input.capability, mappedInput,
            declaredRoute as { method: 'GET' | 'POST'; path: string } | undefined);
        const request = {
            method: route.method,
            headers: {
                Authorization: `Bearer ${required(config.apiKey, 'OpenRouter apiKey')}`,
                'Content-Type': 'application/json',
                'X-OpenRouter-Metadata': 'enabled',
                'User-Agent': 'jovita-server/1.0',
                Accept: input.capability === 'openrouter.chat.generate' ? 'text/event-stream' : 'application/json',
            },
            body:
                route.method === 'POST'
                    ? JSON.stringify(
                          input.capability === 'openrouter.chat.generate'
                              ? {
                                    ...payload,
                                    stream: true,
                                    stream_options: { include_usage: true },
                                }
                              : payload,
                      )
                    : undefined,
            signal: input.signal,
        } satisfies RequestInit;
        const options = {
            maxResponseBytes:
                input.capability === 'openrouter.images.generate'
                    ? MAX_INLINE_IMAGE_RESPONSE_BYTES
                    : input.capability === OPENROUTER_TRANSCRIPTION_CAPABILITY
                      ? 8 * 1024 * 1024
                      : undefined,
            timeoutMs:
                input.capability === 'openrouter.chat.generate'
                    ? STRUCTURED_GENERATION_TIMEOUT_MS
                    : input.capability === 'openrouter.images.generate'
                      ? IMAGE_GENERATION_TIMEOUT_MS
                      : input.capability === OPENROUTER_TRANSCRIPTION_CAPABILITY
                        ? TRANSCRIPTION_TIMEOUT_MS
                        : undefined,
            retryResponseStatuses: input.capability === 'openrouter.chat.generate' ? [429, 503] : undefined,
            clientErrorFactory: (details: ProviderClientErrorDetails) =>
                openRouterClientError(input.capability, details),
            dispatcher: route.method === 'POST' ? OPENROUTER_GENERATION_DISPATCHER : undefined,
        };
        if (input.capability === 'openrouter.chat.generate') {
            const response = await fetchJsonEventStream(`${OPENROUTER_BASE_URL}/${route.path}`, request, options);
            return mapOpenRouterResult(
                input.capability,
                input.payload,
                collectOpenRouterChatEvents(response.events, response.requestId),
                response.requestId,
            );
        }
        const response = await fetchJson(`${OPENROUTER_BASE_URL}/${route.path}`, request, options);
        if (input.capability === OPENROUTER_TRANSCRIPTION_CAPABILITY) {
            const usage = record(response.body.usage);
            const seconds = Number(usage.seconds);
            const maxSeconds = Number(input.payload.max_duration_seconds);
            if (!Number.isFinite(seconds) || seconds <= 0 || seconds > maxSeconds + 1) {
                throw new BadGatewayException('OpenRouter returned invalid transcription usage');
            }
            if (
                !Object.prototype.hasOwnProperty.call(usage, 'cost') ||
                !Number.isFinite(Number(usage.cost)) ||
                Number(usage.cost) < 0
            ) {
                throw new ProviderOutcomeUnknownError(
                    'OpenRouter returned a transcript without authoritative cost usage',
                    undefined,
                    { code: 'OPENROUTER_TRANSCRIPTION_COST_MISSING' },
                );
            }
        }
        return mapOpenRouterResult(input.capability, mappedInput, response.body, response.requestId);
    }

    private async prepareTranscriptionPayload(input: CapabilityCallInput): Promise<Record<string, unknown>> {
        const payload = input.payload;
        const allowedPayloadKeys = new Set([
            'max_duration_seconds',
            'model',
            'input_audio',
            'language',
            'response_format',
            'timestamp_granularities',
            'provider',
        ]);
        if (Object.keys(payload).some((key) => !allowedPayloadKeys.has(key))) {
            throw new BadRequestException('Unsupported OpenRouter transcription field');
        }
        if (payload.model !== VIDEO_EDITOR_TRANSCRIPTION_MODEL) {
            throw new BadRequestException('Unsupported OpenRouter transcription model');
        }
        const maxSeconds = Number(payload.max_duration_seconds);
        if (!Number.isSafeInteger(maxSeconds) || maxSeconds < 1 || maxSeconds > 50) {
            throw new BadRequestException('Transcription chunks must be between 1 and 50 seconds');
        }
        if (payload.response_format !== 'verbose_json') {
            throw new BadRequestException('Video Editor requires verbose transcription output');
        }
        const granularities = payload.timestamp_granularities;
        if (
            !Array.isArray(granularities) ||
            granularities.length !== 2 ||
            !granularities.includes('segment') ||
            !granularities.includes('word')
        ) {
            throw new BadRequestException('Video Editor requires word-level transcription timestamps');
        }
        const language = payload.language;
        if (language !== undefined && (typeof language !== 'string' || !/^[a-z]{2,3}(?:-[A-Z]{2})?$/.test(language))) {
            throw new BadRequestException('Unsupported transcription language');
        }
        const provider = record(payload.provider);
        if (Object.keys(provider).some((key) => key !== 'options')) {
            throw new BadRequestException('Unsupported OpenRouter transcription provider field');
        }
        const providerOptions = record(provider.options);
        if (Object.keys(providerOptions).some((key) => key !== 'deepgram')) {
            throw new BadRequestException('Unsupported OpenRouter transcription provider');
        }
        const options = record(providerOptions.deepgram);
        const allowedOptionKeys = new Set(['diarize', 'smart_format', 'punctuate', 'detect_language']);
        if (
            Object.keys(options).some((key) => !allowedOptionKeys.has(key)) ||
            options.smart_format !== true ||
            options.punctuate !== true ||
            options.detect_language !== true ||
            typeof options.diarize !== 'boolean'
        ) {
            throw new BadRequestException('Unsupported Deepgram transcription options');
        }
        const inputAudio = record(payload.input_audio);
        if (Object.keys(inputAudio).some((key) => key !== 'provider_input')) {
            throw new BadRequestException('Unsupported transcription audio field');
        }
        const providerInput = record(inputAudio.provider_input);
        const attachmentId = required(providerInput.attachment_id, 'Transcription provider input');
        const expectedHash = required(providerInput.sha256, 'Transcription input checksum').toLowerCase();
        const expectedSize = Number(providerInput.size);
        if (
            !/^[a-f0-9]{64}$/.test(expectedHash) ||
            !Number.isSafeInteger(expectedSize) ||
            expectedSize < 4 ||
            expectedSize > MAX_TRANSCRIPTION_AUDIO_BYTES ||
            providerInput.mime_type !== 'audio/flac'
        ) {
            throw new BadRequestException('Transcription provider input is invalid');
        }
        const attachment = await this.uploads?.resolveRuntimeAttachment(input.ownerId, attachmentId);
        if (
            !attachment?.url ||
            attachment.kind !== 'audio' ||
            attachment.mimeType !== 'audio/flac' ||
            attachment.sha256 !== expectedHash ||
            attachment.size !== expectedSize
        ) {
            throw new BadRequestException('Transcription provider input is unavailable or does not match');
        }
        const response = await fetch(attachment.url, {
            method: 'GET',
            signal: input.signal
                ? AbortSignal.any([input.signal, AbortSignal.timeout(30_000)])
                : AbortSignal.timeout(30_000),
        });
        if (!response.ok) throw new BadGatewayException('Private transcription input could not be read');
        const rawContentLength = response.headers.get('content-length');
        if (rawContentLength !== null && Number(rawContentLength) !== expectedSize) {
            throw new BadGatewayException('Private transcription input size changed');
        }
        const bytes = await readBoundedPrivateAudio(response, expectedSize);
        if (
            bytes.length !== expectedSize ||
            bytes.subarray(0, 4).toString('ascii') !== 'fLaC' ||
            createHash('sha256').update(bytes).digest('hex') !== expectedHash
        ) {
            throw new BadGatewayException('Private transcription input failed integrity validation');
        }
        return {
            ...payload,
            input_audio: { data: bytes.toString('base64'), format: 'flac' },
        };
    }
}

async function readBoundedPrivateAudio(response: Response, expectedSize: number): Promise<Buffer> {
    if (!response.body) throw new BadGatewayException('Private transcription input was empty');
    const reader = response.body.getReader();
    const chunks: Buffer[] = [];
    let size = 0;
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.byteLength;
            if (size > expectedSize) {
                await reader.cancel().catch(() => undefined);
                throw new BadGatewayException('Private transcription input exceeded its declared size');
            }
            chunks.push(Buffer.from(value));
        }
    } finally {
        reader.releaseLock();
    }
    return Buffer.concat(chunks, size);
}

const OPENROUTER_IMAGE_REASONS = [
    'IMAGE_OTHER',
    'IMAGE_SAFETY',
    'IMAGE_PROHIBITED_CONTENT',
    'IMAGE_RECITATION',
    'NO_IMAGE',
] as const;

export function openRouterClientError(capability: string, details: ProviderClientErrorDetails): HttpException {
    if ([401, 403].includes(details.providerStatus)) {
        return new HttpException(
            {
                code: 'PROVIDER_NOT_CONFIGURED',
                message: 'OpenRouter credentials are invalid or are not authorized for this request.',
                providerStatus: details.providerStatus,
                retrySafe: false,
                charged: false,
            },
            424,
        );
    }
    if (details.providerStatus === 402) {
        return new HttpException(
            {
                code: 'PROVIDER_ACCOUNT_UNAVAILABLE',
                message: 'The OpenRouter provider account cannot accept paid requests.',
                providerStatus: details.providerStatus,
                retrySafe: false,
                charged: false,
            },
            424,
        );
    }
    if ([408, 425, 429].includes(details.providerStatus)) {
        return new HttpException(
            {
                code: details.providerStatus === 429 ? 'PROVIDER_RATE_LIMITED' : 'PROVIDER_UNAVAILABLE',
                message: 'The provider is temporarily unable to accept this request.',
                providerStatus: details.providerStatus,
            },
            details.providerStatus,
        );
    }
    const providerReason = openRouterImageReason(details);
    if (capability === 'openrouter.images.generate' && providerReason === 'IMAGE_OTHER') {
        return new UnprocessableEntityException({
            code: 'IMAGE_GENERATION_RETRYABLE',
            message: 'The image model could not produce an image for this attempt.',
            providerStatus: details.providerStatus,
            providerReason,
            retrySafe: true,
            charged: false,
        });
    }
    return new UnprocessableEntityException({
        code: 'PROVIDER_REQUEST_REJECTED',
        message: 'The provider rejected this request.',
        providerStatus: details.providerStatus,
        ...(providerReason ? { providerReason } : {}),
        retrySafe: false,
    });
}

function openRouterImageReason(
    details: ProviderClientErrorDetails,
): (typeof OPENROUTER_IMAGE_REASONS)[number] | undefined {
    const source =
        `${details.providerReason ?? ''} ${details.providerCode ?? ''} ${details.providerMessage ?? ''}`.toUpperCase();
    return OPENROUTER_IMAGE_REASONS.find((reason) => new RegExp(`\\b${reason}\\b`).test(source));
}

export function collectOpenRouterChatEvents(
    events: readonly Record<string, unknown>[],
    requestId?: string,
): Record<string, unknown> {
    let id = requestId;
    let model: unknown;
    let provider: unknown;
    let created: unknown;
    let finishReason: unknown;
    let usage: Record<string, unknown> = {};
    const content: string[] = [];
    for (const event of events) {
        const streamError = record(event.error);
        if (Object.keys(streamError).length > 0) {
            throw knownOpenRouterFailure(
                'OPENROUTER_STREAM_FAILED',
                String(streamError.message ?? 'OpenRouter stream failed'),
                requestId,
                String(streamError.code ?? 'OPENROUTER_STREAM_ERROR'),
            );
        }
        id = String(event.id ?? id ?? '').trim() || id;
        model = event.model ?? model;
        provider = event.provider ?? provider;
        created = event.created ?? created;
        const eventUsage = record(event.usage);
        if (Object.keys(eventUsage).length > 0) usage = eventUsage;
        const choice = record(Array.isArray(event.choices) ? event.choices[0] : undefined);
        finishReason = choice.finish_reason ?? finishReason;
        const delta = record(choice.delta);
        const message = record(choice.message);
        const text = streamedContent(delta.content ?? message.content);
        if (text) content.push(text);
    }
    const joined = content.join('');
    if (
        String(finishReason ?? '')
            .trim()
            .toLowerCase() === 'error'
    ) {
        throw knownOpenRouterFailure(
            'OPENROUTER_GENERATION_INCOMPLETE',
            'OpenRouter explicitly ended the generation with finish_reason=error',
            id,
        );
    }
    if (!joined) {
        throw new ProviderOutcomeUnknownError('OpenRouter stream completed without an assistant result', undefined, {
            code: 'OPENROUTER_STREAM_EMPTY',
        });
    }
    return {
        ...(id ? { id } : {}),
        ...(model !== undefined ? { model } : {}),
        ...(provider !== undefined ? { provider } : {}),
        ...(created !== undefined ? { created } : {}),
        choices: [
            {
                index: 0,
                message: { role: 'assistant', content: joined },
                finish_reason: finishReason ?? 'stop',
            },
        ],
        usage,
    };
}

function knownOpenRouterFailure(
    code: string,
    message: string,
    requestId?: string,
    providerCode?: string,
): ServiceUnavailableException {
    return new ServiceUnavailableException({
        code,
        message: message.slice(0, 240),
        ...(requestId ? { provider_request_id: requestId.slice(0, 160) } : {}),
        ...(providerCode ? { provider_code: providerCode.slice(0, 80) } : {}),
    });
}

function streamedContent(value: unknown): string {
    if (typeof value === 'string') return value;
    if (!Array.isArray(value)) return '';
    return value
        .map((part) => {
            const item = record(part);
            return typeof item.text === 'string' ? item.text : '';
        })
        .join('');
}
