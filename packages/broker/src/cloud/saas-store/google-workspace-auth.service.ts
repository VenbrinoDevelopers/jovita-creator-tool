import {
    BadRequestException,
    Injectable,
    Logger,
    NotFoundException,
    ServiceUnavailableException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import { randomUUID } from 'node:crypto';
import { SecretCryptoService } from '../core/security/secret-crypto.service.js';
import { GatewayBridgeService } from '../gateway-bridge/gateway-bridge.service.js';
import { GoogleOAuthFlowService, type TokenExchangeResponse } from './google-auth/google-oauth-flow.service.js';
import type {
    ConnectionAction,
    GoogleWorkspaceProviderActionAuth,
    GoogleWorkspaceProviderActionStatus,
    GoogleWorkspaceConnectionState,
    SaaSPackManifest,
} from './saas-store.types.js';
import {
    GoogleWorkspaceAuthSession,
    type GoogleWorkspaceAuthSessionDocument,
} from './schemas/google-workspace-auth-session.schema.js';
import {
    GoogleWorkspaceConnection,
    type GoogleWorkspaceConnectionDocument,
} from './schemas/google-workspace-connection.schema.js';

const GOOGLE_WORKSPACE_SERVICE_ID = 'google-workspace';
const DEFAULT_AUTH_SESSION_TTL_MS = 15 * 60 * 1000;
const DEFAULT_REFRESH_LEEWAY_MS = 5 * 60 * 1000;

const PROVIDER_SCOPE_MAP: Record<string, string[]> = {
    gmail: ['https://www.googleapis.com/auth/gmail.modify'],
    calendar: ['https://www.googleapis.com/auth/calendar'],
    drive: ['https://www.googleapis.com/auth/drive.file', 'https://www.googleapis.com/auth/drive.metadata.readonly'],
    sheets: ['https://www.googleapis.com/auth/spreadsheets'],
    docs: ['https://www.googleapis.com/auth/documents'],
    slides: ['https://www.googleapis.com/auth/presentations'],
    forms: ['https://www.googleapis.com/auth/forms.body', 'https://www.googleapis.com/auth/forms.responses.readonly'],
    meet: [
        'https://www.googleapis.com/auth/meetings.space.created',
        'https://www.googleapis.com/auth/meetings.space.readonly',
    ],
};

interface GoogleWorkspaceFinalizeResult {
    ok: boolean;
    message: string;
    errorCode?: string;
}

@Injectable()
export class GoogleWorkspaceAuthService {
    private readonly logger = new Logger(GoogleWorkspaceAuthService.name);
    private static readonly RECONNECT_REQUIRED_CODE = 'GOOGLE_RECONNECT_REQUIRED';
    private readonly oauthFlow: GoogleOAuthFlowService;

    constructor(
        @InjectModel(GoogleWorkspaceConnection.name)
        private readonly connectionModel: Model<GoogleWorkspaceConnectionDocument>,
        @InjectModel(GoogleWorkspaceAuthSession.name)
        private readonly authSessionModel: Model<GoogleWorkspaceAuthSessionDocument>,
        private readonly secretCrypto: SecretCryptoService,
        private readonly gatewayBridge: GatewayBridgeService,
        oauthFlow?: GoogleOAuthFlowService,
    ) {
        this.oauthFlow = oauthFlow ?? new GoogleOAuthFlowService();
    }

    isManagedManifest(manifest: Pick<SaaSPackManifest, 'id' | 'auth'>): boolean {
        return (
            manifest.id === GOOGLE_WORKSPACE_SERVICE_ID &&
            (manifest.auth?.type === GOOGLE_WORKSPACE_SERVICE_ID || manifest.auth == null)
        );
    }

    async getConnection(ownerId: string): Promise<GoogleWorkspaceConnectionDocument | null> {
        return this.connectionModel.findOne({ ownerId, serviceId: GOOGLE_WORKSPACE_SERVICE_ID }).exec();
    }

    async ensureConnection(ownerId: string): Promise<GoogleWorkspaceConnectionDocument> {
        try {
            const connection = await this.connectionModel
                .findOneAndUpdate(
                    { ownerId, serviceId: GOOGLE_WORKSPACE_SERVICE_ID },
                    {
                        $setOnInsert: {
                            ownerId,
                            serviceId: GOOGLE_WORKSPACE_SERVICE_ID,
                            grantedScopes: [],
                            enabledProviders: [],
                            state: 'disconnected',
                        },
                    },
                    {
                        upsert: true,
                        returnDocument: 'after',
                        setDefaultsOnInsert: true,
                    },
                )
                .exec();
            if (connection) return connection;
        } catch (error) {
            if (!this.isDuplicateKeyError(error)) {
                throw error;
            }
            const existing = await this.getConnection(ownerId);
            if (existing) return existing;
            throw error;
        }

        const existing = await this.getConnection(ownerId);
        if (existing) return existing;
        throw new ServiceUnavailableException('Google Workspace connection could not be initialized');
    }

    buildProviderStatuses(manifest: SaaSPackManifest, connection: GoogleWorkspaceConnectionDocument | null) {
        const enabled = new Set((connection?.enabledProviders ?? []).map((value) => value.trim()).filter(Boolean));
        const state = this.normalizeConnectionState(connection?.state);
        const updatedAt = (connection as { updatedAt?: Date } | null)?.updatedAt?.toISOString();
        const lastError = String(connection?.lastError ?? '').trim() || undefined;
        return manifest.providers.map((provider) => ({
            providerId: provider.id,
            status: enabled.has(provider.id)
                ? state === 'error'
                    ? ('error' as const)
                    : ('connected' as const)
                : ('disconnected' as const),
            mode: 'runtime' as const,
            updatedAt,
            lastError: enabled.has(provider.id) ? lastError : undefined,
        }));
    }

    async startProviderConsent(
        ownerId: string,
        manifest: SaaSPackManifest,
        input: ConnectionAction,
    ): Promise<GoogleWorkspaceProviderActionAuth | null> {
        const connection = await this.ensureConnection(ownerId);
        const currentEnabled = new Set(connection.enabledProviders.map((value) => value.trim()).filter(Boolean));
        const currentScopes = new Set(connection.grantedScopes.map((value) => value.trim()).filter(Boolean));

        let requestedProviders = [...currentEnabled];
        if (input.action === 'connect' || input.action === 'refresh') {
            currentEnabled.add(input.providerId);
        } else if (input.action === 'disconnect') {
            currentEnabled.delete(input.providerId);
        }

        requestedProviders = manifest.providers
            .map((provider) => provider.id)
            .filter((providerId) => currentEnabled.has(providerId));

        const requestedScopes = this.resolveScopesForProviders(requestedProviders);

        if (input.action === 'disconnect') {
            if (requestedProviders.length === 0) {
                await this.disconnectAll(connection);
                await this.notifyWorkspaceTokenCacheInvalidation(ownerId);
                return null;
            }

            const session = await this.authSessionModel.create({
                ownerId,
                serviceId: GOOGLE_WORKSPACE_SERVICE_ID,
                packId: manifest.id,
                providerId: input.providerId,
                action: input.action,
                requestedProviders,
                requestedScopes,
                state: randomUUID(),
                status: 'pending',
                expiresAt: new Date(Date.now() + DEFAULT_AUTH_SESSION_TTL_MS),
            });

            connection.state = 'pending';
            connection.lastError = undefined;
            await connection.save();

            return {
                requiresAuth: true,
                authType: GOOGLE_WORKSPACE_SERVICE_ID,
                requiresGoogleSignIn: true,
                requestedScopes,
                authSessionId: String(session._id),
                providerId: input.providerId,
                action: input.action,
            };
        }
        if (requestedScopes.length === 0) {
            const missingProviders = requestedProviders.length > 0 ? requestedProviders.join(', ') : input.providerId;
            throw new BadRequestException(`Google Workspace scopes are not registered for: ${missingProviders}`);
        }
        const missingScopes = requestedScopes.filter((scope) => !currentScopes.has(scope));

        const needsAuth = missingScopes.length > 0 || !this.hasRefreshToken(connection);

        if (!needsAuth) {
            connection.enabledProviders = requestedProviders;
            connection.state = 'connected';
            connection.lastError = undefined;
            await connection.save();
            await this.notifyWorkspaceTokenCacheInvalidation(ownerId);
            return null;
        }

        const session = await this.authSessionModel.create({
            ownerId,
            serviceId: GOOGLE_WORKSPACE_SERVICE_ID,
            packId: manifest.id,
            providerId: input.providerId,
            action: input.action,
            requestedProviders,
            requestedScopes,
            state: randomUUID(),
            status: 'pending',
            expiresAt: new Date(Date.now() + DEFAULT_AUTH_SESSION_TTL_MS),
        });

        connection.state = 'pending';
        connection.lastError = undefined;
        await connection.save();

        return {
            requiresAuth: true,
            authType: GOOGLE_WORKSPACE_SERVICE_ID,
            requiresGoogleSignIn: true,
            requestedScopes,
            authSessionId: String(session._id),
            providerId: input.providerId,
            action: input.action,
        };
    }

    async getAuthSessionStatus(ownerId: string, authSessionId: string): Promise<GoogleWorkspaceProviderActionStatus> {
        const session = await this.authSessionModel.findOne({ _id: authSessionId, ownerId }).exec();
        if (!session) {
            throw new NotFoundException('Google Workspace auth session not found');
        }
        if (session.status === 'pending' && session.expiresAt.getTime() <= Date.now()) {
            session.status = 'expired';
            session.errorCode = 'AUTH_SESSION_EXPIRED';
            session.errorMessage = 'Google Workspace auth session expired.';
            await session.save();
        }
        return {
            authSessionId: String(session._id),
            status: session.status,
            providerId: session.providerId,
            action: session.action,
            requiresAuth: session.status === 'pending',
            errorCode: session.errorCode,
            errorMessage: session.errorMessage,
        };
    }

    async finalizeGoogleSignIn(input: {
        ownerId: string;
        authSessionId: string;
        serverAuthCode: string;
        idToken?: string;
        accessToken?: string;
        email?: string;
    }): Promise<GoogleWorkspaceFinalizeResult> {
        const session = await this.authSessionModel
            .findOne({ _id: String(input.authSessionId ?? '').trim(), ownerId: input.ownerId })
            .exec();
        if (!session) {
            throw new NotFoundException('Google Workspace auth session not found');
        }
        if (session.status !== 'pending') {
            return {
                ok: session.status === 'completed',
                message: session.errorMessage ?? 'Auth session already handled.',
                errorCode: session.errorCode,
            };
        }
        if (session.expiresAt.getTime() <= Date.now()) {
            session.status = 'expired';
            session.errorCode = 'AUTH_SESSION_EXPIRED';
            session.errorMessage = 'Google Workspace auth session expired.';
            await session.save();
            return { ok: false, message: session.errorMessage, errorCode: session.errorCode };
        }
        const connection = await this.ensureConnection(session.ownerId);
        const serverAuthCode = String(input.serverAuthCode ?? '').trim();
        if (!serverAuthCode) {
            return this.finalizeWithExistingRefreshToken(session, connection, input.accessToken);
        }

        try {
            const token = await this.exchangeServerAuthCode(serverAuthCode);
            const accessToken = String(token.access_token ?? '').trim();
            if (!accessToken) {
                throw new ServiceUnavailableException('Google OAuth exchange returned no access token');
            }
            const newRefreshToken = String(token.refresh_token ?? '').trim();
            const reusedRefreshToken = newRefreshToken ? '' : this.readRefreshToken(connection);
            const refreshToken = newRefreshToken || reusedRefreshToken;
            if (!refreshToken) {
                throw new ServiceUnavailableException('Google OAuth exchange returned no refresh token');
            }
            const refreshedToken = await this.refreshAccessToken(refreshToken).catch(() => {
                throw new ServiceUnavailableException(
                    newRefreshToken
                        ? 'Google Workspace requires a fresh reconnect because the newly issued Google refresh token could not mint a usable runtime token.'
                        : 'Google Workspace requires a fresh reconnect because Google did not issue a new refresh token and the stored one is invalid or expired.',
                );
            });
            const refreshedAccessToken = String(refreshedToken.access_token ?? '').trim();
            if (!refreshedAccessToken) {
                throw new ServiceUnavailableException('Google Workspace requires a fresh reconnect because Google did not return a usable access token.');
            }
            let refreshedScopes = await this.fetchGrantedScopesFromAccessToken(refreshedAccessToken);
            if (refreshedScopes.length === 0) {
                refreshedScopes = this.parseScopes(refreshedToken.scope);
            }
            if (session.requestedScopes.length > 0 && !session.requestedScopes.every((scope) => refreshedScopes.includes(scope))) {
                throw new ServiceUnavailableException(
                    'Google OAuth exchange completed, but the durable Google Workspace token is still missing one or more requested scopes.',
                );
            }
            const profile = await this.fetchProfile(refreshedAccessToken);

            connection.googleSubject = profile.sub;
            connection.googleEmail = profile.email;
            connection.refreshTokenEncrypted = this.secretCrypto.encrypt(refreshToken);
            connection.accessTokenEncrypted = this.secretCrypto.encrypt(refreshedAccessToken);
            connection.accessTokenExpiresAt = this.resolveExpiry(refreshedToken.expires_in);
            connection.grantedScopes = refreshedScopes;
            connection.enabledProviders = this.resolveProvidersSupportedByScopes(session.requestedProviders, refreshedScopes);
            connection.state = connection.enabledProviders.length > 0 ? 'connected' : 'disconnected';
            connection.lastConsentAt = new Date();
            connection.lastError = undefined;
            await connection.save();

            session.status = 'completed';
            session.completedAt = new Date();
            session.errorCode = undefined;
            session.errorMessage = undefined;
            await session.save();
            await this.notifyWorkspaceTokenCacheInvalidation(session.ownerId);
            return { ok: true, message: 'Google Workspace connected successfully. You can return to Jovita.' };
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            session.status = 'failed';
            session.errorCode = this.resolveFinalizeErrorCode(message, 'GOOGLE_OAUTH_EXCHANGE_FAILED');
            session.errorMessage = message;
            await session.save();
            await this.markConnectionError(session.ownerId, message);
            return { ok: false, message, errorCode: session.errorCode };
        }
    }

    private async finalizeWithExistingRefreshToken(
        session: GoogleWorkspaceAuthSessionDocument,
        connection: GoogleWorkspaceConnectionDocument,
        mobileAccessToken: string | undefined,
    ): Promise<GoogleWorkspaceFinalizeResult> {
        try {
            if (!this.hasRefreshToken(connection)) {
                throw new ServiceUnavailableException('Google Sign-In did not provide a server auth code.');
            }

            const mobileToken = String(mobileAccessToken ?? '').trim();
            if (!mobileToken) {
                throw new ServiceUnavailableException('Google Sign-In did not provide a server auth code.');
            }

            const tokenScopes = await this.fetchGrantedScopesFromAccessToken(mobileToken);
            if (
                session.requestedScopes.length > 0 &&
                !session.requestedScopes.every((scope) => tokenScopes.includes(scope))
            ) {
                throw new ServiceUnavailableException(
                    'Google Sign-In granted consent, but Jovita could not verify all requested Google Workspace scopes.',
                );
            }

            let refreshedToken: TokenExchangeResponse;
            try {
                refreshedToken = await this.refreshAccessToken(this.readRefreshToken(connection));
            } catch {
                throw new ServiceUnavailableException(
                    'Google Workspace requires a fresh reconnect because the stored Google refresh token is invalid or expired.',
                );
            }
            const refreshedAccessToken = String(refreshedToken.access_token ?? '').trim();
            if (!refreshedAccessToken) {
                throw new ServiceUnavailableException(
                    'Google Workspace requires a fresh reconnect because Google did not return a usable access token.',
                );
            }

            let refreshedScopes = await this.fetchGrantedScopesFromAccessToken(refreshedAccessToken);
            if (refreshedScopes.length === 0) {
                refreshedScopes = this.parseScopes(refreshedToken.scope);
            }
            if (session.requestedScopes.length > 0 && !session.requestedScopes.every((scope) => refreshedScopes.includes(scope))) {
                throw new ServiceUnavailableException(
                    'Google Sign-In granted consent, but the durable Google Workspace token is still missing one or more requested scopes.',
                );
            }

            const profile = await this.fetchProfile(refreshedAccessToken);
            connection.googleSubject = profile.sub;
            connection.googleEmail = profile.email;
            connection.accessTokenEncrypted = this.secretCrypto.encrypt(refreshedAccessToken);
            connection.accessTokenExpiresAt = this.resolveExpiry(refreshedToken.expires_in);
            connection.grantedScopes = refreshedScopes;
            connection.enabledProviders = this.resolveProvidersSupportedByScopes(session.requestedProviders, refreshedScopes);
            connection.state = connection.enabledProviders.length > 0 ? 'connected' : 'disconnected';
            connection.lastConsentAt = new Date();
            connection.lastError = undefined;
            await connection.save();

            session.status = 'completed';
            session.completedAt = new Date();
            session.errorCode = undefined;
            session.errorMessage = undefined;
            await session.save();
            await this.notifyWorkspaceTokenCacheInvalidation(session.ownerId);
            return { ok: true, message: 'Google Workspace connected successfully. You can return to Jovita.' };
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            session.status = 'failed';
            session.errorCode = this.resolveFinalizeErrorCode(message, 'GOOGLE_SERVER_AUTH_CODE_MISSING');
            session.errorMessage = message;
            await session.save();
            await this.markConnectionError(session.ownerId, message);
            return { ok: false, message, errorCode: session.errorCode };
        }
    }

    async issueRuntimeAccessToken(
        ownerId: string,
        options: { forceRefresh?: boolean } = {},
    ): Promise<{ accessToken: string; expiresAt: string; scope: string[] }> {
        const connection = await this.getConnection(ownerId);
        if (!connection || !this.hasRefreshToken(connection)) {
            throw new NotFoundException('Google Workspace is not connected for this runtime owner');
        }
        if (connection.enabledProviders.length === 0) {
            throw new NotFoundException('Google Workspace is not enabled for this runtime owner');
        }

        const cachedToken = String(connection.accessTokenEncrypted ?? '').trim()
            ? this.secretCrypto.decrypt(connection.accessTokenEncrypted)
            : '';
        const expiresAt = connection.accessTokenExpiresAt?.getTime() ?? 0;
        if (!options.forceRefresh && cachedToken && expiresAt > Date.now() + DEFAULT_REFRESH_LEEWAY_MS) {
            const cachedScopes = await this.fetchGrantedScopesFromAccessToken(cachedToken);
            if (cachedScopes.length > 0) {
                const enabledProviders = this.resolveProvidersSupportedByScopes(connection.enabledProviders, cachedScopes);
                const scopesChanged = JSON.stringify(connection.grantedScopes) !== JSON.stringify(cachedScopes);
                const providersChanged = JSON.stringify(connection.enabledProviders) !== JSON.stringify(enabledProviders);
                if (scopesChanged || providersChanged) {
                    connection.grantedScopes = cachedScopes;
                    connection.enabledProviders = enabledProviders;
                    connection.state = enabledProviders.length > 0 ? 'connected' : 'disconnected';
                    connection.lastError = undefined;
                    await connection.save();
                }
                return {
                    accessToken: cachedToken,
                    expiresAt: new Date(expiresAt).toISOString(),
                    scope: cachedScopes,
                };
            }
            return {
                accessToken: cachedToken,
                expiresAt: new Date(expiresAt).toISOString(),
                scope: [...connection.grantedScopes],
            };
        }

        try {
            const token = await this.refreshAccessToken(this.readRefreshToken(connection));
            const accessToken = String(token.access_token ?? '').trim();
            if (!accessToken) {
                throw new ServiceUnavailableException('Google token refresh returned no access token');
            }
            let tokenScopes = await this.fetchGrantedScopesFromAccessToken(accessToken);
            if (tokenScopes.length === 0) {
                tokenScopes = this.parseScopes(token.scope);
            }
            const enabledProviders = this.resolveProvidersSupportedByScopes(connection.enabledProviders, tokenScopes);

            connection.accessTokenEncrypted = this.secretCrypto.encrypt(accessToken);
            connection.accessTokenExpiresAt = this.resolveExpiry(token.expires_in);
            connection.enabledProviders = enabledProviders;
            connection.state = enabledProviders.length > 0 ? 'connected' : 'disconnected';
            connection.lastError = undefined;
            connection.grantedScopes = tokenScopes;
            await connection.save();

            return {
                accessToken,
                expiresAt:
                    connection.accessTokenExpiresAt?.toISOString() ?? new Date(Date.now() + 3600_000).toISOString(),
                scope: [...connection.grantedScopes],
            };
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            connection.state = 'error';
            connection.lastError = message;
            connection.accessTokenEncrypted = undefined;
            connection.accessTokenExpiresAt = undefined;
            await connection.save();
            throw new ServiceUnavailableException(
                'Google Workspace access requires reconnect. Refresh token is invalid or expired.',
            );
        }
    }

    async disconnectService(ownerId: string): Promise<void> {
        const connection = await this.getConnection(ownerId);
        if (!connection) return;
        await this.disconnectAll(connection);
        await this.notifyWorkspaceTokenCacheInvalidation(ownerId);
    }

    private async disconnectAll(connection: GoogleWorkspaceConnectionDocument): Promise<void> {
        await this.revokeStoredRefreshToken(connection);
        connection.enabledProviders = [];
        connection.grantedScopes = [];
        connection.refreshTokenEncrypted = undefined;
        connection.accessTokenEncrypted = undefined;
        connection.accessTokenExpiresAt = undefined;
        connection.state = 'disconnected';
        connection.lastError = undefined;
        await connection.save();
    }

    private async notifyWorkspaceTokenCacheInvalidation(ownerId: string): Promise<void> {
        const normalizedOwnerId = String(ownerId ?? '').trim();
        if (!normalizedOwnerId) return;

        const delivered = await this.gatewayBridge.emitEvent(normalizedOwnerId, 'workspace.token.invalidate', {
            packId: GOOGLE_WORKSPACE_SERVICE_ID,
        });
        if (!delivered) {
            this.logger.debug(
                `Workspace token invalidation event was not delivered owner=${normalizedOwnerId} pack=${GOOGLE_WORKSPACE_SERVICE_ID}`,
            );
        }
    }

    private resolveScopesForProviders(providerIds: string[]): string[] {
        const scopes = new Set<string>();
        for (const providerId of providerIds) {
            for (const scope of PROVIDER_SCOPE_MAP[providerId] ?? []) {
                scopes.add(scope);
            }
        }
        return [...scopes];
    }

    private resolveProvidersSupportedByScopes(providerIds: string[], scopes: string[]): string[] {
        const scopeSet = new Set(scopes.map((value) => value.trim()).filter(Boolean));
        return providerIds
            .map((value) => value.trim())
            .filter(Boolean)
            .filter((providerId) =>
                (PROVIDER_SCOPE_MAP[providerId] ?? []).every((scope) => scopeSet.has(scope)),
            );
    }

    private parseScopes(raw: unknown): string[] {
        return this.oauthFlow.parseScopes(raw);
    }

    private hasRefreshToken(
        connection: Pick<GoogleWorkspaceConnectionDocument, 'refreshTokenEncrypted'> | null,
    ): boolean {
        return String(connection?.refreshTokenEncrypted ?? '').trim().length > 0;
    }

    private isDuplicateKeyError(error: unknown): boolean {
        const code = Number((error as { code?: unknown })?.code);
        if (code === 11000) return true;
        return String((error as { message?: unknown })?.message ?? error).includes('E11000');
    }

    private readRefreshToken(connection: Pick<GoogleWorkspaceConnectionDocument, 'refreshTokenEncrypted'>): string {
        const encrypted = String(connection.refreshTokenEncrypted ?? '').trim();
        if (!encrypted) return '';
        return this.secretCrypto.decrypt(encrypted);
    }

    // The following methods are exposed and delegate to GoogleOAuthFlowService
    // to maintain full backwards compatibility with tests that mock or spy on them.
    private async exchangeServerAuthCode(code: string): Promise<TokenExchangeResponse> {
        return this.oauthFlow.exchangeServerAuthCode(code);
    }

    private async refreshAccessToken(refreshToken: string): Promise<TokenExchangeResponse> {
        return this.oauthFlow.refreshAccessToken(refreshToken);
    }

    private async fetchProfile(accessToken: string): Promise<{ sub: string; email: string }> {
        return this.oauthFlow.fetchProfile(accessToken);
    }

    private async fetchGrantedScopesFromAccessToken(accessToken: string | undefined): Promise<string[]> {
        return this.oauthFlow.fetchGrantedScopesFromAccessToken(accessToken);
    }

    private async revokeStoredRefreshToken(
        connection: Pick<GoogleWorkspaceConnectionDocument, 'refreshTokenEncrypted'>,
    ): Promise<void> {
        const refreshToken = this.readRefreshToken(connection);
        return this.oauthFlow.revokeStoredRefreshToken(refreshToken);
    }

    private resolveFinalizeErrorCode(message: string, fallback: string): string {
        const normalized = message.trim().toLowerCase();
        if (
            normalized.includes('invalid_grant') ||
            normalized.includes('expired or revoked') ||
            normalized.includes('please reconnect your google account')
        ) {
            return GoogleWorkspaceAuthService.RECONNECT_REQUIRED_CODE;
        }
        return fallback;
    }

    private resolveExpiry(expiresInSeconds: unknown): Date {
        const seconds = Number(expiresInSeconds);
        const ttl = Number.isFinite(seconds) && seconds > 0 ? seconds : 3600;
        return new Date(Date.now() + ttl * 1000);
    }

    private async markConnectionError(ownerId: string, message: string): Promise<void> {
        const connection = await this.ensureConnection(ownerId);
        connection.state = 'error';
        connection.lastError = message;
        await connection.save();
        await this.notifyWorkspaceTokenCacheInvalidation(ownerId);
    }

    private normalizeConnectionState(
        value: GoogleWorkspaceConnectionState | undefined,
    ): GoogleWorkspaceConnectionState {
        if (!value) return 'disconnected';
        return value;
    }
}
