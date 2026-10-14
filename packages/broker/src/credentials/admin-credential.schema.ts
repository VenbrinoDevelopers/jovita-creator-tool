import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import type { HydratedDocument } from 'mongoose';

export type MiniappProviderCredentialDocument = HydratedDocument<MiniappProviderCredential>;

@Schema({ collection: 'miniapp_provider_credentials', timestamps: true })
export class MiniappProviderCredential {
  @Prop({ type: String, required: true, trim: true, index: true })
  environment!: string;

  @Prop({ type: String, required: true, trim: true, index: true })
  packId!: string;

  @Prop({ type: String, required: true, enum: ['pack', 'environment'], default: 'pack', index: true })
  scope!: 'pack' | 'environment';

  @Prop({ type: String, required: true, trim: true })
  providerId!: string;

  @Prop({ type: String, required: true, select: false })
  encryptedConfig!: string;

  @Prop({ type: String, required: true, trim: true })
  configFingerprint!: string;

  // A tool grant points to a creator-owned credential. The secret is stored once.
  @Prop({ type: String, trim: true, index: true })
  sourcePackId?: string;

  @Prop({ type: String, required: true, enum: ['active', 'disabled'], index: true })
  status!: 'active' | 'disabled';

  @Prop({ type: Date })
  lastTestedAt?: Date;

  @Prop({ type: String, trim: true })
  lastTestStatus?: string;

  @Prop({ type: String, required: true, trim: true })
  updatedBy!: string;
}

export const MiniappProviderCredentialSchema = SchemaFactory.createForClass(MiniappProviderCredential);
MiniappProviderCredentialSchema.index(
  { environment: 1, packId: 1, providerId: 1 },
  { unique: true },
);
