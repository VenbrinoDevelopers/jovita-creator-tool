import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import type { HydratedDocument } from 'mongoose';
import type { GoogleWorkspaceConnectionState } from '../saas-store.types.js';

export type GoogleWorkspaceConnectionDocument = HydratedDocument<GoogleWorkspaceConnection>;

@Schema({
  collection: 'google_workspace_connections',
  timestamps: true,
})
export class GoogleWorkspaceConnection {
  @Prop({ type: String, required: true, index: true, trim: true })
  ownerId!: string;

  @Prop({ type: String, required: true, trim: true, default: 'google-workspace' })
  serviceId!: string;

  @Prop({ type: String, trim: true })
  googleSubject?: string;

  @Prop({ type: String, trim: true })
  googleEmail?: string;

  @Prop({ type: String, trim: true })
  refreshTokenEncrypted?: string;

  @Prop({ type: String, trim: true })
  accessTokenEncrypted?: string;

  @Prop({ type: Date })
  accessTokenExpiresAt?: Date;

  @Prop({ type: [String], default: [] })
  grantedScopes!: string[];

  @Prop({ type: [String], default: [] })
  enabledProviders!: string[];

  @Prop({ type: String, enum: ['connected', 'pending', 'disconnected', 'error'], default: 'disconnected' })
  state!: GoogleWorkspaceConnectionState;

  @Prop({ type: Date })
  lastConsentAt?: Date;

  @Prop({ type: String, trim: true })
  lastError?: string;
}

export const GoogleWorkspaceConnectionSchema = SchemaFactory.createForClass(GoogleWorkspaceConnection);
GoogleWorkspaceConnectionSchema.index({ ownerId: 1, serviceId: 1 }, { unique: true });
