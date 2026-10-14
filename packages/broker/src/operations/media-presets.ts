import { BadGatewayException, BadRequestException } from '@nestjs/common';
import sharp from 'sharp';

export type MediaPreset = 'transparent-png-v1';
const MAX_INPUT_BYTES = 5 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 7 * 1024 * 1024;
const MAX_PIXELS = 16_000_000;

export async function prepareMediaRequest(preset: MediaPreset, input: Record<string, unknown>): Promise<Record<string, unknown>> {
  if (preset !== 'transparent-png-v1') throw new BadRequestException('Unknown media preset');
  if (Object.keys(input).some(key => key !== 'image')) throw new BadRequestException('Unsupported image input');
  const value = input.image;
  if (typeof value !== 'string') throw new BadRequestException('Image must be a base64 data URL');
  const match = /^data:image\/(png|jpeg|jpg|webp);base64,([a-z0-9+/=\s]+)$/i.exec(value);
  if (!match) throw new BadRequestException('Image must be a PNG, JPEG, or WebP data URL');
  const bytes = decodeBase64(match[2]!, 'Input image');
  if (bytes.length < 1 || bytes.length > MAX_INPUT_BYTES) throw new BadRequestException('Input image must be 1 byte to 5 MB');
  let metadata;
  try { metadata = await sharp(bytes, { limitInputPixels: MAX_PIXELS, failOn: 'error' }).metadata(); }
  catch { throw new BadRequestException('Image is malformed or exceeds 16 MP'); }
  if (!metadata.width || !metadata.height || metadata.width < 256 || metadata.height < 256
    || metadata.width > 4096 || metadata.height > 4096
    || !['png', 'jpeg', 'webp'].includes(String(metadata.format))) {
    throw new BadRequestException('Image must be PNG, JPEG, or WebP from 256 to 4096 pixels per side');
  }
  const mediaType = match[1]!.toLowerCase() === 'jpg' ? 'image/jpeg' : `image/${match[1]!.toLowerCase()}`;
  return { response_format: 'b64_json', file: { dataBase64: bytes.toString('base64'),
    filename: `source.${mediaType === 'image/jpeg' ? 'jpg' : mediaType.slice(6)}`, contentType: mediaType } };
}

export async function extractMediaResult(preset: MediaPreset, value: unknown): Promise<{ b64_json: string; media_type: 'image/png' }> {
  if (preset !== 'transparent-png-v1') throw new BadRequestException('Unknown media preset');
  const body = record(value);
  const image = record(body.image);
  const first = record(Array.isArray(body.data) ? body.data[0] : undefined);
  const encoded = image.b64_json ?? image.image ?? first.b64_json ?? first.image ?? body.b64_json;
  if (typeof encoded !== 'string' || !encoded.trim()) throw new BadGatewayException('Provider returned no inline image');
  const bytes = decodeBase64(encoded, 'Provider image');
  if (bytes.length > MAX_OUTPUT_BYTES) throw new BadGatewayException('Provider image exceeds 7 MB');
  try {
    const imageFile = sharp(bytes, { limitInputPixels: MAX_PIXELS, failOn: 'error' });
    const metadata = await imageFile.metadata();
    if (metadata.format !== 'png' || !metadata.hasAlpha) throw new Error('missing PNG alpha');
    const alpha = (await imageFile.stats()).channels[3];
    if (!alpha || alpha.min >= 255) throw new Error('opaque PNG');
  } catch { throw new BadGatewayException('Provider image lacks genuine PNG transparency'); }
  return { b64_json: bytes.toString('base64'), media_type: 'image/png' };
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function decodeBase64(value: string, label: string): Buffer {
  const normalized = value.replace(/\s+/g, '');
  if (!normalized || !/^[a-z0-9+/]+={0,2}$/i.test(normalized)) throw new BadRequestException(`${label} is not valid base64`);
  return Buffer.from(normalized, 'base64');
}
