import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import type { HydratedDocument } from 'mongoose';

/** Published contracts live in MongoDB. This collection is never creator writable. */
@Schema({ collection: 'broker_builtin_operations_public', timestamps: true })
export class BrokerBuiltinOperation {
  @Prop({ type: String, required: true, unique: true }) capability!: string;
  @Prop({ type: String, required: true, index: true }) providerId!: string;
  @Prop({ type: Number, required: true, min: 1 }) contractVersion!: number;
  @Prop({ type: String, required: true }) unit!: string;
  @Prop({ type: Number, required: true, min: 1 }) maxCallsPerInvocation!: number;
  @Prop({ type: String, required: true }) executionKind!: string;
  @Prop({ type: Object }) route?: Record<string, unknown>;
  @Prop({ type: Number, required: true, min: 1 }) maxRequestBytes!: number;
  @Prop({ type: Number, required: true, min: 1 }) maxResponseBytes!: number;
}

export type BrokerBuiltinOperationDocument = HydratedDocument<BrokerBuiltinOperation>;
export const BrokerBuiltinOperationSchema = SchemaFactory.createForClass(BrokerBuiltinOperation);
