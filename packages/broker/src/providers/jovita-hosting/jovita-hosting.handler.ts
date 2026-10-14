import { auditBrowserQuality } from "./browser-quality.client.js";
import { BadGatewayException, BadRequestException } from '@nestjs/common';
import { getDomain } from 'tldts';
import { CloudflarePlatformApi } from './cloudflare-platform.client.js';
import { CloudflareBrowserRenderingClient } from './browser-rendering.client.js';
import { HostingControlClient } from './hosting-control.client.js';
import type {
  CapabilityPayload,
  HostingCapabilityContext,
  HostingControlPlaneConfig,
  JsonObject,
  JsonValue,
} from './jovita-hosting.types.js';
import { normalizeHostname, objectValue, optionalString, stringValue } from './jovita-hosting.types.js';

export function createWebsiteHostingCapabilityHandler(config: HostingControlPlaneConfig) {
  const control = new HostingControlClient(new URL(config.workerControlUrl), config.workerControlSecret);
  const cloudflare = new CloudflarePlatformApi(config);
  const browser = new CloudflareBrowserRenderingClient(config);

  return async (
    capability: string,
    payload: CapabilityPayload,
    context: HostingCapabilityContext,
  ): Promise<JsonObject> => {
    const tenant = stringValue(context.tenantId, 'tenantId');
    const signal = context.signal;
    switch (capability) {
      case 'jovita.hosting.site.reserve': {
        const site = await control.request('/sites/reserve', tenant, 'POST', {
          requested_slug: payload.requested_slug,
        }, signal);
        const siteId = stringValue(site.id, 'site id');
        const siteSlug = stringValue(site.slug, 'site slug');
        const platformDomain = await provisionPlatformDomain(
          cloudflare,
          siteSlug,
          config.sitesBaseDomain,
          signal,
        );
        return {
          ...site,
          site_id: siteId,
          site_slug: siteSlug,
          platform_domain: platformDomain,
        };
      }
      case 'jovita.hosting.site.lookup': return lookupSite(control, tenant, payload, signal);
      case 'jovita.hosting.release.create': return control.request('/releases', tenant, 'POST', payload, signal);
      case 'jovita.hosting.release.lookup': return control.request('/releases/lookup', tenant, 'POST', payload, signal);
      case 'jovita.hosting.release.finalize': return control.request(`/releases/${releaseId(payload)}/finalize`, tenant, 'POST', undefined, signal);
      case 'jovita.hosting.release.promote': return control.request(`/releases/${releaseId(payload)}/promote`, tenant, 'POST', payload, signal);
      case 'jovita.hosting.release.abort': return control.request(`/releases/${releaseId(payload)}/abort`, tenant, 'POST', undefined, signal);
      case 'jovita.hosting.release.list': return control.request(`/sites/${encodeURIComponent(stringValue(payload.site_id, 'site_id'))}/releases`, tenant, 'GET', undefined, signal);
      case 'jovita.hosting.release.rollback': return rollback(control, tenant, payload, signal);
      case 'jovita.hosting.release.health': return releaseHealth(payload, config, signal);
      case 'jovita.hosting.form.upsert': return control.request('/forms', tenant, 'POST', payload, signal);
      case 'jovita.hosting.domain.attach': return attachDomain(control, cloudflare, tenant, payload, signal);
      case 'jovita.hosting.domain.status': return pollDomain(control, cloudflare, tenant, payload, signal);
      case 'jovita.hosting.domain.remove': return detachDomain(control, cloudflare, tenant, payload, signal);
      case 'jovita.hosting.submission.list': return submissions(control, tenant, payload, signal);
      case 'jovita.hosting.submission.export': return exportSubmissions(control, tenant, payload, signal);
      case 'jovita.hosting.preview.create': return control.request('/previews', tenant, 'POST', {
        files: payload.files,
        ttl_seconds: payload.ttl_seconds,
      }, signal);
      case 'jovita.hosting.preview.finalize': return control.request(
        `/previews/${encodeURIComponent(stringValue(payload.preview_id, 'preview_id'))}/finalize`,
        tenant,
        'POST',
        undefined,
        signal,
      );
      case 'jovita.hosting.preview.delete': return control.request(
        `/previews/${encodeURIComponent(stringValue(payload.preview_id, 'preview_id'))}`,
        tenant,
        'DELETE',
        undefined,
        signal,
      );
      case 'jovita.hosting.browser.audit': {
        const previewId = optionalString(payload.preview_id);
        if (previewId) {
          if (payload.site_id || payload.release_id) throw new BadRequestException('BROWSER_AUDIT_IDENTITY_AMBIGUOUS');
          const revision = stringValue(payload.revision, 'revision');
          if (!/^[a-f0-9]{64}$/.test(revision)) throw new BadRequestException('BROWSER_AUDIT_REVISION_INVALID');
          const authorization = await control.request('/visual-snapshots/authorize', tenant, 'POST', {preview_id: previewId}, signal);
          const schedule = numberArray(authorization.capture_not_before_ms, 'capture_not_before_ms', 3);
          const delay = Math.max(0, schedule[0] - Date.now());
          if (delay > 60_000) throw new BadGatewayException('BROWSER_AUDIT_CAPACITY_UNAVAILABLE');
          if (delay) await new Promise<void>(resolve => setTimeout(resolve, delay));
          signal?.throwIfAborted();
          return auditBrowserQuality(config, browser.validateCaptureUrl(stringValue(authorization.capture_url, 'capture URL')), {preview_id: previewId, revision}, signal, payload.checks, payload.supports_inconclusive === true);
        }
        const siteId = stringValue(payload.site_id, 'site_id');
        const candidateId = stringValue(payload.release_id, 'release_id');
        const manifestHash = stringValue(payload.manifest_hash, 'manifest_hash');
        const releases = await control.request(`/sites/${encodeURIComponent(siteId)}/releases`, tenant, 'GET', undefined, signal);
        const release = Array.isArray(releases.releases) ? releases.releases.find(item => item && typeof item === 'object' && !Array.isArray(item) && item.id === candidateId) : undefined;
        if (!release || typeof release !== 'object' || Array.isArray(release) || release.manifest_hash !== manifestHash || !['staged','active','superseded'].includes(String(release.state))) throw new BadRequestException('BROWSER_AUDIT_RELEASE_MISMATCH');
        const authorization = await control.request('/visual-snapshots/authorize', tenant, 'POST', {site_id:siteId,release_id:candidateId}, signal);
        const schedule = numberArray(authorization.capture_not_before_ms, 'capture_not_before_ms', 3);
        const delay = Math.max(0, schedule[0] - Date.now());
        if (delay > 60_000) throw new BadGatewayException('BROWSER_AUDIT_CAPACITY_UNAVAILABLE');
        if (delay) await new Promise<void>(resolve => setTimeout(resolve, delay));
        signal?.throwIfAborted();
        return auditBrowserQuality(config, browser.validateCaptureUrl(stringValue(authorization.capture_url, 'capture URL')), {site_id:siteId,release_id:candidateId,manifest_hash:manifestHash}, signal, payload.checks, payload.supports_inconclusive === true);
      }
      case 'jovita.hosting.visual.snapshot': return visualSnapshot(control, browser, tenant, payload, signal);
      default: throw new BadRequestException(`Unsupported website hosting capability: ${capability}`);
    }
  };
}

