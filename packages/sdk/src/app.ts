import { JovitaProvider, type ProviderOptions, type ApiOperation } from './provider.js';
import { ApiTool, type ToolOptions, type JovitaTool } from './tool.js';
import type { Schema } from './schema.js';

export interface AppOptions {
  id: string; name: string; version: string; category: string; description: string;
  logoUrl?: string;
  compat?: { minRuntimeVersion?: string; serviceAliases?: string[]; executableAliases?: string[] };
}

export class JovitaApp {
  static definition?: AppOptions;
  readonly config: AppOptions;
  private readonly registeredProviders: JovitaProvider[] = [];
  private readonly registeredTools: JovitaTool[] = [];

  constructor(config?: AppOptions) {
    const definition = config ?? (new.target as typeof JovitaApp).definition;
    if (!definition) throw new Error('Set static definition on the app class or pass app metadata to super()');
    this.config = definition;
  }

  protected provider(options: ProviderOptions): JovitaProvider {
    const provider = new JovitaProvider(options);
    this.registeredProviders.push(provider);
    return provider;
  }

  protected expose<I extends Schema, O extends Schema>(operation: ApiOperation<I, O>,
    options?: Partial<Omit<ToolOptions<I, O>, 'input' | 'output' | 'uses'>>): ApiTool<I, O> {
    const tool = new ApiTool(operation, options);
    this.registeredTools.push(tool);
    return tool;
  }

  protected register<T extends JovitaTool>(tool: T): T {
    this.registeredTools.push(tool);
    return tool;
  }

  providers(): JovitaProvider[] { return [...this.registeredProviders]; }
  tools(): JovitaTool[] { return [...this.registeredTools]; }
}
