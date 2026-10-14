import { BadGatewayException, BadRequestException } from '@nestjs/common';
import sharp from 'sharp';
import { ProviderOutcomeUnknownError } from '../../cloud/saas-store/capabilities/capability-operation.types.js';
import type { HostingControlPlaneConfig, JsonObject } from './jovita-hosting.types.js';

const VIEWPORTS = [
  { name: 'phone', width: 390, height: 844, isMobile: true },
  { name: 'tablet', width: 768, height: 1024, isMobile: false },
  { name: 'desktop', width: 1440, height: 900, isMobile: false },
] as const;
const MAX_SCREENSHOT_BYTES = 8 * 1024 * 1024;
const MAX_SNAPSHOT_BYTES = 12 * 1024 * 1024;
const TARGET_CONTACT_SHEET_BYTES = 3_500_000;
const MAX_CONTACT_SHEET_BYTES = 4_000_000;
const MAX_VIEWPORT_ARTIFACT_BYTES = 4_000_000;
const MAX_ARTIFACT_DIMENSION = 16_384;
const INITIAL_COLUMN_WIDTH = 600;
const MINIMUM_COLUMN_WIDTH = 400;
const CAPTURE_SETTLE_TIMEOUT_MS = 2_000;
const CAPTURE_ACTION_TIMEOUT_MS = 60_000;
const CAPTURE_REQUEST_TIMEOUT_MS = 70_000;
const MAX_CAPTURE_IMAGE_EVIDENCE = 16;
const MAX_DETAIL_CROPS = 6;
// This script is deliberately best-effort. A customer site's Content Security
// Policy may prevent an injected inline script from executing, so screenshot
// capture must never wait for a DOM attribute created by this script.
const CAPTURE_PREPARATION_SCRIPT = String.raw`
(() => {
  try {
    const root = document.documentElement;
    root.setAttribute('data-jovita-capture-url', location.href);
    const images = Array.from(document.images);
    for (const image of images) image.loading = 'eager';

    // Briefly visit the page so native lazy-loaded images become eligible for
    // loading. Cloudflare then waits a fixed bounded interval before capture.
    const maximumScroll = Math.max(0, root.scrollHeight - innerHeight);
    const steps = maximumScroll === 0 ? 0 : Math.min(16, Math.max(1, Math.ceil(maximumScroll / Math.max(innerHeight, 1))));
    for (let step = 0; step <= steps; step += 1) {
      scrollTo(0, steps === 0 ? 0 : Math.round(maximumScroll * step / steps));
    }
    scrollTo(0, 0);

    const failedImages = images.filter((image) => image.complete && image.naturalWidth === 0);
    const imageEvidence = images.slice(0, ${MAX_CAPTURE_IMAGE_EVIDENCE}).flatMap((image) => {
      try {
        const rectangle = image.getBoundingClientRect();
        const style = getComputedStyle(image);
        let path = '';
        try { path = new URL(image.currentSrc || image.src, location.href).pathname; } catch {}
        return [{
          path,
          naturalWidth: image.naturalWidth,
          naturalHeight: image.naturalHeight,
          x: Math.round(rectangle.left + scrollX),
          y: Math.round(rectangle.top + scrollY),
          width: Math.round(rectangle.width),
          height: Math.round(rectangle.height),
          visible: rectangle.width >= 2 && rectangle.height >= 2 && style.visibility !== 'hidden' && style.display !== 'none',
          loaded: image.complete && image.naturalWidth > 0,
        }];
      } catch { return []; }
    });
    root.setAttribute('data-jovita-capture-image-errors', String(failedImages.length));
    root.setAttribute('data-jovita-capture-images', encodeURIComponent(JSON.stringify(imageEvidence)));
  } catch {}
})();`;
const CHALLENGE_MARKERS = [
  /<title>\s*just a moment/i,
  /cf-chl-/i,
  /\/cdn-cgi\/challenge-platform/i,
  /cf_chl_opt/i,
  /challenge-error-text/i,
];

export class CloudflareBrowserRenderingClient {
  constructor(private readonly config: HostingControlPlaneConfig) {}

