import type { BrokerOperation, ServiceConfig } from './contracts.js';

export type RuntimeAppDeclaration = Omit<ServiceConfig, 'skill'> & { skill?: ServiceConfig['skill'] };

/** App metadata plus the command operations that may call the broker. */
export interface RuntimeAppOptions extends Omit<ServiceConfig, 'category' | 'providers' | 'skill' | 'runtime' | 'activityProtocolVersion' | 'compat'> {
  category?: string;
  providers?: ServiceConfig['providers'];
  skill?: ServiceConfig['skill'];
  compat?: ServiceConfig['compat'];
  operations?: BrokerOperation[];
  command?: string;
  healthCheck?: NonNullable<NonNullable<ServiceConfig['runtime']>['execute']>['healthCheck'];
  runtimeBuild?: NonNullable<ServiceConfig['runtime']>['build'];
}

export type SkillAppOptions = Omit<RuntimeAppOptions, 'operations' | 'command' | 'healthCheck' | 'runtimeBuild'>;

/** Typed declarations for an existing command runtime during SDK migration. */
export class RuntimeApp {
  readonly kind = 'existing-runtime' as const;
  readonly manifest: ServiceConfig;
  constructor(declaration: RuntimeAppDeclaration | RuntimeAppOptions) {
    if ('runtime' in declaration) {
      this.manifest = { ...declaration,
        skill: declaration.skill ?? { entry: 'skill/SKILL.md', assets: ['skill/SKILL.md'] } } as ServiceConfig;
      return;
    }
    const { operations, command, healthCheck, runtimeBuild, ...metadata } = declaration as RuntimeAppOptions;
    const executable = operations !== undefined;
    this.manifest = {
      ...metadata,
      category: metadata.category ?? 'productivity',
      providers: metadata.providers ?? [],
      skill: metadata.skill ?? { entry: 'skill/SKILL.md', assets: ['skill/SKILL.md'] },
      compat: metadata.compat ?? { minRuntimeVersion: '0.1.0' },
      ...(executable ? {
        activityProtocolVersion: 1,
        runtime: {
          ...(runtimeBuild ? { build: runtimeBuild } : {}),
          execute: { command: command ?? metadata.id, mode: 'brokered', protocolVersion: 1,
            operations,
            ...(healthCheck ? { healthCheck } : {}) },
        },
      } : {}),
    };
  }

  serviceConfig(): ServiceConfig {
    return this.manifest;
  }
}

export function defineRuntimeApp(options: RuntimeAppDeclaration | RuntimeAppOptions): RuntimeApp {
  return new RuntimeApp(options);
}

/** Optional typed authoring for skill-only apps; a JSON manifest works without the SDK. */
export function defineSkillApp(options: SkillAppOptions): RuntimeApp {
  return new RuntimeApp(options);
}

export function isRuntimeApp(value: unknown): value is RuntimeApp {
  return !!value && typeof value === 'object'
    && (value as { kind?: unknown }).kind === 'existing-runtime';
}
