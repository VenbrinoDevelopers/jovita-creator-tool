import { seededBuiltinCatalog } from '../helpers/seeded-builtin-catalog.js';
import { builtinOperationDefinitions as BUILTIN_OPERATION_SEED } from '@jovita-ai/provider-catalog';
import { afterEach, describe, expect, it, vi } from 'vitest';
import sharp from 'sharp';
import { CloudflareBrowserRenderingClient, normalizeContactSheet, normalizeViewportArtifacts } from '../../src/providers/jovita-hosting/browser-rendering.client.js';
import { CloudflarePlatformApi } from '../../src/providers/jovita-hosting/cloudflare-platform.client.js';
import { JovitaHostingLifecycle as JovitaHostingLifecycleBase } from '../../src/providers/jovita-hosting/jovita-hosting.lifecycle.js';

const credential = {
  workerControlUrl: 'https://hosting-control.usejovita.com',
  workerControlSecret: 'control-secret',
  cloudflareApiToken: 'cloudflare-token',
  cloudflareAccountId: 'account_123',
  cloudflareZoneId: 'zone_123',
  fallbackHostname: 'fallback.sites.usejovita.com',
  sitesBaseDomain: 'sites.usejovita.com',
};

describe('JovitaHostingLifecycle', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('declares the brokered hosting surface under the correct provider', () => {
    const adapter = new JovitaHostingLifecycle({} as never);
    expect(adapter.providerId).toBe('jovita-hosting');
    const contracts = BUILTIN_OPERATION_SEED.filter(item => item.providerId === adapter.providerId);
    expect(contracts).toHaveLength(21);
    expect(new Set(contracts.map(item => item.capability)).size).toBe(21);
    expect(contracts.find(item => item.capability === 'jovita.hosting.release.health')?.maxCallsPerInvocation).toBe(2);
    expect(contracts.every(item => item.maxCallsPerInvocation > 0)).toBe(true);
  });

  it('rejects browser audits for a mismatched immutable release before browser authorization', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      expect(url.pathname).toBe('/__jovita/control/sites/site-1/releases');
      expect(new Headers(init?.headers).get('x-jovita-tenant-id')).toBe('tenant-from-owner');
      return Response.json({releases:[{id:'release-1',manifest_hash:'actual',state:'staged'}]});
    });
    vi.stubGlobal('fetch', fetchMock);
    const adapter = new JovitaHostingLifecycle({resolve:vi.fn().mockResolvedValue(credential)} as never);
    await expect(adapter.invoke({environment:'production',ownerId:'tenant-from-owner',packId:'website-builder',capability:'jovita.hosting.browser.audit',payload:{site_id:'site-1',release_id:'release-1',manifest_hash:'different',tenant_id:'attacker'}})).rejects.toThrow('BROWSER_AUDIT_RELEASE_MISMATCH');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('rejects mixed preview and release identities before making an outbound call', async () => {
    const fetchMock = vi.fn(); vi.stubGlobal('fetch', fetchMock);
    const adapter = new JovitaHostingLifecycle({resolve:vi.fn().mockResolvedValue(credential)} as never);
    await expect(adapter.invoke({environment:'production',ownerId:'tenant',packId:'website-builder',capability:'jovita.hosting.browser.audit',payload:{preview_id:'preview',site_id:'site',revision:'a'.repeat(64)}})).rejects.toThrow('BROWSER_AUDIT_IDENTITY_AMBIGUOUS');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('validates public control-plane and Cloudflare configuration', () => {
    const adapter = new JovitaHostingLifecycle({} as never);
    expect(() => adapter.validateCredential(credential)).not.toThrow();
    expect(() => adapter.validateCredential({ ...credential, workerControlUrl: 'https://127.0.0.1/control' }))
      .toThrow('must use a public HTTPS host');
  });

  it('uses ownerId as the tenant and maps Worker site fields for the miniapp', async () => {
    const resolve = vi.fn().mockResolvedValue(credential);
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.hostname === 'hosting-control.usejovita.com' && url.pathname.endsWith('/sites/reserve')) {
        return Response.json({
          id: 'site-1',
          slug: 'acme',
          production_url: 'https://acme.sites.usejovita.com/',
        });
      }
      if (url.hostname === 'api.cloudflare.com' && url.pathname.endsWith('/custom_hostnames') && init?.method !== 'POST') {
        return Response.json({ success: true, result: [] });
      }
      if (url.hostname === 'api.cloudflare.com' && url.pathname.endsWith('/custom_hostnames') && init?.method === 'POST') {
        expect(JSON.parse(String(init.body))).toMatchObject({
          hostname: 'acme.sites.usejovita.com',
          custom_origin_server: credential.fallbackHostname,
          ssl: { method: 'http' },
        });
        return Response.json({
          success: true,
          result: {
            id: 'cf-platform-hostname',
            hostname: 'acme.sites.usejovita.com',
            status: 'active',
            ssl: { status: 'active' },
          },
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const adapter = new JovitaHostingLifecycle({ resolve } as never);

    const output = await adapter.invoke({
      environment: 'production',
      ownerId: 'tenant-from-owner',
      packId: 'website-builder',
      capability: 'jovita.hosting.site.reserve',
      payload: { requested_slug: 'acme', tenant_id: 'untrusted-tenant' },
    });

    expect(output.result).toMatchObject({
      site_id: 'site-1',
      site_slug: 'acme',
      platform_domain: { domain: 'acme.sites.usejovita.com', ready: true },
    });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://hosting-control.usejovita.com/__jovita/control/sites/reserve');
    expect(new Headers(init.headers).get('x-jovita-tenant-id')).toBe('tenant-from-owner');
    expect(JSON.parse(String(init.body))).not.toHaveProperty('tenant_id');
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('returns the active release when looking up a site for protected update comparison', async () => {
    const resolve = vi.fn().mockResolvedValue(credential);
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.hostname === 'hosting-control.usejovita.com' && url.pathname.endsWith('/sites/by-slug/acme')) {
        return Response.json({
          id: 'site-1',
          slug: 'acme',
          active_release_id: 'release-live',
          production_url: 'https://acme.sites.usejovita.com/',
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    }));
    const adapter = new JovitaHostingLifecycle({ resolve } as never);
    const output = await adapter.invoke({
      environment: 'production',
      ownerId: 'tenant-from-owner',
      packId: 'website-builder',
      capability: 'jovita.hosting.site.lookup',
      payload: { site_slug: 'acme' },
    });
    expect(output.result).toMatchObject({
      site_id: 'site-1',
      site_slug: 'acme',
      active_release_id: 'release-live',
      deployment_url: 'https://acme.sites.usejovita.com/',
    });
  });

  it('surfaces invalid form schemas as definite validation failures', async () => {
    const resolve = vi.fn().mockResolvedValue(credential);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({
      error: { code: 'INVALID_FORM_FIELD_NAME', message: 'invalid field name: full-name' },
    }, { status: 400 })));
    const adapter = new JovitaHostingLifecycle({ resolve } as never);

    await expect(adapter.invoke({
      environment: 'production', ownerId: 'tenant-1', packId: 'website-builder',
      capability: 'jovita.hosting.form.upsert',
      payload: { site_id: 'site-1', field_schema: { fields: [{ name: 'full-name', type: 'text' }] } },
    })).rejects.toMatchObject({
      response: {
        code: 'PROVIDER_REQUEST_REJECTED',
        providerCode: 'INVALID_FORM_FIELD_NAME',
      },
    });
  });

  it('blocks health checks outside the configured hosting domain', async () => {
    const resolve = vi.fn().mockResolvedValue(credential);
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const adapter = new JovitaHostingLifecycle({ resolve } as never);

    await expect(adapter.invoke({
      environment: 'production',
      ownerId: 'tenant-1',
      packId: 'website-builder',
      capability: 'jovita.hosting.release.health',
      payload: { url: 'https://metadata.internal/latest' },
    })).rejects.toThrow('configured Jovita hosting domain');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reconciles release creation through the control plane', async () => {
    const resolve = vi.fn().mockResolvedValue(credential);
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      expect(new Headers(init?.headers).get('x-jovita-tenant-id')).toBe('tenant-1');
      if (url.pathname.endsWith('/releases/lookup')) {
        expect(JSON.parse(String(init?.body))).toEqual({ site_id: 'site-1', idempotency_key: 'a'.repeat(64) });
        return Response.json({ release_id: 'release-1', uploads: [] });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const adapter = new JovitaHostingLifecycle({ resolve } as never);
    await expect(adapter.invoke({
      environment: 'production', ownerId: 'tenant-1', packId: 'website-builder', capability: 'jovita.hosting.release.lookup',
      payload: { site_id: 'site-1', idempotency_key: 'a'.repeat(64) },
    })).resolves.toMatchObject({ result: { release_id: 'release-1' } });
  });

  it('rejects visual snapshots that are not bound to an owned preview or release', async () => {
    const resolve = vi.fn().mockResolvedValue(credential);
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const adapter = new JovitaHostingLifecycle({ resolve } as never);
    await expect(adapter.invoke({
      environment: 'production',
      ownerId: 'tenant-1',
      packId: 'website-builder',
      capability: 'jovita.hosting.visual.snapshot',
      payload: { url: 'https://attacker.example/preview' },
    })).rejects.toThrow('requires preview_id or both site_id and release_id');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects preview redirects that leave Jovita hosting before Browser Rendering runs', async () => {
    const resolve = vi.fn().mockResolvedValue(credential);
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith('/visual-snapshots/authorize')) {
        return Response.json({ capture_url: 'https://hosting-control.usejovita.com/__jovita/private-preview/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/?signature=private&expires=9999999999', capture_not_before_ms: [1, 2, 3] });
      }
      return new Response(null, { status: 302, headers: { Location: 'https://attacker.example/capture' } });
    });
    vi.stubGlobal('fetch', fetchMock);
    const adapter = new JovitaHostingLifecycle({ resolve } as never);
    await expect(adapter.invoke({
      environment: 'production', ownerId: 'tenant-1', packId: 'website-builder',
      capability: 'jovita.hosting.visual.snapshot',
      payload: { preview_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' },
    })).rejects.toThrow('configured Jovita preview domain');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('captures three remote viewports and stores all four visual artifacts', async () => {
    const resolve = vi.fn().mockResolvedValue(credential);
    const screenshot = await sharp({ create: { width: 100, height: 180, channels: 4, background: '#2563eb' } }).webp().toBuffer();
    const browserBodies: Array<Record<string, unknown>> = [];
    let activeBrowserCalls = 0;
    let maximumBrowserConcurrency = 0;
    const uploadedVisualArtifacts = new Map<string, Buffer>();
    const artifactIds = new Map([
      ['contact-sheet.webp', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'],
      ['phone.webp', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'],
      ['tablet.webp', 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'],
      ['desktop.webp', 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'],
    ]);
    const imageEvidence = encodeURIComponent(JSON.stringify([{
      path: '/assets/pet-care.webp', naturalWidth: 1600, naturalHeight: 1067,
      x: 120, y: 480, width: 720, height: 480, visible: true, loaded: true,
    }]));
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.hostname === 'hosting-control.usejovita.com' && init?.method === 'HEAD') {
        return new Response(null, { status: 200 });
      }
      if (url.hostname === 'hosting-control.usejovita.com' && url.pathname.endsWith('/visual-snapshots/authorize')) {
        expect(new Headers(init?.headers).get('x-jovita-tenant-id')).toBe('tenant-visual');
        expect(JSON.parse(String(init?.body))).toEqual({ preview_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' });
        return Response.json({ capture_url: 'https://hosting-control.usejovita.com/__jovita/private-preview/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/?signature=private&expires=9999999999', capture_not_before_ms: [1, 2, 3] });
      }
      if (url.hostname === 'api.cloudflare.com' && url.pathname.endsWith('/browser-rendering/snapshot')) {
        browserBodies.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>);
        activeBrowserCalls += 1;
        maximumBrowserConcurrency = Math.max(maximumBrowserConcurrency, activeBrowserCalls);
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 5));
        activeBrowserCalls -= 1;
        return Response.json({ success: true, result: { content: `<!doctype html><html data-jovita-capture-ready="true" data-jovita-capture-image-errors="0" data-jovita-capture-images="${imageEvidence}"><body><main>Petify</main></body></html>`, screenshot: screenshot.toString('base64'), url: 'https://hosting-control.usejovita.com/__jovita/private-preview/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/' } });
      }
      if (url.hostname === 'hosting-control.usejovita.com' && url.pathname.endsWith('/visual-artifacts') && init?.method === 'POST') {
        expect(new Headers(init.headers).get('x-jovita-tenant-id')).toBe('tenant-visual');
        const body = JSON.parse(String(init.body)) as { file_name: string };
        const artifactId = artifactIds.get(body.file_name);
        expect(artifactId).toBeTruthy();
        return Response.json({
          artifact_id: artifactId,
          upload_url: `https://hosting-control.usejovita.com/__jovita/control/visual-artifacts/${artifactId}/upload?signature=signed&expires=9999999999&path=${body.file_name}`,
          expires_at: '2026-08-07T10:00:00.000Z',
        });
      }
      const uploadMatch = url.pathname.match(/\/visual-artifacts\/([0-9a-f-]+)\/upload$/);
      if (uploadMatch && init?.method === 'PUT') {
        expect(new Headers(init.headers).get('authorization')).toBeNull();
        expect(Number(new Headers(init.headers).get('content-length'))).toBeGreaterThan(0);
        uploadedVisualArtifacts.set(uploadMatch[1], Buffer.from(init.body as Uint8Array));
        return Response.json({
          artifact_id: uploadMatch[1],
          url: `https://hosting-control.usejovita.com/__jovita/visual-artifacts/${uploadMatch[1]}?signature=read&expires=9999999999`,
          expires_at: '2026-08-07T10:00:00.000Z',
        });
      }
      const readMatch = url.pathname.match(/\/__jovita\/visual-artifacts\/([0-9a-f-]+)$/);
      if (readMatch && (!init?.method || init.method === 'GET')) {
        const image = uploadedVisualArtifacts.get(readMatch[1]) ?? Buffer.alloc(0);
        return new Response(image, { headers: { 'content-type': 'image/webp', 'content-length': String(image.byteLength) } });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const adapter = new JovitaHostingLifecycle({ resolve } as never);
    const output = await adapter.invoke({
      environment: 'production',
      ownerId: 'tenant-visual',
      packId: 'website-builder',
      capability: 'jovita.hosting.visual.snapshot',
      payload: {
        preview_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      },
    });
    expect(output.result).toMatchObject({
      artifact_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      contact_sheet_url: expect.stringContaining('/__jovita/visual-artifacts/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),
      content_type: 'image/webp',
      dimensions: { width: expect.any(Number), height: expect.any(Number) },
      capture: {
        provider: 'cloudflare_browser_rendering',
        preview_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        sha256: expect.any(String),
        images: expect.arrayContaining([
          expect.objectContaining({
            viewport: 'desktop', path: '/assets/pet-care.webp',
            natural_width: 1600, natural_height: 1067, visible: true, loaded: true,
          }),
        ]),
      },
      viewports: [{ name: 'phone' }, { name: 'tablet' }, { name: 'desktop' }],
      artifacts: [
        { file_name: 'contact-sheet.webp', model_input: true },
        { file_name: 'phone.webp', model_input: false },
        { file_name: 'tablet.webp', model_input: false },
        { file_name: 'desktop.webp', model_input: false },
      ],
    });
    expect(output.result).not.toHaveProperty('contact_sheet_data_url');
    expect(browserBodies).toHaveLength(3);
    expect(browserBodies.map((body) => (body.viewport as Record<string, unknown>).width).sort((a, b) => Number(a) - Number(b)))
      .toEqual([390, 768, 1440]);
    expect(browserBodies).toEqual(expect.arrayContaining([
      expect.objectContaining({
        actionTimeout: 60_000,
        gotoOptions: { waitUntil: 'load', timeout: 45_000 },
        waitForTimeout: 2_000,
        addScriptTag: [expect.objectContaining({
          content: expect.stringMatching(/image\.loading = 'eager'[\s\S]*scrollTo\(0, 0\)/),
        })],
      }),
    ]));
    for (const body of browserBodies) expect(body).not.toHaveProperty('waitForSelector');
    expect(maximumBrowserConcurrency).toBe(1);
  });

  it('falls back to a bounded GET preflight when an origin rejects HEAD', async () => {
    const screenshot = await sharp({ create: { width: 100, height: 180, channels: 4, background: '#f3f4f6' } }).webp().toBuffer();
    const methods: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.hostname === 'petify.sites.usejovita.com') {
        methods.push(init?.method ?? 'GET');
        if (init?.method === 'HEAD') return new Response(null, { status: 405 });
        expect(new Headers(init?.headers).get('range')).toBe('bytes=0-65535');
        return new Response('<!doctype html><main>Petify</main>', { status: 200, headers: { 'content-type': 'text/html' } });
      }
      if (url.pathname.endsWith('/browser-rendering/snapshot')) {
        return Response.json({
          success: true,
          result: {
            content: '<html data-jovita-capture-ready="true" data-jovita-capture-image-errors="0"><body><main>Petify</main></body></html>',
            screenshot: screenshot.toString('base64'),
            url: 'https://petify.sites.usejovita.com/',
          },
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    }));
    const client = new CloudflareBrowserRenderingClient(credential);
    await expect(client.captureContactSheet('https://petify.sites.usejovita.com/', [1, 2, 3]))
      .resolves.toMatchObject({ images: [] });
    expect(methods).toEqual(['HEAD', 'GET']);
  });

  it('returns a retryable error for a definitive Cloudflare action timeout', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.hostname === 'petify.sites.usejovita.com' && init?.method === 'HEAD') return new Response(null, { status: 200 });
      if (url.pathname.endsWith('/browser-rendering/snapshot')) {
        return Response.json({
          success: false,
          errors: [{ code: 6002, message: 'A timeout was reached. Waiting failed: 30000ms exceeded' }],
        }, { status: 422 });
      }
      throw new Error(`Unexpected request: ${url}`);
    }));
    const client = new CloudflareBrowserRenderingClient(credential);
    await expect(client.captureContactSheet('https://petify.sites.usejovita.com/', [1, 2, 3]))
      .rejects.toMatchObject({ response: { code: 'VISUAL_CAPTURE_RETRYABLE' } });
  });

  it('rejects a visual snapshot when a rendered page asset did not load', async () => {
    const screenshot = await sharp({ create: { width: 100, height: 180, channels: 4, background: '#f3f4f6' } }).webp().toBuffer();
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.hostname === 'petify.sites.usejovita.com' && init?.method === 'HEAD') return new Response(null, { status: 200 });
      if (url.pathname.endsWith('/browser-rendering/snapshot')) {
        return Response.json({
          success: true,
          result: {
            content: '<html data-jovita-capture-ready="true" data-jovita-capture-image-errors="1"><body><main>Petify</main></body></html>',
            screenshot: screenshot.toString('base64'),
          },
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    }));
    const client = new CloudflareBrowserRenderingClient(credential);
    await expect(client.captureContactSheet('https://petify.sites.usejovita.com/', [1, 2, 3]))
      .rejects.toMatchObject({ response: { code: 'VISUAL_CAPTURE_ASSET_FAILED' } });
  });

  it('rejects a Cloudflare challenge snapshot instead of treating it as website evidence', async () => {
    const screenshot = await sharp({ create: { width: 100, height: 180, channels: 4, background: '#f3f4f6' } }).webp().toBuffer();
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.hostname === 'petify.sites.usejovita.com' && init?.method === 'HEAD') return new Response(null, { status: 200 });
      if (url.pathname.endsWith('/browser-rendering/snapshot')) {
        return Response.json({ success: true, result: { content: '<html><head><title>Just a moment...</title></head><body><div id="cf-chl-widget">Verify</div></body></html>', screenshot: screenshot.toString('base64') } });
      }
      throw new Error(`Unexpected request: ${url}`);
    }));
    const client = new CloudflareBrowserRenderingClient(credential);
    await expect(client.captureContactSheet('https://petify.sites.usejovita.com/', [1, 2, 3]))
      .rejects.toThrow('VISUAL_CAPTURE_CHALLENGED');
  });

  it('normalizes long full-page captures into a readable R2-sized WebP artifact', async () => {
    const viewports = [
      { name: 'phone', width: 390, height: 844, isMobile: true },
      { name: 'tablet', width: 768, height: 1024, isMobile: false },
      { name: 'desktop', width: 1440, height: 900, isMobile: false },
    ] as const;
    const screenshots = await Promise.all(viewports.map(async (viewport, index) => ({
      viewport,
      bytes: await sharp({ create: { width: viewport.width, height: 12_000, channels: 4, background: index === 0 ? '#ef4444' : index === 1 ? '#22c55e' : '#3b82f6' } }).png().toBuffer(),
    })));
    const result = await normalizeContactSheet(screenshots);
    expect(result.image.byteLength).toBeLessThanOrEqual(4_000_000);
    expect(result.dimensions.width).toBeGreaterThanOrEqual(1_200);
    expect(result.viewports.map((item) => item.renderedHeight)).toEqual([12_000, 12_000, 12_000]);
    const viewportArtifacts = await normalizeViewportArtifacts(screenshots);
    expect(viewportArtifacts.map((item) => item.fileName)).toEqual(['phone.webp', 'tablet.webp', 'desktop.webp']);
    expect(viewportArtifacts.every((item) => item.image.byteLength <= 4_000_000)).toBe(true);
    expect(viewportArtifacts.every((item) => item.dimensions.width <= 16_384 && item.dimensions.height <= 16_384)).toBe(true);
    const compactScreenshots = await Promise.all(viewports.map(async (viewport) => ({
      viewport,
      bytes: await sharp({ create: { width: viewport.width, height: viewport.height, channels: 4, background: '#111827' } }).png().toBuffer(),
    })));
    await expect(normalizeContactSheet(compactScreenshots, { targetBytes: 1, maximumBytes: 1 }))
      .rejects.toMatchObject({ response: { code: 'VISUAL_ARTIFACT_NORMALIZATION_FAILED' } });
  }, 30_000);

  it('retries transient transport failures during release health checks', async () => {
    const resolve = vi.fn().mockResolvedValue(credential);
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(new Response('ok', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const adapter = new JovitaHostingLifecycle({ resolve } as never);

    const output = await adapter.invoke({
      environment: 'production',
      ownerId: 'tenant-1',
      packId: 'website-builder',
      capability: 'jovita.hosting.release.health',
      payload: { url: 'https://acme.sites.usejovita.com/' },
    });

    expect(output.result).toMatchObject({ healthy: true, attempts: 2, http_status: 200 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('tests the Worker, Cloudflare zone, and Browser Rendering permission', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith('/__jovita/control/ping')) return Response.json({ status: 'ok' });
      if (url.pathname.endsWith('/browser-rendering/screenshot')) return new Response(new Uint8Array([82, 73, 70, 70]), { status: 200, headers: { 'Content-Type': 'image/webp' } });
      if (url.pathname.endsWith('/zones/zone_123')) return Response.json({ success: true, result: { id: 'zone_123' } });
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const adapter = new JovitaHostingLifecycle({} as never);

    await adapter.testCredential(credential);

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual(expect.arrayContaining([
      'https://hosting-control.usejovita.com/__jovita/control/ping',
      'https://api.cloudflare.com/client/v4/zones/zone_123',
      'https://api.cloudflare.com/client/v4/accounts/account_123/browser-rendering/screenshot',
    ]));
  });

  it('recognizes apex routing produced by CNAME flattening', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      const name = url.searchParams.get('name');
      const type = url.searchParams.get('type');
      const answer = type === 'A' && ['example.com', credential.fallbackHostname].includes(String(name))
        ? [{ data: '203.0.113.10' }]
        : [];
      return Response.json({ Status: 0, Answer: answer });
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(new CloudflarePlatformApi(credential).routingStatus('example.com')).resolves.toBe('active');
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });

  it('maps domain attachment through Worker state and Cloudflare Custom Hostnames', async () => {
    const resolve = vi.fn().mockResolvedValue(credential);
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.hostname === 'hosting-control.usejovita.com' && url.pathname.endsWith('/domains/sync')) {
        const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
        return Response.json({ id: 'domain-1', ...body });
      }
      if (url.hostname === 'api.cloudflare.com' && url.pathname.endsWith('/custom_hostnames')) {
        expect(new Headers(init?.headers).get('content-type')).toBe('application/json');
        return Response.json({
          success: true,
          result: {
            id: 'cf-hostname-1',
            hostname: 'www.example.com',
            status: 'pending',
            ownership_verification: { type: 'txt', name: '_cf-custom-hostname.www.example.com', value: 'verify-token' },
            ssl: { status: 'pending', validation_records: [] },
          },
        });
      }
      if (url.hostname === 'cloudflare-dns.com') {
        return Response.json({ Status: 0, Answer: [{ data: `${credential.fallbackHostname}.` }] });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const adapter = new JovitaHostingLifecycle({ resolve } as never);

    const output = await adapter.invoke({
      environment: 'production',
      ownerId: 'tenant-1',
      packId: 'website-builder',
      capability: 'jovita.hosting.domain.attach',
      payload: { site_id: 'site-1', hostname: 'www.example.com', is_primary: true },
    });

    expect(output.result).toMatchObject({
      domain: 'www.example.com',
      cloudflare_hostname_id: 'cf-hostname-1',
      routing_status: 'active',
      ownership_status: 'pending',
      ssl_status: 'pending',
      ready: false,
    });
  });
});

class JovitaHostingLifecycle extends JovitaHostingLifecycleBase {
  constructor(credentials: any) { super(credentials, seededBuiltinCatalog as never); }
}
