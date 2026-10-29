const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { pathToFileURL } = require('node:url');

const vendor = process.env.DSH_INTEGRATION_VENDOR;
const dependencyFiles = {
  workspacePath: 'dsh-util-workspace-path/lib/index.js',
  cordis: 'cordis/lib/index.js',
  cosmokit: 'cosmokit/lib/index.js'
};

function integrationSkip(...dependencies) {
  if (!vendor) return 'Optional local DSH integration: set DSH_INTEGRATION_VENDOR to your local dependency directory.';
  const missing = dependencies.filter((name) => !fs.existsSync(path.resolve(vendor, dependencyFiles[name])));
  return missing.length
    ? `Optional local DSH integration: missing ${missing.map((name) => dependencyFiles[name]).join(', ')} under DSH_INTEGRATION_VENDOR.`
    : false;
}

async function workspacePathApi() {
  return import(pathToFileURL(path.resolve(vendor, dependencyFiles.workspacePath)).href);
}

function plugin() {
  let value;
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../client.js'), 'utf8'), {
    window: { __ModuleLoader__: { load: ({ factory }) => { value = factory(); } } }
  });
  return value;
}

async function framework() {
  const cosmokit = fs.readFileSync(path.resolve(vendor, dependencyFiles.cosmokit), 'utf8');
  const cosmokitUrl = 'data:text/javascript;base64,' + Buffer.from(cosmokit).toString('base64');
  const cordis = fs.readFileSync(path.resolve(vendor, dependencyFiles.cordis), 'utf8').replace('from "@deepseek-ai/cosmokit"', `from "${cosmokitUrl}"`);
  return import('data:text/javascript;base64,' + Buffer.from(cordis).toString('base64'));
}

test('actual DSH address builder and parser deliver a Windows file path', { skip: integrationSkip('workspacePath') }, async () => {
  const { fileAddressFor, parseFileAddress } = await workspacePathApi();
  const sessionId = 'session-1';
  const cwd = 'C:/Project';
  const native = 'C:/Project/README.md';
  const broken = '/' + native;
  const resource = fileAddressFor(sessionId, cwd, broken);
  let hook;
  let opened;
  const service = { openResource(address, options) { opened = { ...parseFileAddress(address), options }; } };
  plugin().apply({ effect(fn) { fn(); }, on(_name, listener) { hook = listener; } });
  hook({}, 'sidebarRight', undefined, () => service).openResource(resource);
  assert.equal(opened.path, native);
  assert.equal(opened.sessionId, sessionId);
  assert.equal(opened.scope, 'session');
});

test('Cordis 4.0.5 normalizes links across service caches, uninstall and re-enable', { skip: integrationSkip('workspacePath', 'cordis', 'cosmokit') }, async () => {
  const { Context } = await framework();
  const { parseFileAddress } = await workspacePathApi();
  const ctx = new Context();
  const calls = [];
  const controller = {
    identity: 'same-controller',
    openResource(address, options) { calls.push({ address, options, controller: this }); }
  };
  ctx.provide('sidebarRight', controller);
  const fix = ctx.plugin(plugin());
  await fix;
  let caller;
  const consumer = ctx.plugin({ inject: ['sidebarRight'], apply(context) { caller = context; } });
  await consumer;
  const input = 'dsh-resource://file/session/s1//C:/Project/README.md:14';
  caller.sidebarRight.openResource(input);
  assert.equal(parseFileAddress(calls[0].address).path, 'C:/Project/README.md');
  assert.equal(calls[0].options.params.line, 14);
  assert.equal(calls[0].controller, controller);
  const held = caller.sidebarRight;
  await fix.dispose();
  caller.sidebarRight.openResource(input);
  held.openResource(input);
  assert.equal(calls[1].address, input);
  assert.equal(calls[2].address, input);
  const again = ctx.plugin(plugin());
  await again;
  caller.sidebarRight.openResource(input);
  assert.equal(parseFileAddress(calls[3].address).path, 'C:/Project/README.md');
  await again.dispose();
  await consumer.dispose();
});
