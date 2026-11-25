import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';

const directory = new URL('../infra/migrations/', import.meta.url);

export async function expectedMigrations() {
  const files = (await readdir(directory))
    .filter((name) => /^\d{3}_[a-z_]+\.sql$/.test(name))
    .sort();
  return Promise.all(
    files.map(async (name, index) => {
      if (Number(name.slice(0, 3)) !== index + 1) throw new Error('Unexpected migration sequence');
      const sql = (await readFile(new URL(name, directory), 'utf8')).replaceAll('\r\n', '\n');
      return { name, checksum: createHash('sha256').update(sql).digest('hex') };
    }),
  );
}

export async function migrationStatus(client, expected) {
  const {
    rows: [ledger],
  } = await client.query("SELECT to_regclass('governance.migration') AS name");
  const rows = ledger.name
    ? (await client.query('SELECT name, checksum FROM governance.migration ORDER BY name')).rows
    : [];
  const expectedByName = new Map(expected.map(({ name, checksum }) => [name, checksum]));
  const applied = new Map(rows.map(({ name, checksum }) => [name, checksum]));
  const pending = expected.filter(({ name }) => !applied.has(name)).map(({ name }) => name);
  const changed = rows
    .filter(
      ({ name, checksum }) => expectedByName.has(name) && expectedByName.get(name) !== checksum,
    )
    .map(({ name }) => name);
  const unexpected = rows.filter(({ name }) => !expectedByName.has(name)).map(({ name }) => name);
  return {
    current: Boolean(ledger.name) && pending.length + changed.length + unexpected.length === 0,
    pending,
    changed,
    unexpectedCount: unexpected.length,
  };
}
