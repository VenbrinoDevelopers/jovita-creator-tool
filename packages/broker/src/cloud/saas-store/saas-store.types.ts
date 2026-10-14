export type SaaSBillingTier = 'free' | 'pro' | 'enterprise';
export type SaaSConnectionMode = 'app' | 'runtime' | 'hybrid';
export type SaaSConnectionStatus = 'connected' | 'disconnected' | 'expired' | 'error' | 'unknown';
export type SaaSPackUpdateChannel = 'patch' | 'major';
export type SaaSPackCategory = string;
export type SaaSPackLifecycleStatus = 'draft' | 'published' | 'deprecated';
export type SaaSPackRuntimeProfile = 'declarative' | 'native-runtime' | 'packaged-runtime';
export type SaaSPackExecutionMode = 'direct' | 'brokered';

export interface AgentStoreMetrics {
    installCount: number;
    ratingAverage: number | null;
    ratingCount: number;
    reviewCount: number;
}
export type SaaSProviderAuthType = 'google-workspace';
export type SaaSProviderAuthConnectionModel = 'single-connection';
export type JovitaActivityKind =
    | 'build'
    | 'generate'
    | 'check'
    | 'test'
    | 'search'
    | 'list'
    | 'read'
    | 'write'
    | 'prepare'
    | 'publish'
    | 'send'
    | 'run';
export type JovitaActivityIcon =
    | 'build'
    | 'check'
    | 'test'
    | 'search'
    | 'folder'
    | 'document'
    | 'publish'
    | 'send'
    | 'command';

export interface JovitaActivityTargetV1 {
    source: 'flag-value' | 'positional' | 'working-directory';
    key?: string;
    index?: number;
    format: 'display-name' | 'basename' | 'path-tail' | 'hostname';
    placement: 'before-object' | 'after-object';
}

export interface JovitaActivityPhaseV1 {
    kind: JovitaActivityKind;
    object: string;
    article?: 'none' | 'the';
    icon?: JovitaActivityIcon;
    labels?: { active?: string; completed?: string; failed?: string };
}

export interface JovitaActivitySpecV1 extends JovitaActivityPhaseV1 {
    target?: JovitaActivityTargetV1;
    phases?: Record<string, JovitaActivityPhaseV1>;
}

export interface SaaSPackAuthConfig {
    type: SaaSProviderAuthType;
    connectionModel: SaaSProviderAuthConnectionModel;
    providerIds: string[];
    consentClient?: 'google-sign-in';
    consentStrategy?: 'oauth-scope-upgrade';
}

export interface SaaSPackSkillIndexEntry {
    path: string;
    sha256: string;
    size: number;
}

export interface SaaSPackManifest {
    id: string;
    kind?: 'ai-tool' | 'creator-skill';
    creatorSkill?: { promptId: string; toolIds: string[]; priceCents: number;
        listing: { title: string; summary: string; details: string; category: string;
            logoUrl: string; coverUrl: string; examples: string[];
            showcase: Array<{ prompt: string; mediaUrl: string; mediaType: 'image' | 'video' }> } };
    name: string;
    version: string;
    lifecycle: SaaSPackLifecycleStatus;
    description: string;
    category: SaaSPackCategory;
    logoUrl?: string;
    presentation?: SaaSPackPresentation;
    activityProtocolVersion?: 1;
    discovery?: {
        keywords?: string[];
        intents?: string[];
        synonyms?: string[];
        examples?: string[];
    };
    skill: {
        entry: string;
        index: SaaSPackSkillIndexEntry[];
    };
    runtime?: {
        execute?: {
            command: string;
            argsTemplate?: string[];
            mode?: SaaSPackExecutionMode;
            protocolVersion?: 1;
            operations?: SaaSPackRuntimeOperation[];
            healthCheck?: {
                command: string;
                args?: string[];
                operationId?: string;
            };
        };
        bundle?: {
            target?: 'linux-arm64' | 'linux-amd64' | 'any';
            uri?: string;
            checksum: string;
            signature: string;
            oci?: {
                registry: string;
                repository: string;
                tag: string;
                manifestDigest: string;
                bundleDigest: string;
                bundleSize: number;
            };
        };
    };
    auth?: SaaSPackAuthConfig;
    providers: Array<{
        id: string;
        name: string;
        capabilities: string[];
        logoUrl?: string;
        status?: string;
    }>;
    /** Public creator API declarations from a signed .jov bundle; never contains credentials. */
    broker?: {
        providers: Array<{
            id: string; name: string; summary: string; docsUrl: string; category: string;
            baseUrl: string; authMethod: 'bearer' | 'header'; authHeader?: string; timeoutMs?: number;
            operations: Array<{
                id: string; version: number; name: string; purpose: string;
                method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'; path: string;
                executionKind?: 'http-json' | 'http-multipart' | 'http-binary' | 'http-sse' | 'http-poll';
                poll?: { path: string; jobIdField: string; statusField: string; resultField?: string;
                    successValue: string; failureValue: string; failureValues?: string[];
                    providerStatusField?: string; noResultStatuses?: number[];
                    intervalMs: number; maxAttempts: number };
                mediaPreset?: 'transparent-png-v1';
                requestMapping?: { body: Record<string, { from: string } | { const: string | number | boolean }> };
                responseField?: string;
                queryFields?: string[]; inputSchema: Record<string, unknown>;
                outputSchema: Record<string, unknown>; buyerCredits: number;
                emptyResultIsNoResult?: boolean;
                maxRequestBytes?: number; maxResponseBytes?: number; providerCostNote: string;
            }>;
        }>;
    };
    billing: {
        tier: SaaSBillingTier;
        entitlementKey: string;
        quota?: {
            maxDailyRuns?: number;
            maxMonthlyRuns?: number;
        };
    };
    compat: {
        minRuntimeVersion: string;
    };
}

