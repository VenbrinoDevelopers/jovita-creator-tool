import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import type { HydratedDocument } from 'mongoose';

export type VoiceProfileDocument = HydratedDocument<VoiceProfile>;

@Schema({ collection: 'voice_profiles', timestamps: true })
export class VoiceProfile {
  @Prop({ type: String, required: true, unique: true }) voiceId!: string;
  @Prop({ type: String, required: true, index: true }) ownerId!: string;
  @Prop({ type: String, required: true, trim: true }) name!: string;
  @Prop({ type: String, required: true, select: false }) specificationEncrypted!: string;
  @Prop({ type: String, required: true, select: false }) consentAttestationEncrypted!: string;
  @Prop({ type: [String], required: true, default: [] }) referenceAssetIds!: string[];
  @Prop({ type: String, enum: ['openrouter_stateless'], required: true, default: 'openrouter_stateless' })
  cloneMode!: 'openrouter_stateless';
  @Prop({ type: String, required: true, default: 'fish-audio/s2.1-pro@openrouter-v1' }) routeVersion!: string;
  @Prop({ type: String, required: true }) referenceSha256!: string;
  @Prop({ type: String, enum: ['self', 'authorized'], required: true }) consentType!: 'self' | 'authorized';
  @Prop({ type: String, enum: ['active', 'deleting'], required: true, default: 'active', index: true }) status!: 'active' | 'deleting';
  @Prop({ type: Number, required: true, default: 0 }) revision!: number;
}

export const VoiceProfileSchema = SchemaFactory.createForClass(VoiceProfile);
VoiceProfileSchema.index({ ownerId: 1, name: 1 }, { unique: true, partialFilterExpression: { status: 'active' }, collation: { locale: 'en', strength: 2 } });
VoiceProfileSchema.index({ ownerId: 1, createdAt: -1 });
