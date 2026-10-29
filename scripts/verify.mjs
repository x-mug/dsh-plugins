import { readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
function run(directory, args) {
  console.log(`\n[${directory}] node ${args.join(' ')}`);
  const result = spawnSync(process.execPath, args, { cwd: path.join(root, directory), stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

run('plugins/dsh-session-find', ['build.mjs']);
for (const plugin of ['dsh-auto-review-cache-identity', 'dsh-code-location-links', 'dsh-session-find']) {
  const directory = `plugins/${plugin}`;
  const tests = (await readdir(path.join(root, directory, 'test'))).filter((name) => /\.test\.(cjs|mjs)$/.test(name)).sort().map((name) => `test/${name}`);
  run(directory, ['--test', '--test-isolation=none', ...tests]);
  for (const script of ['client.js', 'index.js']) run(directory, ['--check', script]);
}
console.log('\nAll plugins verified.');
