import assert from 'node:assert/strict';
import { test } from 'node:test';
import { builtinOperationDefinitions, builtinReferences, findCatalogOperation,
  providerCatalog, resolveCatalogReference } from '../dist/index.js';

test('reviewed built-ins have SDK names and unique broker references', () => {
  assert.equal(providerCatalog.schemaVersion, 1);
  const sdkReferences = Object.values(builtinReferences).flatMap(provider => Object.values(provider));
  assert.equal(sdkReferences.length, 43);
  assert.equal(new Set(sdkReferences).size, sdkReferences.length);
  assert.equal(builtinOperationDefinitions.length, 44);
  assert.equal(new Set(builtinOperationDefinitions.map(row => row.capability)).size, 44);
  for (const reference of sdkReferences) assert.ok(findCatalogOperation(reference));
  assert.equal(builtinReferences.monid, undefined);
  assert.equal(providerCatalog.providers.some(provider => provider.id === 'monid'), false);
  assert.equal(findCatalogOperation('monid.apollo.companies.search'), undefined);
  assert.equal(builtinReferences.googlePlaces, undefined);
  assert.equal(builtinReferences.serper, undefined);
  assert.equal(findCatalogOperation('google.places.text_search'), undefined);
  assert.equal(findCatalogOperation('serper.maps.search'), undefined);
  assert.equal(builtinReferences.cloudflare.captureProduct, 'cloudflare.browser.capture_product.v1');
  assert.equal(resolveCatalogReference('jovita.product.capture'), builtinReferences.cloudflare.captureProduct);
  assert.equal(builtinOperationDefinitions.find(row => row.capability === 'jovita.product.capture')?.providerId,
    'jovita-product-capture');
});
