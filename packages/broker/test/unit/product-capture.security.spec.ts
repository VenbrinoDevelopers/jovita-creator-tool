import assert from 'node:assert/strict';
import { it } from 'vitest';
import { assertPublicPageUrl, isPublicAddress } from '../../src/providers/jovita-product-capture/product-capture.lifecycle.js';

it('product capture rejects private, reserved, and mapped addresses', () => {
  for (const address of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.2', '169.254.169.254', '100.64.0.1', '198.18.0.1', '203.0.113.2', '::1', 'fe80::1', 'fc00::1', '::ffff:127.0.0.1', '2001:db8::1']) {
    assert.equal(isPublicAddress(address), false, address);
  }
  for (const address of ['1.1.1.1', '8.8.8.8', '2606:4700:4700::1111']) assert.equal(isPublicAddress(address), true, address);
});

it('product capture rejects malformed or credentialed URLs before navigation', async () => {
  for (const url of ['http://example.com/', 'https://user:pass@example.com/', 'https://localhost/', 'https://example.local/', 'https://127.0.0.1/', 'https://example.com:8443/']) {
    await assert.rejects(() => assertPublicPageUrl(url), { name: 'BadRequestException' });
  }
});
