import { readFile } from 'node:fs/promises';
import { demoTenants, OpsError, options, run, transaction } from './postgres.mjs';
import { fixtureTables } from './tenant-archive.mjs';

run(async () => {
  const usage = 'Usage: node ops/demo-reset.mjs (--dry-run | --apply)';
  const args = options(usage, { apply: 'boolean' });
  if (Boolean(args.apply) === Boolean(args['dry-run'])) throw new OpsError(usage);
  if (args['dry-run']) {
    console.log(
      JSON.stringify({
        operation: 'reseed_demo_fixtures',
        tenants: demoTenants,
        tables: fixtureTables,
      }),
    );
    return;
  }
  const seed = await readFile(
    new URL('../packages/contracts/fixtures/seed.sql', import.meta.url),
    'utf8',
  );
  const statements = /^--[^\r\n]*\r?\nBEGIN;\s+([\s\S]*?)\s+COMMIT;\s*$/.exec(seed)?.[1];
  const seedTables = [...(statements ?? '').matchAll(/^TRUNCATE (demo_fixture\.\w+);\r?$/gm)].map(
    (match) => match[1],
  );
  if (
    !statements ||
    seedTables.length !== fixtureTables.length ||
    fixtureTables.some((table) => !seedTables.includes(table))
  ) {
    throw new OpsError('Unexpected fixture seed table list or transaction format.');
  }

  await transaction('BEGIN', async (client) => {
    await client.query('LOCK TABLE ' + fixtureTables.join(', ') + ' IN ACCESS EXCLUSIVE MODE');
    for (const table of fixtureTables) {
      const foreign = await client.query(
        'SELECT 1 FROM ' + table + ' WHERE NOT (tenant_id = ANY($1::text[])) LIMIT 1',
        [demoTenants],
      );
      if (foreign.rowCount) throw new OpsError('The fixture tables contain a non-demo tenant.');
    }
    await client.query(statements);
  });
  console.log('Business fixtures reset. Governance and platform state retained.');
});
