import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { ScheduleModule } from '@nestjs/schedule';
import { Redis } from 'ioredis';
import { RedisService } from './cloud/redis/redis.service.js';
import { CloudCallbackClient } from './cloud/cloud-callback.client.js';
import { GatewayBridgeService } from './cloud/gateway-bridge/gateway-bridge.service.js';
import { MiniappInvocationService } from './cloud/saas-store/miniapp-invocation.service.js';
import { GoogleOAuthFlowService } from './cloud/saas-store/google-auth/google-oauth-flow.service.js';
import { GoogleWorkspaceAuthService } from './cloud/saas-store/google-workspace-auth.service.js';
import { GoogleWorkspaceConnection, GoogleWorkspaceConnectionSchema } from './cloud/saas-store/schemas/google-workspace-connection.schema.js';
import { GoogleWorkspaceAuthSession, GoogleWorkspaceAuthSessionSchema } from './cloud/saas-store/schemas/google-workspace-auth-session.schema.js';
import { MediaJob, MediaJobSchema } from './cloud/media/jobs/media-job.schema.js';
import { MediaJobStep, MediaJobStepSchema } from './cloud/media/jobs/media-job-step.schema.js';
import { MediaJobService } from './cloud/media/jobs/media-job.service.js';
import { MediaJobStepService } from './cloud/media/jobs/media-job-step.service.js';
import { MediaJobWorker } from './cloud/media/jobs/media-job.worker.js';
import { MediaProcessingService } from './cloud/media/jobs/media-processing.service.js';
import { MediaSourceService } from './cloud/media/jobs/media-source.service.js';
import { MediaArchiveService } from './cloud/media/jobs/media-archive.service.js';
import { AttachmentUpload, AttachmentUploadSchema, AttachmentUsage, AttachmentUsageSchema } from './cloud/media/uploads/attachment-upload.schema.js';
import { UploadsService } from './cloud/media/uploads/uploads.service.js';
import { VoiceProfile, VoiceProfileSchema } from './cloud/media/voice-library/voice-profile.schema.js';
import { VoiceLibraryService } from './cloud/media/voice-library/voice-library.service.js';
import { MiniappInvocation, MiniappInvocationSchema } from './cloud/saas-store/schemas/miniapp-invocation.schema.js';
import { BuiltinOperationCatalog } from './catalog/builtin-operation.catalog.js';
import { BrokerBuiltinOperation, BrokerBuiltinOperationSchema } from './catalog/builtin-operation.schema.js';
import { BrokerCatalogRevision, BrokerCatalogRevisionSchema } from './catalog/builtin-catalog-revision.schema.js';
import { BUILTIN_PROVIDER_PROVIDERS } from './operations/builtin-provider-executors.js';
import { BuiltinOperationEngine } from './operations/builtin-operation.engine.js';
import { BrokerOperationRouter } from './operations/broker-operation.router.js';
import { BrokerHealthController, BrokerController } from './broker.controller.js';
import { BrokerAuthGuard } from './internal-auth.guard.js';
import { SecretCryptoService } from './security/secret-crypto.service.js';
import { BrokerCatalogService } from './catalog/broker-catalog.service.js';
import { ADMIN_CREDENTIALS } from './contracts/platform-ports.js';
import { MiniappProviderCredentialService } from './credentials/admin-credential.service.js';
import { MiniappProviderCredential, MiniappProviderCredentialSchema } from './credentials/admin-credential.schema.js';
import { BrokerProviderProfile, BrokerProviderProfileSchema,
  BrokerOperation, BrokerOperationSchema, BrokerConnection, BrokerConnectionSchema,
  BrokerRouteGrant, BrokerRouteGrantSchema, BrokerExecution, BrokerExecutionSchema } from './catalog/broker-catalog.schema.js';

@Module({
  imports: [
    MongooseModule.forRoot(process.env.DATABASE_URL ?? 'mongodb://127.0.0.1:27017',
      { dbName: process.env.DATABASE_NAME ?? 'jovita_broker' }),
    MongooseModule.forFeature([
      { name: BrokerProviderProfile.name, schema: BrokerProviderProfileSchema },
      { name: BrokerOperation.name, schema: BrokerOperationSchema },
      { name: BrokerConnection.name, schema: BrokerConnectionSchema },
      { name: BrokerRouteGrant.name, schema: BrokerRouteGrantSchema },
      { name: BrokerExecution.name, schema: BrokerExecutionSchema },
      { name: MiniappProviderCredential.name, schema: MiniappProviderCredentialSchema },
      { name: BrokerBuiltinOperation.name, schema: BrokerBuiltinOperationSchema },
      { name: BrokerCatalogRevision.name, schema: BrokerCatalogRevisionSchema },
      { name: GoogleWorkspaceConnection.name, schema: GoogleWorkspaceConnectionSchema },
      { name: GoogleWorkspaceAuthSession.name, schema: GoogleWorkspaceAuthSessionSchema },
      { name: MediaJob.name, schema: MediaJobSchema },
      { name: MediaJobStep.name, schema: MediaJobStepSchema },
      { name: AttachmentUpload.name, schema: AttachmentUploadSchema },
      { name: AttachmentUsage.name, schema: AttachmentUsageSchema },
      { name: VoiceProfile.name, schema: VoiceProfileSchema },
      { name: MiniappInvocation.name, schema: MiniappInvocationSchema },
    ]),
    ScheduleModule.forRoot(),
  ],
  controllers: [BrokerHealthController, BrokerController],
  providers: [
    { provide: Redis, useFactory: () => new Redis(process.env.REDIS_URL ?? 'redis://127.0.0.1:6379') },
    RedisService, CloudCallbackClient, GatewayBridgeService, MiniappInvocationService,
    BrokerAuthGuard, SecretCryptoService, BrokerCatalogService, MiniappProviderCredentialService,
    { provide: ADMIN_CREDENTIALS, useExisting: MiniappProviderCredentialService },
    BuiltinOperationCatalog, GoogleOAuthFlowService, GoogleWorkspaceAuthService,
    UploadsService, MediaJobService, MediaJobStepService, MediaJobWorker,
    MediaProcessingService, MediaSourceService, MediaArchiveService, VoiceLibraryService,
    ...BUILTIN_PROVIDER_PROVIDERS, BuiltinOperationEngine, BrokerOperationRouter,
  ],
})
export class BrokerModule {}
