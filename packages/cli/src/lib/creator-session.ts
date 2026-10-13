import { chmod, mkdir, readFile, rename, writeFile, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export interface CreatorSession {
  apiUrl: string;
  accessToken: string;
  refreshToken: string;
  email: string;
}

export function creatorApiUrl(): string {
  const url = String(process.env.JOVITA_API_URL || 'https://api-jovita-server.usejovita.com').trim().replace(/\/$/, '');
  if (!/^https:\/\/[a-z0-9.-]+(?::\d+)?$/i.test(url)) {
    throw new Error('JOVITA_API_URL must be an HTTPS origin without a path.');
  }
  return url;
}

export function sessionPath(): string {
  return join(process.env.JOVITA_CONFIG_DIR || join(homedir(), '.config', 'jovita'), 'creator-session.json');
}

export async function readSession(): Promise<CreatorSession | undefined> {
  try {
    const parsed = JSON.parse(await readFile(sessionPath(), 'utf8')) as Partial<CreatorSession>;
    if (parsed.apiUrl === creatorApiUrl() && parsed.accessToken && parsed.refreshToken && parsed.email) {
      return parsed as CreatorSession;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  return undefined;
}

export async function saveSession(session: CreatorSession): Promise<void> {
  const path = sessionPath();
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(session), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    await chmod(temporary, 0o600);
    await rename(temporary, path);
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
}

export async function clearSession(): Promise<void> {
  await unlink(sessionPath()).catch(error => {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  });
}
