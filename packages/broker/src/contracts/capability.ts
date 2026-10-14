/** Public broker wire contract. Jovita Cloud keeps authorization and billing outside this package. */
export interface CapabilityCallInput {
  environment: string;
  ownerId: string;
  packId: string;
  invocationId?: string;
  callId?: string;
  operationId?: string;
  pricingSnapshot?: Readonly<Record<string, unknown>>;
  capability: string;
  payload: Record<string, unknown>;
  signal?: AbortSignal;
}

export interface CapabilityCallResult {
  result: unknown;
  resultExpiresAt?: string;
  providerRequestId?: string;
  providerCostMicros: number;
  quantity: number;
}

export class ProviderOutcomeUnknownError extends Error {
  readonly code = 'INVOCATION_OUTCOME_UNKNOWN';
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = 'ProviderOutcomeUnknownError';
  }
}
