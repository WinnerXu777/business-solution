# Postgres restore drill

Use an isolated local Postgres instance with synthetic data. Set `PGHOST`, `PGPORT`, `PGUSER` and `PGDATABASE` for the selected instance. Use a private libpq password file or supply the local fixture password via the process environment. Keep archives out of Git and store them in an access-controlled encrypted location. Use Postgres client tools compatible with the demo server. The destination directory must already exist.

1. Point `PGDATABASE` at the source. Check migrations and export a full database archive and, separately, a tenant archive.

   ```sh
   node ops/migration-status.mjs
   node ops/backup.mjs --file ./demo.dump
   node ops/backup.mjs --file ./rivetquay.json --tenant tenant-rivetquay
   ```

2. Change `PGDATABASE` to a freshly created, empty scratch database. Keep the API and dispatch worker disconnected from it. Preview and apply the full restore.

   ```sh
   node ops/restore.mjs --file ./demo.dump --dry-run
   node ops/restore.mjs --file ./demo.dump --apply
   node ops/migration-status.mjs
   ```

3. For a tenant drill, use a second scratch database. Apply the same repository migrations and provision the empty `demo_fixture` tables with a schema-only export from the source. The target must have no data for the selected tenant in archive tables. Point `PGDATABASE` to that scratch database.

   ```sh
   node ops/restore.mjs --file ./rivetquay.json --tenant tenant-rivetquay --dry-run
   node ops/restore.mjs --file ./rivetquay.json --tenant tenant-rivetquay --apply
   ```

4. Compare expected fixture row counts, verify `ord-001`, check append-only audit chain continuity, and inspect held outbox rows before starting any worker. For the tenant archive, verify Spoolharbour rows were excluded and that a second restore rejects existing Rivetquay rows.
5. Record the backup timestamp, migration status, restore start and finish time, integrity checks and any differences. Retire the scratch database and archives according to the fixture retention decision.

A full archive covers the selected database. Tenant archives cover the milestone's `demo_fixture`, `governance` and `platform` tenant tables under a consistent snapshot. Vault keys, Mailpit state and worker files are managed separately. The tenant restore verifies migration checksums and the allowlisted schema, requires an empty tenant scope and commits the imported rows together. Review encrypted credential records and outbox state before connecting any worker to a restored database.

To reseed an existing isolated fixture database, stop the API and worker, run `node ops/demo-reset.mjs --dry-run`, then apply with `node ops/demo-reset.mjs --apply`. This resets the demo business tables and preserves governance and platform records. For a fresh approval, audit and usage history, provision a new demo database. All four operations support dry-run without a database connection.
