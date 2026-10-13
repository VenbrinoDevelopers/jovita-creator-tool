import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { clearRemoteImageUrls, prepareToolResultForModel, toOpenAIChatImage, toOpenAIResponsesImage, validateArtifactForModel } from './artifacts.js';
import type { EphemeralArtifactReference } from '../types.js';

const bytes = Buffer.from('real-image-pixels');
const artifact: EphemeralArtifactReference = {
  id: 'artifact_opaque_123', kind: 'image', transport: 'signed_url', url: 'https://artifacts.usejovita.com/image?token=secret',
  mime_type: 'image/webp', size: bytes.byteLength, sha256: createHash('sha256').update(bytes).digest('hex'), width: 1200, height: 900,
  expires_at: new Date(Date.now() + 10 * 60_000).toISOString(), purpose: 'visual_inspection', label: 'Candidate', persistence: 'transient',
};
const policy = {
  artifactHostname: 'artifacts.usejovita.com', authorize: (id: string) => id === artifact.id,
  fetch: async () => new Response(bytes, { status: 200, headers: { 'content-type': 'image/webp' } }),
};

test('validates native image artifacts and maps both provider APIs', async () => {
  const image = await validateArtifactForModel(artifact, policy);
  assert.equal(toOpenAIChatImage(image).type, 'image_url');
  assert.equal(toOpenAIResponsesImage(image).type, 'input_image');
});

test('text-only results remain compatible and persistence omits signed URLs', async () => {
  const textOnly = await prepareToolResultForModel({ result: { text: 'done', details: { count: 1 } }, policy, supportsImages: false });
  assert.deepEqual(textOnly, { text: 'done', details: { count: 1 }, images: [], provenance: [] });
  const prepared = await prepareToolResultForModel({ result: { text: 'inspect', details: { signed: artifact.url, production: 'https://example.com/' }, artifacts: [artifact] }, policy, supportsImages: true });
  assert.equal(prepared.images.length, 1);
  assert.doesNotMatch(JSON.stringify(prepared.provenance), /token=secret|https:\/\//);
  assert.equal(prepared.details?.signed, '[transient artifact URL removed]');
  assert.equal(prepared.details?.production, 'https://example.com/');
  clearRemoteImageUrls(prepared.images);
  assert.equal(prepared.images[0].url, '', 'signed URLs can be removed immediately after the provider request');
});

test('rejects unsupported models, cross-tenant IDs, redirects, expiry, and altered bytes', async () => {
  await assert.rejects(() => prepareToolResultForModel({ result: { text: 'inspect', artifacts: [artifact] }, policy, supportsImages: false }), /AGENT_REMOTE_IMAGE_UNSUPPORTED/);
  await assert.rejects(() => validateArtifactForModel(artifact, { ...policy, authorize: () => false }), /VISUAL_ARTIFACT_INVALID/);
  await assert.rejects(() => validateArtifactForModel(artifact, { ...policy, fetch: async () => new Response(null, { status: 302, headers: { location: 'https://evil.invalid' } }) }), /VISUAL_ARTIFACT_INVALID/);
  await assert.rejects(() => validateArtifactForModel({ ...artifact, expires_at: new Date(Date.now() + 30_000).toISOString() }, policy), /VISUAL_ARTIFACT_INVALID/);
  await assert.rejects(() => validateArtifactForModel(artifact, { ...policy, fetch: async () => new Response(Buffer.from('altered'), { headers: { 'content-type': 'image/webp' } }) }), /VISUAL_ARTIFACT_INVALID/);
  await assert.rejects(() => validateArtifactForModel(artifact, { ...policy, artifactHostname: '' }), /VISUAL_ARTIFACT_INVALID/);
  const oversized = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(artifact.size));
      controller.enqueue(new Uint8Array(1));
      controller.close();
    },
  });
  await assert.rejects(() => validateArtifactForModel(artifact, { ...policy, fetch: async () => new Response(oversized, { headers: { 'content-type': 'image/webp' } }) }), /VISUAL_ARTIFACT_INVALID/);
});
