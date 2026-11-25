import { PlatformError } from './audit.ts';

export const dayMs = 86_400_000;

export function instant(value: string) {
  const time = Date.parse(value);
  if (!Number.isFinite(time)) throw new PlatformError('forbidden', 'Invalid timestamp.');
  return time;
}

export function iso(time: number) {
  return new Date(time).toISOString();
}
