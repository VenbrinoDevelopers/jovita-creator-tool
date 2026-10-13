import { Command } from 'commander';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

export const initCommand = new Command('init')
  .description('Create a Jovita skill, API tool, or custom app')
  .argument('<name>', 'App directory name')
  .option('--template <kind>', 'skill, api, or custom', 'api')
  .option('--dir <path>', 'Parent directory', '.')
  .action((name: string, options) => {
    if (options.template !== 'skill' && options.template !== 'api' && options.template !== 'custom') throw new Error('Choose --template skill, api, or custom');
    const id = name.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/^-+|-+$/g, '');
    if (!/^[a-z][a-z0-9-]{1,31}$/.test(id)) throw new Error('Use a name with 2 to 32 lowercase letters, numbers, or hyphens');
    const root = resolve(options.dir, name);
    if (existsSync(root)) throw new Error(`Directory already exists: ${root}`);
    mkdirSync(resolve(root, 'skill'), { recursive: true });
    const display = name.replace(/[-_]/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
    if (options.template === 'skill') {
      writeFileSync(resolve(root, 'jovita.service.json'), JSON.stringify({
        id, name: display, version: '0.1.0', category: 'productivity',
        description: `A skill that helps with ${display.toLowerCase()}.`,
        skill: { entry: 'skill/SKILL.md', assets: ['skill/SKILL.md'] },
        compat: { minRuntimeVersion: '0.1.0' },
      }, null, 2) + '\n');
      writeFileSync(resolve(root, 'skill/SKILL.md'), `# ${display}\n\nDescribe when and how Jovita should use this skill.\n`);
      writeFileSync(resolve(root, '.gitignore'), 'build/\n.env\n');
      console.log(JSON.stringify({ ok: true, root, template: 'skill',
        next: [`cd ${root}`, 'jov lint', 'jov build', 'jov verify build/*.jov'] }, null, 2));
      return;
    }
    mkdirSync(resolve(root, 'fixtures'), { recursive: true });
    mkdirSync(resolve(root, 'src'), { recursive: true });
    const provider = `class ExampleProvider extends JovitaProvider {
  constructor() {
    super({ id: 'example_api', name: 'Example API', summary: 'Example JSON endpoint',
      docsUrl: 'https://api.example.com/docs', category: 'search',
      baseUrl: 'https://api.example.com', authMethod: 'bearer' });
  }
  readonly lookup = this.operation({
    id: 'lookup', name: 'Lookup', purpose: 'Look up one query', version: 1,
    method: 'POST', path: '/lookup', creditsPerCall: 10,
    providerCostNote: 'The provider bills your own account separately.',
    input: z.object({ query: z.string().min(1) }),
    output: z.object({ answer: z.string() }),
  });
}`;
    const appSource = options.template === 'api'
      ? `import { defineApp, provider } from '@jovita/sdk';
import { z } from 'zod';

const example = provider({
  name: 'Example Search', baseUrl: 'https://api.example.com', auth: 'bearer',
  docsUrl: 'https://api.example.com/docs', category: 'search',
});

export default defineApp({
  id: '${id}', name: '${display}', version: '0.1.0',
  tools: {
    search: example.post('/search', {
      description: 'Find web pages for a query',
      input: z.object({ query: z.string().min(1) }),
      output: z.object({ results: z.array(z.object({ title: z.string() })) }),
      creditsPerCall: 10,
    }),
  },
});
`
      : `import { JovitaApp, JovitaProvider, JovitaTool, ToolContext } from '@jovita/sdk';
import { z } from 'zod';

${provider}

class LookupWorkflow extends JovitaTool {
  constructor(private readonly lookup: ExampleProvider['lookup']) {
    super({ id: 'lookup', description: 'Look up a query and format an answer',
      input: z.object({ query: z.string().min(1) }), output: z.object({ answer: z.string() }),
      uses: [{ operation: lookup, maxCalls: 1 }],
      activity: { kind: 'search', object: 'answer', icon: 'search' } });
  }
  override async run(ctx: ToolContext, input: { query: string }) {
    const result = await ctx.call(this.lookup, input);
    return { answer: result.answer.trim() };
  }
}

export default class ${id.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase()).replace(/^./, c => c.toUpperCase())}App extends JovitaApp {
  private readonly api = new ExampleProvider();
  constructor() { super({ id: '${id}', name: '${display}', version: '0.1.0',
    category: 'productivity', description: 'A custom workflow using the Example API.' }); }
  providers() { return [this.api]; }
  tools() { return [new LookupWorkflow(this.api.lookup)]; }
}
`;
    writeFileSync(resolve(root, 'src/jovita.app.ts'), appSource);
    const cliPackage = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as {
      version: string;
      dependencies: Record<string, string>;
    };
    writeFileSync(resolve(root, 'package.json'), JSON.stringify({
      name: id, version: '0.1.0', private: true, type: 'module',
      dependencies: {
        '@jovita/sdk': cliPackage.dependencies['@jovita/sdk'],
        zod: '^4.1.12',
      },
      devDependencies: {
        '@jovita/cli': cliPackage.version,
        typescript: '^5.9.3',
      },
      scripts: { dev: `jov dev ${options.template === 'api' ? 'search' : 'lookup'} --input '{"query":"hello"}'`, build: 'jov build --target linux-amd64' },
    }, null, 2) + '\n');
    writeFileSync(resolve(root, 'tsconfig.json'), JSON.stringify({
      compilerOptions: { target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext',
        strict: true, noEmit: true, skipLibCheck: true },
      include: ['src/**/*.ts'],
    }, null, 2) + '\n');
    const operation = options.template === 'api' ? 'search' : 'lookup';
    writeFileSync(resolve(root, 'skill/SKILL.md'), `# ${display}\n\nLook up information with the Example API.\n\n## Usage\n\nRun \`${id} ${operation} '{"query":"your question"}'\`.\n`);
    const providerId = options.template === 'api' ? 'example_search' : 'example_api';
    writeFileSync(resolve(root, `fixtures/broker.${id}.${providerId}.${operation}.v1.json`),
      options.template === 'api' ? '{"results":[{"title":"Example result"}]}\n' : '{"answer":"Example response"}\n');
    writeFileSync(resolve(root, '.gitignore'), 'node_modules/\nbuild/\n.env\n');
    console.log(JSON.stringify({ ok: true, root, template: options.template,
      next: [`cd ${root}`, 'npm install', `jov dev ${operation} --input '{"query":"hello"}'`,
        'jov build --target linux-amd64'] }, null, 2));
  });
