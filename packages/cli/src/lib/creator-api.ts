import { readFile } from 'node:fs/promises';
import { creatorApiUrl, readSession, saveSession } from './creator-session.js';

type TokenPair = { accessToken: string; refreshToken: string };

async function responseBody(response: Response): Promise<Record<string, unknown>> {
  return await response.json().catch(() => ({})) as Record<string, unknown>;
}

function apiError(response: Response, body: Record<string, unknown>): Error {
  const message = Array.isArray(body.message) ? body.message.join(', ') : body.message;
  return new Error(`Jovita API ${response.status}: ${typeof message === 'string' ? message : JSON.stringify(body)}`);
}

export class CreatorApi {
  readonly baseUrl = creatorApiUrl();

  async publicRequest<T>(path: string, body: unknown): Promise<T> {
    const response = await fetch(`${this.baseUrl}${path}`, { method: 'POST',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const result = await responseBody(response);
    if (!response.ok) throw apiError(response, result);
    return result as T;
  }

  private async authorizedFetch(path: string, init: RequestInit): Promise<Response> {
    const explicitToken = String(process.env.JOVITA_CREATOR_TOKEN || '').trim();
    const session = explicitToken ? undefined : await readSession();
    const token = explicitToken || session?.accessToken;
    if (!token) throw new Error('Run jov login, or set JOVITA_CREATOR_TOKEN for automated builds.');
    const call = (accessToken: string) => fetch(`${this.baseUrl}${path}`, {
      ...init, headers: { ...init.headers, Authorization: `Bearer ${accessToken}` },
    });
    let response = await call(token);
    if (response.status === 401 && session?.refreshToken) {
      const refreshed = await this.publicRequest<TokenPair>('/creator-auth/refresh',
        { refreshToken: session.refreshToken });
      if (!refreshed.accessToken || !refreshed.refreshToken) throw new Error('Creator session refresh returned no tokens. Run jov login.');
      await saveSession({ ...session, ...refreshed });
      response = await call(refreshed.accessToken);
    }
    return response;
  }

  async request<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
    const response = await this.authorizedFetch(path, { method,
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const result = await responseBody(response);
    if (!response.ok) throw apiError(response, result);
    return result as T;
  }

  async upload(bundlePath: string, priceCents: number): Promise<{ id: string; approvalStatus: string }> {
    const form = new FormData();
    const bytes = await readFile(bundlePath);
    form.append('bundle', new Blob([bytes], { type: 'application/vnd.jovita.jov' }), bundlePath.split('/').at(-1));
    form.append('priceCents', String(priceCents));
    const response = await this.authorizedFetch('/creator/tools/releases/upload', { method: 'POST', body: form });
    const result = await responseBody(response);
    if (!response.ok) throw apiError(response, result);
    return result as { id: string; approvalStatus: string };
  }
}
