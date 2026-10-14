import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import type { HydratedDocument } from 'mongoose';
import type { ConnectionAction, GoogleWorkspaceAuthSessionState } from '../saas-store.types.js';

export type GoogleWorkspaceAuthSessionDocument = HydratedDocument<GoogleWorkspaceAuthSession>;

@Schema({
  collection: 'google_workspace_auth_sessions',
  timestamps: true,
})
export class GoogleWorkspaceAuthSession {
  @Prop({ type: String, required: true, index: true, trim: true })
  ownerId!: string;

  @Prop({ type: String, required: true, trim: true, default: 'google-workspace' })
  serviceId!: string;

  @Prop({ type: String, required: true, trim: true })
  packId!: string;

  @Prop({ type: String, required: true, trim: true })
  providerId!: string;

  @Prop({ type: String, required: true, enum: ['connect', 'disconnect', 'refresh'] })
  action!: ConnectionAction['action'];

  @Prop({ type: [String], default: [] })
  requestedProviders!: string[];

  @Prop({ type: [String], default: [] })
  requestedScopes!: string[];

  @Prop({ type: String, required: true, trim: true, unique: true })
  state!: string;

  @Prop({ type: String, enum: ['pending', 'completed', 'failed', 'expired'], default: 'pending' })
  status!: GoogleWorkspaceAuthSessionState;

  @Prop({ type: Date, required: true })
  expiresAt!: Date;

  @Prop({ type: Date })
  completedAt?: Date;

  @Prop({ type: String, trim: true })
  errorCode?: string;

  @Prop({ type: String, trim: true })
  errorMessage?: string;
}

export const GoogleWorkspaceAuthSessionSchema = SchemaFactory.createForClass(GoogleWorkspaceAuthSession);
GoogleWorkspaceAuthSessionSchema.index({ ownerId: 1, serviceId: 1, status: 1 });
