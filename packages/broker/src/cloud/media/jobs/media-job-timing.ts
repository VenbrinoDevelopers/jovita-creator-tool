/**
 * One synchronous provider request may legitimately occupy a worker for five
 * minutes. The lease must outlive that request even if a heartbeat is delayed;
 * otherwise a healthy paid dispatch is falsely quarantined as unknown.
 */
export const MEDIA_PROVIDER_REQUEST_TIMEOUT_MS = 300_000;
export const MEDIA_JOB_HEARTBEAT_MS = 30_000;
export const MEDIA_JOB_LEASE_MS = MEDIA_PROVIDER_REQUEST_TIMEOUT_MS + 2 * MEDIA_JOB_HEARTBEAT_MS;

