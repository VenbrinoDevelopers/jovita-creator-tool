import type { Provider } from '@nestjs/common';
import { GoogleWorkspaceLifecycle } from '../providers/google-workspace/google-workspace.lifecycle.js';
import { JovitaHostingLifecycle } from '../providers/jovita-hosting/jovita-hosting.lifecycle.js';
import { OpenRouterModelEngine } from '../providers/openrouter/openrouter-model.engine.js';
import { JovitaMediaLifecycle } from '../providers/jovita-media/jovita-media.lifecycle.js';
import { PlatformActionRegistry } from './platform-action.registry.js';
import { ProductCaptureLifecycle } from '../providers/jovita-product-capture/product-capture.lifecycle.js';
import type { BuiltinProviderExecutor } from './builtin-provider-executor.js';

/** Executors implement the few provider protocols and platform lifecycles that cannot be expressed as a plain HTTP request. Published routes are declared separately. */
export const BUILTIN_PROVIDER_EXECUTORS = Symbol('BUILTIN_PROVIDER_EXECUTORS');

export const BUILTIN_PROVIDER_CLASSES = [
  OpenRouterModelEngine,
  GoogleWorkspaceLifecycle,
  JovitaHostingLifecycle,
  JovitaMediaLifecycle,
  ProductCaptureLifecycle,
] as const;

export const BUILTIN_PROVIDER_PROVIDERS: Provider[] = [
  PlatformActionRegistry,
  ...BUILTIN_PROVIDER_CLASSES,
  {
    provide: BUILTIN_PROVIDER_EXECUTORS,
    inject: [...BUILTIN_PROVIDER_CLASSES, PlatformActionRegistry],
    useFactory: (...items: [...BuiltinProviderExecutor[], PlatformActionRegistry]) => {
      const registry = items[items.length - 1] as PlatformActionRegistry;
      const platform: BuiltinProviderExecutor = {
        providerId: 'jovita-voice-library', credentialSource: 'none', credentialFields: [],
        validateCredential: config => { if (Object.keys(config).length) throw new Error('Platform actions do not accept credentials'); },
        invoke: input => registry.invoke(input),
      };
      const providers = items.slice(0, -1) as BuiltinProviderExecutor[];
      const capture = providers.find(provider => provider.providerId === 'cloudflare');
      if (!capture) throw new Error('Cloudflare capture executor is missing');
      const legacyCapture: BuiltinProviderExecutor = {
        providerId: 'jovita-product-capture', credentialSource: capture.credentialSource,
        credentialFields: capture.credentialFields,
        validateCredential: config => capture.validateCredential(config),
        invoke: input => capture.invoke(input),
      };
      return [...providers, legacyCapture, platform];
    },
  },
];
