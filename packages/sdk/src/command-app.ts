import { JovitaApp, type AppOptions } from './app.js';
import type { BrokerOperation, RuntimeBuildConfig, ServiceConfig } from './contracts.js';

/** Author only the parts of a command that differ from the usual CLI convention. */
export type CommandToolInput = Omit<BrokerOperation, 'argvPrefix' | 'capabilities' | 'billingRequired'> & {
  argvPrefix?: string[];
  capabilities?: string[];
  billingRequired?: boolean;
};
export type NamedCommandToolInput = Omit<CommandToolInput, 'id'>;

function normalizeCommandTool(input: CommandToolInput): BrokerOperation {
  const capabilities = input.capabilities ?? [];
  const object = input.id.replace(/[._-]+/g, ' ').slice(0, 64);
  return {
    ...input,
    argvPrefix: input.argvPrefix ?? (input.id === 'offline' || input.id === 'default' ? [] : [input.id]),
    capabilities,
    billingRequired: input.billingRequired ?? capabilities.length > 0,
    activity: input.activity ?? { kind: capabilities.length > 0 ? 'run' : 'read', object,
      icon: capabilities.length > 0 ? 'command' : 'document' },
  };
}

export interface CommandAppOptions extends Omit<ServiceConfig,
  'activityProtocolVersion' | 'runtime' | 'skill' | 'providers' | 'category' | 'presentation'> {
  category?: string;
  providers?: ServiceConfig['providers'];
  skill?: ServiceConfig['skill'];
  command?: string;
  healthCheck?: NonNullable<NonNullable<ServiceConfig['runtime']>['execute']>['healthCheck'];
  /** Arguments used by the generated free offline health operation. Defaults to --help. */
  healthArgs?: string[];
  runtimeBuild?: RuntimeBuildConfig;
  tools: Record<string, CommandToolSpec>;
}

/** A command tool keeps its existing CLI argument contract and broker grants. */
export class CommandToolSpec {
  constructor(readonly operation: BrokerOperation) {}
}

export function commandTool(operation: CommandToolInput): CommandToolSpec {
  return new CommandToolSpec(normalizeCommandTool(operation));
}

export function commandTools(operations: readonly CommandToolInput[]): Record<string, CommandToolSpec>;
export function commandTools(operations: Record<string, NamedCommandToolInput>): Record<string, CommandToolSpec>;
export function commandTools(operations: readonly CommandToolInput[] | Record<string, NamedCommandToolInput>): Record<string, CommandToolSpec> {
  const tools: Record<string, CommandToolSpec> = {};
  const entries = Array.isArray(operations)
    ? operations
    : Object.entries(operations).map(([id, operation]) => ({ ...operation, id }));
  for (const operation of entries) {
    if (Object.hasOwn(tools, operation.id)) throw new Error(`Duplicate command tool: ${operation.id}`);
    tools[operation.id] = commandTool(operation);
  }
  return tools;
}

/** A Jovita app whose workflow is implemented by its existing executable. */
export class CommandApp extends JovitaApp {
  readonly kind = 'command-app' as const;
  constructor(readonly declaration: CommandAppOptions) {
    super({ id: declaration.id, name: declaration.name, version: declaration.version,
      category: declaration.category ?? 'productivity', description: declaration.description,
      logoUrl: declaration.logoUrl,
      compat: declaration.compat as JovitaApp['config']['compat'] });
  }

  serviceConfig(): ServiceConfig {
    const { tools, command, healthCheck, healthArgs, runtimeBuild, ...metadata } = this.declaration;
    const operations = Object.entries(tools).map(([id, spec]) => {
      if (!(spec instanceof CommandToolSpec)) throw new Error(`Tool ${id} must be a commandTool`);
      if (spec.operation.id !== id) throw new Error(`Command tool key ${id} differs from operation ID ${spec.operation.id}`);
      return { ...spec.operation };
    });
    if (!operations.length) throw new Error('A command app needs at least one tool');
    if (healthCheck && healthArgs) throw new Error('Use either healthCheck or healthArgs, not both');
    const inferredExclusions = [...new Set(operations
      .filter(operation => operation.id !== 'offline')
      .map(operation => operation.argvPrefix[0]).filter((value): value is string => !!value))];
    const declaredOffline = operations.find(operation => operation.id === 'offline');
    if (declaredOffline && declaredOffline.argvPrefix.length === 0 && !declaredOffline.excludedArgs) {
      declaredOffline.excludedArgs = inferredExclusions;
    }
    let resolvedHealthCheck = healthCheck;
    if (!resolvedHealthCheck) {
      const offline = declaredOffline;
      if (offline && (offline.capabilities.length > 0 || offline.billingRequired || offline.destructive)) {
        throw new Error('The offline health operation must be free and have no broker grants');
      }
      if (!offline) {
        if (operations.some(operation => operation.argvPrefix.length === 0)) {
          throw new Error('A catch-all command needs an explicit healthCheck or an offline tool');
        }
        operations.unshift({ id: 'offline', argvPrefix: [], excludedArgs: inferredExclusions, capabilities: [], billingRequired: false,
          activity: { kind: 'read', object: `${metadata.name} information`.slice(0, 64), icon: 'document' } });
      }
      resolvedHealthCheck = { command: command ?? metadata.id, args: healthArgs ?? ['--help'], operationId: 'offline' };
    }
    return {
      ...metadata,
      category: metadata.category ?? 'productivity',
      providers: metadata.providers ?? [],
      skill: metadata.skill ?? { entry: 'skill/SKILL.md', assets: ['skill/SKILL.md'] },
      compat: metadata.compat ?? { minRuntimeVersion: '0.1.0' },
      activityProtocolVersion: 1,
      runtime: {
        ...(runtimeBuild ? { build: runtimeBuild } : {}),
        execute: {
          command: command ?? metadata.id, mode: 'brokered', protocolVersion: 1,
          operations,
          healthCheck: resolvedHealthCheck,
        },
      },
    };
  }
}

export function isCommandApp(value: unknown): value is CommandApp {
  return !!value && typeof value === 'object'
    && (value as { kind?: unknown }).kind === 'command-app'
    && typeof (value as { serviceConfig?: unknown }).serviceConfig === 'function';
}
