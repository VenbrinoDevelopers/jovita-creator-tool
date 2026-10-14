import { BadGatewayException, BadRequestException, Injectable } from '@nestjs/common';
import { lookup } from 'node:dns/promises';
import ipaddr from 'ipaddr.js';
import sharp from 'sharp';
import { Agent, fetch as undiciFetch } from 'undici';
import { MiniappProviderCredentialService } from '../../cloud/saas-store/miniapp-provider-credential.service.js';
import type { CapabilityCallInput, CapabilityCallResult } from '../../cloud/saas-store/capabilities/capability-operation.types.js';
import { required } from '../../cloud/saas-store/capabilities/capability-utils.js';

const MAX_SNAPSHOT_BYTES = 12 * 1024 * 1024;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const BLOCKED_TITLE = /^(?:just a moment|access denied|forbidden|unauthorized|error|not found)$/i;

@Injectable()
export class ProductCaptureLifecycle {
  readonly providerId = 'cloudflare';
  readonly credentialSource = 'admin' as const;
  readonly credentialFields = [
    { key: 'cloudflareApiToken', label: 'Cloudflare API token with Browser Rendering Write', type: 'secret', required: true },
    { key: 'cloudflareAccountId', label: 'Cloudflare account ID', type: 'text', required: true },
  ] as const;


  constructor(private readonly credentials: MiniappProviderCredentialService) {}

