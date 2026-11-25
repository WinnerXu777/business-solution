import { expectedMigrations, migrationStatus } from './migrations.mjs';
import { options, run, transaction } from './postgres.mjs';

run(async () => {
  const args = options('Usage: node ops/migration-status.mjs [--dry-run]', {});
  const expected = await expectedMigrations();
  if (args['dry-run']) {
    console.log(JSON.stringify({ operation: 'compare_read_only_migration_ledger', expected }));
    return;
  }
  const status = await transaction('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY', (client) =>
    migrationStatus(client, expected),
  );
  console.log(JSON.stringify(status));
  if (!status.current) process.exitCode = 1;
});