  async testAccess(signal?: AbortSignal): Promise<void> {
    const endpoint = this.screenshotEndpoint();
    const healthUrl = new URL('/__jovita/health', this.config.workerControlUrl).toString();
    const response = await fetch(endpoint, {
      method: 'POST',
      redirect: 'manual',
      signal: combinedSignal(signal, 20_000),
      headers: {
        Authorization: `Bearer ${this.config.cloudflareApiToken}`,
        Accept: 'image/webp',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        url: healthUrl,
        gotoOptions: { waitUntil: 'load', timeout: 10_000 },
        viewport: { width: 64, height: 64, deviceScaleFactor: 1 },
        screenshotOptions: { type: 'webp', quality: 40, fullPage: false, optimizeForSpeed: true },
        rejectResourceTypes: ['image', 'media', 'font', 'websocket', 'eventsource'],
      }),
    });
    const bytes = await readBoundedBytes(response, 512 * 1024);
    if (!response.ok) {
      const message = bytes.toString('utf8').replace(/[\r\n\t]+/g, ' ').slice(0, 300);
      throw new BadGatewayException(`Cloudflare Browser Rendering credential check failed with status ${response.status}${message ? `: ${message}` : ''}`);
    }
    if (!bytes.length) throw new BadGatewayException('Cloudflare Browser Rendering credential check returned an empty screenshot');
  }

  async captureContactSheet(
    inputUrl: string,
    captureNotBeforeMs: readonly number[],
    signal?: AbortSignal,
  ): Promise<{
    image: Buffer;
    dimensions: { width: number; height: number };
    viewportArtifacts: Array<{ fileName: 'phone.webp' | 'tablet.webp' | 'desktop.webp'; image: Buffer; dimensions: { width: number; height: number } }>;
    viewports: JsonObject[];
    capturedUrl: string;
    capturedAt: string;
    images: JsonObject[];
  }> {
    const url = this.validateCaptureUrl(inputUrl);
    if (captureNotBeforeMs.length !== VIEWPORTS.length || captureNotBeforeMs.some((value) => !Number.isSafeInteger(value) || value < 0)) {
      throw new BadGatewayException('Worker returned an invalid Browser Rendering capture schedule');
    }
    if (captureNotBeforeMs.some((value, index) => index > 0 && value <= captureNotBeforeMs[index - 1])) {
      throw new BadGatewayException('Worker returned a non-increasing Browser Rendering capture schedule');
    }
    if (captureNotBeforeMs[0] > Date.now() + 60_000) {
      throw new BadGatewayException('Browser Rendering capture schedule exceeded the queue wait limit');
    }
    await this.verifyRedirectChain(url, signal);
    const screenshots: CapturedViewport[] = [];
    let capturedUrl = url.toString();
    for (const [index, viewport] of VIEWPORTS.entries()) {
      await waitUntil(captureNotBeforeMs[index], signal);
      const captured = await this.capture(url, viewport, signal);
      capturedUrl = captured.finalUrl;
      screenshots.push({ viewport, bytes: captured.bytes, images: captured.images });
    }
    const normalized = await normalizeContactSheet(screenshots);
    const viewportArtifacts = await normalizeViewportArtifacts(screenshots);
    return {
      image: normalized.image,
      dimensions: normalized.dimensions,
      viewportArtifacts,
      capturedUrl,
      capturedAt: new Date().toISOString(),
      images: screenshots.flatMap(({ viewport, images }) => images.map((image) => ({ viewport: viewport.name, ...image }))),
      viewports: normalized.viewports.map(({ viewport, renderedHeight }) => ({
        name: viewport.name,
        width: viewport.width,
        height: viewport.height,
        full_page_height: renderedHeight,
      })),
    };
  }

  validateCaptureUrl(inputUrl: string): URL {
    let url: URL;
    try { url = new URL(inputUrl); } catch { throw new BadRequestException('url must be a valid URL'); }
    const base = this.config.sitesBaseDomain.toLowerCase();
    const hostname = url.hostname.toLowerCase();
    const controlHostname = new URL(this.config.workerControlUrl).hostname.toLowerCase();
    if (url.protocol !== 'https:' || (hostname !== controlHostname && hostname !== base && !hostname.endsWith(`.${base}`))) {
      throw new BadRequestException('Visual snapshot URL must use the configured Jovita preview domain');
    }
    if (url.username || url.password || url.port) throw new BadRequestException('Visual snapshot URL contains unsupported authority fields');
    return url;
  }

  private async verifyRedirectChain(initial: URL, signal?: AbortSignal): Promise<void> {
    let current = initial;
    for (let hop = 0; hop < 4; hop += 1) {
      const response = await this.preflightRequest(current, signal);
      if (response.status >= 200 && response.status < 300) {
        await response.body?.cancel();
        return;
      }
      if (response.status < 300 || response.status >= 400) {
        await response.body?.cancel();
        throw new BadGatewayException(`Preview preflight failed with status ${response.status}`);
      }
      const location = response.headers.get('location');
      await response.body?.cancel();
      if (!location) throw new BadGatewayException('Preview returned a redirect without a destination');
      current = this.validateCaptureUrl(new URL(location, current).toString());
    }
    throw new BadGatewayException('Preview exceeded the redirect limit');
  }

  private async preflightRequest(url: URL, signal?: AbortSignal): Promise<Response> {
    try {
      const response = await fetch(url, {
        method: 'HEAD', redirect: 'manual', signal: combinedSignal(signal, 8_000),
        headers: { 'User-Agent': 'Jovita-Visual-Preflight/1.0' },
      });
      if (response.status !== 405 && response.status !== 501) return response;
      await response.body?.cancel();
    } catch (error) {
      if (signal?.aborted) throw error;
      // HEAD is only an optimization. Some valid preview origins do not
      // implement it reliably, so use one bounded read-only GET fallback.
    }
    try {
      return await fetch(url, {
        method: 'GET', redirect: 'manual', signal: combinedSignal(signal, 12_000),
        headers: {
          'User-Agent': 'Jovita-Visual-Preflight/1.0',
          Accept: 'text/html,application/xhtml+xml',
          Range: 'bytes=0-65535',
        },
      });
    } catch (error) {
      throw new BadGatewayException({
        code: 'VISUAL_CAPTURE_PREFLIGHT_UNAVAILABLE',
        message: 'The private website candidate could not be reached for visual capture',
        cause: error instanceof Error ? error.name : 'network_error',
      });
    }
  }

  private async capture(
    url: URL,
    viewport: typeof VIEWPORTS[number],
    signal?: AbortSignal,
  ): Promise<{ bytes: Buffer; finalUrl: string; images: CaptureImageEvidence[] }> {
    const endpoint = this.snapshotEndpoint();
    let response: Response;
    try {
      response = await fetch(endpoint, {
        method: 'POST',
        redirect: 'manual',
        signal: combinedSignal(signal, CAPTURE_REQUEST_TIMEOUT_MS),
        headers: {
          Authorization: `Bearer ${this.config.cloudflareApiToken}`,
          Accept: 'image/webp',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          url: url.toString(),
          actionTimeout: CAPTURE_ACTION_TIMEOUT_MS,
          gotoOptions: { waitUntil: 'load', timeout: 45_000 },
          addScriptTag: [{ content: CAPTURE_PREPARATION_SCRIPT }],
          waitForTimeout: CAPTURE_SETTLE_TIMEOUT_MS,
          viewport: { width: viewport.width, height: viewport.height, isMobile: viewport.isMobile, deviceScaleFactor: 1 },
          screenshotOptions: { type: 'webp', quality: 82, fullPage: true, optimizeForSpeed: true },
          rejectResourceTypes: ['media', 'websocket', 'eventsource'],
        }),
      });
    } catch (error) {
      throw new ProviderOutcomeUnknownError('Cloudflare Browser Rendering ended without a provable outcome', error);
    }
    let responseBytes: Buffer;
    try { responseBytes = await readBoundedBytes(response, MAX_SNAPSHOT_BYTES); }
    catch (error) {
      if (response.ok) throw new ProviderOutcomeUnknownError('Cloudflare Browser Rendering responded, but its snapshot could not be captured safely', error);
      throw error;
    }
    if (!response.ok) {
      const message = responseBytes.toString('utf8').replace(/[\r\n\t]+/g, ' ').slice(0, 300);
      if (response.status === 422 && /(?:timeout was reached|waiting failed|exceeded)/i.test(message)) {
        throw new BadGatewayException({
          code: 'VISUAL_CAPTURE_RETRYABLE',
          message: 'Cloudflare Browser Rendering timed out while preparing the website screenshot',
          upstream_status: response.status,
        });
      }
      throw new BadGatewayException(`Cloudflare Browser Rendering failed with status ${response.status}${message ? `: ${message}` : ''}`);
    }
    let envelope: unknown;
    try { envelope = JSON.parse(responseBytes.toString('utf8')); }
    catch { throw new BadGatewayException('Cloudflare Browser Rendering returned an invalid snapshot envelope'); }
    const parsed = parseSnapshotEnvelope(envelope, url.toString());
    parsed.finalUrl = this.validateCaptureUrl(parsed.finalUrl).toString();
    if (CHALLENGE_MARKERS.some((marker) => marker.test(parsed.content))) {
      throw new BadGatewayException('VISUAL_CAPTURE_CHALLENGED: Cloudflare Browser Rendering captured a challenge page');
    }
    if (/<title>\s*(?:error|not found|unauthorized|forbidden)/i.test(parsed.content) || !/<(?:main|body)\b/i.test(parsed.content)) {
      throw new BadGatewayException('VISUAL_CAPTURE_INVALID_PAGE: Browser Rendering did not reach a valid website document');
    }
    const imageErrors = Number(parsed.content.match(/data-jovita-capture-image-errors=["'](\d+)["']/i)?.[1] ?? 0);
    if (!Number.isSafeInteger(imageErrors) || imageErrors < 0) {
      throw new BadGatewayException('VISUAL_CAPTURE_INVALID_PAGE: Browser Rendering returned invalid image readiness evidence');
    }
    if (imageErrors > 0) {
      throw new BadGatewayException({
        code: 'VISUAL_CAPTURE_ASSET_FAILED',
        message: `Browser Rendering could not load ${imageErrors} page image${imageErrors === 1 ? '' : 's'} before visual review`,
      });
    }
    const bytes = Buffer.from(parsed.screenshot, 'base64');
    if (!bytes.length || bytes.byteLength > MAX_SCREENSHOT_BYTES) throw new BadGatewayException('Cloudflare Browser Rendering returned an invalid screenshot');
    return { bytes, finalUrl: parsed.finalUrl, images: parseImageEvidence(parsed.content) };
  }

  private screenshotEndpoint(): string {
    return `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(this.config.cloudflareAccountId)}/browser-rendering/screenshot`;
  }

  private snapshotEndpoint(): string {
    return `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(this.config.cloudflareAccountId)}/browser-rendering/snapshot`;
  }
}

type CaptureImageEvidence = {
  path: string; natural_width: number; natural_height: number;
  box: { x: number; y: number; width: number; height: number };
  visible: boolean; loaded: boolean;
};
type CapturedViewport = { viewport: typeof VIEWPORTS[number]; bytes: Buffer; images?: CaptureImageEvidence[] };

export async function normalizeViewportArtifacts(
  screenshots: CapturedViewport[],
  maximumBytes = MAX_VIEWPORT_ARTIFACT_BYTES,
): Promise<Array<{ fileName: 'phone.webp' | 'tablet.webp' | 'desktop.webp'; image: Buffer; dimensions: { width: number; height: number } }>> {
  if (screenshots.length !== VIEWPORTS.length) throw visualArtifactError('Viewport artifacts require phone, tablet, and desktop captures');
  return Promise.all(screenshots.map(async ({ viewport, bytes }) => {
    const metadata = await sharp(bytes, { limitInputPixels: 50_000_000, failOn: 'error' }).rotate().metadata();
    if (!metadata.width || !metadata.height) throw visualArtifactError(`Browser Rendering returned an invalid ${viewport.name} screenshot`);
    const scale = Math.min(1, MAX_ARTIFACT_DIMENSION / metadata.width, MAX_ARTIFACT_DIMENSION / metadata.height);
    let width = Math.max(1, Math.floor(metadata.width * scale));
    let best: { image: Buffer; dimensions: { width: number; height: number } } | undefined;
    while (width >= Math.min(320, metadata.width)) {
      for (const quality of [82, 74, 66, 58, 50, 42, 34]) {
        const image = await sharp(bytes, { limitInputPixels: 50_000_000, failOn: 'error' })
          .rotate()
          .resize({ width, fit: 'inside', withoutEnlargement: true })
          .webp({ quality, effort: 5 })
          .toBuffer();
        const output = await sharp(image).metadata();
        const dimensions = { width: output.width ?? width, height: output.height ?? 1 };
        if (!best || image.byteLength < best.image.byteLength) best = { image, dimensions };
        if (image.byteLength <= maximumBytes) {
          return { fileName: `${viewport.name}.webp` as const, image, dimensions };
        }
      }
      width = Math.floor(width * 0.85);
    }
    if (best && best.image.byteLength <= maximumBytes) return { fileName: `${viewport.name}.webp` as const, ...best };
    throw visualArtifactError(`The ${viewport.name} screenshot could not be normalized below the visual artifact limit`);
  }));
}

export async function normalizeContactSheet(
  screenshots: CapturedViewport[],
  limits: { targetBytes?: number; maximumBytes?: number } = {},
): Promise<{
  image: Buffer;
  dimensions: { width: number; height: number };
  viewports: Array<{ viewport: typeof VIEWPORTS[number]; renderedHeight: number }>;
}> {
  if (screenshots.length !== VIEWPORTS.length) throw visualArtifactError('Contact sheet requires phone, tablet, and desktop captures');
  const source = await Promise.all(screenshots.map(async ({ viewport, bytes }) => {
    const metadata = await sharp(bytes, { limitInputPixels: 50_000_000, failOn: 'error' }).rotate().metadata();
    if (!metadata.width || !metadata.height) throw visualArtifactError('Browser Rendering returned an invalid screenshot');
    return { viewport, bytes, sourceWidth: metadata.width, sourceHeight: metadata.height, renderedHeight: metadata.height };
  }));
  const targetBytes = limits.targetBytes ?? TARGET_CONTACT_SHEET_BYTES;
  const maximumBytes = limits.maximumBytes ?? MAX_CONTACT_SHEET_BYTES;
  let best: { image: Buffer; dimensions: { width: number; height: number } } | undefined;

  for (let columnWidth = INITIAL_COLUMN_WIDTH; columnWidth >= MINIMUM_COLUMN_WIDTH; columnWidth -= 50) {
    const labelHeight = Math.max(40, Math.round(columnWidth * 0.1));
    const gap = Math.max(16, Math.round(columnWidth * 0.04));
    const labelled = await Promise.all(source.map(async (item) => {
      const resizedHeight = Math.min(Math.round(6_000 * columnWidth / INITIAL_COLUMN_WIDTH), Math.max(1, Math.round(item.sourceHeight * columnWidth / item.sourceWidth)));
      const body = await sharp(item.bytes, { limitInputPixels: 50_000_000, failOn: 'error' })
        .rotate().resize({ width: columnWidth, height: resizedHeight, fit: 'inside', withoutEnlargement: false })
        .webp({ quality: 82, effort: 4 }).toBuffer();
      const bodyMetadata = await sharp(body).metadata();
      const bodyWidth = bodyMetadata.width ?? columnWidth;
      const bodyHeight = bodyMetadata.height ?? resizedHeight;
      const image = await sharp({ create: { width: columnWidth, height: bodyHeight + labelHeight, channels: 4, background: '#111827' } })
        .composite([
          { input: body, top: labelHeight, left: Math.max(0, Math.floor((columnWidth - bodyWidth) / 2)) },
          { input: Buffer.from(labelSvg(item.viewport.name, item.viewport.width, item.viewport.height, columnWidth, labelHeight)), top: 0, left: 0 },
        ]).png().toBuffer();
      return { image, height: bodyHeight + labelHeight };
    }));
    const detailCrops = await createImageDetailCrops(screenshots, columnWidth, labelHeight);
    const overviewHeight = Math.max(...labelled.map((item) => item.height));
    const detailsHeight = detailCrops.length ? Math.ceil(detailCrops.length / 3) * (detailCrops[0].height + gap) + gap : 0;
    const dimensions = {
      width: source.length * columnWidth + (source.length - 1) * gap,
      height: overviewHeight + detailsHeight,
    };
    for (const quality of [82, 74, 66, 58, 50, 42, 34]) {
      const image = await sharp({ create: { ...dimensions, channels: 4, background: '#e5e7eb' } })
        .composite([
          ...labelled.map((item, index) => ({ input: item.image, left: index * (columnWidth + gap), top: 0 })),
          ...detailCrops.map((item, index) => ({ input: item.image, left: (index % 3) * (columnWidth + gap), top: overviewHeight + gap + Math.floor(index / 3) * (item.height + gap) })),
        ])
        .webp({ quality, effort: 5 }).toBuffer();
      if (!best || image.byteLength < best.image.byteLength) best = { image, dimensions };
      if (image.byteLength <= targetBytes) return { image, dimensions, viewports: source };
    }
  }
  if (best && best.image.byteLength <= maximumBytes) return { ...best, viewports: source };
  throw visualArtifactError('The captured page could not be normalized below the visual artifact limit at readable dimensions');
}

async function createImageDetailCrops(screenshots: CapturedViewport[], width: number, labelHeight: number): Promise<Array<{ image: Buffer; height: number }>> {
  const desktop = screenshots.find((item) => item.viewport.name === 'desktop');
  if (!desktop) return [];
  const metadata = await sharp(desktop.bytes).metadata();
  if (!metadata.width || !metadata.height) return [];
  const candidates = (desktop.images ?? [])
    .filter((image) => image.loaded && image.visible && image.box.width >= 96 && image.box.height >= 72)
    .sort((left, right) => right.box.width * right.box.height - left.box.width * left.box.height)
    .slice(0, MAX_DETAIL_CROPS);
  return Promise.all(candidates.map(async (evidence, index) => {
    const left = Math.max(0, Math.min(metadata.width - 1, evidence.box.x));
    const top = Math.max(0, Math.min(metadata.height - 1, evidence.box.y));
    const cropWidth = Math.max(1, Math.min(metadata.width - left, evidence.box.width));
    const cropHeight = Math.max(1, Math.min(metadata.height - top, evidence.box.height));
    const bodyHeight = Math.round(width * 0.62);
    const body = await sharp(desktop.bytes).extract({ left, top, width: cropWidth, height: cropHeight })
      .resize(width, bodyHeight, { fit: 'contain', background: '#f9fafb' }).webp({ quality: 82, effort: 4 }).toBuffer();
    const image = await sharp({ create: { width, height: bodyHeight + labelHeight, channels: 4, background: '#111827' } })
      .composite([
        { input: body, left: 0, top: labelHeight },
        { input: Buffer.from(detailLabelSvg(index + 1, evidence.path, width, labelHeight)), left: 0, top: 0 },
      ]).png().toBuffer();
    return { image, height: bodyHeight + labelHeight };
  }));
}

function parseImageEvidence(content: string): CaptureImageEvidence[] {
  const encoded = content.match(/data-jovita-capture-images=["']([^"']*)["']/i)?.[1];
  if (!encoded) return [];
  try {
    const value = JSON.parse(decodeURIComponent(encoded.replaceAll('&amp;', '&'))) as unknown;
    if (!Array.isArray(value)) return [];
    return value.slice(0, MAX_CAPTURE_IMAGE_EVIDENCE).flatMap((row) => {
      if (!row || typeof row !== 'object' || Array.isArray(row)) return [];
      const item = row as Record<string, unknown>;
      const numbers = ['naturalWidth', 'naturalHeight', 'x', 'y', 'width', 'height'].map((key) => Number(item[key]));
      if (numbers.some((number) => !Number.isFinite(number) || number < 0)) return [];
      return [{
        path: typeof item.path === 'string' ? item.path.slice(0, 512) : '',
        natural_width: numbers[0], natural_height: numbers[1],
        box: { x: numbers[2], y: numbers[3], width: numbers[4], height: numbers[5] },
        visible: item.visible === true, loaded: item.loaded === true,
      }];
    });
  } catch { return []; }
}

function visualArtifactError(message: string): BadGatewayException {
  return new BadGatewayException({ code: 'VISUAL_ARTIFACT_NORMALIZATION_FAILED', message });
}

function parseSnapshotEnvelope(value: unknown, requestedUrl: string): { content: string; screenshot: string; finalUrl: string } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new BadGatewayException('Cloudflare Browser Rendering returned an invalid snapshot envelope');
  const outer = value as Record<string, unknown>;
  if (outer.success === false) throw new BadGatewayException('Cloudflare Browser Rendering snapshot reported failure');
  const result = outer.result && typeof outer.result === 'object' && !Array.isArray(outer.result)
    ? outer.result as Record<string, unknown>
    : outer;
  const content = typeof result.content === 'string' ? result.content : '';
  const screenshot = typeof result.screenshot === 'string' ? result.screenshot.replace(/^data:image\/[a-z0-9.+-]+;base64,/i, '') : '';
  const embeddedUrl = content.match(/data-jovita-capture-url=["']([^"']+)["']/i)?.[1]
    ?.replaceAll('&amp;', '&');
  const finalUrl = embeddedUrl || (typeof result.url === 'string' ? result.url : requestedUrl);
  if (!content || !screenshot) throw new BadGatewayException('Cloudflare Browser Rendering snapshot omitted page content or screenshot evidence');
  return { content, screenshot, finalUrl };
}