export interface SaaSPackPresentation {
    details: string;
    inputDescription: string;
    outputDescription: string;
    highlights: string[];
    featuredPrompt: string;
    examplePrompts?: string[];
    showcase?: Array<{ prompt: string; mediaUrl: string; mediaType: 'image' | 'video' }>;
    storefront?: {
        tagline: string;
        coverImageUrl: string;
        accentHex: string;
    };
}

export type StorefrontSectionLayout = 'landscape' | 'compact';

export interface StorefrontSection {
    id: string;
    title: string;
    subtitle?: string;
    layout: StorefrontSectionLayout;
    packIds: string[];
    skillIds?: string[];
}

export interface StorefrontConfig {
    version: number;
    heroPackId?: string;
    heroSkillId?: string;
    sections: StorefrontSection[];
}

export interface StorefrontDraftInput {
    heroPackId?: string;
    heroSkillId?: string;
    sections: StorefrontSection[];
}

export interface SaaSPackRuntimeOperation {
    id: string;
    description?: string;
    argvPrefix: string[];
    requiredArgs?: string[];
    excludedArgs?: string[];
    capabilities: string[];
    capabilityLimits?: Record<string, number>;
    billingRequired: boolean;
    partialExitCodes?: number[];
    activity?: JovitaActivitySpecV1;
}

export interface InstalledPackConnectionStatus {
    providerId: string;
    status: SaaSConnectionStatus;
    mode: SaaSConnectionMode;
    updatedAt?: string;
    lastError?: string;
}

export interface InstalledPackResponse {
    packId: string;
    name: string;
    enabled: boolean;
    installedVersion: string;
    latestVersion: string;
    entitled: boolean;
    hasUpdate: boolean;
    connectionStatus: InstalledPackConnectionStatus[];
    runtimeReady: boolean;
    activeRuntimeVersion?: string;
    runtimeHealth: 'healthy' | 'unhealthy' | 'unknown';
    runtimeStatus: 'pending' | 'reconciling' | 'ok' | 'failed' | 'skipped' | 'unavailable' | 'incompatible';
    runtimeLifecycle: 'active' | 'sleeping' | 'starting' | 'offline' | 'error';
    runtimeError?: string;
    lastSyncAt?: string;
}

export interface CatalogPackResponse {
    manifest: SaaSPackManifest;
    installed: boolean;
    enabled: boolean;
    entitled: boolean;
    installedVersion?: string;
    latestVersion: string;
    hasUpdate: boolean;
    connectionStatus: InstalledPackConnectionStatus[];
    runtimeReady: boolean;
    activeRuntimeVersion?: string;
    runtimeHealth: 'healthy' | 'unhealthy' | 'unknown';
    runtimeStatus: 'pending' | 'reconciling' | 'ok' | 'failed' | 'skipped' | 'unavailable' | 'incompatible';
    runtimeLifecycle: 'active' | 'sleeping' | 'starting' | 'offline' | 'error';
    runtimeError?: string;
    lastSyncAt?: string;
    storeMetrics?: AgentStoreMetrics;
    creatorName?: string;
    creatorHandle?: string;
    acquisitionPriceCents?: number;
    acquisitionPriceCredits?: number;
    acquired?: boolean;
}

