import { capabilityContext, invokeCapability, stableCallId } from '@jovita-ai/runtime';
import { validateValue, type Schema, type InputOf, type OutputOf } from './schema.js';
import { ApiOperation } from './provider.js';
import type { JovitaActivitySpecV1 } from './contracts.js';

export interface ToolOptions<I extends Schema = Schema, O extends Schema = Schema> {
  id: string;
  description: string;
  input: I;
  output: O;
  uses?: Array<{ operation: ApiOperation | string; maxCalls?: number }>;
  activity: JovitaActivitySpecV1;
  destructive?: boolean;
}

export class ToolContext {
  private readonly ordinals = new Map<string, number>();
  private invocationId?: Promise<string>;
  constructor(readonly appId: string, readonly toolId: string) {}

  async call<I extends Schema, O extends Schema>(operation: ApiOperation<I, O>, input: InputOf<I>): Promise<OutputOf<O>>;
  async call<T>(capability: string, input: Record<string, unknown>): Promise<T>;
  async call(operation: ApiOperation | string, input: Record<string, unknown>): Promise<unknown> {
    const reference = typeof operation === 'string' ? operation : operation.reference(this.appId);
    const ordinal = this.ordinals.get(reference) ?? 0;
    this.ordinals.set(reference, ordinal + 1);
    this.invocationId ??= capabilityContext().then(value => {
      if (!value.invocation_id) throw new Error('Broker did not provide an invocation ID');
      return value.invocation_id;
    });
    const callId = stableCallId(`${await this.invocationId}:${this.toolId}:${reference}:${ordinal}`, input);
    const result = await invokeCapability<unknown>(reference, input, { callId });
    return typeof operation === 'string' ? result
      : validateValue(operation.definition.output, result, 'Provider response');
  }
}

/** Override run for a workflow, or use ApiTool for a direct provider call. */
export class JovitaTool<I extends Schema = Schema, O extends Schema = Schema> {
  constructor(readonly config: ToolOptions<I, O>) {}
  async run(_ctx: ToolContext, _input: InputOf<I>): Promise<OutputOf<O>> {
    throw new Error(`Tool ${this.config.id} has no run method`);
  }
}

export class ApiTool<I extends Schema, O extends Schema> extends JovitaTool<I, O> {
  constructor(readonly apiOperation: ApiOperation<I, O>,
    options: Partial<Omit<ToolOptions<I, O>, 'input' | 'output' | 'uses'>> = {}) {
    super({ id: options.id ?? apiOperation.definition.id,
      description: options.description ?? apiOperation.definition.purpose,
      activity: options.activity ?? { kind: 'run', object: apiOperation.definition.name },
      destructive: options.destructive,
      input: apiOperation.definition.input, output: apiOperation.definition.output,
      uses: [{ operation: apiOperation, maxCalls: 1 }] });
  }
  override async run(ctx: ToolContext, input: InputOf<I>): Promise<OutputOf<O>> {
    return ctx.call(this.apiOperation, input);
  }
}

