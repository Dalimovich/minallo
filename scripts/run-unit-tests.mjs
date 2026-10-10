import { readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

function discover(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) return discover(path);
    return /\.test\.(?:mjs|ts)$/.test(entry.name) ? [path] : [];
  });
}

const files = discover(resolve('tests')).sort((left, right) => left.localeCompare(right));
console.log(`Discovered ${files.length} unit test files.`);
if (!files.length) process.exit(1);

const tsxCli = resolve('node_modules', 'tsx', 'dist', 'cli.mjs');
const result = spawnSync(process.execPath, [tsxCli, '--test', '--test-reporter=spec', ...files], {
  stdio: 'inherit',
  shell: false,
});

if (result.error) {
  console.error(result.error);
  process.exit(1);
}
process.exit(result.status ?? 1);
