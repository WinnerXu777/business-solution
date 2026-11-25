import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

function run(script, ...args) {
  return spawnSync(process.execPath, [fileURLToPath(new URL(script, import.meta.url)), ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PGHOST: 'invalid.invalid',
      PGDATABASE: '',
      PGPASSWORD: 'fixture-secret',
    },
  });
}

function dry(script, ...args) {
  const result = run(script, ...args, '--dry-run');
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stdout + result.stderr, /fixture-secret|invalid\.invalid/);
  return JSON.parse(result.stdout);
}

test('full and tenant archive plans need no database or archive files', () => {
  const file = join(tmpdir(), randomUUID() + ' missing archive');
  assert.equal(dry('backup.mjs', '--file', file).command, 'pg_dump');
  const restore = dry('restore.mjs', '--file', file);
  assert.equal(restore.command, 'pg_restore');
  assert.ok(restore.args.includes('--single-transaction'));
  const args = ['--file', file, '--tenant', 'tenant-rivetquay'];
  const exported = dry('backup.mjs', ...args);
  const imported = dry('restore.mjs', ...args);
  assert.equal(exported.operation, 'export_tenant');
  assert.equal(imported.operation, 'restore_tenant');
  assert.deepEqual(exported.tables, imported.tables);
  assert.equal(exported.tenant, 'tenant-rivetquay');
  assert.equal(existsSync(file), false);
});

test('migration and reset plans verify local schema intentions', () => {
  const migrations = dry('migration-status.mjs').expected;
  assert.match(migrations[0].name, /^001_/);
  assert.ok(migrations.every(({ checksum }) => /^[0-9a-f]{64}$/.test(checksum)));
  const reset = dry('demo-reset.mjs');
  assert.equal(reset.operation, 'reseed_demo_fixtures');
  assert.ok(reset.tables.every((table) => table.startsWith('demo_fixture.')));
  assert.equal(run('restore.mjs', '--file', 'archive').status, 1);
  assert.equal(
    run('restore.mjs', '--file', 'archive', '--tenant', "tenant'bad", '--dry-run').status,
    1,
  );
  assert.equal(run('demo-reset.mjs').status, 1);
});
