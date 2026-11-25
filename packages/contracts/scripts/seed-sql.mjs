import { readFileSync, writeFileSync } from 'node:fs';

const folder = new URL('../fixtures/', import.meta.url);
const fixtures = JSON.parse(readFileSync(new URL('demo.json', folder), 'utf8'));
const tables = {
  workspaces: ['workspace', (row) => [row.id, row.id]],
  grants: ['actor_grant', (row) => [row.tenantId, row.actor.id]],
  customers: ['customer', (row) => [row.tenantId, row.id]],
  skus: ['sku', (row) => [row.tenantId, row.id]],
  vendors: ['vendor', (row) => [row.tenantId, row.id]],
  orders: ['sales_order', (row) => [row.tenantId, row.id]],
  invoices: ['invoice', (row) => [row.tenantId, row.id]],
  purchaseRequests: ['purchase_request', (row) => [row.tenantId, row.id]],
  entitlements: ['entitlement', (row) => [row.tenantId, row.flag.module + ':' + row.unit]],
};
const quote = (value) => "'" + value.replaceAll("'", "''") + "'";
const statements = [
  '-- Generated from demo.json by pnpm codegen.',
  'BEGIN;',
  'SET LOCAL standard_conforming_strings = on;',
  'CREATE SCHEMA IF NOT EXISTS demo_fixture;',
];
function resetTable(target) {
  statements.push(
    'CREATE TABLE IF NOT EXISTS ' +
      target +
      ' (tenant_id text NOT NULL, id text NOT NULL, payload jsonb NOT NULL, PRIMARY KEY (tenant_id, id));',
    'TRUNCATE ' + target + ';',
  );
}
for (const [key, [table, keyOf]] of Object.entries(tables)) {
  const target = 'demo_fixture.' + table;
  resetTable(target);
  if (fixtures[key].length === 0) continue;
  const rows = fixtures[key].map(
    (row) => '(' + [...keyOf(row), JSON.stringify(row)].map(quote).join(', ') + '::jsonb)',
  );
  statements.push(
    'INSERT INTO ' + target + ' (tenant_id, id, payload) VALUES\n  ' + rows.join(',\n  ') + ';',
  );
}
resetTable('demo_fixture.purchase_order');
statements.push('COMMIT;', '');
const sql = statements.join('\n');
const target = new URL('seed.sql', folder);
if (process.argv.includes('--check')) {
  if (readFileSync(target, 'utf8').replaceAll('\r\n', '\n') !== sql) {
    console.error('fixtures/seed.sql is stale. Run pnpm codegen.');
    process.exitCode = 1;
  }
} else {
  writeFileSync(target, sql);
}
