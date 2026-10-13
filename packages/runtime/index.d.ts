export interface CapabilityCallOptions<T> {
  callId?: string;
  attempt?: number;
  timeoutMs?: number;
  /** After an uncertain result, retry the same call ID for this long without submitting another provider request. */
  recoveryTimeoutMs?: number;
  maxResponseBytes?: number;
  onReceived?: (result: T) => void;
}
export declare function stableCallId(scope: string, payload: unknown): string;
export declare function invokeCapability<T>(capability: string, payload: Record<string, unknown>, options?: CapabilityCallOptions<T>): Promise<T>;
export declare function capabilityContext(): Promise<{ invocation_id?: string; receipt_recovery?: boolean }>;
export declare function recoverCapability<T>(callId: string, originInvocationId: string, capability: string): Promise<T>;
export declare function requirePendingJobReceipt(result: unknown): void;
