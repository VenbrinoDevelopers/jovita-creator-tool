import { createHash, createPrivateKey, createPublicKey, sign as signBuffer, verify as verifyBuffer } from 'node:crypto';
import { readFileSync } from 'node:fs';

export function signChecksum(checksum: string): string {
  const keyPem = readSigningPrivateKeyPem();
  const privateKey = createPrivateKey(keyPem);
  const payload = Buffer.from(normalizeChecksumHex(checksum), 'utf-8');
  return signBuffer(null, payload, privateKey).toString('base64');
}

export function computeChecksum(data: Buffer): string {
  return `sha256:${createHash('sha256').update(data).digest('hex')}`;
}

export function verifyChecksumSignature(checksum: string, signature: string, publicKeyPem: string): boolean {
  const key = createPublicKey(publicKeyPem);
  const payload = Buffer.from(normalizeChecksumHex(checksum), 'utf-8');
  const signatureBytes = Buffer.from(String(signature ?? '').trim(), 'base64');
  if (signatureBytes.length === 0) {
    return false;
  }
  return verifyBuffer(null, payload, key, signatureBytes) || verifyBuffer('sha256', payload, key, signatureBytes);
}

export function readSigningPrivateKeyPem(): string {
  const filePath = String(process.env.SERVICE_SIGNING_PRIVATE_KEY_FILE ?? '').trim();
  if (filePath) return readFileSync(filePath, 'utf-8').trim();
  const inline = String(process.env.SERVICE_SIGNING_PRIVATE_KEY ?? '').replace(/\\n/g, '\n').trim();
  if (!inline) throw new Error('SERVICE_SIGNING_PRIVATE_KEY_FILE or SERVICE_SIGNING_PRIVATE_KEY is required');
  return inline;
}

export function readVerificationPublicKeyPem(): string {
  const primaryPath = String(process.env.JOVITA_SAAS_MANIFEST_PUBLIC_KEY_FILE ?? '').trim();
  if (primaryPath) return readFileSync(primaryPath, 'utf-8').trim();
  const fallbackPath = String(process.env.SERVICE_SIGNING_PUBLIC_KEY_FILE ?? '').trim();
  if (fallbackPath) return readFileSync(fallbackPath, 'utf-8').trim();
  const inline = String(process.env.JOVITA_SAAS_MANIFEST_PUBLIC_KEY ?? '').replace(/\\n/g, '\n').trim();
  if (inline) return inline;
  throw new Error('JOVITA_SAAS_MANIFEST_PUBLIC_KEY_FILE, SERVICE_SIGNING_PUBLIC_KEY_FILE, or JOVITA_SAAS_MANIFEST_PUBLIC_KEY is required');
}

function normalizeChecksumHex(value: string): string {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (!normalized.startsWith('sha256:')) {
    throw new Error('Checksum must be in sha256:<hex> format');
  }
  const hex = normalized.slice('sha256:'.length).trim();
  if (!/^[a-f0-9]{64}$/.test(hex)) {
    throw new Error('Checksum hex is invalid');
  }
  return hex;
}
