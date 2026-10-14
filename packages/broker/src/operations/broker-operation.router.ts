import { Injectable, NotImplementedException } from '@nestjs/common';
import type { CapabilityCallInput } from '../cloud/saas-store/capabilities/capability-operation.types.js';
import { BrokerCatalogService } from '../catalog/broker-catalog.service.js';
import { BuiltinOperationEngine } from './builtin-operation.engine.js';

@Injectable()
export class BrokerOperationRouter {
  constructor(private readonly builtins: BuiltinOperationEngine, private readonly catalog: BrokerCatalogService) {}

  async definitions() {
    return [...this.builtins.definitions(), ...await this.catalog.definitions()];
  }

  activationRequirements(capability: string, packId: string, operationId: string) {
    if (this.builtins.has(capability)) return this.builtins.activationRequirements(capability, packId, operationId) ?? null;
    if (this.creatorReference(capability)) return this.catalog.activationRequirements(capability, packId);
    throw this.unknown(capability);
  }

  async estimate(input: Parameters<BuiltinOperationEngine['estimateQuantityForCall']>[0]) {
    if (this.builtins.has(input.capability)) return this.builtins.estimateQuantityForCall(input);
    if (this.creatorReference(input.capability)) return 1;
    throw this.unknown(input.capability);
  }

  invoke(input: CapabilityCallInput) {
    if (this.builtins.has(input.capability)) return this.builtins.invoke(input);
    if (this.creatorReference(input.capability)) return this.catalog.invoke(input);
    throw this.unknown(input.capability);
  }

  private creatorReference(capability: string) {
    return capability.startsWith('creator.') || capability.startsWith('broker.');
  }

  private unknown(capability: string) {
    return new NotImplementedException({ code: 'CAPABILITY_NOT_ALLOWED',
      message: `Broker operation is not registered: ${capability}` });
  }
}
