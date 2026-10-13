import { JovitaApp, type AppOptions } from './app.js';
import type { BrokerOperation, RuntimeBuildConfig, ServiceConfig } from './contracts.js';

export interface CommandAppOptions extends Omit<ServiceConfig,
  'activityProtocolVersion' | 'runtime' | 'skill' | 'providers' | 'category'> {
  category?: string;
  providers?: ServiceConfig['providers'];
  skill?: ServiceConfig['skill'];
  command?: string;
  healthCheck?: NonNullable<NonNullable<ServiceConfig['runtime']>['execute']>['healthCheck'];
  runtimeBuild?: RuntimeBuildConfig;
  tools: Record<string, CommandToolSpec>;
}

/** A command tool keeps its existing CLI argument contract and broker grants. */
export class CommandToolSpec {
  constructor(readonly operation: BrokerOperation) {}
}

export function commandTool(operation: BrokerOperation): CommandToolSpec {
  return new CommandToolSpec(operation);
}

export function commandTools(operations: readonly BrokerOperation[]): Record<string, CommandToolSpec> {
  const tools: Record<string, CommandToolSpec> = {};
  for (const operation of operations) {
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
      logoUrl: declaration.logoUrl, presentation: declaration.presentation as AppOptions['presentation'],
      compat: declaration.compat as JovitaApp['config']['compat'] });
  }

  serviceConfig(): ServiceConfig {
    const { tools, command, healthCheck, runtimeBuild, ...metadata } = this.declaration;
    const operations = Object.entries(tools).map(([id, spec]) => {
      if (!(spec instanceof CommandToolSpec)) throw new Error(`Tool ${id} must be a commandTool`);
      if (spec.operation.id !== id) throw new Error(`Command tool key ${id} differs from operation ID ${spec.operation.id}`);
      return spec.operation;
    });
    if (!operations.length) throw new Error('A command app needs at least one tool');
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
          ...(healthCheck ? { healthCheck } : {}),
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
