import { readFile, writeFile } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';
import { publishArchive } from './archive-file.mjs';
import { expectedMigrations, migrationStatus } from './migrations.mjs';
import { OpsError, transaction } from './postgres.mjs';

const format = 'rivetquay-demo-tenant-v1';
const payload = ['id', 'payload'];
export const fixtureTables = [
  'workspace',
  'actor_grant',
  'customer',
  'sku',
  'vendor',
  'sales_order',
  'invoice',
  'purchase_request',
  'entitlement',
  'purchase_order',
].map((table) => 'demo_fixture.' + table);

const tables = new Map([
  ...fixtureTables.map((table) => [table, payload]),
  ['governance.audit', ['sequence', 'payload']],
  ['governance.approval', payload],
  ['governance.artifact', payload],
  ['governance.intent', payload],
  ['governance.outbox', payload],
  ['governance.outcome', payload],
  ['governance.usage', payload],
  ['governance.billing_event', payload],
  ['platform.tenant_state', ['collection', 'id', 'body']],
]);
export const archiveTables = Object.freeze([...tables.keys()]);

async function verifySchema(client, expected) {
  const status = await migrationStatus(client, expected);
  if (!status.current)
    throw new OpsError('Apply the repository migrations before using a tenant archive.');
  const { rows } = await client.query(
    "SELECT table_schema, table_name, column_name FROM information_schema.columns WHERE table_schema IN ('demo_fixture', 'governance', 'platform') AND NOT (table_schema = 'governance' AND table_name = 'migration')",
  );
  const expectedColumns = archiveTables.flatMap((table) =>
    ['tenant_id', ...tables.get(table)].map((column) => table + '.' + column),
  );
  const actual = rows.map(({ table_schema, table_name, column_name }) =>
    [table_schema, table_name, column_name].join('.'),
  );
  if (!isDeepStrictEqual(actual.sort(), expectedColumns.sort())) {
    throw new OpsError('The tenant archive table list or columns differ from the demo schema.');
  }
}

export async function exportTenant(file, tenant) {
  const migrations = await expectedMigrations();
  const data = await transaction(
    'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY',
    async (client) => {
      await verifySchema(client, migrations);
      const contents = [];
      for (const [table, columns] of tables) {
        const order = columns
          .slice(0, -1)
          .map((column) => table + '.' + column)
          .join(', ');
        const fields = columns.map((column) => column + '::text AS ' + column).join(', ');
        const result = await client.query(
          'SELECT ' + fields + ' FROM ' + table + ' WHERE tenant_id = $1 ORDER BY ' + order,
          [tenant],
        );
        contents.push({ table, rows: result.rows });
      }
      if (contents[0].rows.length !== 1)
        throw new OpsError('Fixture tenant is missing from the workspace table.');
      return contents;
    },
  );
  await publishArchive(file, (archive) =>
    writeFile(archive, JSON.stringify({ format, tenant, migrations, data }) + '\n', {
      flag: 'wx',
      mode: 0o600,
    }),
  );
}

export async function restoreTenant(file, tenant) {
  const archive = JSON.parse(await readFile(file, 'utf8'));
  const migrations = await expectedMigrations();
  if (
    archive?.format !== format ||
    archive.tenant !== tenant ||
    !isDeepStrictEqual(archive.migrations, migrations) ||
    !Array.isArray(archive.data) ||
    !isDeepStrictEqual(
      archive.data.map((entry) => entry.table),
      archiveTables,
    ) ||
    archive.data[0].rows?.length !== 1 ||
    archive.data[0].rows[0]?.id !== tenant
  )
    throw new OpsError('Tenant archive does not match the requested fixture tenant or schema.');

  await transaction('BEGIN', async (client) => {
    await verifySchema(client, migrations);
    await client.query('LOCK TABLE ' + archiveTables.join(', ') + ' IN SHARE ROW EXCLUSIVE MODE');
    for (const { table } of archive.data) {
      const existing = await client.query(
        'SELECT 1 FROM ' + table + ' WHERE tenant_id = $1 LIMIT 1',
        [tenant],
      );
      if (existing.rowCount)
        throw new OpsError('The restore target already contains rows for this tenant.');
    }
    for (const { table, rows } of archive.data) {
      const columns = tables.get(table);
      if (
        !Array.isArray(rows) ||
        rows.some(
          (row) =>
            !row ||
            Object.keys(row).length !== columns.length ||
            columns.some(
              (column) => !Object.hasOwn(row, column) || typeof row[column] !== 'string',
            ),
        )
      )
        throw new OpsError('Tenant archive contains an invalid row.');
      const fields = ['tenant_id', ...columns].join(', ');
      const placeholders = ['tenant_id', ...columns]
        .map((_, index) => '$' + (index + 1))
        .join(', ');
      for (const row of rows) {
        await client.query(
          'INSERT INTO ' + table + ' (' + fields + ') VALUES (' + placeholders + ')',
          [tenant, ...columns.map((column) => row[column])],
        );
      }
    }
  });
}
