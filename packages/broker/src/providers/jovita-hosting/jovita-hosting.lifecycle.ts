import { BuiltinOperationCatalog } from '../../catalog/builtin-operation.catalog.js';
import { BadRequestException, Injectable } from '@nestjs/common';
import { MiniappProviderCredentialService } from '../../cloud/saas-store/miniapp-provider-credential.service.js';
import type {
  CapabilityCallInput,
  CapabilityCallResult,
} from '../../cloud/saas-store/capabilities/capability-operation.types.js';
import { assertPublicProviderUrl, required, requiredHttpsUrl } from '../../cloud/saas-store/capabilities/capability-utils.js';
import { CloudflarePlatformApi } from './cloudflare-platform.client.js';
import { CloudflareBrowserRenderingClient } from './browser-rendering.client.js';
import { HostingControlClient } from './hosting-control.client.js';
import { createWebsiteHostingCapabilityHandler } from './jovita-hosting.handler.js';
import type { HostingControlPlaneConfig } from './jovita-hosting.types.js';
import { normalizeHostname } from './jovita-hosting.types.js';


@Injectable()
export class JovitaHostingLifecycle {
  readonly providerId = 'jovita-hosting';
  readonly credentialSource = 'admin' as const;
  readonly credentialFields = [
    { key: 'workerControlUrl', label: 'Worker control URL', type: 'url', required: true },
    { key: 'workerControlSecret', label: 'Worker control secret', type: 'secret', required: true },
    { key: 'cloudflareApiToken', label: 'Cloudflare API token (Zone + Browser Rendering Write)', type: 'secret', required: true },
    { key: 'cloudflareAccountId', label: 'Cloudflare account ID', type: 'text', required: true },
    { key: 'cloudflareZoneId', label: 'Cloudflare zone ID', type: 'text', required: true },
    { key: 'fallbackHostname', label: 'Cloudflare for SaaS fallback hostname', type: 'text', required: true },
    { key: 'sitesBaseDomain', label: 'Jovita sites base domain', type: 'text', required: true },
  ] as const;


  constructor(private readonly credentials: MiniappProviderCredentialService,
    private readonly catalog?: BuiltinOperationCatalog) {}

  validateCredential(config: Record<string, unknown>): void {
    this.parseConfig(config);
  }

  async testCredential(config: Record<string, unknown>, signal?: AbortSignal): Promise<void> {
    const parsed = this.parseConfig(config);
    await Promise.all([
      new HostingControlClient(new URL(parsed.workerControlUrl), parsed.workerControlSecret).ping(signal),
      new CloudflarePlatformApi(parsed).testAccess(signal),
      new CloudflareBrowserRenderingClient(parsed).testAccess(signal),
    ]);
  }

  async invoke(input: CapabilityCallInput): Promise<CapabilityCallResult> {
    if (this.catalog?.find(input.capability)?.providerId !== this.providerId) {
      throw new BadRequestException(`Unsupported website hosting capability: ${input.capability}`);
    }
    const stored = await this.credentials.resolve(input.environment, input.packId, this.providerId);
    const config = this.parseConfig(stored);
    const handle = createWebsiteHostingCapabilityHandler(config);
    const result = await handle(input.capability, input.payload, {
      tenantId: input.ownerId,
      signal: input.signal,
    });
    return { result, providerCostMicros: 0, quantity: 1 };
  }

  private parseConfig(config: Record<string, unknown>): HostingControlPlaneConfig {
    const workerControlUrl = requiredHttpsUrl(config.workerControlUrl, 'Worker control URL');
    assertPublicProviderUrl(workerControlUrl, 'Website hosting Worker');
    if (workerControlUrl.pathname !== '/' || workerControlUrl.search || workerControlUrl.hash) {
      throw new BadRequestException('Worker control URL must be an origin without a path, query, or fragment');
    }
    const cloudflareAccountId = safeIdentifier(config.cloudflareAccountId, 'Cloudflare account ID');
    const cloudflareZoneId = safeIdentifier(config.cloudflareZoneId, 'Cloudflare zone ID');
    return {
      workerControlUrl: workerControlUrl.toString(),
      workerControlSecret: required(config.workerControlSecret, 'Worker control secret'),
      cloudflareApiToken: required(config.cloudflareApiToken, 'Cloudflare API token'),
      cloudflareAccountId,
      cloudflareZoneId,
      fallbackHostname: normalizeHostname(config.fallbackHostname, 'Fallback hostname'),
      sitesBaseDomain: normalizeHostname(config.sitesBaseDomain, 'Sites base domain'),
    };
  }
}

function safeIdentifier(value: unknown, name: string): string {
  const identifier = required(value, name);
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(identifier)) {
    throw new BadRequestException(`${name} contains unsupported characters`);
  }
  return identifier;
}
