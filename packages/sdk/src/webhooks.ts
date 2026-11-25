import { createHmac, timingSafeEqual } from 'node:crypto';

export function verifyWebhookSignature(
  rawBody: string | Uint8Array,
  headers: HeadersInit,
  secret: string | Uint8Array,
  options: { nowSeconds?: number; toleranceSeconds?: number } = {},
): boolean {
  const values = new Headers(headers);
  const stamp = values.get('x-connector-timestamp') ?? '';
  const signature = values.get('x-connector-signature') ?? '';
  const now = options.nowSeconds ?? Date.now() / 1000;
  const tolerance = options.toleranceSeconds ?? 300;
  if (
    !/^\d{1,12}$/.test(stamp) ||
    !/^[0-9a-f]{64}$/i.test(signature) ||
    !secret.length ||
    !Number.isFinite(now) ||
    !Number.isFinite(tolerance) ||
    tolerance < 0 ||
    Math.abs(now - Number(stamp)) > tolerance
  )
    return false;
  const expected = createHmac('sha256', secret)
    .update(stamp + '.')
    .update(rawBody)
    .digest();
  return timingSafeEqual(expected, Buffer.from(signature, 'hex'));
}
