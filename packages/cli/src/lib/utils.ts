import { readdirSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { basename, relative, resolve } from 'node:path';
import { IGNORED_FILE_NAMES } from '../types.js';

export function walkFiles(root: string): string[] {
  const result: string[] = [];
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop()!;
    const entries = readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      const abs = resolve(current, entry.name);
      if (entry.isDirectory()) stack.push(abs);
      else if (entry.isFile()) result.push(abs);
    }
  }
  return result;
}

export async function collectBundleFileIndex(root: string): Promise<Array<{ path: string; sha256: string; size: number; executable?: boolean }>> {
  const result: Array<{ path: string; sha256: string; size: number; executable?: boolean }> = [];
  for (const filePath of walkFiles(root).sort((a, b) => a.localeCompare(b))) {
    if (IGNORED_FILE_NAMES.has(basename(filePath))) continue;
    const relativePath = normalizeRelativePath(relative(root, filePath));
    const data = await readFile(filePath);
    result.push({
      path: relativePath,
      sha256: createHash('sha256').update(data).digest('hex'),
      size: data.length,
      ...((statSync(filePath).mode & 0o111) !== 0 ? { executable: true } : {}),
    });
  }
  return result;
}

export async function runCommand(command: string, args: string[], opts: { cwd: string; env: Record<string, string> }): Promise<void> {
  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd: opts.cwd, env: opts.env, stdio: 'inherit' });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolvePromise();
        return;
      }
      reject(new Error(`${command} ${args.join(' ')} exited with code ${code}`));
    });
  });
}

export function normalizeRelativePath(value: string): string {
  return String(value ?? '').replace(/\\/g, '/').replace(/^\/+/, '').replace(/\.\.(\/|$)/g, '').trim();
}

export function sanitizeForFs(value: string): string {
  return String(value ?? '').trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
}
