import type { CapabilityCallInput, CapabilityCallResult, MiniappCapabilityContract, ProviderAccountStatus } from '../cloud/saas-store/capabilities/capability-operation.types.js';
import type { MiniappPricingMode } from '../cloud/saas-store/schemas/miniapp-pricing-policy.schema.js';

/** A protocol or lifecycle executor. Public routes and prices live in the operation definitions. */
export interface BuiltinProviderExecutor {
  readonly providerId: string;
  readonly credentialSource: 'admin' | 'user' | 'none';
  readonly credentialScope?: 'pack' | 'environment';
  readonly credentialFields: readonly { key: string; label: string; type: 'text' | 'secret' | 'url'; required: boolean }[];
  validateCredential(config: Record<string, unknown>): void;
  testCredential?(config: Record<string, unknown>, signal?: AbortSignal): Promise<void>;
  getAccountStatus?(config: Record<string, unknown>, signal?: AbortSignal): Promise<ProviderAccountStatus>;
  activationRequirements?(input: Readonly<{ capability: string; packId: string; operationId: string }>): Readonly<{
    ready: boolean; credentialProviderIds?: readonly string[]; billingUnit?: MiniappCapabilityContract['unit']; reason?: string;
  }>;
  estimateQuantity?(input: Readonly<{ capability: string; ownerId: string; packId: string;
    operationId: string; pricingMode: MiniappPricingMode; payload: Record<string, unknown> }>): Promise<number>;
  invoke(input: CapabilityCallInput): Promise<CapabilityCallResult>;
}
