import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const web = fileURLToPath(new URL('../apps/web/', import.meta.url));
const resolveWeb = createRequire(new URL('../apps/web/package.json', import.meta.url));
const vite = resolveWeb.resolve('vite/package.json').replace(/package\.json$/, 'bin/vite.js');
const env = { ...process.env, BS_FIXTURE_LOGIN: '1', VITE_FIXTURE_LOGIN: '1' };
if (!env.DATABASE_URL && !env.BS_PLATFORM_VAULT_MASTER_KEY) {
  env.BS_PLATFORM_VAULT_MASTER_KEY = randomBytes(32).toString('base64');
}
const processes = [
  spawn(process.execPath, ['apps/api/src/server.ts'], { cwd: root, env, stdio: 'inherit' }),
  spawn(
    process.execPath,
    [vite, '--configLoader', 'native', '--host', '127.0.0.1', '--strictPort'],
    {
      cwd: web,
      env,
      stdio: 'inherit',
    },
  ),
];
let stopping = false;
function stop(code) {
  if (stopping) return;
  stopping = true;
  process.exitCode = code;
  for (const child of processes) child.kill();
}
for (const child of processes) {
  child.on('exit', (code) => stop(code || 1));
  child.on('error', (error) => {
    console.error(error.message);
    stop(1);
  });
}
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => stop(0));
