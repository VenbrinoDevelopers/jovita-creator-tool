import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import { BrokerBuiltinOperation, type BrokerBuiltinOperationDocument } from './builtin-operation.schema.js';
import { BrokerCatalogRevision, type BrokerCatalogRevisionDocument } from './builtin-catalog-revision.schema.js';
import { builtinCatalogDigest } from './builtin-catalog-digest.js';
import { BUILTIN_PROVIDER_CATALOG } from './builtin-provider-catalog.js';
import { builtinOperationDefinitions } from '@jovita-ai/provider-catalog';

export type BuiltinOperationDefinition = Readonly<{
  capability: string;
  providerId: string;
  contractVersion: 1;
  unit: 'request' | 'result' | 'token' | 'image' | 'byte' | 'second' | 'provider_credit';
  maxCallsPerInvocation: number;
  executionKind: string;
  route?: Record<string, unknown>;
  maxRequestBytes: number;
  maxResponseBytes: number;
}>;

@Injectable()
export class BuiltinOperationCatalog {
  private operations = new Map<string, BuiltinOperationDefinition>();

  constructor(@InjectModel(BrokerBuiltinOperation.name)
    private readonly model: Model<BrokerBuiltinOperationDocument>,
    @InjectModel(BrokerCatalogRevision.name)
    private readonly revisions: Model<BrokerCatalogRevisionDocument>) {}

  async load(): Promise<readonly BuiltinOperationDefinition[]> {
    const rows = await this.model.find({}).lean();
    if (!rows.length) throw new ServiceUnavailableException('Built-in operation catalog is empty; run the catalog migration');
    const revision = await this.revisions.findOne({ key: 'public-catalog-v1' }).lean();
    if (!revision || revision.count !== rows.length || revision.digest !== builtinCatalogDigest(rows)
      || revision.digest !== builtinCatalogDigest(builtinOperationDefinitions)) {
      throw new ServiceUnavailableException('Built-in operation catalog is incomplete or has changed since migration');
    }
    const next = new Map<string, BuiltinOperationDefinition>();
    for (const row of rows) {
      const definition = this.validate(row);
      if (next.has(definition.capability)) throw new Error(`Duplicate built-in operation: ${definition.capability}`);
      next.set(definition.capability, Object.freeze(definition));
    }
    this.operations = next;
    return this.all();
  }

  all(): readonly BuiltinOperationDefinition[] { return [...this.operations.values()]; }
  find(capability: string): BuiltinOperationDefinition | undefined { return this.operations.get(capability); }
  forProvider(providerId: string): readonly BuiltinOperationDefinition[] {
    return this.all().filter(item => item.providerId === providerId);
  }

  private validate(row: BrokerBuiltinOperation): BuiltinOperationDefinition {
    const { capability, providerId, contractVersion, unit, maxCallsPerInvocation,
      executionKind, route, maxRequestBytes, maxResponseBytes } = row;
    if (!/^[a-z][a-z0-9._-]{2,127}$/.test(capability)
      || !/^[a-z][a-z0-9-]{1,63}$/.test(providerId)
      || contractVersion !== 1
      || !['request', 'result', 'token', 'image', 'byte', 'second', 'provider_credit'].includes(unit)
      || !Number.isSafeInteger(maxCallsPerInvocation) || maxCallsPerInvocation < 1
      || !['lifecycle', 'http-json', 'http-sse', 'http-multipart'].includes(executionKind)
      || !Number.isSafeInteger(maxRequestBytes) || maxRequestBytes < 1
      || !Number.isSafeInteger(maxResponseBytes) || maxResponseBytes < 1) {
      throw new Error(`Invalid built-in operation catalog row: ${String(capability)}`);
    }
    if (executionKind !== 'lifecycle' && (!route || typeof route !== 'object')) {
      throw new Error(`Built-in operation has no route: ${capability}`);
    }
    if (executionKind !== 'lifecycle') {
      if (!['GET', 'POST'].includes(String(route?.method)) || typeof route?.path !== 'string'
        || !/^(?:\/?[a-zA-Z0-9._:-]+)(?:\/(?:[a-zA-Z0-9._:-]+|\{model\}))*$/.test(route.path)
        || route.path.includes('..') || route.path.includes('://')) {
        throw new Error(`Invalid approved HTTP route: ${capability}`);
      }
    }
    if (executionKind === 'http-multipart') {
      const profile = BUILTIN_PROVIDER_CATALOG.find(item => item.profileId === providerId);
      if (!profile?.baseUrl || !['bearer', 'header'].includes(profile.authMethod)
        || !['environment', 'pack'].includes(String(route?.credentialScope))
        || (route?.baseUrl !== undefined && (typeof route.baseUrl !== 'string'
          || !URL.canParse(route.baseUrl) || new URL(route.baseUrl).origin !== new URL(profile.baseUrl).origin))
        || (route?.requestLimitBytes !== undefined && (!Number.isSafeInteger(route.requestLimitBytes)
          || Number(route.requestLimitBytes) < maxRequestBytes || Number(route.requestLimitBytes) > 8_000_000))) {
        throw new Error(`Invalid external execution settings: ${capability}`);
      }
      if (executionKind === 'http-multipart' && (route?.mediaPreset !== 'transparent-png-v1'
        || !Number.isSafeInteger(route.evidenceCostMicros) || Number(route.evidenceCostMicros) < 0)) {
        throw new Error(`Invalid media preset or evidence cost: ${capability}`);
      }
    }
    return { capability, providerId, contractVersion: 1, unit: unit as BuiltinOperationDefinition['unit'],
      maxCallsPerInvocation, executionKind, route, maxRequestBytes, maxResponseBytes };
  }
}
