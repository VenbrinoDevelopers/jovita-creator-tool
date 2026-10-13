import { createHash, randomUUID } from 'node:crypto';
import { createConnection } from 'node:net';

const automaticCallOrdinals = new Map();

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function stableCallId(scope, payload) {
  return `call_${createHash('sha256').update(scope).update('\0').update(stableJson(payload)).digest('hex').slice(0, 32)}`;
}

function nextAutomaticCallId(capability, payload) {
  const fingerprint = stableCallId(capability, payload);
  const ordinal = automaticCallOrdinals.get(fingerprint) ?? 0;
  automaticCallOrdinals.set(fingerprint, ordinal + 1);
  return stableCallId(`${fingerprint}:${ordinal}`, payload);
}

function coded(code, message, cause) {
  return Object.assign(new Error(message), { code, ...(cause ? { cause } : {}) });
}

function brokerContext() {
  const socketPath = String(process.env.JOVITA_CAPABILITY_SOCKET ?? '').trim();
  const token = String(process.env.JOVITA_CAPABILITY_TOKEN ?? '').trim();
  if (!socketPath) throw coded('BROKER_UNAVAILABLE', 'Jovita capability broker is unavailable.');
  if (!token) throw coded('CAPABILITY_NOT_AUTHENTICATED', 'Jovita capability invocation is not authenticated.');
  return { socketPath, token };
}

function providerError(value) {
  if (typeof value === 'string') return coded('CAPABILITY_REQUEST_FAILED', value);
  const code = String(value?.code ?? 'CAPABILITY_REQUEST_FAILED');
  const error = coded(code, String(value?.message ?? code));
  for (const key of ['retrySafe', 'charged', 'retryable', 'phase', 'viewport', 'retry_after_seconds']) {
    if (value && Object.prototype.hasOwnProperty.call(value, key)) error[key] = value[key];
  }
  return error;
}

function frame(socketPath, body, timeoutMs, maxResponseBytes) {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    let raw = '';
    let dispatched = false;
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (error) reject(error);
      else resolve(value);
    };
    socket.setEncoding('utf8');
    socket.setTimeout(timeoutMs, () => finish(coded(dispatched ? 'OUTCOME_UNKNOWN' : 'BROKER_UNAVAILABLE', 'Capability request timed out.')));
    socket.once('connect', () => {
      dispatched = true;
      socket.write(`${JSON.stringify({ protocolVersion: 2, ...body })}\n`);
    });
    socket.on('data', (chunk) => {
      raw += chunk;
      if (Buffer.byteLength(raw) > maxResponseBytes) finish(coded('CAPABILITY_RESPONSE_TOO_LARGE', 'Capability response exceeded its limit.'));
    });
    socket.once('error', (error) => finish(coded(dispatched ? 'OUTCOME_UNKNOWN' : 'BROKER_UNAVAILABLE', 'Capability transport failed.', error)));
    socket.once('end', () => {
      if (settled) return;
      try {
        const response = JSON.parse(raw.trim());
        if (response.protocolVersion !== 2) throw coded('BROKER_PROTOCOL_ERROR', 'Unsupported capability protocol.');
        if (!response.ok) throw providerError(response.error);
        finish(undefined, response.result);
      } catch (error) {
        finish(error instanceof SyntaxError ? coded('OUTCOME_UNKNOWN', 'Capability response could not be decoded.', error) : error);
      }
    });
  });
}

export async function invokeCapability(capability, payload, options = {}) {
  const { socketPath, token } = brokerContext();
  const callId = options.callId ?? nextAutomaticCallId(capability, payload);
  const request = {
    type: 'invoke', callId, capability, payload, token,
    ...(options.attempt ? { attempt: options.attempt } : {}),
  };
  const timeoutMs = options.timeoutMs ?? 120_000;
  const maxResponseBytes = options.maxResponseBytes ?? 32 * 1024 * 1024;
  const recoveryTimeoutMs = options.recoveryTimeoutMs
    ?? (/^(?:broker|creator)\./.test(capability) ? 10 * 60_000 : 0);
  if (!Number.isSafeInteger(recoveryTimeoutMs) || recoveryTimeoutMs < 0 || recoveryTimeoutMs > 30 * 60_000) {
    throw coded('CAPABILITY_INVALID_RECOVERY_TIMEOUT', 'Recovery timeout must be between 0 and 30 minutes.');
  }
  let result;
  try {
    result = await frame(socketPath, request, timeoutMs, maxResponseBytes);
  } catch (error) {
    if (!recoveryTimeoutMs || !['OUTCOME_UNKNOWN', 'INVOCATION_OUTCOME_UNKNOWN'].includes(error?.code)) throw error;
    const deadline = Date.now() + recoveryTimeoutMs;
    while (true) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw error;
      await new Promise(resolve => setTimeout(resolve, Math.min(1500, remaining)));
      const retryRemaining = deadline - Date.now();
      if (retryRemaining <= 0) throw error;
      try {
        result = await frame(socketPath, request, Math.min(timeoutMs, retryRemaining), maxResponseBytes);
        break;
      } catch (retryError) {
        if (!['OUTCOME_UNKNOWN', 'INVOCATION_OUTCOME_UNKNOWN'].includes(retryError?.code)) throw retryError;
        error = retryError;
      }
    }
  }
  options.onReceived?.(result);
  try {
    await frame(socketPath, { type: 'ack', callId, token }, 30_000, 64 * 1024);
  } catch (error) {
    throw coded('CAPABILITY_DELIVERY_ACK_FAILED', 'Capability result was received but delivery could not be acknowledged.', error);
  }
  return result;
}

export async function capabilityContext() {
  const { socketPath, token } = brokerContext();
  return frame(socketPath, { type: 'context', callId: `call_${randomUUID()}`, token }, 30_000, 64 * 1024);
}

export async function recoverCapability(callId, originInvocationId, capability) {
  const { socketPath, token } = brokerContext();
  return frame(socketPath, { type: 'recover', callId, originInvocationId, capability, token }, 120_000, 32 * 1024 * 1024);
}

export function requirePendingJobReceipt(result) {
  if (!result || typeof result !== 'object' || result.status !== 'pending'
    || typeof result.job_id !== 'string' || !result.job_id.trim()) {
    throw coded('OUTCOME_UNKNOWN', 'Submission response lacks a valid job ID; delivery was not acknowledged.');
  }
}