function combinedSignal(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

async function waitUntil(notBeforeMs: number, signal?: AbortSignal): Promise<void> {
  const delayMs = Math.max(0, notBeforeMs - Date.now());
  if (delayMs === 0) return;
  await new Promise<void>((resolve, reject) => {
    const finish = () => {
      signal?.removeEventListener('abort', abort);
      resolve();
    };
    const timeout = setTimeout(finish, delayMs);
    const abort = () => {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', abort);
      reject(signal?.reason instanceof Error ? signal.reason : new Error('Browser Rendering capture was cancelled'));
    };
    if (signal?.aborted) return abort();
    signal?.addEventListener('abort', abort, { once: true });
  });
}

async function readBoundedBytes(response: Response, maxBytes: number): Promise<Buffer> {
  const length = Number(response.headers.get('content-length') ?? 0);
  if (length > maxBytes) throw new BadGatewayException('Browser Rendering response exceeded the configured limit');
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new BadGatewayException('Browser Rendering response exceeded the configured limit');
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

function labelSvg(name: string, width: number, height: number, canvasWidth: number, canvasHeight: number): string {
  const label = `${name.toUpperCase()}  ${width} x ${height}`;
  return `<svg width="${canvasWidth}" height="${canvasHeight}" xmlns="http://www.w3.org/2000/svg"><rect width="100%" height="100%" fill="#111827"/><text x="24" y="38" font-family="Arial, sans-serif" font-size="22" font-weight="700" fill="#ffffff">${label}</text></svg>`;
}

function detailLabelSvg(index: number, path: string, canvasWidth: number, canvasHeight: number): string {
  const safePath = path.replace(/[<>&"']/g, '').slice(-42);
  return `<svg width="${canvasWidth}" height="${canvasHeight}" xmlns="http://www.w3.org/2000/svg"><rect width="100%" height="100%" fill="#111827"/><text x="18" y="36" font-family="Arial, sans-serif" font-size="19" font-weight="700" fill="#ffffff">IMAGE DETAIL ${index}  ${safePath}</text></svg>`;
}
