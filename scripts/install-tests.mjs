import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const testDir = join(root, 'droiddock/tests');

// Publication and release-packaging checks that an installed service never uses.
// They stay in `npm test`, `npm run verify`, and CI.
export const publicationTests = Object.freeze(['release.test.mjs']);

// The installation gate is every offline test except publication tooling, so new
// runtime tests join it automatically.
export function installTestFiles() {
  return readdirSync(testDir).filter(name => name.endsWith('.test.mjs') && !publicationTests.includes(name)).sort()
    .map(name => join('droiddock/tests', name));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = spawnSync(process.execPath, ['--test', ...installTestFiles()], { cwd: root, stdio: 'inherit', windowsHide: true });
  process.exitCode = result.status ?? 1;
}
