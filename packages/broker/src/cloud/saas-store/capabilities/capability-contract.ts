import type { MiniappCapabilityContract } from './capability-operation.types.js';

export function validateCapabilityContract(contract: MiniappCapabilityContract): void {
  if (!/^[a-z][a-z0-9_-]*(?:\.[a-z][a-z0-9_-]*)+$/.test(contract.id)) {
    throw new Error(`Invalid mini-app capability id: ${contract.id}`);
  }
  if (contract.contractVersion !== 1) {
    throw new Error(`Unsupported capability contract version for ${contract.id}`);
  }
  if (!['request', 'token', 'image', 'result', 'byte', 'second', 'provider_credit'].includes(contract.unit)) {
    throw new Error(`Invalid capability unit for ${contract.id}`);
  }
  if (!Number.isSafeInteger(contract.maxCallsPerInvocation)
    || contract.maxCallsPerInvocation < 1
    || contract.maxCallsPerInvocation > 128) {
    throw new Error(`Invalid capability call limit for ${contract.id}`);
  }
}
