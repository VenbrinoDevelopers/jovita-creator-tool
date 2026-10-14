import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import type { HydratedDocument } from 'mongoose';

@Schema({ collection: 'broker_catalog_revisions' })
export class BrokerCatalogRevision {
  @Prop({ type: String, required: true, unique: true }) key!: string;
  @Prop({ type: Number, required: true, min: 1 }) count!: number;
  @Prop({ type: String, required: true }) digest!: string;
}
export type BrokerCatalogRevisionDocument = HydratedDocument<BrokerCatalogRevision>;
export const BrokerCatalogRevisionSchema = SchemaFactory.createForClass(BrokerCatalogRevision);
