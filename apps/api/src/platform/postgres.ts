import type { Pool } from 'pg';
import { PostgresPlatformPersistence } from '../../../../packages/core/src/platform/postgres.ts';

/** The app host owns pool configuration and shutdown. */
export function platformPostgres(pool: Pool) {
  return new PostgresPlatformPersistence(pool);
}