  validateCredential(config: Record<string, unknown>): void {
    required(config.cloudflareApiToken, 'Cloudflare API token');
    const account = required(config.cloudflareAccountId, 'Cloudflare account ID');
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(account)) throw new BadRequestException('Invalid Cloudflare account ID');
  }

  async invoke(input: CapabilityCallInput): Promise<CapabilityCallResult> {
    if (!['jovita.product.capture', 'cloudflare.browser.capture_product.v1'].includes(input.capability)) throw new BadRequestException('Unsupported product capture capability');
    const credentialProviderId = input.capability === 'jovita.product.capture' ? 'jovita-product-capture' : this.providerId;
    const config = await this.credentials.resolve(input.environment, input.packId, credentialProviderId);
    this.validateCredential(config);
    const requested = await assertPublicPageUrl(input.payload.url, input.signal);
    const endpoint = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(String(config.cloudflareAccountId))}/browser-rendering/snapshot`;
    const response = await fetch(endpoint, {
      method: 'POST', redirect: 'error',
      signal: input.signal ? AbortSignal.any([input.signal, AbortSignal.timeout(75_000)]) : AbortSignal.timeout(75_000),
      headers: { Authorization: `Bearer ${config.cloudflareApiToken}`, Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: requested.toString(), actionTimeout: 60_000,
        gotoOptions: { waitUntil: 'load', timeout: 45_000 },
        viewport: { width: 1440, height: 900, deviceScaleFactor: 1 },
        screenshotOptions: { type: 'webp', quality: 80, fullPage: false, optimizeForSpeed: true },
        rejectResourceTypes: ['media', 'websocket', 'eventsource'],
        rejectRequestPattern: [
          '^http://',
          '^https?://(?:localhost|[^/]*\\.(?:local|internal|localhost))(?:[:/]|$)',
          '^https?://(?:127\\.|10\\.|192\\.168\\.|169\\.254\\.|172\\.(?:1[6-9]|2[0-9]|3[01])\\.|100\\.(?:6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\\.)',
          '^https?://\\[(?:::1|fc|fd|fe80)',
        ],
      }),
    });
    const buffer = await boundedResponse(response, MAX_SNAPSHOT_BYTES);
    if (!response.ok) throw new BadGatewayException({ code: 'PRODUCT_CAPTURE_FAILED', message: `Browser capture failed with status ${response.status}` });
    let envelope: Record<string, unknown>;
    try { envelope = JSON.parse(buffer.toString('utf8')) as Record<string, unknown>; }
    catch { throw new BadGatewayException('Browser capture returned invalid JSON'); }
    if (envelope.success === false) throw new BadGatewayException('Browser capture reported failure');
    const result = typeof envelope.result === 'object' && envelope.result && !Array.isArray(envelope.result) ? envelope.result as Record<string, unknown> : envelope;
    const html = String(result.content ?? '');
    const screenshotRaw = String(result.screenshot ?? '').replace(/^data:image\/[a-z0-9.+-]+;base64,/i, '');
    const finalUrl = await assertPublicPageUrl(result.url ?? requested.toString(), input.signal);
    if (!html || !screenshotRaw) throw new BadGatewayException('Browser capture omitted page content or screenshot');
    const title = decodeEntities(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? '').trim().slice(0, 200);
    if (!title || BLOCKED_TITLE.test(title) || /cf-chl-|\/cdn-cgi\/challenge-platform/i.test(html)) {
      return this.free({ status: 'blocked', reason: 'The product page returned a challenge or inaccessible page' });
    }
    const visibleText = extractText(html);
    if (visibleText.length < 80) return this.free({ status: 'blocked', reason: 'The product page did not provide enough readable content' });
    const screenshot = Buffer.from(screenshotRaw, 'base64');
    if (screenshot.length < 5_000 || screenshot.length > MAX_IMAGE_BYTES) throw new BadGatewayException('Browser capture returned an invalid screenshot');
    const image = await sharp(screenshot).webp({ quality: 78 }).toBuffer();
    if (image.length > MAX_IMAGE_BYTES) throw new BadGatewayException('Product screenshot is too large');
    const description = decodeEntities(html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)["']/i)?.[1] ?? '').slice(0, 500);
    const colors = [...new Set((html.match(/#[0-9a-fA-F]{6}\b/g) ?? []).map(value => value.toLowerCase()))].slice(0, 12);
    const fonts = [...new Set((html.match(/font-family\s*:\s*[^;"']+/gi) ?? []).map(value => value.split(':')[1].trim().slice(0, 80)))].slice(0, 8);
    return this.free({ status: 'complete', final_url: finalUrl.toString(), title, description, visible_text: visibleText.slice(0, 100_000), screenshot_base64: image.toString('base64'), colors, fonts, captured_at: new Date().toISOString() });
  }

  private free(result: unknown): CapabilityCallResult { return { result, providerCostMicros: 0, quantity: 1 }; }
}

export async function assertPublicPageUrl(value: unknown, signal?: AbortSignal): Promise<URL> {
  let url: URL;
  try { url = new URL(String(value)); } catch { throw new BadRequestException('A public HTTPS URL is required'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hostname.length > 253 || !url.hostname.includes('.')) throw new BadRequestException('A public HTTPS URL without credentials or a custom port is required');
  if (url.hostname.endsWith('.local') || url.hostname.endsWith('.internal') || url.hostname.endsWith('.localhost')) throw new BadRequestException('Private hostnames are not allowed');
  let current = url;
  for (let hop = 0; hop < 4; hop += 1) {
    if (current.protocol !== 'https:' || current.username || current.password || current.port || current.hostname.length > 253 || !current.hostname.includes('.') || /\.(?:local|internal|localhost)$/i.test(current.hostname)) throw new BadRequestException('Product URL redirects to an unsupported destination');
    const answers = await lookup(current.hostname, { all: true, verbatim: true });
    if (!answers.length || answers.some(answer => !isPublicAddress(answer.address))) throw new BadRequestException('Product URL does not resolve entirely to public addresses');
    const address = answers[0];
    const dispatcher = new Agent({ connect: { lookup: (_hostname, _options, callback) => callback(null, address.address, address.family) } });
    let preflight;
    try {
      preflight = await undiciFetch(current, { method: 'HEAD', redirect: 'manual', dispatcher, signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(8_000)]) : AbortSignal.timeout(8_000) });
      await preflight.body?.cancel();
    } finally {
      await dispatcher.close();
    }
    if (preflight.status >= 300 && preflight.status < 400) {
      const location = preflight.headers.get('location');
      if (!location) throw new BadRequestException('Product URL redirects without a destination');
      current = new URL(location, current);
      continue;
    }
    if (preflight.status >= 200 && preflight.status < 300 || preflight.status === 405 || preflight.status === 501) return current;
    throw new BadGatewayException(`Product page preflight failed with status ${preflight.status}`);
  }
  throw new BadRequestException('Product URL exceeded the redirect limit');
}

export function isPublicAddress(address: string): boolean {
  try {
    const parsed = ipaddr.parse(address);
    if (parsed.range() !== 'unicast') return false;
    if (parsed.kind() === 'ipv4') return true;
    const first = Number.parseInt(parsed.toNormalizedString().split(':')[0], 16);
    return first >= 0x2000 && first <= 0x3fff;
  } catch { return false; }
}

function extractText(html: string): string {
  const without = html.replace(/<(?:script|style|noscript|svg|template)\b[^>]*>[\s\S]*?<\/(?:script|style|noscript|svg|template)>/gi, ' ')
    .replace(/<!--([\s\S]*?)-->/g, ' ').replace(/<[^>]+>/g, '\n');
  return decodeEntities(without).split(/\n+/).map(line => line.replace(/\s+/g, ' ').trim()).filter(line => line.length >= 3).join('\n').slice(0, 100_000);
}

function decodeEntities(value: string): string {
  return value.replace(/&(?:amp|lt|gt|quot|apos|nbsp);/gi, entity => ({ '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'", '&nbsp;': ' ' })[entity.toLowerCase()] ?? entity)
    .replace(/&#(\d+);/g, (_, number: string) => String.fromCodePoint(Math.min(0x10ffff, Number(number))));
}

async function boundedResponse(response: Response, limit: number): Promise<Buffer> {
  if (!response.body) throw new BadGatewayException('Browser capture returned an empty body');
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.byteLength;
    if (size > limit) throw new BadGatewayException('Browser capture response is too large');
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks, size);
}
