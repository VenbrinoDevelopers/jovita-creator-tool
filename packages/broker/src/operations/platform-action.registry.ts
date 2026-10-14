import { BadRequestException, Injectable } from '@nestjs/common';
import { VoiceLibraryService } from '../cloud/media/voice-library/voice-library.service.js';
import type { CapabilityCallInput, CapabilityCallResult } from '../cloud/saas-store/capabilities/capability-operation.types.js';

type PlatformHandler = (input: CapabilityCallInput) => Promise<unknown>;

/** Reviewed handlers for Jovita-owned resources. External APIs never register here. */
@Injectable()
export class PlatformActionRegistry {
  private readonly handlers: ReadonlyMap<string, PlatformHandler>;

  constructor(library: VoiceLibraryService) {
    this.handlers = new Map<string, PlatformHandler>([
      ['jovita.voice-library.list', async input => ({ status: 'success', voices: await library.list(input.ownerId) })],
      ['jovita.voice-library.show', input => library.show(input.ownerId, text(input.payload.voice_id))],
      ['jovita.voice-library.rename', input => library.rename(input.ownerId,
        text(input.payload.voice_id), text(input.payload.name))],
      ['jovita.voice-library.delete', input => library.delete(input.ownerId,
        text(input.payload.voice_id), text(input.payload.confirm))],
      ['jovita.voice-library.save', input => library.save(input.ownerId, {
        name: text(input.payload.name),
        referenceAssetIds: stringArray(input.payload.reference_asset_ids),
        referenceTranscript: optionalText(input.payload.reference_transcript),
        consentType: consentType(input.payload.consent_type),
        consentConfirmed: input.payload.consent_confirmed === true,
        consentText: text(input.payload.consent_text),
      })],
    ]);
  }

  has(capability: string): boolean { return this.handlers.has(capability); }

  async invoke(input: CapabilityCallInput): Promise<CapabilityCallResult> {
    const handler = this.handlers.get(input.capability);
    if (!handler) throw new BadRequestException('Unknown platform action');
    return { result: await handler(input), providerCostMicros: 0, quantity: 1 };
  }
}

function text(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 2000) {
    throw new BadRequestException('Invalid Voice Library field');
  }
  return value.trim();
}
function optionalText(value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string' || value.length > 10_000) throw new BadRequestException('Invalid Voice Library field');
  return value.trim();
}
function stringArray(value: unknown): string[] {
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) {
    throw new BadRequestException('Invalid Voice Library assets');
  }
  return value;
}
function consentType(value: unknown): 'self' | 'authorized' {
  if (value !== 'self' && value !== 'authorized') throw new BadRequestException('Invalid Voice Library consent type');
  return value;
}
