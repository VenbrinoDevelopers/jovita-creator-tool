import { JovitaApp, JovitaProvider, JovitaTool, ToolContext } from '@jovita/sdk';
import { z } from 'zod';

class ExampleProvider extends JovitaProvider {
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
}

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

export default class CustomExampleApp extends JovitaApp {
  private readonly api = new ExampleProvider();
  constructor() { super({ id: 'custom-example', name: 'Custom Example', version: '0.1.0',
    category: 'productivity', description: 'A custom workflow using the Example API.' }); }
  providers() { return [this.api]; }
  tools() { return [new LookupWorkflow(this.api.lookup)]; }
}
