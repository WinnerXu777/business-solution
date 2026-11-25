import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const seed = readFileSync(new URL('../packages/contracts/fixtures/seed.sql', import.meta.url));
const cli = process.argv.slice(2);
if (cli.length > 0 && (cli.length !== 2 || cli[0] !== '--env-file')) {
  throw new Error('Usage is pnpm reset-fixtures [--env-file path]');
}
const command = process.platform === 'win32' ? 'docker.exe' : 'docker';
const args = [
  'compose',
  '-f',
  'infra/compose/compose.yaml',
  ...cli,
  'exec',
  '-T',
  'postgres',
  'psql',
  '-X',
  '-v',
  'ON_ERROR_STOP=1',
  '-U',
  'demo',
  '-d',
  'demo',
];
const result = spawnSync(command, args, {
  cwd: root,
  input: seed,
  stdio: ['pipe', 'inherit', 'inherit'],
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
