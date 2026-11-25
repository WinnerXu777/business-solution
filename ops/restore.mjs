import { resolve } from 'node:path';
import { OpsError, options, postgresTool, run, tenantId } from './postgres.mjs';
import { archiveTables, restoreTenant } from './tenant-archive.mjs';

run(async () => {
  const usage =
    'Usage: node ops/restore.mjs --file <path> [--tenant <fixture-id>] (--dry-run | --apply)';
  const args = options(usage, { file: 'string', tenant: 'string', apply: 'boolean' });
  if (!args.file || Boolean(args.apply) === Boolean(args['dry-run'])) throw new OpsError(usage);
  const file = resolve(args.file);
  const tenant = args.tenant === undefined ? undefined : tenantId(args.tenant);
  const flags = [
    '--no-password',
    '--no-owner',
    '--no-acl',
    '--exit-on-error',
    '--single-transaction',
  ];
  if (args['dry-run']) {
    console.log(
      JSON.stringify(
        tenant
          ? { operation: 'restore_tenant', tenant, file, tables: archiveTables }
          : {
              operation: 'restore',
              command: 'pg_restore',
              args: [...flags, '--dbname', '<PGDATABASE>', file],
            },
      ),
    );
    return;
  }
  if (tenant) await restoreTenant(file, tenant);
  else postgresTool('pg_restore', [...flags, '--dbname', process.env.PGDATABASE ?? '', file]);
  console.log('Restore committed.');
});
