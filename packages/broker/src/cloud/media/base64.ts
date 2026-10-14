export function canonicalizeBase64(value: string): string | undefined {
  const normalized = value
    .replace(/^data:[^;]+;base64,/i, '')
    .replace(/\s+/g, '')
    .replace(/-/g, '+')
    .replace(/_/g, '/');

  if (!normalized) return undefined;
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(normalized)) return undefined;
  const pad = normalized.length % 4;
  if (pad === 1) return undefined;
  if (pad === 2) return `${normalized}==`;
  if (pad === 3) return `${normalized}=`;
  return normalized;
}

export function estimateBase64DecodedBytes(value: string): number {
  const normalized = value.replace(/\s+/g, '');
  const len = normalized.length;
  const padding = normalized.endsWith('==') ? 2 : normalized.endsWith('=') ? 1 : 0;
  return Math.floor((len * 3) / 4) - padding;
}
