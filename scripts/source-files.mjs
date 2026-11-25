import { readdirSync } from 'node:fs';
import { join } from 'node:path';

const roots = ['.github', 'apps', 'infra', 'packages', 'scripts', 'tests', 'workers'];
const ignoredDirectories = new Set(['node_modules', '__pycache__', 'dist', '.cache', '.venv']);
const sources = /\.(ts|tsx|mjs|py|json|yaml|yml|sql|html|toml)$/;

function walk(path) {
  return readdirSync(path, { withFileTypes: true }).flatMap((entry) => {
    const child = join(path, entry.name);
    if (entry.isDirectory()) return ignoredDirectories.has(entry.name) ? [] : walk(child);
    if (entry.isFile() && sources.test(entry.name)) return [child];
    return [];
  });
}

export const sourceFiles = [
  '.editorconfig',
  '.gitattributes',
  '.gitignore',
  '.node-version',
  '.python-version',
  'README.md',
  'docs/personal-plan/milestone-1.md',
  'infra/compose/.env.example',
  'package.json',
  'pnpm-workspace.yaml',
  'pyproject.toml',
  'tsconfig.json',
  ...roots.flatMap(walk),
];
