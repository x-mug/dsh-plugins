import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { nodeForHit } from '../src/navigation.js';
import { SessionFindController } from '../src/controller.js';

const tick = () => new Promise((resolve) => setTimeout(resolve, 60));

function bridgeFixture() {
  const instances = [];
  class Bridge {
    constructor() { this.docs = new Map(); this.disposed = false; this.cancelled = 0; this.queries = []; instances.push(this); }
    upsert(docs) { for (const doc of docs) this.docs.set(doc.id, doc); return Promise.resolve(); }
    remove(ids) { for (const id of ids) this.docs.delete(id); return Promise.resolve(); }
    cancel() { this.cancelled++; }
    query(query) { return new Promise((resolve) => this.queries.push({ query, resolve })); }
    dispose() { this.disposed = true; }
  }
  return { Bridge, instances };
}
function setupController() {
  const fixture = bridgeFixture();
  const sources = [];
  const controller = new SessionFindController({
    ctx: { remote: {}, sidebarRight: { mounted: { getSnapshot: () => 's1' } } }, binding: { sessionId: 's1' }, workerText: '', Bridge: fixture.Bridge,
    createSource(callbacks) { const source = { callbacks, start: async () => {}, refresh: async () => {}, dispose() { callbacks.onRemove(['1:0']); } }; sources.push(source); return source; },
    reveal: async () => ({ precise: true })
  });
  return { controller, fixture, sources };
}

test('navigation resolves settled seq and never substitutes a different message', () => {
  const user = { kind: 'user', key: 'u', data: { seq: 2 } };
  const assistant = { kind: 'assistant-step', key: 'a', data: { finalNode: { seq: 5 }, turn: 1, step: 0 } };
  const snapshot = { nodes: new Map([['u', user], ['a', assistant]]) };
  assert.equal(nodeForHit(snapshot, { role: 'user', seq: 2 }), user);
  assert.equal(nodeForHit(snapshot, { role: 'assistant', seq: 5 }), assistant);
  assert.equal(nodeForHit(snapshot, { role: 'reasoning', seq: 5 }), assistant);
  assert.equal(nodeForHit(snapshot, { role: 'user', seq: 123 }), undefined);
});

test('controller discards an obsolete query that finishes after newer input', async () => {
  const { controller, fixture } = setupController();
  controller.start();
  controller.setQuery('first');
  await tick();
  controller.setQuery('second');
  await tick();
  const bridge = fixture.instances[0];
  assert.equal(bridge.queries.length, 2);
  bridge.queries[1].resolve({ id: 2, total: 1, items: [] });
  await Promise.resolve();
  bridge.queries[0].resolve({ id: 1, total: 9, items: [] });
  await Promise.resolve();
  assert.equal(controller.getSnapshot().result.id, 2);
  controller.stop();
});

test('closing a source cannot enqueue work against a reopened Worker', async () => {
  const { controller, fixture, sources } = setupController();
  controller.start();
  sources[0].callbacks.onUpsert([{ id: '1:0', text: 'old' }]);
  controller.stop();
  controller.start();
  sources[0].callbacks.onUpsert([{ id: '99:0', text: 'stale' }]);
  sources[1].callbacks.onUpsert([{ id: '2:0', text: 'new' }]);
  await tick();
  assert.equal(fixture.instances[0].disposed, true);
  assert.deepEqual([...fixture.instances[1].docs.keys()], ['2:0']);
  controller.stop();
});

test('generated client registers and disposes with installed Cordis 4.0.5', async (t) => {
  if (!process.env.DSH_TEST_VENDOR_DIR) {
    t.skip('Optional DSH runtime integration: set DSH_TEST_VENDOR_DIR to a directory holding extracted cordis/ and cosmokit/ packages.');
    return;
  }
  const vendor = pathToFileURL(path.resolve(process.env.DSH_TEST_VENDOR_DIR) + path.sep);
  const cosmokit = await readFile(new URL('cosmokit/lib/index.js', vendor), 'utf8');
  const cosmokitUrl = 'data:text/javascript;base64,' + Buffer.from(cosmokit).toString('base64');
  const cordis = (await readFile(new URL('cordis/lib/index.js', vendor), 'utf8')).replace('from "@deepseek-ai/cosmokit"', `from "${cosmokitUrl}"`);
  const { Context } = await import('data:text/javascript;base64,' + Buffer.from(cordis).toString('base64'));
  let plugin;
  vm.runInNewContext(await readFile(new URL('../client.js', import.meta.url), 'utf8'), {
    window: { __ModuleLoader__: { load: ({ factory }) => { plugin = factory((name) => { assert.equal(name, 'react'); return { createElement() {} }; }); } } },
    clearTimeout, setTimeout, console
  });
  const ctx = new Context();
  const registered = new Map();
  let shortcuts = 0;
  let types = 0;
  let subscriptions = 0;
  const noop = () => {};
  const mounted = { getSnapshot: () => 's1', subscribe() { subscriptions++; return () => subscriptions--; } };
  ctx.provide('slots', {
    inject(_name, callback) { return callback(); },
    register(options, component) { registered.set(options.name, component); return () => registered.delete(options.name); }
  });
  ctx.provide('locale', { register: () => noop, bind: () => (key) => key });
  ctx.provide('sessions', { binding: () => undefined });
  ctx.provide('uiSession', {});
  ctx.provide('uiConversation', {});
  ctx.provide('sidebarRight', { mounted });
  ctx.provide('sidebarRightTabs', { register() { types++; return () => types--; } });
  ctx.provide('shortcuts', { register(spec) {
    assert.equal(Object.keys(spec.defaults).length, 0);
    assert.equal(spec.resolve().status, 'handled');
    shortcuts++;
    return () => shortcuts--;
  } });
  ctx.provide('remote', {});
  ctx.provide('remote.session', {});
  ctx.provide('workspaces', { list: { getSnapshot: () => ({ items: [], archivedSessionIds: [] }) } });
  ctx.provide('uiWorkspace', {});
  const activation = ctx.plugin(plugin);
  await activation;
  assert.equal(registered.size, 2);
  assert.equal(shortcuts, 1);
  assert.equal(types, 1);
  assert.equal(subscriptions, 2);
  await activation.dispose();
  assert.equal(registered.size, 0);
  assert.equal(shortcuts, 0);
  assert.equal(types, 0);
  assert.equal(subscriptions, 0);
});
