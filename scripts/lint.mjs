import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { sourceFiles } from './source-files.mjs';

for (const path of sourceFiles) {
  if (path.endsWith('.json')) JSON.parse(readFileSync(path, 'utf8'));
  if (path.endsWith('.mjs')) {
    const run = spawnSync(process.execPath, ['--check', path], { stdio: 'inherit' });
    if (run.status !== 0) process.exitCode = 1;
  }
}
