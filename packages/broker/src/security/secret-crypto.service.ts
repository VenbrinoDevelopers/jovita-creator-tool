import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

const ENCRYPTION_PREFIX = 'enc:v1';
const ALGORITHM = 'aes-256-gcm';

@Injectable()
export class SecretCryptoService {
  encrypt(plaintext: string): string {
    const normalized = String(plaintext ?? '');
    if (!normalized) return '';

    const iv = randomBytes(12);
    const cipher = createCipheriv(ALGORITHM, this.key(), iv);
    const ciphertext = Buffer.concat([cipher.update(normalized, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `${ENCRYPTION_PREFIX}:${iv.toString('base64')}:${tag.toString('base64')}:${ciphertext.toString('base64')}`;
  }

  decrypt(payload: string | undefined): string {
    const normalized = String(payload ?? '').trim();
    if (!normalized) return '';
    if (!normalized.startsWith(`${ENCRYPTION_PREFIX}:`)) {
      throw new ServiceUnavailableException('Invalid encrypted secret payload format');
    }
    const parts = normalized.split(':');
    if (parts.length !== 5) {
      throw new ServiceUnavailableException('Invalid encrypted secret payload shape');
    }

    const iv = Buffer.from(parts[2], 'base64');
    const tag = Buffer.from(parts[3], 'base64');
    const ciphertext = Buffer.from(parts[4], 'base64');

    const decipher = createDecipheriv(ALGORITHM, this.key(), iv);
    decipher.setAuthTag(tag);
    const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return decrypted.toString('utf8');
  }

  private key(): Buffer {
    const raw = String(process.env.JOVITA_DATA_ENCRYPTION_KEY ?? '').trim();
    if (!raw) {
      throw new ServiceUnavailableException('Missing JOVITA_DATA_ENCRYPTION_KEY');
    }
    return createHash('sha256').update(raw, 'utf8').digest();
  }
}