export interface SyncResult {
    packId: string;
    fromVersion: string;
    toVersion: string;
    status: 'ok' | 'failed' | 'skipped';
    health: 'healthy' | 'unhealthy' | 'unknown';
    rollbackAvailable: boolean;
    errorCode?: string;
    errorMessage?: string;
    errorRetryable?: boolean;
    errorStage?: string;
    errorCauseCode?: string;
}

export interface ConnectionAction {
    packId: string;
    providerId: string;
    action: 'connect' | 'disconnect' | 'refresh';
    mode: 'app' | 'runtime';
}

export type GoogleWorkspaceConnectionState = 'connected' | 'pending' | 'disconnected' | 'error';
export type GoogleWorkspaceAuthSessionState = 'pending' | 'completed' | 'failed' | 'expired';

export interface GoogleWorkspaceProviderActionAuth {
    requiresAuth: true;
    authType: SaaSProviderAuthType;
    requiresGoogleSignIn: true;
    requestedScopes: string[];
    authSessionId: string;
    providerId: string;
    action: ConnectionAction['action'];
}

export interface GoogleWorkspaceProviderActionStatus {
    authSessionId: string;
    status: GoogleWorkspaceAuthSessionState;
    providerId: string;
    action: ConnectionAction['action'];
    requiresAuth: boolean;
    installed?: InstalledPackResponse;
    errorCode?: string;
    errorMessage?: string;
}

export type SaaSDiscoveryBlockedReason =
    | 'NOT_AVAILABLE'
    | 'NOT_INSTALLED'
    | 'DISABLED'
    | 'NOT_ENTITLED'
    | 'NOT_CONNECTED'
    | 'RUNTIME_SYNC_PENDING'
    | 'RUNTIME_NOT_INSTALLED'
    | 'RUNTIME_VERSION_MISMATCH'
    | 'RUNTIME_UNHEALTHY'
    | 'READY';

export interface SaaSDiscoveryService {
    packId: string;
    name: string;
    category: string;
    description: string;
    logoUrl?: string;
    available: boolean;
    installed: boolean;
    enabled: boolean;
    entitled: boolean;
    blockedReason: SaaSDiscoveryBlockedReason;
    connectionStatus: InstalledPackConnectionStatus[];
    providers: Array<{
        id: string;
        name: string;
        capabilities: string[];
    }>;
    capabilities: string[];
    relevanceScore: number;
    recommendedForIntent: string[];
}

export interface SaaSPackManifestValidationIssue {
    code: string;
    path: string;
    message: string;
}

export interface SaaSPackManifestValidationProfile {
    runtimeMode: SaaSPackRuntimeProfile;
    hasSkillIndex: boolean;
    hasRuntime: boolean;
    hasArtifact: boolean;
    hasBundle: boolean;
    hasExecute: boolean;
    hasHealthCheck: boolean;
    providerCount: number;
}

export interface SaaSPackManifestValidationResult {
    ok: boolean;
    profile: SaaSPackManifestValidationProfile;
    errors: SaaSPackManifestValidationIssue[];
}

export interface SourceServiceReleaseRequest {
    kind: 'source';
    source: {
        repoUrl: string;
        ref: string;
        path: string;
    };
    service: {
        id: string;
        name: string;
        version: string;
        category: string;
        description: string;
        logoUrl?: string;
        billing: SaaSPackManifest['billing'];
    };
}

export interface PrebuiltServiceReleaseRequest {
    kind: 'prebuilt';
    manifest: SaaSPackManifest;
}

export interface UploadedPrebuiltServiceReleaseRequest {
    kind: 'prebuilt-upload';
    manifest: SaaSPackManifest;
}

export interface CreatorUploadedServiceReleaseRequest {
    kind: 'creator-upload';
    skillPromptId?: string;
    manifest: SaaSPackManifest;
    target: 'linux-arm64' | 'linux-amd64' | 'any';
    checksum: string;
    stagingKey: string;
    priceCents: number;
    files: Array<{ path: string; size: number; sha256: string; preview?: string }>;
}

export type ServiceReleaseRequest =
    | SourceServiceReleaseRequest
    | PrebuiltServiceReleaseRequest
    | UploadedPrebuiltServiceReleaseRequest
    | CreatorUploadedServiceReleaseRequest;

export type ServiceReleaseStage =
    | 'queued'
    | 'checkout'
    | 'collect_assets'
    | 'build'
    | 'pack'
    | 'publish'
    | 'checksum'
    | 'sign'
    | 'validate'
    | 'draft_created'
    | 'published'
    | 'failed';
