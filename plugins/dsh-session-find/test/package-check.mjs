import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const archive = process.argv[2];
if (!archive) throw new Error('Pass the packed tgz path.');
const bytes = await readFile(archive);
const tar = gunzipSync(bytes);
const files = new Map();
for (let offset = 0; offset + 512 <= tar.length;) {
  const header = tar.subarray(offset, offset + 512);
  const name = header.subarray(0, 100).toString().replace(/\0.*$/s, '');
  if (!name) break;
  const size = parseInt(header.subarray(124, 136).toString().replace(/\0.*$/s, '').trim(), 8) || 0;
  const type = header[156];
  if (type === 0 || type === 48) files.set(name, tar.subarray(offset + 512, offset + 512 + size));
  offset += 512 + Math.ceil(size / 512) * 512;
}
const root = path.dirname(fileURLToPath(new URL('.', import.meta.url)));
for (const [name, contents] of files) {
  assert.ok(name.startsWith('package/'));
  const relative = name.slice(8);
  const local = await readFile(path.join(root, relative));
  if (relative === 'package.json') assert.deepEqual(JSON.parse(contents), JSON.parse(local));
  else assert.ok(contents.equals(local), `Packed bytes differ for ${relative}`);
}
for (const required of ['index.js', 'client.js', 'cordis.patch.yml', 'locale/zh.json', 'locale/en.json', 'icon.svg', 'README.md', 'PERFORMANCE.md', 'src/styles.css']) assert.ok(files.has(`package/${required}`), `Missing ${required}`);
console.log(JSON.stringify({ archive: path.resolve(archive), files: files.size, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), verified: true }, null, 2));
