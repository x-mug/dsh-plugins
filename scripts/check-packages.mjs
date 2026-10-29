import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');
const checksums = [];
for (const plugin of ['dsh-code-location-links', 'dsh-session-find']) {
  const directory = path.join(root, 'plugins', plugin);
  const manifest = JSON.parse(await readFile(path.join(directory, 'package.json'), 'utf8'));
  const filename = `local-${plugin}-${manifest.version}.tgz`;
  const bytes = await readFile(path.join(dist, filename));
  const tar = gunzipSync(bytes);
  const names = new Set();
  for (let offset = 0; offset + 512 <= tar.length;) {
    const header = tar.subarray(offset, offset + 512);
    const name = header.subarray(0, 100).toString().replace(/\0.*$/s, '');
    if (!name) break;
    const size = parseInt(header.subarray(124, 136).toString().replace(/\0.*$/s, '').trim(), 8) || 0;
    const type = header[156];
    if (type === 0 || type === 48) {
      assert.ok(name.startsWith('package/'), `Unexpected tar entry: ${name}`);
      const relative = name.slice(8);
      assert.ok(!relative.split('/').includes('..'));
      const actual = tar.subarray(offset + 512, offset + 512 + size);
      const expected = await readFile(path.join(directory, relative));
      if (relative === 'package.json') assert.deepEqual(JSON.parse(actual), JSON.parse(expected));
      else assert.ok(actual.equals(expected), `Packed bytes differ: ${plugin}/${relative}`);
      names.add(relative);
    }
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  for (const required of ['index.js', 'client.js', 'cordis.patch.yml', 'locale/zh.json', 'locale/en.json', 'icon.svg', 'README.md', 'package.json']) assert.ok(names.has(required), `Missing ${required}`);
  assert.ok(![...names].some((name) => name.includes('node_modules/') || name.startsWith('.git/')));
  const sha = createHash('sha256').update(bytes).digest('hex');
  checksums.push(`${sha}  ${filename}`);
  console.log(`${filename}: ${names.size} files, ${bytes.length} bytes, verified`);
}
await writeFile(path.join(dist, 'SHA256SUMS.txt'), checksums.join('\n') + '\n');
console.log(checksums.join('\n'));
