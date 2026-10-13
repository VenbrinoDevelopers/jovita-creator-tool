import { Command } from 'commander';
import { createServer } from 'node:net';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { compileApp, runCli } from '@jovita-ai/sdk';
import { loadSdkApp } from '../lib/sdk-project.js';

export const devCommand = new Command('dev')
  .description('Run one SDK tool locally with recorded broker responses')
  .argument('<tool-id>', 'Tool to run')
  .option('--dir <path>', 'App directory', '.')
  .option('--input <json>', 'Tool input as JSON', '{}')
  .option('--fixtures <path>', 'Directory of recorded broker JSON responses', 'fixtures')
  .action(async (toolId: string, options) => {
    const root = resolve(options.dir);
    const app = await loadSdkApp(root);
    const manifest = compileApp(app) as { runtime: { execute: { operations: Array<{
      id: string; capabilities: string[]; capabilityLimits?: Record<string, number> }> } } };
    const tool = manifest.runtime.execute.operations.find(row => row.id === toolId);
    if (!tool) throw new Error(`Unknown tool ${toolId}`);
    const fixtureRoot = resolve(root, options.fixtures);
    const temp = await mkdtemp(join(tmpdir(), 'jov-dev-'));
    const socketPath = join(temp, 'broker.sock');
    const token = randomUUID();
    const counts = new Map<string, number>();
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
          } else if (frame.type === 'invoke') {
            const capability = String(frame.capability ?? '');
            if (!tool.capabilities.includes(capability)) throw new Error(`Tool has no grant for ${capability}`);
            const count = (counts.get(capability) ?? 0) + 1;
            counts.set(capability, count);
            if (count > (tool.capabilityLimits?.[capability] ?? 1)) throw new Error(`Call limit exceeded for ${capability}`);
            const fixturePath = resolve(fixtureRoot, `${capability}.json`);
            if (!existsSync(fixturePath)) throw new Error(`Missing fixture ${fixturePath}`);
            const fixture = JSON.parse(readFileSync(fixturePath, 'utf8'));
            process.stderr.write(`broker ${capability} call ${count}\n`);
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
      try { await runCli(app, [toolId, options.input]); }
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
