import { JovitaApp, type AppOptions } from './app.js';
import { JovitaProvider, type ApiOperationOptions, type ProviderOptions } from './provider.js';
import { ApiTool } from './tool.js';
import type { Schema } from './schema.js';
import type { JovitaActivitySpecV1 } from './contracts.js';
import { CommandApp, type CommandAppOptions, CommandToolSpec } from './command-app.js';

export interface ProviderShortcutOptions extends Omit<ProviderOptions, 'id' | 'authMethod'> {
  id?: string;
  name: string;
  auth: 'bearer' | 'header';
}

type RouteOptions<I extends Schema, O extends Schema> = Omit<ApiOperationOptions<I, O>,
  'id' | 'name' | 'purpose' | 'method' | 'path'> & { description: string; name?: string;
    activity?: JovitaActivitySpecV1; destructive?: boolean };

export class ApiToolSpec<I extends Schema, O extends Schema> {
  constructor(readonly provider: ProviderBuilder, readonly method: ApiOperationOptions<I, O>['method'],
    readonly path: string, readonly options: RouteOptions<I, O>) {}
}

/** Fluent provider declarations are data; credentials remain in broker connections. */
export class ProviderBuilder {
  readonly config: ProviderOptions;
  constructor(options: ProviderShortcutOptions) {
    const id = options.id ?? options.name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
    const { auth, ...rest } = options;
    this.config = { ...rest, id, authMethod: auth };
  }
  get<I extends Schema, O extends Schema>(path: string, options: RouteOptions<I, O>) {
    return new ApiToolSpec(this, 'GET', path, options);
  }
  post<I extends Schema, O extends Schema>(path: string, options: RouteOptions<I, O>) {
    return new ApiToolSpec(this, 'POST', path, options);
  }
  put<I extends Schema, O extends Schema>(path: string, options: RouteOptions<I, O>) {
    return new ApiToolSpec(this, 'PUT', path, options);
  }
  patch<I extends Schema, O extends Schema>(path: string, options: RouteOptions<I, O>) {
    return new ApiToolSpec(this, 'PATCH', path, options);
  }
  delete<I extends Schema, O extends Schema>(path: string, options: RouteOptions<I, O>) {
    return new ApiToolSpec(this, 'DELETE', path, options);
  }
}

export function provider(options: ProviderShortcutOptions): ProviderBuilder {
  return new ProviderBuilder(options);
}

export function defineApp(options: CommandAppOptions): CommandApp;
export function defineApp(options: Pick<AppOptions, 'id' | 'name' | 'version'>
  & Partial<Omit<AppOptions, 'id' | 'name' | 'version'>>
  & { tools: Record<string, ApiToolSpec<Schema, Schema>> }): JovitaApp;
export function defineApp(options: (Pick<AppOptions, 'id' | 'name' | 'version'>
  & Partial<Omit<AppOptions, 'id' | 'name' | 'version'>>
  & { tools: Record<string, ApiToolSpec<Schema, Schema>> }) | CommandAppOptions): JovitaApp {
  if (Object.values(options.tools).some(spec => spec instanceof CommandToolSpec)) {
    return new CommandApp(options as CommandAppOptions);
  }
  if ('command' in options || 'healthCheck' in options || 'healthArgs' in options || 'runtimeBuild' in options) {
    throw new Error('Command apps must declare tools with commandTool or commandTools');
  }
  const providers = new Map<ProviderBuilder, JovitaProvider>();
  const tools: ApiTool<Schema, Schema>[] = [];
  for (const [id, spec] of Object.entries(options.tools)) {
    if (!(spec instanceof ApiToolSpec)) throw new Error(`Tool ${id} must be a provider route`);
    let instance = providers.get(spec.provider);
    if (!instance) {
      instance = new JovitaProvider(spec.provider.config);
      providers.set(spec.provider, instance);
    }
    const { description, name, activity, destructive, ...route } = spec.options;
    const operation = instance.operation({ ...route, id, name: name ?? id, purpose: description,
      method: spec.method, path: spec.path });
    tools.push(new ApiTool(operation, { id, description, activity, destructive }));
  }
  const direct = options as Pick<AppOptions, 'id' | 'name' | 'version'> & Partial<Omit<AppOptions, 'id' | 'name' | 'version'>>;
  const metadata: AppOptions = { ...direct, category: direct.category ?? 'productivity',
    description: direct.description ?? `Tools provided by ${direct.name}.` };
  class DefinedApp extends JovitaApp {
    override providers() { return [...providers.values()]; }
    override tools() { return tools; }
  }
  return new DefinedApp(metadata);
}
