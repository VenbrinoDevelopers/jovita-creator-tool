import { ToolContext } from './tool.js';
import type { JovitaApp } from './app.js';
import { validateValue } from './schema.js';

export async function runCli(app: JovitaApp, argv = process.argv.slice(2)): Promise<void> {
  const [toolId, rawInput] = argv;
  if (toolId === 'health') { process.stdout.write(JSON.stringify({ ok: true }) + '\n'); return; }
  const tool = app.tools().find(candidate => candidate.config.id === toolId);
  if (!tool) throw new Error(`Unknown tool: ${toolId ?? ''}`);
  const input = rawInput ? JSON.parse(rawInput) : {};
  const validatedInput = validateValue(tool.config.input, input, 'Tool input');
  const result = await tool.run(new ToolContext(app.config.id, tool.config.id), validatedInput);
  const validatedOutput = validateValue(tool.config.output, result, 'Tool output');
  process.stdout.write(JSON.stringify(validatedOutput) + '\n');
}
