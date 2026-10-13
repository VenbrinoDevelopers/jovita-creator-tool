import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CreatorApi } from './creator-api.js';
import { readSession, saveSession, sessionPath } from './creator-session.js';

test('creator session refresh rotates tokens and retries an authorized call', async () => {
  const original = { dir: process.env.JOVITA_CONFIG_DIR, url: process.env.JOVITA_API_URL,
    token: process.env.JOVITA_CREATOR_TOKEN, fetch: globalThis.fetch };
  const dir = await mkdtemp(join(tmpdir(), 'jov-auth-test-'));
  process.env.JOVITA_CONFIG_DIR = dir;
  process.env.JOVITA_API_URL = 'https://api.example.test';
  delete process.env.JOVITA_CREATOR_TOKEN;
  const calls: string[] = [];
  try {
    await saveSession({ apiUrl: 'https://api.example.test', email: 'creator@example.test',
      accessToken: 'old-access', refreshToken: 'old-refresh' });
    globalThis.fetch = async (input, init) => {
      const path = new URL(String(input)).pathname;
      calls.push(`${path}:${new Headers(init?.headers).get('authorization') || ''}`);
      if (path === '/creator/tools/providers/catalog' && calls.length === 1) {
        return Response.json({ message: 'expired' }, { status: 401 });
      }
      if (path === '/creator-auth/refresh') {
        assert.equal(JSON.parse(String(init?.body)).refreshToken, 'old-refresh');
        return Response.json({ accessToken: 'new-access', refreshToken: 'new-refresh' });
      }
      return Response.json({ profiles: [] });
    };
    const result = await new CreatorApi().request<{ profiles: unknown[] }>('/creator/tools/providers/catalog');
    assert.deepEqual(result.profiles, []);
    assert.deepEqual(calls, [
      '/creator/tools/providers/catalog:Bearer old-access',
      '/creator-auth/refresh:',
      '/creator/tools/providers/catalog:Bearer new-access',
    ]);
    assert.equal((await readSession())?.refreshToken, 'new-refresh');
    assert.equal((await stat(sessionPath())).mode & 0o777, 0o600);
    assert.doesNotMatch(await readFile(sessionPath(), 'utf8'), /old-refresh/);
  } finally {
    globalThis.fetch = original.fetch;
    if (original.dir === undefined) delete process.env.JOVITA_CONFIG_DIR;
    else process.env.JOVITA_CONFIG_DIR = original.dir;
    if (original.url === undefined) delete process.env.JOVITA_API_URL;
    else process.env.JOVITA_API_URL = original.url;
    if (original.token === undefined) delete process.env.JOVITA_CREATOR_TOKEN;
    else process.env.JOVITA_CREATOR_TOKEN = original.token;
  }
});
