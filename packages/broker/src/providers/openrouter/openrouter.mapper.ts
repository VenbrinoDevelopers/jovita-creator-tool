import { BadRequestException } from '@nestjs/common';
import type { CapabilityCallResult } from '../../cloud/saas-store/capabilities/capability-operation.types.js';
import { positiveInteger, record, required } from '../../cloud/saas-store/capabilities/capability-utils.js';
import { OPENROUTER_VIDEO_GENERATE_ROUTE } from './openrouter.routes.js';

export function mapOpenRouterRequest(
  capability: string,
  payload: Record<string, unknown>,
  declaredRoute?: Readonly<{ method: 'GET' | 'POST'; path: string }>,
): {
  route: { readonly method: 'GET' | 'POST'; readonly path: string };
  payload: Record<string, unknown>;
} {
  if (capability === 'openrouter.images.model_endpoints.list'
    && (declaredRoute?.method !== 'GET'
      || declaredRoute.path !== 'images/models/{model}/endpoints')) {
    throw new BadRequestException('OpenRouter model endpoint route is not approved');
  }
  const route = capability === 'openrouter.videos.status'
    ? videoStatusRoute(payload.jobId)
    : capability === 'openrouter.images.model_endpoints.list'
      ? imageModelEndpointsRoute(payload.model)
      : capability === 'openrouter.videos.generate' ? OPENROUTER_VIDEO_GENERATE_ROUTE : declaredRoute;
  if (!route) throw new BadRequestException('OpenRouter capability is not supported');
  const providerPayload = { ...payload };
  delete providerPayload.jobId;
  delete providerPayload.max_duration_seconds;
  if (capability === 'openrouter.images.model_endpoints.list') delete providerPayload.model;
  if (route.method === 'POST') required(providerPayload.model, 'OpenRouter model');
  if (capability === 'openrouter.chat.generate'
    && (providerPayload.max_tokens !== undefined || providerPayload.maxTokens !== undefined)) {
    providerPayload.max_tokens = positiveInteger(
      providerPayload.max_tokens ?? providerPayload.maxTokens,
      'OpenRouter max_tokens',
    );
    delete providerPayload.maxTokens;
  }
  if (capability === 'openrouter.images.generate' && providerPayload.n !== undefined) {
    providerPayload.n = positiveInteger(providerPayload.n, 'OpenRouter image quantity');
  }
  if (capability === 'openrouter.videos.generate') {
    required(providerPayload.prompt, 'OpenRouter video prompt');
    if (providerPayload.callback_url !== undefined) {
      throw new BadRequestException('OpenRouter callback_url is managed by Jovita Server');
    }
    if (providerPayload.duration !== undefined) {
      providerPayload.duration = positiveInteger(providerPayload.duration, 'OpenRouter video duration');
    }
  }
  return { route, payload: providerPayload };
}

export function mapOpenRouterResult(
  capability: string,
  requestedPayload: Record<string, unknown>,
  body: Record<string, unknown>,
  requestId?: string,
): CapabilityCallResult {
  const usage = record(body.usage);
  const costDetails = record(usage.cost_details);
  const routerMetadata = record(body.openrouter_metadata);
  const openRouterCostUsd = finiteCost(usage.cost ?? usage.total_cost);
  const upstreamCostUsd = finiteCost(costDetails.upstream_inference_cost);
  const isByok = body.is_byok === true
    || usage.is_byok === true
    || routerMetadata.is_byok === true
    // Historical image responses did not always include router metadata. A
    // zero router charge with a positive upstream cost is the BYOK accounting
    // shape and must not silently erase real provider spend.
    || (openRouterCostUsd === 0 && upstreamCostUsd > 0);
  const providerCostUsd = isByok
    ? openRouterCostUsd + upstreamCostUsd
    : openRouterCostUsd;
  const transcriptionSeconds = capability === 'openrouter.audio.transcribe'
    ? Number(usage.seconds ?? body.duration ?? 0)
    : 0;
  return {
    result: body,
    providerRequestId: String(body.id ?? requestId ?? '').trim() || undefined,
    providerCostMicros: Number.isFinite(providerCostUsd)
      ? Math.max(0, Math.round(providerCostUsd * 1_000_000))
      : 0,
    quantity: capability === 'openrouter.audio.transcribe'
      ? Math.max(1, Math.ceil(transcriptionSeconds))
      : capability === 'openrouter.images.generate'
        ? Math.max(1, Array.isArray(body.data)
          ? body.data.length
          : positiveInteger(requestedPayload.n ?? 1, 'OpenRouter image quantity'))
        : capability === 'openrouter.models.list'
          || capability === 'openrouter.images.models.list'
          || capability === 'openrouter.images.model_endpoints.list'
          || capability === 'openrouter.videos.models.list'
          ? (capability === 'openrouter.images.model_endpoints.list'
              ? (Array.isArray(body.endpoints) ? body.endpoints.length : 0)
              : (Array.isArray(body.data) ? body.data.length : 0))
          : capability === 'openrouter.videos.generate'
            || capability === 'openrouter.videos.status'
            ? 1
            : Math.max(0, Number(usage.total_tokens ?? 0)),
    ...(capability === 'openrouter.audio.transcribe'
      ? {
          costEvidence: {
            source: 'provider_usage' as const,
            billableQuantity: transcriptionSeconds,
            unit: 'second' as const,
          },
        }
      : {}),
  };
}

function finiteCost(value: unknown): number {
  const cost = Number(value ?? 0);
  return Number.isFinite(cost) && cost > 0 ? cost : 0;
}

function imageModelEndpointsRoute(value: unknown): { readonly method: 'GET'; readonly path: string } {
  const model = required(value, 'OpenRouter image model');
  const match = /^([a-z0-9][a-z0-9._-]{0,79})\/([a-z0-9][a-z0-9._-]{0,159})$/i.exec(model);
  if (!match) throw new BadRequestException('OpenRouter image model is invalid');
  return {
    method: 'GET',
    path: `images/models/${encodeURIComponent(match[1]!)}/${encodeURIComponent(match[2]!)}/endpoints`,
  };
}

function videoStatusRoute(value: unknown): { readonly method: 'GET'; readonly path: string } {
  const jobId = required(value, 'OpenRouter video jobId');
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,199}$/.test(jobId)) {
    throw new BadRequestException('OpenRouter video jobId is invalid');
  }
  return { method: 'GET', path: `videos/${encodeURIComponent(jobId)}` };
}
