import type { JovitaApp } from './app.js';
import { schemaJson } from './schema.js';
import type { ServiceConfig } from './contracts.js';

export function compileApp(app: JovitaApp): ServiceConfig {
  const providers = app.providers();
  const tools = app.tools();
  const providerIds = new Set<string>();
  const operationRefs = new Set<string>();
  const providerRows = providers.map(provider => {
    if (providerIds.has(provider.config.id)) throw new Error(`Duplicate provider: ${provider.config.id}`);
    providerIds.add(provider.config.id);
    const operations = provider.operations().map(operation => {
      const ref = operation.reference(app.config.id);
      if (operationRefs.has(ref)) throw new Error(`Duplicate operation: ${ref}`);
      operationRefs.add(ref);
      const { input, output, creditsPerCall, ...other } = operation.definition;
      return { ...other, version: other.version ?? 1, inputSchema: schemaJson(input),
        outputSchema: schemaJson(output), buyerCredits: creditsPerCall };
    });
    return { ...provider.config, operations };
  });

  const toolIds = new Set<string>();
  const runtimeOperations = tools.map(tool => {
    const { id, uses = [] } = tool.config;
    if (toolIds.has(id) || id === 'health') throw new Error(`Duplicate or reserved tool: ${id}`);
    toolIds.add(id);
    const limits: Record<string, number> = {};
    const capabilities: string[] = [];
    for (const use of uses) {
      const ref = typeof use.operation === 'string' ? use.operation : use.operation.reference(app.config.id);
      if (ref.startsWith('broker.') && !operationRefs.has(ref)) {
        throw new Error(`Tool ${id} references an undeclared operation: ${ref}`);
      }
      if (capabilities.includes(ref)) throw new Error(`Tool ${id} repeats operation ${ref}`);
      capabilities.push(ref);
      if (ref.startsWith('broker.')) limits[ref] = use.maxCalls ?? 1;
      else if (use.maxCalls !== undefined) throw new Error(`Call limits for ${ref} are controlled by the platform`);
    }
    return { id, description: tool.config.description, argvPrefix: [id], capabilities,
      ...(Object.keys(limits).length ? { capabilityLimits: limits } : {}),
      billingRequired: capabilities.length > 0, destructive: tool.config.destructive ?? false,
      activity: tool.config.activity };
  });
  for (const provider of providers) for (const operation of provider.operations()) {
    const ref = operation.reference(app.config.id);
    if (!runtimeOperations.some(tool => tool.capabilities.includes(ref))) {
      throw new Error(`Operation ${ref} is not granted to any tool`);
    }
  }
  return {
    ...app.config, compat: { minRuntimeVersion: '0.1.0', ...app.config.compat }, activityProtocolVersion: 1, providers: [],
    ...(providerRows.length ? { broker: { providers: providerRows } } : {}),
    skill: { entry: 'SKILL.md', assets: ['.'] },
    runtime: { execute: { command: app.config.id, mode: 'brokered', protocolVersion: 1,
      operations: [{ id: 'health', argvPrefix: ['health'], capabilities: [], billingRequired: false,
        activity: { kind: 'check', object: 'app health', icon: 'check' } }, ...runtimeOperations],
      healthCheck: { command: app.config.id, args: ['health'], operationId: 'health' } } },
  };
}
