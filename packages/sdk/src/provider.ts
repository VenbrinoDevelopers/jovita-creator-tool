import type { Schema } from './schema.js';

export interface ProviderOptions {
  id: string;
  name?: string;
  summary?: string;
  docsUrl?: string;
  category?: string;
  baseUrl: string;
  authMethod: 'bearer' | 'header';
  authHeader?: string;
  timeoutMs?: number;
}

export type ProviderDefinition = ProviderOptions & Required<Pick<ProviderOptions, 'name' | 'summary' | 'docsUrl' | 'category'>>;

export interface ApiOperationOptions<I extends Schema, O extends Schema> {
  id: string;
  version?: number;
  name?: string;
  purpose?: string;
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  path: string;
  input: I;
  output: O;
  creditsPerCall: number;
  providerCostNote?: string;
  executionKind?: 'http-json' | 'http-multipart' | 'http-binary' | 'http-sse' | 'http-poll' | 'named-run';
  /** Only for the broker's reviewed Monid named-run route. */
  providerName?: string;
  endpoint?: string;
  requestMapping?: { body: Record<string, { from: string } | { const: string | number | boolean }> };
  responseField?: string;
  queryFields?: string[];
  poll?: {
    path: string; jobIdField: string; statusField: string; resultField?: string;
    successValue: string; failureValue: string; failureValues?: string[];
    intervalMs: number; maxAttempts: number;
  };
  artifact?: { path: string; kind: 'video' | 'audio'; maxBytes: number; retentionSeconds: number; timeoutMs?: number };
  mediaPreset?: 'transparent-png-v1';
  maxRequestBytes?: number;
  maxResponseBytes?: number;
  emptyResultIsNoResult?: boolean;
}

export class ApiOperation<I extends Schema = Schema, O extends Schema = Schema> {
  constructor(readonly provider: JovitaProvider,
    readonly definition: ApiOperationOptions<I, O> & Required<Pick<ApiOperationOptions<I, O>, 'name' | 'purpose' | 'providerCostNote'>>) {}
  reference(appId: string): string {
    return `broker.${appId}.${this.provider.config.id}.${this.definition.id}.v${this.definition.version ?? 1}`;
  }
}

/** One provider class can declare and reuse any number of named operations. */
export class JovitaProvider {
  private readonly registered = new Map<string, ApiOperation>();
  readonly config: ProviderDefinition;
  constructor(config: ProviderOptions) {
    this.config = { ...config, name: config.name ?? config.id.replace(/[_-]/g, ' '),
      summary: config.summary ?? `Operations from ${config.name ?? config.id}`,
      docsUrl: config.docsUrl ?? config.baseUrl, category: config.category ?? 'api' };
  }

  operation<I extends Schema, O extends Schema>(definition: ApiOperationOptions<I, O>): ApiOperation<I, O> {
    const key = `${definition.id}.v${definition.version ?? 1}`;
    if (this.registered.has(key)) throw new Error(`Duplicate provider operation: ${this.config.id}.${key}`);
    const operation = new ApiOperation(this, { ...definition,
      name: definition.name ?? definition.id.replace(/[_-]/g, ' '),
      purpose: definition.purpose ?? definition.name ?? definition.id.replace(/[_-]/g, ' '),
      providerCostNote: definition.providerCostNote ?? 'The provider may bill your account separately.' });
    this.registered.set(key, operation);
    return operation;
  }

  operations(): ApiOperation[] { return [...this.registered.values()]; }
}
