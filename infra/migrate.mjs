import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL is required.');

const require = createRequire(new URL('../apps/api/package.json', import.meta.url));
const { Client } = require('pg');
const client = new Client({ connectionString });
const directory = new URL('./migrations/', import.meta.url);
const files = (await readdir(directory)).filter((name) => /^\d{3}_[a-z_]+\.sql$/.test(name)).sort();

await client.connect();
try {
  await client.query('BEGIN');
  await client.query(
    "SELECT pg_advisory_xact_lock(hashtextextended('rivetquay-governance-migrations', 0))",
  );
  await client.query('CREATE SCHEMA IF NOT EXISTS governance');
  await client.query(
    'CREATE TABLE IF NOT EXISTS governance.migration (' +
      'name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())',
  );
  const { rows } = await client.query('SELECT name, checksum FROM governance.migration');
  const applied = new Map(rows.map(({ name, checksum }) => [name, checksum]));
  if (rows.some(({ name }) => !files.includes(name)))
    throw new Error('Applied migration file missing.');
  for (const [index, name] of files.entries()) {
    if (Number(name.slice(0, 3)) !== index + 1)
      throw new Error('Unexpected migration number: ' + name);
    const sql = (await readFile(new URL(name, directory), 'utf8')).replaceAll('\r\n', '\n');
    const checksum = createHash('sha256').update(sql).digest('hex');
    if (applied.has(name)) {
      if (applied.get(name) !== checksum) throw new Error('Applied migration changed: ' + name);
      continue;
    }
    await client.query(sql);
    await client.query('INSERT INTO governance.migration (name, checksum) VALUES ($1, $2)', [
      name,
      checksum,
    ]);
  }
  await client.query('COMMIT');
  console.log('Governance migrations are current.');
} catch (error) {
  await client.query('ROLLBACK');
  throw error;
} finally {
  await client.end();
}
