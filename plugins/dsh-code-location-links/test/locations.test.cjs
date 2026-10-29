const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function plugin() {
  let exports;
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../client.js'), 'utf8'), {
    window: { __ModuleLoader__: { load: (entry) => { exports = entry.factory(); } } }
  });
  return exports;
}

function harness() {
  const calls = [];
  const cleanups = [];
  let get;
  const service = {
    marker: {},
    openResource(...args) { calls.push({ args, receiver: this }); return 'opened'; }
  };
  plugin().apply({
    effect(fn) { cleanups.push(fn()); },
    on(name, listener) {
      assert.equal(name, 'internal/get');
      get = listener;
      cleanups.push(() => { get = undefined; });
    }
  });
  return {
    service,
    calls,
    sidebar: () => get({}, 'sidebarRight', new Error(), () => service),
    other: () => get({}, 'unrelated', new Error(), () => service),
    dispose: () => cleanups.reverse().forEach((fn) => fn())
  };
}

const base = 'dsh-resource://file/session/session-1/';
const examples = [
  ['Assets/Spawner.cs:251', 'Assets/Spawner.cs', 251],
  ['C:/Project/Assets/Test.cs:251:8', 'C:/Project/Assets/Test.cs', 251],
  ['/home/me/test.ts:42', '/home/me/test.ts', 42],
  ['C%3A/Project/My%20File.cs%3A251%3A8', 'C:/Project/My%20File.cs', 251],
  ['src/%E6%B5%8B%E8%AF%95.cpp:5', 'src/%E6%B5%8B%E8%AF%95.cpp', 5],
  ['src/test.cs:251?view=code#L251', 'src/test.cs?view=code#L251', 251],
  ['/C:/Project/README.md:14', 'C:/Project/README.md', 14],
  ['src/Test.cs%28251%2C8%29', 'src/Test.cs', 251],
  ['src/Test.cs%28251%29', 'src/Test.cs', 251],
  ['src/README:12', 'src/README', 12],
  ['src/.env:12', 'src/.env', 12],
  ['src/README.md#L12', 'src/README.md#L12', 12],
  ['src/README.md#L12-L18', 'src/README.md#L12-L18', 12],
  ['src/README.md?view=code#L12C3-L18C7', 'src/README.md?view=code#L12C3-L18C7', 12],
  ['/c%3a/Project/My%20File.cs%3A251%3A8', 'c:/Project/My%20File.cs', 251]
];

for (const [source, expected, line] of examples) {
  test(`opens source and passes line: ${source}`, () => {
    const h = harness();
    const sidebar = h.sidebar();
    assert.equal(sidebar.openResource(base + source), 'opened');
    assert.equal(h.calls[0].args[0], base + expected);
    assert.equal(h.calls[0].args[1].params.line, line);
    assert.equal(h.calls[0].receiver, h.service);
    h.dispose();
  });
}

const pathCases = [
  ['/C:/Project/README.md', 'C:/Project/README.md'],
  ['/c%3A/Project/%E6%96%87%E6%A1%A3%20A.md', 'c:/Project/%E6%96%87%E6%A1%A3%20A.md'],
  ['C%3A%5CProject%5CMy%20File.md', 'C:/Project/My%20File.md'],
  ['/C%3A%5CProject%5CMy%20File.md', 'C:/Project/My%20File.md'],
  ['%5C%5Cserver%5Cshare%5Creadme.md', '//server/share/readme.md'],
  ['/C:/Project/100%25%23done%3F.md', 'C:/Project/100%25%23done%3F.md'],
  ['/C:/Project/README.md?view=code#heading', 'C:/Project/README.md?view=code#heading']
];
for (const [source, expected] of pathCases) {
  test(`normalizes Windows file paths: ${source}`, () => {
    const h = harness();
    const options = { paneId: 'pane-1', params: { line: 7, custom: true } };
    h.sidebar().openResource(base + source, options, 'future-option');
    assert.equal(h.calls[0].args[0], base + expected);
    assert.equal(h.calls[0].args[1], options);
    assert.equal(h.calls[0].args[2], 'future-option');
    assert.equal(h.calls[0].receiver, h.service);
  });
}

test('preserves navigation options and an explicit line', () => {
  const h = harness();
  const options = { paneId: 'pane-1', replaceTab: 'old-tab', params: { line: 17, custom: 'keep' } };
  h.sidebar().openResource(base + 'test.cs:251', options);
  const result = h.calls[0].args[1];
  assert.equal(result.params.line, 17);
  assert.equal(result.params.custom, 'keep');
  assert.equal(result.paneId, 'pane-1');
  assert.equal(result.replaceTab, 'old-tab');
  assert.deepEqual(options.params, { line: 17, custom: 'keep' });
});

for (const source of [
  base + 'plain.cs', base + 'file%3Aname.cs', base + 'file.cs:0', base + 'file.cs:-3',
  base + 'file.cs:1:0', base + 'file.cs:9007199254740992', base + 'no-extension:12',
  base + 'folder:251/file.cs', base + 'bad%xx.cs:12', base + 'file.cs:12oops',
  'https://example.com/file.cs:251', 'dsh-resource://browser/file.cs:251',
  'dsh-resource://file/absolute/C:/file.cs:251', base + 'file%2Fname.cs:12',
  base + '/home/me/README.md', base + '//server/share/README.md',
  base + 'C:relative.md', base + '/C:relative.md', base + '/var/C:/README.md',
  base + 'path/README.md#L0', base + 'path/README.md#L9007199254740992',
  base + 'path/README.md#heading', base + 'path/README.md#L18-L12', base + '/C:/bad%xx.md',
  base + '/C%253A/README.md', base + 'file:///C:/README.md',
  base + '/C:/bad%00name.md', base + '/C:/folder%2Ffile.md', base + 'file:///C:/README.md:12',
  base + 'https://example.com/README.md:12',
  'file:///C:/README.md', 'dsh-resource://file/session//C:/README.md'
]) {
  test(`leaves other addresses unchanged: ${source}`, () => {
    const h = harness();
    const options = { params: { x: 1 } };
    h.sidebar().openResource(source, options);
    assert.equal(h.calls[0].args[0], source);
    assert.equal(h.calls[0].args[1], options);
  });
}

test('keeps unrelated services and restores behavior after disposal', () => {
  const h = harness();
  assert.equal(h.other(), h.service);
  const cached = h.sidebar();
  assert.equal(cached.marker, h.service.marker);
  h.dispose();
  cached.openResource(base + 'test.cs:251');
  assert.equal(h.calls[0].args[0], base + 'test.cs:251');
});
