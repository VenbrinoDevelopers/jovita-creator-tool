import { BadRequestException, Injectable } from '@nestjs/common';
import { GoogleWorkspaceAuthService } from '../../cloud/saas-store/google-workspace-auth.service.js';
import type { CapabilityCallInput, CapabilityCallResult } from '../../cloud/saas-store/capabilities/capability-operation.types.js';

@Injectable()
export class GoogleWorkspaceLifecycle {
  readonly providerId = 'google-workspace';
  readonly credentialSource = 'user' as const;
  readonly credentialFields = [] as const;


  constructor(private readonly googleWorkspace: GoogleWorkspaceAuthService) {}

  validateCredential(): void {
    throw new BadRequestException('Google Workspace credentials are connected by each user');
  }

  async invoke(input: CapabilityCallInput): Promise<CapabilityCallResult> {
    return {
      result: await this.googleWorkspace.issueRuntimeAccessToken(input.ownerId, {
        forceRefresh: input.payload.forceRefresh === true,
      }),
      providerCostMicros: 0,
      quantity: 1,
    };
  }
}
