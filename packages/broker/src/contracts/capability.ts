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
  costEvidence?: Readonly<{
    source: 'provider_usage' | 'account_tariff';
    tariffVersion?: string;
    billableQuantity?: number;
    unit?: 'second';
  }>;
  deferred?: Readonly<{ jobId: string }>;
}

export interface MiniappCapabilityContract {
  readonly id: string;
  readonly contractVersion: 1;
  readonly unit: 'request' | 'token' | 'image' | 'result' | 'byte' | 'second' | 'provider_credit';
  readonly maxCallsPerInvocation: number;
}

export interface ProviderAccountStatus {
  providerId: string;
  plan?: string;
  remainingCredits?: number;
  usedCredits?: number;
  balanceMicros?: number;
  currency?: string;
  nextRenewalDays?: number;
  nextRenewalAt?: string;
  rateLimits?: Record<string, number>;
}

export class ProviderOutcomeUnknownError extends Error {
  readonly code = 'INVOCATION_OUTCOME_UNKNOWN';
  constructor(message: string, readonly cause?: unknown,
    readonly diagnostics?: Readonly<Record<string, string>>,
    readonly measurement?: Readonly<{ providerRequestId?: string;
      providerCostMicros: number; quantity: number }>) {
    super(message);
    this.name = 'ProviderOutcomeUnknownError';
  }
}
