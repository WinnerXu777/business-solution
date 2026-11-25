import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { parseArgs } from 'node:util';

const require = createRequire(new URL('../apps/api/package.json', import.meta.url));
const { Client } = require('pg');

export class OpsError extends Error {}

const fixtureTenants = ['tenant-rivetquay', 'tenant-spoolharbour'];

export function options(usage, keys) {
  try {
    return parseArgs({
      options: Object.fromEntries([
        ['dry-run', { type: 'boolean' }],
        ...Object.entries(keys).map(([key, type]) => [key, { type }]),
      ]),
    }).values;
  } catch {
    throw new OpsError(usage);
  }
}

export function tenantId(value) {
  if (!fixtureTenants.includes(value)) throw new OpsError('Use a milestone fixture tenant ID.');
  return value;
}

export function run(main) {
  void main().catch((error) => {
    console.error(
      error instanceof OpsError
        ? error.message
        : 'Operation failed. Check local configuration and tool availability.',
    );
    process.exitCode = 1;
  });
}

export function checkTarget() {
  if (!process.env.PGDATABASE || !/^[\w-]+$/.test(process.env.PGDATABASE)) {
    throw new OpsError('Set PGDATABASE to the name of the isolated demo database.');
  }
}

export async function transaction(mode, work) {
  checkTarget();
  const client = new Client({ connectionTimeoutMillis: 5_000, statement_timeout: 30_000 });
  await client.connect();
  try {
    await client.query(mode);
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    await client.end();
  }
}

export function postgresTool(command, args) {
  checkTarget();
  const result = spawnSync(command, args, {
    stdio: 'ignore',
    env: { ...process.env, PGCONNECT_TIMEOUT: '5' },
  });
  if (result.error || result.status !== 0) {
    throw new OpsError(
      command + ' failed. Check the client version, demo target and database permissions.',
    );
  }
}

export const demoTenants = Object.freeze(fixtureTenants);
