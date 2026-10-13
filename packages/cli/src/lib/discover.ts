import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ServiceDiscovery } from '../types.js';

export function discoverService(servicePath: string | undefined, servicesDir?: string): ServiceDiscovery {
  let serviceRoot: string;

  if (servicePath) {
    const absolutePath = servicePath.startsWith('/') || servicePath.includes('://')
      ? servicePath
      : resolve(servicesDir ?? process.env.JOVITA_SERVICES_DIR ?? '.', servicePath);
    serviceRoot = absolutePath;
  } else {
    const cwd = process.cwd();
    if (existsSync(resolve(cwd, 'jovita.service.json'))) {
      serviceRoot = cwd;
    } else if (servicesDir) {
      throw new Error(`No service path provided and current directory (${cwd}) is not a service directory. Provide a service path or run from within a service directory containing jovita.service.json.`);
    } else {
      throw new Error(`No service path provided and current directory (${cwd}) is not a service directory. Provide a service path or run from within a service directory containing jovita.service.json.`);
    }
  }

  const manifestPath = resolve(serviceRoot, 'jovita.service.json');
  const runtimePath = resolve(serviceRoot, 'runtime');
  const skillPath = resolve(serviceRoot, 'skill');

  return { serviceRoot, manifestPath, runtimePath, skillPath };
}

export function validateServiceStructure(discovery: ServiceDiscovery): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  if (!existsSync(discovery.manifestPath)) {
    errors.push(`Missing jovita.service.json at ${discovery.manifestPath}`);
  }

  if (!existsSync(discovery.skillPath)) {
    errors.push(`Missing skill/ directory at ${discovery.skillPath}`);
  }

  const skillEntryPath = resolve(discovery.skillPath, 'SKILL.md');
  if (!existsSync(skillEntryPath)) {
    errors.push(`Missing skill/SKILL.md at ${skillEntryPath}`);
  }

  return { valid: errors.length === 0, errors };
}

export function hasRuntime(runtimePath: string): boolean {
  const packageJsonPath = resolve(runtimePath, 'package.json');
  return existsSync(packageJsonPath);
}