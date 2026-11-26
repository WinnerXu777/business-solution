import { createHash, randomBytes } from 'node:crypto';

export function randomToken() {
  return randomBytes(32).toString('base64url');
}

export function tokenDigest(value: string) {
  return createHash('sha256').update(value).digest('base64url');
}

export function decodeBase64Url(value: string) {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('Invalid base64url.');
  const data = Buffer.from(value, 'base64url');
  if (data.toString('base64url') !== value) throw new Error('Invalid base64url.');
  return data;
}

export function jsonObject(encoded: string): Record<string, unknown> {
  const value: unknown = JSON.parse(decodeBase64Url(encoded).toString('utf8'));
  if (!isObject(value)) throw new Error('Invalid JSON object.');
  return value;
}

export function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** The tenant is a routing hint. The full token digest must match a row in that tenant. */
export function routedToken(tenantId: string) {
  return Buffer.from(tenantId).toString('base64url') + '.' + randomToken();
}

export function tokenTenant(token: string) {
  const match = /^([A-Za-z0-9_-]{2,171})\.[A-Za-z0-9_-]{43}$/.exec(token);
  if (!match) return;
  try {
    const tenant = decodeBase64Url(match[1]).toString('utf8');
    if (/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(tenant)) return tenant;
  } catch {
    return;
  }
}
