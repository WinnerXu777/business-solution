import { resolve } from 'node:path';
import { publishArchive } from './archive-file.mjs';
import { checkTarget, OpsError, options, postgresTool, run, tenantId } from './postgres.mjs';
import { archiveTables, exportTenant } from './tenant-archive.mjs';

run(async () => {
  const usage = 'Usage: node ops/backup.mjs --file <path> [--tenant <fixture-id>] [--dry-run]';
  const args = options(usage, { file: 'string', tenant: 'string' });
  if (!args.file) throw new OpsError(usage);
  const file = resolve(args.file);
  const tenant = args.tenant === undefined ? undefined : tenantId(args.tenant);
  const flags = ['--format=custom', '--no-password', '--no-owner', '--no-acl'];
  if (args['dry-run']) {
    console.log(
      JSON.stringify(
        tenant
          ? { operation: 'export_tenant', tenant, file, tables: archiveTables }
          : { operation: 'backup', command: 'pg_dump', args: [...flags, '--file', file] },
      ),
    );
    return;
  }
  checkTarget();
  if (tenant) {
    await exportTenant(file, tenant);
  } else {
    await publishArchive(file, (archive) => postgresTool('pg_dump', [...flags, '--file', archive]));
  }
  console.log('Backup written.');
});
