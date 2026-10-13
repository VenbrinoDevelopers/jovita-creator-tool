import type { ServiceConfig } from './contracts.js';

export type RuntimeAppDeclaration = Omit<ServiceConfig, 'skill'> & { skill?: ServiceConfig['skill'] };

/** Typed declarations for an existing command runtime during SDK migration. */
export class RuntimeApp {
  readonly kind = 'existing-runtime' as const;
  constructor(readonly manifest: RuntimeAppDeclaration) {}

  serviceConfig(): ServiceConfig {
    return { ...this.manifest,
      skill: this.manifest.skill ?? { entry: 'SKILL.md', assets: ['.'] } };
  }
}

export function defineRuntimeApp(manifest: RuntimeAppDeclaration): RuntimeApp {
  return new RuntimeApp(manifest);
}

export function isRuntimeApp(value: unknown): value is RuntimeApp {
  return !!value && typeof value === 'object'
    && (value as { kind?: unknown }).kind === 'existing-runtime';
}
