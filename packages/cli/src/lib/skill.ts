import { existsSync, readdirSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { basename, relative, resolve } from 'node:path';
import { IGNORED_FILE_NAMES } from '../types.js';
import { normalizeRelativePath, walkFiles } from './utils.js';

export async function collectSkillIndex(skillPath: string): Promise<Array<{ path: string; sha256: string; size: number }>> {
  const resolvedPaths = new Set<string>();

  const skillEntry = resolve(skillPath, 'SKILL.md');
  if (!existsSync(skillEntry)) {
    throw new Error(`Skill entry SKILL.md not found at ${skillEntry}`);
  }
  resolvedPaths.add('SKILL.md');

  for (const filePath of walkFiles(skillPath)) {
    if (IGNORED_FILE_NAMES.has(basename(filePath))) continue;
    const relPath = normalizeRelativePath(relative(skillPath, filePath));
    resolvedPaths.add(relPath);
  }

  const index: Array<{ path: string; sha256: string; size: number }> = [];
  for (const relPath of Array.from(resolvedPaths).sort((a, b) => a.localeCompare(b))) {
    const absPath = resolve(skillPath, relPath);
    if (!absPath.startsWith(skillPath) || !existsSync(absPath) || !statSync(absPath).isFile()) {
      throw new Error(`Skill file missing: ${relPath}`);
    }
    const data = await readFile(absPath);
    index.push({
      path: relPath,
      sha256: createHash('sha256').update(data).digest('hex'),
      size: data.length,
    });
  }
  return index;
}
