import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';

export interface TokenExchangeResponse {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    scope?: string;
    token_type?: string;
}

@Injectable()
export class GoogleOAuthFlowService {
    private readonly logger = new Logger(GoogleOAuthFlowService.name);
    static readonly RECONNECT_REQUIRED_MESSAGE =
        'Google Workspace session expired. Please reconnect your Google account.';

    async exchangeServerAuthCode(code: string): Promise<TokenExchangeResponse> {
        const body = new URLSearchParams();
        body.set('code', code);
        body.set('client_id', this.googleClientId());
        body.set('client_secret', this.googleClientSecret());
        body.set('grant_type', 'authorization_code');
        return this.postToken(body);
    }

    async refreshAccessToken(refreshToken: string): Promise<TokenExchangeResponse> {
        const body = new URLSearchParams();
        body.set('grant_type', 'refresh_token');
        body.set('refresh_token', refreshToken);
        body.set('client_id', this.googleClientId());
        body.set('client_secret', this.googleClientSecret());
        return this.postToken(body);
    }

    async fetchProfile(accessToken: string): Promise<{ sub: string; email: string }> {
        const response = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
            headers: {
                authorization: `Bearer ${accessToken}`,
            },
        });
        if (!response.ok) {
            throw new ServiceUnavailableException('Failed to fetch Google Workspace account profile');
        }
        const json = (await response.json()) as Record<string, unknown>;
        const sub = String(json.sub ?? '').trim();
        const email = String(json.email ?? '')
            .trim()
            .toLowerCase();
        if (!sub || !email) {
            throw new ServiceUnavailableException('Google Workspace profile did not include subject and email');
        }
        return { sub, email };
    }

    async fetchGrantedScopesFromAccessToken(accessToken: string | undefined): Promise<string[]> {
        const token = String(accessToken ?? '').trim();
        if (!token) return [];
        const response = await fetch(
            `https://oauth2.googleapis.com/tokeninfo?access_token=${encodeURIComponent(token)}`,
        );
        if (!response.ok) {
            return [];
        }
        const json = (await response.json()) as Record<string, unknown>;
        return this.parseScopes(json.scope);
    }

    async revokeStoredRefreshToken(refreshToken: string): Promise<void> {
        if (!refreshToken) return;
        try {
            const body = new URLSearchParams();
            body.set('token', refreshToken);
            await fetch('https://oauth2.googleapis.com/revoke', {
                method: 'POST',
                headers: { 'content-type': 'application/x-www-form-urlencoded' },
                body: body.toString(),
            });
        } catch (error) {
            this.logger.warn(`Failed to revoke Google Workspace refresh token: ${String(error)}`);
        }
    }

    parseScopes(raw: unknown): string[] {
        return String(raw ?? '')
            .split(/\s+/)
            .map((value) => value.trim())
            .filter(Boolean);
    }

    private async postToken(body: URLSearchParams): Promise<TokenExchangeResponse> {
        const response = await fetch('https://oauth2.googleapis.com/token', {
            method: 'POST',
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
            body: body.toString(),
        });
        const json = (await response.json()) as Record<string, unknown>;
        if (!response.ok) {
            throw this.tokenExchangeException(response.status, json);
        }
        return json as TokenExchangeResponse;
    }

    private tokenExchangeException(status: number, json: Record<string, unknown>): ServiceUnavailableException {
        const error = String(json.error ?? '')
            .trim()
            .toLowerCase();
        const description = String(json.error_description ?? '').trim();
        if (error === 'invalid_grant') {
            return new ServiceUnavailableException(GoogleOAuthFlowService.RECONNECT_REQUIRED_MESSAGE);
        }
        const suffix = description ? `: ${description}` : '';
        return new ServiceUnavailableException(`Google token exchange failed (${status})${suffix}`);
    }

    private googleClientId(): string {
        const value = String(process.env.GOOGLE_WORKSPACE_CLIENT_ID ?? '').trim();
        if (!value) {
            throw new ServiceUnavailableException('Missing GOOGLE_WORKSPACE_CLIENT_ID');
        }
        return value;
    }

    private googleClientSecret(): string {
        const value = String(process.env.GOOGLE_WORKSPACE_CLIENT_SECRET ?? '').trim();
        if (!value) {
            throw new ServiceUnavailableException('Missing GOOGLE_WORKSPACE_CLIENT_SECRET');
        }
        return value;
    }
}
