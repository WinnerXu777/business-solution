import type { Notice } from '../data.tsx';
import type { PlatformClient, PlatformIdentity } from '../platform-client.ts';

export interface ScreenProps {
  client: PlatformClient;
  me: PlatformIdentity;
  notify: Notice;
}

export function formatDate(value: string) {
  return value.slice(0, 10);
}
