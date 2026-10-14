import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import type { HydratedDocument } from 'mongoose';

export type MiniappPricingPolicyDocument = HydratedDocument<MiniappPricingPolicy>;
// Variable modes remain readable only for policies published before fixed call pricing.
// MiniappPricingService rejects them when creating or activating a policy.
export type MiniappPricingMode =
  | 'free'
  | 'fixed_success'
  | 'cost_plus'
  | 'per_unit'
  | 'included_then_overage';

@Schema({ collection: 'miniapp_pricing_policies', timestamps: true })
export class MiniappPricingPolicy {
  @Prop({ type: String, required: true, trim: true, index: true })
  environment!: string;

  @Prop({ type: String, required: true, trim: true, index: true })
  packId!: string;

  @Prop({ type: String, required: true, trim: true })
  operationId!: string;

  @Prop({ type: Number, required: true, min: 1 })
  version!: number;

  @Prop({
    type: String,
    required: true,
    enum: ['free', 'fixed_success', 'cost_plus', 'per_unit', 'included_then_overage'],
  })
  mode!: MiniappPricingMode;

  @Prop({ type: String, required: true, enum: ['draft', 'active', 'retired'], index: true })
  status!: 'draft' | 'active' | 'retired';

  @Prop({ type: Number, min: 0 })
  fixedCredits?: number;

  @Prop({ type: Number, min: 0 })
  maxCredits?: number;

  /** Fixed buyer credits for each declared broker capability call. */
  @Prop({ type: Object })
  brokerCallPrices?: Record<string, number>;

  @Prop({ type: Number, min: 0 })
  fixedFeeCredits?: number;

  @Prop({ type: Number, min: 0 })
  marginBasisPoints?: number;

  @Prop({ type: Number, min: 0 })
  creditsPerUnit?: number;

  @Prop({ type: String, trim: true })
  unitName?: string;

  @Prop({ type: Number, min: 0 })
  includedUnits?: number;

  @Prop({ type: String, enum: ['daily', 'monthly'] })
  allowancePeriod?: 'daily' | 'monthly';

  @Prop({ type: Number, required: true, min: 1 })
  creditsPerUsd!: number;

  @Prop({ type: String, required: true, trim: true })
  createdBy!: string;

  @Prop({ type: Date })
  activatedAt?: Date;

  @Prop({ type: Date })
  retiredAt?: Date;
}

export const MiniappPricingPolicySchema = SchemaFactory.createForClass(MiniappPricingPolicy);
MiniappPricingPolicySchema.index(
  { environment: 1, packId: 1, operationId: 1, version: 1 },
  { unique: true },
);
MiniappPricingPolicySchema.index(
  { environment: 1, packId: 1, operationId: 1, status: 1 },
  {
    unique: true,
    partialFilterExpression: { status: 'active' },
  },
);