async function visualSnapshot(
  control: HostingControlClient,
  browser: CloudflareBrowserRenderingClient,
  tenant: string,
  payload: CapabilityPayload,
  signal?: AbortSignal,
): Promise<JsonObject> {
  const previewId = optionalString(payload.preview_id);
  const siteId = optionalString(payload.site_id);
  const releaseId = optionalString(payload.release_id);
  if (Boolean(previewId) === Boolean(siteId || releaseId) || Boolean(siteId) !== Boolean(releaseId)) {
    throw new BadRequestException('visual snapshot requires preview_id or both site_id and release_id');
  }
  const authorization = await control.request('/visual-snapshots/authorize', tenant, 'POST', previewId
    ? { preview_id: previewId }
    : { site_id: siteId, release_id: releaseId }, signal);
  const captureSchedule = numberArray(authorization.capture_not_before_ms, 'capture_not_before_ms', 3);
  const capture = await browser.captureContactSheet(
    stringValue(authorization.capture_url, 'capture URL'),
    captureSchedule,
    signal,
  );
  const createHash = (await import('node:crypto')).createHash;
  const sourceArtifacts = [
    { fileName: 'contact-sheet.webp' as const, modelInput: true, image: capture.image, dimensions: capture.dimensions },
    ...capture.viewportArtifacts.map((item) => ({ ...item, modelInput: false })),
  ];
  const artifacts = await Promise.all(sourceArtifacts.map(async (source) => {
    const sha256 = createHash('sha256').update(source.image).digest('hex');
    const artifact = await control.request('/visual-artifacts', tenant, 'POST', {
      size: source.image.byteLength,
      sha256,
      content_type: 'image/webp',
      file_name: source.fileName,
    }, signal);
    const uploaded = await control.uploadSigned(
      stringValue(artifact.upload_url, 'visual artifact upload URL'),
      source.image,
      'image/webp',
      signal,
    );
    const url = stringValue(uploaded.url, 'visual artifact URL');
    await verifyVisualArtifactReadback(url, source.image.byteLength, sha256, signal);
    return {
      artifact_id: stringValue(uploaded.artifact_id ?? artifact.artifact_id, 'visual artifact id'),
      url,
      expires_at: stringValue(uploaded.expires_at ?? artifact.expires_at, 'visual artifact expiry'),
      file_name: source.fileName,
      model_input: source.modelInput,
      content_type: 'image/webp' as const,
      size: source.image.byteLength,
      sha256,
      dimensions: source.dimensions,
    };
  }));
  const contactSheet = artifacts[0];
  if (!contactSheet) throw new BadGatewayException('Visual capture omitted the contact sheet artifact');
  return {
    artifact_id: contactSheet.artifact_id,
    contact_sheet_url: contactSheet.url,
    expires_at: contactSheet.expires_at,
    dimensions: capture.dimensions,
    viewports: capture.viewports,
    content_type: 'image/webp',
    size: contactSheet.size,
    sha256: contactSheet.sha256,
    artifacts,
    capture: {
      provider: 'cloudflare_browser_rendering',
      captured_url: capture.capturedUrl,
      ...(previewId ? { preview_id: previewId } : { site_id: siteId, release_id: releaseId }),
      captured_at: capture.capturedAt,
      viewports: capture.viewports,
      dimensions: capture.dimensions,
      content_type: 'image/webp',
      size: contactSheet.size,
      sha256: contactSheet.sha256,
      images: capture.images,
    },
  };
}

