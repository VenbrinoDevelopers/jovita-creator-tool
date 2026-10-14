import { seededBuiltinCatalog, mapOpenRouterRequest } from '../helpers/seeded-builtin-catalog.js';
import { builtinOperationDefinitions as BUILTIN_OPERATION_SEED } from '@jovita-ai/provider-catalog';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import {
    collectOpenRouterChatEvents,
    openRouterClientError,
    OpenRouterModelEngine as OpenRouterModelEngineBase,
} from '../../src/providers/openrouter/openrouter-model.engine.js';
import {
    mapOpenRouterResult,
} from '../../src/providers/openrouter/openrouter.mapper.js';

describe('OpenRouterModelEngine', () => {
    afterEach(() => vi.unstubAllGlobals());

    it('exposes only the secret needed to authenticate with OpenRouter', () => {
        const adapter = new OpenRouterModelEngine({} as never);
        expect(adapter.credentialFields).toEqual([{ key: 'apiKey', label: 'API key', type: 'secret', required: true }]);
    });

    it('maps provider requests without imposing model-specific output ceilings', () => {
        const mapped = mapOpenRouterRequest('openrouter.images.generate', {
            model: 'openai/gpt-image-1',
            n: 12,
        });
        expect(mapped.route).toEqual({ method: 'POST', path: 'images' });
        expect(mapped.payload).toMatchObject({ model: 'openai/gpt-image-1', n: 12 });
    });

    it('supports read-only text model discovery for structured-output validation', () => {
        const adapter = new OpenRouterModelEngine({} as never);
        expect(BUILTIN_OPERATION_SEED.filter(item => item.providerId === 'openrouter').map(item => item.capability)).toContain('openrouter.models.list');
        expect(BUILTIN_OPERATION_SEED.find(item => item.capability === 'openrouter.models.list')?.maxCallsPerInvocation).toBeGreaterThan(0);
        expect(mapOpenRouterRequest('openrouter.models.list', {})).toEqual({
            route: { method: 'GET', path: 'models' },
            payload: {},
        });
        expect(
            mapOpenRouterResult(
                'openrouter.models.list',
                {},
                { data: [{ id: 'google/gemini-3.6-flash' }, { id: 'qwen/qwen3.8-max' }] },
            ).quantity,
        ).toBe(2);
    });

    it('transcribes private FLAC chunks with pinned Nova-3 and authoritative OpenRouter usage', async () => {
        const bytes = Buffer.from('fLaCtest-audio');
        const sha256 = createHash('sha256').update(bytes).digest('hex');
        const providerFetch = vi
            .fn()
            .mockResolvedValueOnce(new Response(bytes, { headers: { 'content-length': String(bytes.length) } }))
            .mockResolvedValueOnce(
                Response.json(
                    {
                        text: 'Hello.',
                        language: 'en',
                        duration: 12.5,
                        words: [{ word: 'Hello.', start: 0.1, end: 0.8, speaker: 0 }],
                        segments: [{ text: 'Hello.', start: 0.1, end: 0.8, speaker: 0 }],
                        usage: { seconds: 12.5, cost: 0.0009 },
                    },
                    { headers: { 'x-generation-id': 'stt-1' } },
                ),
            );
        vi.stubGlobal('fetch', providerFetch);
        const adapter = new OpenRouterModelEngine(
            { resolve: vi.fn().mockResolvedValue({ apiKey: 'openrouter-key' }) } as never,
            {
                resolveRuntimeAttachment: vi.fn().mockResolvedValue({
                    attachmentId: 'attachment-1',
                    url: 'https://private.example.test/audio.flac',
                    kind: 'audio',
                    mimeType: 'audio/flac',
                    size: bytes.length,
                    sha256,
                }),
            } as never,
        );

        const result = await adapter.invoke({
            environment: 'development',
            ownerId: 'owner-1',
            packId: 'video-editor',
            capability: 'openrouter.audio.transcribe',
            payload: {
                max_duration_seconds: 50,
                model: 'deepgram/nova-3',
                input_audio: {
                    provider_input: {
                        attachment_id: 'attachment-1',
                        mime_type: 'audio/flac',
                        size: bytes.length,
                        sha256,
                    },
                },
                response_format: 'verbose_json',
                timestamp_granularities: ['segment', 'word'],
                provider: {
                    options: {
                        deepgram: {
                            diarize: true,
                            smart_format: true,
                            punctuate: true,
                            detect_language: true,
                        },
                    },
                },
            },
        });

        expect(providerFetch).toHaveBeenCalledTimes(2);
        const outbound = JSON.parse(String((providerFetch.mock.calls[1]?.[1] as RequestInit).body));
        expect(providerFetch.mock.calls[1]?.[0]).toBe('https://openrouter.ai/api/v1/audio/transcriptions');
        expect(outbound).toMatchObject({
            model: 'deepgram/nova-3',
            input_audio: { data: bytes.toString('base64'), format: 'flac' },
        });
        expect(outbound).not.toHaveProperty('max_duration_seconds');
        expect(result).toMatchObject({
            providerRequestId: 'stt-1',
            providerCostMicros: 900,
            quantity: 13,
            costEvidence: { source: 'provider_usage', billableQuantity: 12.5, unit: 'second' },
        });
    });

    it('rejects transcription model substitution before reading private audio', async () => {
        const uploads = { resolveRuntimeAttachment: vi.fn() };
        const adapter = new OpenRouterModelEngine(
            { resolve: vi.fn().mockResolvedValue({ apiKey: 'openrouter-key' }) } as never,
            uploads as never,
        );
        await expect(
            adapter.invoke({
                environment: 'development',
                ownerId: 'owner-1',
                packId: 'video-editor',
                capability: 'openrouter.audio.transcribe',
                payload: { model: 'some/more-expensive-model', max_duration_seconds: 50 },
            }),
        ).rejects.toThrow('Unsupported OpenRouter transcription model');
        expect(uploads.resolveRuntimeAttachment).not.toHaveBeenCalled();
    });

    it('preserves bounded multimodal chat content for reference-guided generation', () => {
        const messages = [
            {
                role: 'user',
                content: [
                    { type: 'text', text: 'Use this as art direction without copying it.' },
                    { type: 'image_url', image_url: { url: 'https://imgs.search.brave.com/reference.webp' } },
                ],
            },
        ];
        const mapped = mapOpenRouterRequest('openrouter.chat.generate', {
            model: 'google/gemini-3.6-flash',
            max_tokens: 6_000,
            messages,
        });
        expect(mapped.payload.messages).toEqual(messages);
    });

    it('reconstructs one auditable chat result from the streamed response', () => {
        const body = collectOpenRouterChatEvents([
            {
                id: 'gen-1',
                model: 'google/gemini-3.6-flash',
                choices: [{ delta: { content: '{"site"' } }],
            },
            {
                choices: [{ delta: { content: ':true}' }, finish_reason: 'stop' }],
                usage: { total_tokens: 42, cost: 0.0012 },
            },
        ]);

        expect(body).toMatchObject({
            id: 'gen-1',
            model: 'google/gemini-3.6-flash',
            choices: [
                {
                    message: { role: 'assistant', content: '{"site":true}' },
                    finish_reason: 'stop',
                },
            ],
            usage: { total_tokens: 42, cost: 0.0012 },
        });
    });

    it('uses the isolated dispatcher for paid generation requests', async () => {
        const providerFetch = vi
            .fn()
            .mockResolvedValue(
                new Response(
                    [
                        'data: {"id":"gen-1","choices":[{"delta":{"content":"{\\"ok\\":true}"},"finish_reason":"stop"}],"usage":{"total_tokens":4}}',
                        '',
                        'data: [DONE]',
                        '',
                    ].join('\n'),
                    { headers: { 'content-type': 'text/event-stream', 'x-generation-id': 'gen-1' } },
                ),
            );
        vi.stubGlobal('fetch', providerFetch);
        const adapter = new OpenRouterModelEngine({
            resolve: vi.fn().mockResolvedValue({ apiKey: 'test-key' }),
        } as never);

        await adapter.invoke({
            environment: 'development',
            ownerId: 'owner-1',
            packId: 'website-builder',
            capability: 'openrouter.chat.generate',
            payload: {
                model: 'google/gemini-3.6-flash',
                messages: [{ role: 'user', content: 'Return JSON' }],
                response_format: { type: 'json_object' },
            },
        });

        expect(providerFetch).toHaveBeenCalledTimes(1);
        expect(providerFetch.mock.calls[0]?.[1]).toMatchObject({
            headers: expect.objectContaining({
                Accept: 'text/event-stream',
                'User-Agent': 'jovita-server/1.0',
            }),
            dispatcher: expect.anything(),
        });
        expect(providerFetch.mock.calls[0]?.[1]?.headers).not.toHaveProperty('Connection');
    });

    it('classifies IMAGE_OTHER as a known unbilled retry-safe image rejection', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn().mockResolvedValue(
                Response.json(
                    {
                        error: {
                            code: 400,
                            message: 'Provider returned an error',
                            metadata: {
                                raw: '{"error":{"message":"Unable to generate this image (IMAGE_OTHER)"}}',
                            },
                        },
                    },
                    { status: 400 },
                ),
            ),
        );
        const adapter = new OpenRouterModelEngine({
            resolve: vi.fn().mockResolvedValue({ apiKey: 'test-key' }),
        } as never);

        await expect(
            adapter.invoke({
                environment: 'development',
                ownerId: 'owner-1',
                packId: 'character-studio',
                capability: 'openrouter.images.generate',
                payload: { model: 'google/gemini-image', prompt: 'fictional portrait', n: 1 },
            }),
        ).rejects.toMatchObject({
            status: 422,
            response: {
                code: 'IMAGE_GENERATION_RETRYABLE',
                providerReason: 'IMAGE_OTHER',
                retrySafe: true,
                charged: false,
            },
        });
    });

    it('keeps safety and malformed requests non-retryable', () => {
        const safety = openRouterClientError('openrouter.images.generate', {
            providerStatus: 400,
            providerMessage: 'Generation stopped (IMAGE_SAFETY)',
        });
        expect(safety.getStatus()).toBe(422);
        expect(safety.getResponse()).toMatchObject({
            code: 'PROVIDER_REQUEST_REJECTED',
            providerReason: 'IMAGE_SAFETY',
            retrySafe: false,
        });

        const malformed = openRouterClientError('openrouter.images.generate', {
            providerStatus: 400,
            providerMessage: 'Invalid aspect ratio',
        });
        expect(malformed.getResponse()).toMatchObject({
            code: 'PROVIDER_REQUEST_REJECTED',
            retrySafe: false,
        });
        expect(malformed.getResponse()).not.toHaveProperty('providerMessage');
    });

    it.each([
        [401, 'PROVIDER_NOT_CONFIGURED'],
        [403, 'PROVIDER_NOT_CONFIGURED'],
        [402, 'PROVIDER_ACCOUNT_UNAVAILABLE'],
    ])('keeps provider account status %s out of the request-rejection lane', (providerStatus, code) => {
        const error = openRouterClientError('openrouter.images.generate', {
            providerStatus,
            providerMessage: 'provider account detail that must not be returned',
        });
        expect(error.getStatus()).toBe(424);
        expect(error.getResponse()).toMatchObject({
            code,
            providerStatus,
            retrySafe: false,
            charged: false,
        });
        expect(error.getResponse()).not.toHaveProperty('providerMessage');
    });

    it('finds IMAGE_OTHER in bounded raw metadata after a generic reason field', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn().mockResolvedValue(
                Response.json(
                    {
                        error: {
                            message: 'Provider returned an error',
                            metadata: {
                                reason: 'provider_error',
                                raw: '{"error":{"reason":"IMAGE_OTHER"}}',
                            },
                        },
                    },
                    { status: 400 },
                ),
            ),
        );
        const adapter = new OpenRouterModelEngine({
            resolve: vi.fn().mockResolvedValue({ apiKey: 'test-key' }),
        } as never);

        await expect(
            adapter.invoke({
                environment: 'development',
                ownerId: 'owner-1',
                packId: 'character-studio',
                capability: 'openrouter.images.generate',
                payload: { model: 'google/gemini-image', prompt: 'fictional portrait', n: 1 },
            }),
        ).rejects.toMatchObject({
            status: 422,
            response: { code: 'IMAGE_GENERATION_RETRYABLE', providerReason: 'IMAGE_OTHER' },
        });
    });

    it('keeps an unreadable provider 4xx response out of the infrastructure failure lane', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn().mockResolvedValue(
                new Response('<html>invalid request</html>', {
                    status: 400,
                    headers: { 'content-type': 'text/html' },
                }),
            ),
        );
        const adapter = new OpenRouterModelEngine({
            resolve: vi.fn().mockResolvedValue({ apiKey: 'test-key' }),
        } as never);

        await expect(
            adapter.invoke({
                environment: 'development',
                ownerId: 'owner-1',
                packId: 'character-studio',
                capability: 'openrouter.images.generate',
                payload: { model: 'google/gemini-image', prompt: 'fictional portrait', n: 1 },
            }),
        ).rejects.toMatchObject({
            status: 422,
            response: {
                code: 'PROVIDER_REQUEST_REJECTED',
                retrySafe: false,
            },
        });
    });

    it('keeps a provider 4xx with an unreadable body out of the infrastructure failure lane', async () => {
        const body = new ReadableStream<Uint8Array>({
            start(controller) {
                controller.error(new Error('response body socket closed'));
            },
        });
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(body, { status: 400 })));
        const adapter = new OpenRouterModelEngine({
            resolve: vi.fn().mockResolvedValue({ apiKey: 'test-key' }),
        } as never);

        await expect(
            adapter.invoke({
                environment: 'development',
                ownerId: 'owner-1',
                packId: 'character-studio',
                capability: 'openrouter.images.generate',
                payload: { model: 'google/gemini-image', prompt: 'fictional portrait', n: 1 },
            }),
        ).rejects.toMatchObject({
            status: 422,
            response: {
                code: 'PROVIDER_REQUEST_REJECTED',
                retrySafe: false,
            },
        });
    });

    it('allows image generation to run for ten minutes instead of inheriting the generic one-minute timeout', async () => {
        const timeoutSignal = new AbortController().signal;
        const timeoutSpy = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(timeoutSignal);
        vi.stubGlobal(
            'fetch',
            vi.fn().mockResolvedValue(
                Response.json({
                    id: 'image-generation-1',
                    data: [{ b64_json: 'aW1hZ2U=' }],
                    usage: { cost: 0.035 },
                }),
            ),
        );
        const adapter = new OpenRouterModelEngine({
            resolve: vi.fn().mockResolvedValue({ apiKey: 'test-key' }),
        } as never);

        await adapter.invoke({
            environment: 'development',
            ownerId: 'owner-1',
            packId: 'image-studio',
            capability: 'openrouter.images.generate',
            payload: {
                model: 'bytedance-seed/seedream-5.0-pro',
                prompt: 'A Lagos waterfront at sunset',
                n: 1,
            },
        });

        expect(timeoutSpy).toHaveBeenCalledWith(300_000);
    });

    it('records an explicit provider finish error as a known failed call', () => {
        expect.assertions(2);
        try {
            collectOpenRouterChatEvents(
                [
                    { id: 'gen-failed', choices: [{ delta: { content: '{"partial":' } }] },
                    { choices: [{ delta: { content: 'true' }, finish_reason: 'error' }] },
                ],
                'request-failed',
            );
        } catch (error) {
            expect(error).toBeInstanceOf(Error);
            expect((error as { getResponse(): unknown }).getResponse()).toMatchObject({
                code: 'OPENROUTER_GENERATION_INCOMPLETE',
                provider_request_id: 'gen-failed',
            });
        }
    });

    it('records a structured stream error as a known failed call', () => {
        expect.assertions(1);
        try {
            collectOpenRouterChatEvents(
                [{ error: { code: 400, message: 'Upstream rejected the structured response' } }],
                'request-stream-error',
            );
        } catch (error) {
            expect((error as { getResponse(): unknown }).getResponse()).toMatchObject({
                code: 'OPENROUTER_STREAM_FAILED',
                provider_code: '400',
                provider_request_id: 'request-stream-error',
            });
        }
    });

    it('uses authoritative provider usage and result counts', () => {
        expect(
            mapOpenRouterResult(
                'openrouter.images.generate',
                { n: 12 },
                { id: 'request-1', data: [{}, {}, {}], usage: { cost: 0.02 } },
            ),
        ).toMatchObject({
            providerRequestId: 'request-1',
            providerCostMicros: 20_000,
            quantity: 3,
        });
    });

    it('accounts for upstream inference cost on BYOK requests without double-counting normal requests', () => {
        expect(
            mapOpenRouterResult(
                'openrouter.images.generate',
                { n: 1 },
                {
                    is_byok: true,
                    data: [{}],
                    usage: { cost: 0.001, cost_details: { upstream_inference_cost: 0.0347 } },
                },
            ).providerCostMicros,
        ).toBe(35_700);
        expect(
            mapOpenRouterResult(
                'openrouter.images.generate',
                { n: 1 },
                {
                    is_byok: false,
                    data: [{}],
                    usage: { cost: 0.3, cost_details: { upstream_inference_cost: 0.2 } },
                },
            ).providerCostMicros,
        ).toBe(300_000);
        expect(
            mapOpenRouterResult(
                'openrouter.images.generate',
                { n: 1 },
                {
                    openrouter_metadata: { is_byok: true },
                    data: [{}],
                    usage: { cost: 0, cost_details: { upstream_inference_cost: 0.578399 } },
                },
            ).providerCostMicros,
        ).toBe(578_399);
    });

    it('exposes video discovery but keeps paid generation worker-only', async () => {
        const adapter = new OpenRouterModelEngine({} as never);
        expect(BUILTIN_OPERATION_SEED.filter(item => item.providerId === 'openrouter').map(item => item.capability)).toContain('openrouter.videos.models.list');
        expect(BUILTIN_OPERATION_SEED.filter(item => item.providerId === 'openrouter').map(item => item.capability)).not.toContain('openrouter.videos.generate');
        expect(BUILTIN_OPERATION_SEED.filter(item => item.providerId === 'openrouter').map(item => item.capability)).not.toContain('openrouter.videos.status');

        await expect(adapter.invoke({
            environment: 'development', ownerId: 'owner-1', packId: 'video-studio',
            capability: 'openrouter.videos.generate', payload: { prompt: 'test' },
        })).rejects.toMatchObject({ response: expect.objectContaining({ code: 'MEDIA_WORKER_REQUIRED' }) });

        expect(
            mapOpenRouterRequest('openrouter.videos.generate', {
                model: 'google/veo-3.1',
                prompt: 'A cinematic ocean sunrise',
                duration: 8,
            }),
        ).toEqual({
            route: { method: 'POST', path: 'videos' },
            payload: {
                model: 'google/veo-3.1',
                prompt: 'A cinematic ocean sunrise',
                duration: 8,
            },
        });
        expect(mapOpenRouterRequest('openrouter.videos.status', { jobId: 'job-abc_123' })).toEqual({
            route: { method: 'GET', path: 'videos/job-abc_123' },
            payload: {},
        });
        expect(mapOpenRouterRequest('openrouter.videos.models.list', {})).toEqual({
            route: { method: 'GET', path: 'videos/models' },
            payload: {},
        });
    });

    it('rejects unsafe video polling IDs and caller-controlled callbacks', () => {
        expect(() => mapOpenRouterRequest('openrouter.videos.status', { jobId: '../models' })).toThrow(
            'video jobId is invalid',
        );
        expect(() =>
            mapOpenRouterRequest('openrouter.videos.generate', {
                model: 'google/veo-3.1',
                prompt: 'test',
                callback_url: 'https://attacker.example/callback',
            }),
        ).toThrow('callback_url is managed by Jovita Server');
    });
});

class OpenRouterModelEngine extends OpenRouterModelEngineBase {
  constructor(credentials: any, uploads?: any) { super(credentials, uploads, seededBuiltinCatalog as never); }
}
