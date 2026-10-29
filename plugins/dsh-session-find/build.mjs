import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.dirname(fileURLToPath(import.meta.url));
const read = (name) => readFile(path.join(root, name), 'utf8');
const strip = (source) => source.replace(/^import\s+[^;]+;\s*$/gm, '').replace(/^export\s+(?=(?:async\s+)?(?:class|function|const|let|var)\b)/gm, '');
const engine = await read('src/engine.js');
const worker = await read('src/worker.js');
const workerText = strip(engine) + '\n' + strip(worker);
const modules = await Promise.all(['source', 'navigation', 'bridge', 'controller', 'ui'].map((name) => read(`src/${name}.js`)));
const css = await read('src/styles.css');
const zh = JSON.parse(await read('locale/zh.json'));
const en = JSON.parse(await read('locale/en.json'));
const client = `window.__ModuleLoader__.load({id:'@local/dsh-session-find',factory:(require)=>{\n${modules.map(strip).join('\n')}\nreturn createFindPlugin({React:require('react'),workerText:${JSON.stringify(workerText)},css:${JSON.stringify(css)},dictionaries:${JSON.stringify({ zh, en })}});\n}});\n`;
await writeFile(path.join(root, 'client.js'), client, 'utf8');
await writeFile(path.join(root, 'test/worker-built.js'), workerText, 'utf8');
console.log(`Built client.js (${Buffer.byteLength(client)} bytes) and Worker (${Buffer.byteLength(workerText)} bytes).`);
