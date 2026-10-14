import { createHash } from 'node:crypto';

export type ProviderState = 'queued' | 'dispatching' | 'running' | 'succeeded' | 'failed' | 'unknown' | 'cancelled';
export type AssetState = 'pending' | 'persisting' | 'ready' | 'failed';
export type DeliveryState = 'pending' | 'delivered' | 'failed';
export type CostSource = 'openrouter_usage' | 'account_tariff';

const transitions: Record<ProviderState, readonly ProviderState[]> = {
  // A route can become incompatible between signed publication and dispatch.
  // This terminal transition is pre-dispatch only and therefore has zero cost.
  queued: ['dispatching', 'failed', 'cancelled'],
  dispatching: ['running', 'succeeded', 'failed', 'unknown'],
  running: ['succeeded', 'failed', 'cancelled', 'unknown'],
  unknown: ['running', 'succeeded', 'failed', 'cancelled'],
  succeeded: [], failed: [], cancelled: [],
};

export function assertProviderTransition(from: ProviderState, to: ProviderState): void {
  if (!transitions[from]?.includes(to)) throw new Error(`Invalid media job transition: ${from} -> ${to}`);
}

/** Hash validated JSON, not insertion order. Arrays (dialogue, frames) retain order. */
export function mediaRequestHash(value: unknown): string {
  function canonical(item: unknown, depth = 0): string {
    if (depth > 32) throw new Error('Media request nesting exceeds limit');
    if (item === null || typeof item === 'boolean' || typeof item === 'string') return JSON.stringify(item);
    if (typeof item === 'number' && Number.isFinite(item)) return JSON.stringify(item);
    if (Array.isArray(item)) return `[${item.map(v => canonical(v, depth + 1)).join(',')}]`;
    if (typeof item === 'object' && Object.getPrototypeOf(item) === Object.prototype) {
      return `{${Object.keys(item).sort().map(key => `${JSON.stringify(key)}:${canonical(item[key], depth + 1)}`).join(',')}}`;
    }
    throw new Error('Media requests must contain finite JSON values');
  }
  const json = canonical(value);
  if (Buffer.byteLength(json) > 256 * 1024) throw new Error('Media request exceeds limit; use private asset references');
  return createHash('sha256').update(json).digest('hex');
}

export function mediaReservationCredits(providerCeilingMicros: number, creditsPerUsd: number): number {
  if (!Number.isSafeInteger(providerCeilingMicros) || providerCeilingMicros <= 0
    || !Number.isSafeInteger(creditsPerUsd) || creditsPerUsd <= 0) throw new Error('A bounded server tariff is required');
  const numerator = BigInt(providerCeilingMicros) * 120n * 150n * BigInt(creditsPerUsd);
  const denominator = 1_000_000n * 100n * 100n;
  const credits = Number((numerator + denominator - 1n) / denominator);
  if (!Number.isSafeInteger(credits)) throw new Error('Reservation exceeds supported range');
  return credits;
}

export function pollDelayMs(sequence: number): number {
  return Math.min(60_000, 2_000 * 2 ** Math.min(5, Math.max(0, sequence)));
}

export function validateCost(micros: number, source: CostSource, tariffVersion?: string): void {
  if (!Number.isSafeInteger(micros) || micros < 0) throw new Error('Authoritative cost must be nonnegative integer microdollars');
  if (!['openrouter_usage', 'account_tariff'].includes(source)) throw new Error('Invalid cost source');
  if (source === 'account_tariff' && !tariffVersion?.trim()) throw new Error('Account tariff version required');
}