async function verifyVisualArtifactReadback(
  url: string,
  expectedSize: number,
  expectedSha256: string,
  signal?: AbortSignal,
): Promise<void> {
  const timeout = AbortSignal.timeout(15_000);
  let response: Response;
  try {
    response = await fetch(url, { method: 'GET', signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
  } catch (error) {
    throw new BadGatewayException({
      code: 'VISUAL_ARTIFACT_READBACK_FAILED',
      message: 'The visual artifact could not be retrieved after upload',
      cause: error instanceof Error ? error.name : 'network_error',
    });
  }
  if (!response.ok || response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'image/webp') {
    throw new BadGatewayException({ code: 'VISUAL_ARTIFACT_READBACK_FAILED', message: 'The visual artifact could not be verified after upload' });
  }
  const declaredLength = Number(response.headers.get('content-length') ?? expectedSize);
  if (!Number.isFinite(declaredLength) || declaredLength !== expectedSize || declaredLength > 4 * 1024 * 1024) {
    throw new BadGatewayException({ code: 'VISUAL_ARTIFACT_READBACK_FAILED', message: 'The visual artifact size did not match after upload' });
  }
  const body = Buffer.from(await response.arrayBuffer());
  const actualSha256 = (await import('node:crypto')).createHash('sha256').update(body).digest('hex');
  if (body.byteLength !== expectedSize || actualSha256 !== expectedSha256) {
    throw new BadGatewayException({ code: 'VISUAL_ARTIFACT_READBACK_FAILED', message: 'The visual artifact integrity check failed after upload' });
  }
}

function numberArray(value: unknown, name: string, length: number): number[] {
  if (!Array.isArray(value) || value.length !== length) {
    throw new BadGatewayException(`${name} must contain exactly ${length} values`);
  }
  return value.map((entry) => {
    const number = Number(entry);
    if (!Number.isSafeInteger(number) || number < 0) throw new BadGatewayException(`${name} contains an invalid value`);
    return number;
  });
}

async function provisionPlatformDomain(
  cloudflare: CloudflarePlatformApi,
  siteSlug: string,
  sitesBaseDomain: string,
  signal?: AbortSignal,
): Promise<JsonObject> {
  const hostname = normalizeHostname(`${siteSlug}.${sitesBaseDomain}`, 'platform hostname');
  let customHostname = await cloudflare.ensureCustomHostname(hostname, signal, 'http');
  const deadline = Date.now() + 30_000;
  while (!customHostnameReady(customHostname) && Date.now() < deadline) {
    await abortableDelay(2_000, signal);
    customHostname = await cloudflare.getCustomHostname(
      stringValue(customHostname.id, 'custom hostname id'),
      signal,
    );
  }
  return {
    domain: hostname,
    cloudflare_hostname_id: stringValue(customHostname.id, 'custom hostname id'),
    status: customHostnameReady(customHostname) ? 'active' : 'pending',
    ownership_status: customHostname.status === 'active' ? 'active' : 'pending',
    ssl_status: customHostnameSslStatus(customHostname),
    routing_status: 'active',
    ready: customHostnameReady(customHostname),
  };
}

function customHostnameReady(value: JsonObject): boolean {
  return value.status === 'active' && customHostnameSslStatus(value) === 'active';
}

function customHostnameSslStatus(value: JsonObject): 'active' | 'failed' | 'pending' {
  const ssl = value.ssl && typeof value.ssl === 'object' && !Array.isArray(value.ssl)
    ? value.ssl as JsonObject
    : {};
  return ssl.status === 'active' ? 'active' : ssl.status === 'failed' ? 'failed' : 'pending';
}

async function pollDomain(
  control: HostingControlClient,
  cloudflare: CloudflarePlatformApi,
  tenant: string,
  payload: CapabilityPayload,
  signal?: AbortSignal,
): Promise<JsonObject> {
  const requestedWait = Number(payload.wait_seconds ?? 0);
  const waitSeconds = Number.isFinite(requestedWait)
    ? Math.max(0, Math.min(120, Math.floor(requestedWait)))
    : 0;
  const operationTimeout = AbortSignal.timeout(120_000);
  const operationSignal = signal ? AbortSignal.any([signal, operationTimeout]) : operationTimeout;
  const deadline = Date.now() + waitSeconds * 1000;
  do {
    const state = await refreshDomain(control, cloudflare, tenant, payload, operationSignal);
    if (state.ready === true || Date.now() >= deadline) return state;
    await abortableDelay(Math.min(5_000, Math.max(0, deadline - Date.now())), operationSignal);
  } while (true);
}

async function lookupSite(
  control: HostingControlClient,
  tenant: string,
  payload: CapabilityPayload,
  signal?: AbortSignal,
): Promise<JsonObject> {
  const site = await control.request(
    `/sites/by-slug/${encodeURIComponent(stringValue(payload.site_slug, 'site_slug'))}`,
    tenant,
    'GET',
    undefined,
    signal,
  );
  const hostname = optionalString(payload.hostname);
  const domain = hostname
    ? await control.request(`/domains/${encodeURIComponent(hostname.toLowerCase())}`, tenant, 'GET', undefined, signal)
    : undefined;
  const verified = domain?.ownership_status === 'active'
    && domain.routing_status === 'active'
    && domain.ssl_status === 'active';
  return {
    status: 'success',
    site_id: stringValue(site.id, 'site id'),
    site_slug: stringValue(site.slug, 'site slug'),
    ...(optionalString(site.active_release_id) ? { active_release_id: optionalString(site.active_release_id) } : {}),
    deployment_url: stringValue(site.production_url, 'production url'),
    ...(hostname ? { custom_domain: { domain: hostname, status: verified ? 'verified_dns' : 'pending_dns' } } : {}),
    dns_records: [],
    warnings: [],
  };
}

async function rollback(
  control: HostingControlClient,
  tenant: string,
  payload: CapabilityPayload,
  signal?: AbortSignal,
): Promise<JsonObject> {
  let id = optionalString(payload.release_id);
  if (!id) {
    const listed = await control.request(
      `/sites/${encodeURIComponent(stringValue(payload.site_id, 'site_id'))}/releases`,
      tenant,
      'GET',
      undefined,
      signal,
    );
    const releases = Array.isArray(listed.releases) ? listed.releases : [];
    const prior = releases.find((entry) => entry
      && typeof entry === 'object'
      && !Array.isArray(entry)
      && (entry as JsonObject).state === 'superseded');
    id = prior && typeof prior === 'object' && !Array.isArray(prior)
      ? optionalString((prior as JsonObject).id)
      : undefined;
  }
  if (!id) throw new BadRequestException('No successful release is available for rollback');
  return control.request(`/releases/${encodeURIComponent(id)}/rollback`, tenant, 'POST', {}, signal);
}

async function releaseHealth(
  payload: CapabilityPayload,
  config: HostingControlPlaneConfig,
  signal?: AbortSignal,
): Promise<JsonObject> {
  let url: URL;
  try {
    url = new URL(stringValue(payload.url, 'url'));
  } catch {
    throw new BadRequestException('url must be a valid URL');
  }
  const baseDomain = config.sitesBaseDomain.toLowerCase();
  const hostname = url.hostname.toLowerCase();
  if (url.protocol !== 'https:' || (hostname !== baseDomain && !hostname.endsWith(`.${baseDomain}`))) {
    throw new BadRequestException('Release health URL must use the configured Jovita hosting domain');
  }
  const operationTimeout = AbortSignal.timeout(20_000);
  const operationSignal = signal ? AbortSignal.any([signal, operationTimeout]) : operationTimeout;
  const errors: string[] = [];
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const requestSignal = AbortSignal.any([operationSignal, AbortSignal.timeout(7_000)]);
      const response = await fetch(url, {
        redirect: 'manual',
        signal: requestSignal,
        headers: { 'User-Agent': 'Jovita-Release-Health/1.0' },
      });
      const healthy = response.status >= 200 && response.status < 400;
      if (healthy || response.status < 500 || attempt === 3) {
        return {
          healthy,
          status: healthy ? 'healthy' : 'unhealthy',
          url: url.toString(),
          http_status: response.status,
          attempts: attempt,
          errors: healthy ? [] : [`HTTP ${response.status}`],
        };
      }
      errors.push(`Attempt ${attempt}: HTTP ${response.status}`);
    } catch (error) {
      if (signal?.aborted) throw error;
      errors.push(`Attempt ${attempt}: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (attempt < 3) await abortableDelay(250 * attempt, operationSignal);
  }
  return {
    healthy: false,
    status: 'unhealthy',
    url: url.toString(),
    attempts: 3,
    errors,
  };
}

async function attachDomain(
  control: HostingControlClient,
  cloudflare: CloudflarePlatformApi,
  tenant: string,
  payload: CapabilityPayload,
  signal?: AbortSignal,
): Promise<JsonObject> {
  const hostname = normalizeHostname(payload.hostname, 'hostname');
  const routingMode = optionalString(payload.routing_mode);
  const isApex = getDomain(hostname, { allowPrivateDomains: true }) === hostname;
  if (isApex && !['cname_flattening', 'alias', 'aname', 'cloudflare'].includes(routingMode ?? '')) {
    throw new BadRequestException('Apex domains require routing_mode: cname_flattening, alias, aname, or cloudflare');
  }
  await control.request('/domains/sync', tenant, 'POST', {
    site_id: payload.site_id,
    hostname,
    ownership_status: 'pending',
    routing_status: 'pending',
    ssl_status: 'pending',
    is_primary: payload.is_primary === true,
    redirect_subdomain: payload.redirect_subdomain === true,
    validation_records: [],
  }, signal);
  const created = await cloudflare.createCustomHostname(hostname, signal);
  const state = cloudflare.domainState(created, await cloudflare.routingStatus(hostname, signal));
  const synced = await control.request('/domains/sync', tenant, 'POST', {
    ...state,
    site_id: payload.site_id,
    is_primary: payload.is_primary === true,
    redirect_subdomain: payload.redirect_subdomain === true,
  }, signal);
  const ready = state.ownership_status === 'active'
    && state.ssl_status === 'active'
    && state.routing_status === 'active';
  return {
    ...synced,
    domain: hostname,
    status: ready ? 'active' : 'pending',
    ready,
    dns_records: state.dns_records as JsonValue,
    validation_records: state.validation_records as JsonValue,
  };
}

async function refreshDomain(
  control: HostingControlClient,
  cloudflare: CloudflarePlatformApi,
  tenant: string,
  payload: CapabilityPayload,
  signal?: AbortSignal,
): Promise<JsonObject> {
  const hostname = normalizeHostname(payload.hostname, 'hostname');
  const stored = await control.request(`/domains/${encodeURIComponent(hostname)}`, tenant, 'GET', undefined, signal);
  const id = stringValue(stored.cloudflare_hostname_id, 'cloudflare_hostname_id');
  const state = cloudflare.domainState(
    await cloudflare.getCustomHostname(id, signal),
    await cloudflare.routingStatus(hostname, signal),
  );
  const synced = await control.request('/domains/sync', tenant, 'POST', {
    ...state,
    id: stored.id,
    site_id: stored.site_id,
    is_primary: stored.is_primary === 1 || stored.is_primary === true,
    redirect_subdomain: stored.redirect_subdomain === 1 || stored.redirect_subdomain === true,
  }, signal);
  return {
    ...synced,
    dns_records: state.dns_records as JsonValue,
    ready: state.ownership_status === 'active'
      && state.ssl_status === 'active'
      && state.routing_status === 'active',
  };
}

async function detachDomain(
  control: HostingControlClient,
  cloudflare: CloudflarePlatformApi,
  tenant: string,
  payload: CapabilityPayload,
  signal?: AbortSignal,
): Promise<JsonObject> {
  const hostname = normalizeHostname(payload.hostname, 'hostname');
  const stored = await control.request(`/domains/${encodeURIComponent(hostname)}`, tenant, 'GET', undefined, signal);
  const id = optionalString(stored.cloudflare_hostname_id);
  if (id) await cloudflare.deleteCustomHostname(id, signal);
  return control.request(`/domains/${encodeURIComponent(hostname)}`, tenant, 'DELETE', undefined, signal);
}

async function submissions(
  control: HostingControlClient,
  tenant: string,
  payload: CapabilityPayload,
  signal?: AbortSignal,
): Promise<JsonObject> {
  const before = optionalString(payload.before);
  const suffix = before ? `?before=${encodeURIComponent(before)}` : '';
  const formId = optionalString(payload.form_id);
  if (formId) {
    return control.request(`/forms/${encodeURIComponent(formId)}/submissions${suffix}`, tenant, 'GET', undefined, signal);
  }
  return control.request(
    `/sites/${encodeURIComponent(stringValue(payload.site_id, 'site_id'))}/submissions${suffix}`,
    tenant,
    'GET',
    undefined,
    signal,
  );
}

async function exportSubmissions(
  control: HostingControlClient,
  tenant: string,
  payload: CapabilityPayload,
  signal?: AbortSignal,
): Promise<JsonObject> {
  const listed = await submissions(control, tenant, payload, signal);
  const rows = Array.isArray(listed.submissions) ? listed.submissions : [];
  const keys = new Set<string>(['id', 'received_at', 'status']);
  for (const row of rows) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) continue;
    const data = (row as JsonObject).payload;
    if (data && typeof data === 'object' && !Array.isArray(data)) {
      Object.keys(data).forEach((key) => keys.add(key));
    }
  }
  const headings = [...keys];
  const csvRows = [headings.map(csvCell).join(',')];
  for (const value of rows) {
    const row = objectValue(value, 'submission');
    const data = row.payload && typeof row.payload === 'object' && !Array.isArray(row.payload)
      ? row.payload as JsonObject
      : {};
    csvRows.push(headings.map((key) => csvCell(key in row ? row[key] : data[key])).join(','));
  }
  const scope = optionalString(payload.form_id) ?? stringValue(payload.site_id, 'site_id');
  return {
    filename: `submissions-${scope}.csv`,
    content_type: 'text/csv; charset=utf-8',
    content: `${csvRows.join('\n')}\n`,
    next_cursor: listed.next_cursor ?? null,
  };
}

function releaseId(payload: CapabilityPayload): string {
  return encodeURIComponent(stringValue(payload.release_id, 'release_id'));
}

function csvCell(value: unknown): string {
  let text = value && typeof value === 'object' ? JSON.stringify(value) : String(value ?? '');
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}

function abortableDelay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (!signal) return new Promise((resolve) => setTimeout(resolve, milliseconds));
  if (signal.aborted) return Promise.reject(signal.reason ?? new BadGatewayException('Hosting request was cancelled'));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, milliseconds);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason ?? new BadGatewayException('Hosting request was cancelled'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

export type { HostingCapabilityContext, HostingControlPlaneConfig } from './jovita-hosting.types.js';
