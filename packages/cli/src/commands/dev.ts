import { Command } from 'commander';
import { createServer } from 'node:net';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { compileApp, isCommandApp, isRuntimeApp, runCli } from '@jovita-ai/sdk';
import { loadProjectDefinition } from '../lib/sdk-project.js';

export const devCommand = new Command('dev')
  .description('Run one SDK tool locally with recorded broker responses')
  .argument('<tool-id>', 'Tool to run')
  .option('--dir <path>', 'App directory', '.')
  .option('--input <json>', 'Tool input as JSON', '{}')
  .option('--args-json <json>', 'Command app arguments after the declared tool prefix, as a JSON string array', '[]')
  .option('--fixtures <path>', 'Directory of recorded broker JSON responses', 'fixtures')
  .action(async (toolId: string, options) => {
    const root = resolve(options.dir);
    const app = await loadProjectDefinition(root);
    if (isRuntimeApp(app)) throw new Error('Use defineApp for local command app development');
    const manifest = compileApp(app) as { runtime: { execute: { command: string; operations: Array<{
      id: string; argvPrefix: string[]; capabilities: string[]; capabilityLimits?: Record<string, number> }> } } };
    const tool = manifest.runtime.execute.operations.find(row => row.id === toolId);
    if (!tool) throw new Error(`Unknown tool ${toolId}`);
    const fixtureRoot = resolve(root, options.fixtures);
    const temp = await mkdtemp(join(tmpdir(), 'jov-dev-'));
    const socketPath = join(temp, 'broker.sock');
    const token = randomUUID();
    const counts = new Map<string, number>();
    const receipts = new Map<string, { capability: string; result: unknown }>();
    const server = createServer(socket => {
      let raw = '';
      socket.setEncoding('utf8');
      socket.on('data', chunk => {
        raw += chunk;
        if (raw.length > 4_000_000) { socket.destroy(); return; }
        const newline = raw.indexOf('\n');
        if (newline < 0) return;
        try {
          const frame = JSON.parse(raw.slice(0, newline)) as Record<string, unknown>;
          if (frame.token !== token || frame.protocolVersion !== 2) throw new Error('Invalid local broker frame');
          if (frame.type === 'context') {
            socket.end(JSON.stringify({ protocolVersion: 2, ok: true,
              result: { invocation_id: `dev-${toolId}`, receipt_recovery: true } }));
          } else if (frame.type === 'ack') {
            socket.end(JSON.stringify({ protocolVersion: 2, ok: true, result: { acknowledged: true } }));
          } else if (frame.type === 'invoke' || frame.type === 'recover') {
            const capability = String(frame.capability ?? '');
            if (!tool.capabilities.includes(capability)) throw new Error(`Tool has no grant for ${capability}`);
            const callId = String(frame.callId ?? '');
            const previous = receipts.get(callId);
            if (previous) {
              if (previous.capability !== capability) throw new Error('Call ID belongs to another operation');
              socket.end(JSON.stringify({ protocolVersion: 2, ok: true, result: previous.result }));
              return;
            }
            const count = (counts.get(capability) ?? 0) + (frame.type === 'invoke' ? 1 : 0);
            if (frame.type === 'invoke') counts.set(capability, count);
            const limit = tool.capabilityLimits?.[capability] ?? (capability.startsWith('broker.') ? 1 : Infinity);
            if (count > limit) throw new Error(`Call limit exceeded for ${capability}`);
            const fixturePath = resolve(fixtureRoot, `${capability}.json`);
            if (!existsSync(fixturePath)) throw new Error(`Missing fixture ${fixturePath}`);
            const fixture = JSON.parse(readFileSync(fixturePath, 'utf8'));
            if (callId) receipts.set(callId, { capability, result: fixture });
            process.stderr.write(`broker ${capability} ${frame.type === 'recover' ? 'recovery' : `call ${count}`}\n`);
            socket.end(JSON.stringify({ protocolVersion: 2, ok: true, result: fixture }));
          } else throw new Error(`Unsupported local broker frame ${String(frame.type)}`);
        } catch (error) {
          socket.end(JSON.stringify({ protocolVersion: 2, ok: false,
            error: { code: 'DEV_FIXTURE_ERROR', message: error instanceof Error ? error.message : String(error) } }));
        }
      });
    });
    try {
      await new Promise<void>((resolveReady, reject) => {
        server.once('error', reject);
        server.listen(socketPath, resolveReady);
      });
      const oldSocket = process.env.JOVITA_CAPABILITY_SOCKET;
      const oldToken = process.env.JOVITA_CAPABILITY_TOKEN;
      process.env.JOVITA_CAPABILITY_SOCKET = socketPath;
      process.env.JOVITA_CAPABILITY_TOKEN = token;
      try {
        if (isCommandApp(app)) {
          const extra = JSON.parse(options.argsJson) as unknown;
          if (!Array.isArray(extra) || !extra.every(value => typeof value === 'string')) {
            throw new Error('--args-json must be a JSON string array');
          }
          const runtimePath = resolve(root, 'runtime');
          const pkg = JSON.parse(readFileSync(resolve(runtimePath, 'package.json'), 'utf8')) as {
            bin?: Record<string, string> | string; scripts?: { build?: string } };
          if (pkg.scripts?.build) await runProcess('npm', ['run', 'build'], runtimePath);
          const command = manifest.runtime.execute.command;
          const binary = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin?.[command];
          if (!binary) throw new Error(`runtime/package.json has no executable for ${command}`);
          const executable = resolve(runtimePath, binary);
          const argv = [...tool.argvPrefix, ...extra];
          for (const required of (tool as typeof tool & { requiredArgs?: string[] }).requiredArgs ?? []) {
            if (!argv.includes(required)) throw new Error(`Tool ${toolId} requires argument ${required}`);
          }
          for (const excluded of (tool as typeof tool & { excludedArgs?: string[] }).excludedArgs ?? []) {
            if (argv.includes(excluded)) throw new Error(`Tool ${toolId} excludes argument ${excluded}`);
          }
          await runProcess(executable.endsWith('.js') ? process.execPath : executable,
            executable.endsWith('.js') ? [executable, ...argv] : argv, runtimePath);
        } else {
          await runCli(app, [toolId, options.input]);
        }
      }
      finally {
        if (oldSocket === undefined) delete process.env.JOVITA_CAPABILITY_SOCKET;
        else process.env.JOVITA_CAPABILITY_SOCKET = oldSocket;
        if (oldToken === undefined) delete process.env.JOVITA_CAPABILITY_TOKEN;
        else process.env.JOVITA_CAPABILITY_TOKEN = oldToken;
      }
    } finally {
      await new Promise<void>(done => server.close(() => done()));
      await rm(temp, { recursive: true, force: true });
    }
  });

async function runProcess(command: string, args: string[], cwd: string): Promise<void> {
  await new Promise<void>((resolveDone, reject) => {
    const child = spawn(command, args, { cwd, env: process.env, stdio: 'inherit' });
    child.once('error', reject);
    child.once('close', code => code === 0 ? resolveDone() : reject(new Error(`${command} exited with code ${code}`)));
  });
}
