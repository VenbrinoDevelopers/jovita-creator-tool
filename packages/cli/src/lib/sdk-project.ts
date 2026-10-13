import { existsSync, mkdirSync, cpSync, writeFileSync, chmodSync, readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { build } from 'esbuild';
import { tsImport } from 'tsx/esm/api';
import { JovitaApp, RuntimeApp, compileApp, isRuntimeApp } from '@jovita/sdk';
import type { ServiceConfig } from '@jovita/sdk';

export function sdkProjectPath(root: string): string | undefined {
  const candidates = [resolve(root, 'runtime/jovita.app.ts'), resolve(root, 'runtime/jovita.app.js'),
    resolve(root, 'src/jovita.app.ts'), resolve(root, 'src/jovita.app.js'),
    resolve(root, 'jovita.app.ts'), resolve(root, 'jovita.app.js')];
  const sources = candidates.filter(existsSync);
  if (sources.length > 1) throw new Error('Found multiple app entry points. Keep one jovita.app.ts or jovita.app.js.');
  const source = sources[0];
  return source;
}

export async function loadProjectDefinition(root: string, options: { allowManifestDrift?: boolean } = {}): Promise<JovitaApp | RuntimeApp> {
  const path = sdkProjectPath(root);
  if (!path) throw new Error(`No runtime/jovita.app.ts, src/jovita.app.ts, or root app entry in ${root}`);
  const module = await tsImport(path, import.meta.url) as { default?: JovitaApp | RuntimeApp | (new () => JovitaApp) };
  if (!module.default) throw new Error('The app entry must default-export defineApp(...) or an app class');
  const app = typeof module.default === 'function' ? new module.default() : module.default;
  if (isRuntimeApp(app)) {
    const manifest = app.manifest;
    if (!manifest || typeof manifest.id !== 'string') {
      throw new Error('defineRuntimeApp requires an app id');
    }
    if (existsSync(resolve(root, 'runtime/package.json')) && !manifest.runtime?.execute) {
      throw new Error('Executable apps must declare their operations in defineRuntimeApp');
    }
    const checkedIn = resolve(root, 'jovita.service.json');
    if (!options.allowManifestDrift && !existsSync(checkedIn)) throw new Error('Existing runtime apps need the matching jovita.service.json during migration');
    const saved = existsSync(checkedIn) ? JSON.parse(readFileSync(checkedIn, 'utf8')) as ServiceConfig : undefined;
    if (!options.allowManifestDrift && !isDeepStrictEqual(saved, manifest)) {
      throw new Error('SDK declaration and jovita.service.json differ. Regenerate the compatibility manifest before building.');
    }
    return app;
  }
  if (!app || typeof app.providers !== 'function' || typeof app.tools !== 'function'
    || typeof app.config?.id !== 'string') {
    throw new Error('Default export must extend JovitaApp');
  }
  if (existsSync(resolve(root, 'jovita.service.json'))) {
    throw new Error('Both an SDK app and jovita.service.json are present. Keep one authoring source.');
  }
  return app;
}

export async function loadSdkApp(root: string): Promise<JovitaApp> {
  const app = await loadProjectDefinition(root);
  if (isRuntimeApp(app)) {
    throw new Error('This app uses its existing command runtime. Run that runtime locally; jov build and jov verify support its SDK declaration.');
  }
  return app;
}

export interface PreparedSdkProject { root: string; app: JovitaApp | RuntimeApp; cleanup(): Promise<void> }

export async function prepareSdkProject(projectRoot: string): Promise<PreparedSdkProject> {
  const source = sdkProjectPath(projectRoot);
  if (!source) throw new Error(`No SDK app in ${projectRoot}`);
  const app = await loadProjectDefinition(projectRoot);
  if (isRuntimeApp(app)) {
    return { root: projectRoot, app, cleanup: async () => {} };
  }
  const manifest = compileApp(app);
  const root = await mkdtemp(join(tmpdir(), `jov-sdk-${app.config.id}-`));
  try {
    writeFileSync(resolve(root, 'jovita.service.json'), JSON.stringify(manifest, null, 2));
    const sourceSkill = resolve(projectRoot, 'skill');
    const targetSkill = resolve(root, 'skill');
    if (existsSync(sourceSkill)) cpSync(sourceSkill, targetSkill, { recursive: true });
    else {
      mkdirSync(targetSkill, { recursive: true });
      const commands = app.tools().map(tool => `- \`${app.config.id} ${tool.config.id} '<json-input>'\`: ${tool.config.description}`).join('\n');
      writeFileSync(resolve(targetSkill, 'SKILL.md'), `# ${app.config.name}\n\n${app.config.description}\n\n## Commands\n\n${commands}\n`);
    }
    const runtimeRoot = resolve(root, 'runtime');
    const dist = resolve(runtimeRoot, 'dist');
    mkdirSync(dist, { recursive: true });
    const sdkUrl = import.meta.resolve('@jovita/sdk');
    const runtimeSource = `import App from ${JSON.stringify(source)};\nimport { runCli } from ${JSON.stringify(fileURLToPath(sdkUrl))};\nawait runCli(typeof App === 'function' ? new App() : App);\n`;
    await build({ stdin: { contents: runtimeSource, resolveDir: projectRoot, sourcefile: 'jovita-runtime.ts', loader: 'ts' },
      outfile: resolve(dist, 'index.js'), bundle: true, platform: 'node', format: 'esm', target: 'node22',
      banner: { js: '#!/usr/bin/env node' }, logLevel: 'silent' });
    chmodSync(resolve(dist, 'index.js'), 0o755);
    writeFileSync(resolve(runtimeRoot, 'package.json'), JSON.stringify({
      name: `@jovita-app/${app.config.id}`, version: app.config.version, type: 'module',
      bin: { [app.config.id]: './dist/index.js' },
      scripts: { build: 'node -e ""' }, dependencies: {},
    }, null, 2));
    return { root, app, cleanup: () => rm(root, { recursive: true, force: true }) };
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}
