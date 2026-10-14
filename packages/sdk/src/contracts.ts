export interface ServiceConfig {
  id: string;
  name: string;
  version: string;
  category: string;
  description: string;
  logoUrl?: string;
  /** @deprecated Legacy JSON input only. Buyer-facing copy is edited in Creator Studio and is not bundled. */
  presentation?: ServicePresentation;
  activityProtocolVersion?: 1;
  billing?: unknown;
  auth?: unknown;
  providers: unknown[];
  /** Public broker definitions; credentials are supplied in Creator Studio. */
  broker?: BrokerDeclaration;
  compat?: unknown;
  skill: {
    entry: string;
    assets: string[];
  };
  runtime?: {
    build?: RuntimeBuildConfig;
    execute?: {
      command: string;
      argsTemplate?: string[];
      mode?: 'direct' | 'brokered';
      protocolVersion?: 1;
      operations?: BrokerOperation[];
      healthCheck?: {
        command: string;
        args?: string[];
        operationId?: string;
      };
    };
    payload?: {
      packageName: string;
      version: string;
      files: SkillIndexItem[];
    };
  };
}

export interface BrokerDeclaration {
  providers: Array<{
    id: string;
    name: string;
    summary: string;
    docsUrl: string;
    category: string;
    baseUrl: string;
    authMethod: 'bearer' | 'header';
    authHeader?: string;
    timeoutMs?: number;
    operations: Array<{
      id: string;
      version: number;
      name: string;
      purpose: string;
      method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
      path: string;
      executionKind?: 'http-json' | 'http-multipart' | 'http-binary' | 'http-sse' | 'http-poll';
      poll?: { path: string; jobIdField: string; statusField: string; resultField?: string;
        successValue: string; failureValue: string; failureValues?: string[];
        providerStatusField?: string; noResultStatuses?: number[];
        intervalMs: number; maxAttempts: number };
      artifact?: { path: string; kind: 'video' | 'audio'; maxBytes: number; retentionSeconds: number; timeoutMs?: number };
      mediaPreset?: 'transparent-png-v1';
      requestMapping?: { body: Record<string, { from: string } | { const: string | number | boolean }> };
      responseField?: string;
      queryFields?: string[];
      inputSchema: Record<string, unknown>;
      outputSchema: Record<string, unknown>;
      buyerCredits: number;
      emptyResultIsNoResult?: boolean;
      maxRequestBytes?: number;
      maxResponseBytes?: number;
      providerCostNote: string;
    }>;
  }>;
}

/** Provider-independent artifact result contract shared by Jovita runtimes. */
export type ArtifactPurpose =
  | 'visual_inspection'
  | 'comparison'
  | 'generated_asset'
  | 'data_visualization'
  | 'document_preview'
  | 'user_attachment'
  | 'other';

export interface EphemeralArtifactReference {
  id: string;
  kind: 'image';
  transport: 'signed_url';
  url: string;
  mime_type: string;
  size: number;
  sha256: string;
  width: number;
  height: number;
  expires_at: string;
  purpose: ArtifactPurpose;
  label?: string;
  group_id?: string;
  sequence?: number;
  metadata?: {
    context?: string;
    viewport?: 'phone' | 'tablet' | 'desktop';
    comparison_side?: 'before' | 'after';
    [key: string]: string | number | boolean | undefined;
  };
  persistence: 'transient';
}

export interface ToolExecutionResult {
  text: string;
  details?: Record<string, unknown>;
  artifacts?: EphemeralArtifactReference[];
}

export interface RemoteImageContent {
  type: 'remote_image';
  url: string;
  mimeType: string;
  detail?: 'low' | 'high' | 'auto';
}

export interface ServicePresentation {
  details: string;
  inputDescription: string;
  outputDescription: string;
  highlights: string[];
  featuredPrompt: string;
  examplePrompts?: string[];
}

export interface BrokerOperation {
  id: string;
  description?: string;
  argvPrefix: string[];
  requiredArgs?: string[];
  excludedArgs?: string[];
  capabilities: string[];
  capabilityLimits?: Record<string, number>;
  billingRequired: boolean;
  partialExitCodes?: number[];
  destructive?: boolean;
  activity?: JovitaActivitySpecV1;
}

export type JovitaActivityKind = 'build' | 'generate' | 'check' | 'test' | 'search' | 'list' | 'read' | 'write' | 'prepare' | 'publish' | 'send' | 'run';
export type JovitaActivityIcon = 'build' | 'check' | 'test' | 'search' | 'folder' | 'document' | 'publish' | 'send' | 'command';
export interface JovitaActivityPhaseV1 {
  kind: JovitaActivityKind;
  object: string;
  article?: 'none' | 'the';
  icon?: JovitaActivityIcon;
  labels?: { active?: string; completed?: string; failed?: string };
}
export interface JovitaActivitySpecV1 extends JovitaActivityPhaseV1 {
  target?: {
    source: 'flag-value' | 'positional' | 'working-directory';
    key?: string;
    index?: number;
    format: 'display-name' | 'basename' | 'path-tail' | 'hostname';
    placement: 'before-object' | 'after-object';
  };
  phases?: Record<string, JovitaActivityPhaseV1>;
}

export interface SkillIndexItem {
  path: string;
  sha256: string;
  size: number;
  executable?: boolean;
}

export interface RuntimePayload {
  root: string;
  packageName: string;
  version: string;
  files: SkillIndexItem[];
  target?: RuntimeTarget;
  buildReport?: RuntimeBuildReport;
}

export interface RuntimeBuildConfig {
  prunePreset?: 'production-node';
  omitOptionalPackages?: string[];
  sizeReport?: boolean;
}

export interface RuntimePruneCategoryReport {
  files: number;
  bytes: number;
}

export interface RuntimeBuildReport {
  prunePreset?: 'production-node';
  removedFiles: number;
  removedBytes: number;
  categories: Record<string, RuntimePruneCategoryReport>;
  omittedOptionalPackages: string[];
}

export interface BundleSizeReport {
  compressedBytes: number;
  uncompressedBytes: number;
  fileCount: number;
  directories: Record<string, { compressedBytes: number; uncompressedBytes: number; fileCount: number }>;
  optimizations?: RuntimeBuildReport;
}

export interface RuntimeTarget {
  id: 'linux-arm64' | 'linux-amd64';
  os: 'linux';
  cpu: 'arm64' | 'x64';
  libc: 'glibc';
}

export interface ServiceDiscovery {
  serviceRoot: string;
  manifestPath: string;
  runtimePath: string;
  skillPath: string;
}

export interface ManifestValidationError {
  field: string;
  message: string;
}

export interface ManifestValidationResult {
  valid: boolean;
  errors: ManifestValidationError[];
}

export const BUNDLE_FORMAT = 'jovita-pack-bundle@1';
export const IGNORED_FILE_NAMES = new Set(['.DS_Store']);
